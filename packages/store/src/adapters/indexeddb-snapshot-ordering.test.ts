import 'fake-indexeddb/auto'
import { SimpleEventEmitter } from '@korajs/core/internal'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { minimalSchema } from '../../tests/fixtures/test-schema'
import { PersistenceError } from '../errors'
import {
	FollowerBroadcastBridge,
	TransactionSerializingWorkerBridge,
	startLeaderRpcRelay,
} from '../multi-tab/tab-storage'
import type { Transaction } from '../types'
import type { DatabaseDump } from './database-dump'
import { IndexedDbAdapter } from './indexeddb-adapter'
import type { WorkerBridge, WorkerRequest, WorkerResponse } from './sqlite-wasm-channel'
import { MockWorkerBridge } from './sqlite-wasm-mock-bridge'
import {
	SNAPSHOT_SUPERSEDED,
	compareSnapshotVersions,
	deleteFromIndexedDB,
	loadSnapshotFromIndexedDB,
	saveDumpToIndexedDB,
	saveSnapshotToIndexedDB,
	saveToIndexedDB,
	startSnapshotLineage,
} from './sqlite-wasm-persistence'

/**
 * Snapshot ordering on the IndexedDB fallback across tabs.
 *
 * Each tab has its own IndexedDbAdapter and persistence scheduler, but every tab's
 * snapshot reads the leader's single worker database (a follower relays its export
 * transaction to it). Two tabs can therefore save snapshots out of order: a follower
 * whose export was taken earlier but whose IndexedDB put lands later must never replace
 * a newer snapshot, or a write whose `ensureDurable()` already resolved is lost on reload.
 */

/** The browser worker: one live database shared by tabs, `open` idempotent. */
class BrowserWorkerSim implements WorkerBridge {
	private readonly inner = new MockWorkerBridge()
	private opened = false
	constructor(private readonly supportsExport = false) {}
	async send(request: WorkerRequest): Promise<WorkerResponse> {
		if (request.type === 'open') {
			if (this.opened) return { id: request.id, type: 'success' }
			this.opened = true
		}
		if (request.type === 'export' && !this.supportsExport) {
			return {
				id: request.id,
				type: 'error',
				message: 'Export not yet supported in browser worker',
				code: 'EXPORT_NOT_SUPPORTED',
			}
		}
		if (request.type === 'close') return { id: request.id, type: 'success' }
		return this.inner.send(request)
	}
	terminate(): void {}
}

/**
 * A follower tab's link to the leader's worker. When armed, the response to the next
 * COMMIT is held back (the statement itself already ran in the worker): the follower's
 * snapshot export finished in the worker, but the follower only gets to save it later,
 * as with a slow broadcast-channel round trip.
 */
class SlowFollowerLink implements WorkerBridge {
	private armed = false
	/** The request type whose response is held: `commit` (the dump) or `export` (the image). */
	holdType: WorkerRequest['type'] = 'commit'
	private release: (() => void) | null = null
	private committed: (() => void) | null = null
	readonly commitReached: Promise<void>
	constructor(private readonly leaderWorker: WorkerBridge) {
		this.commitReached = new Promise((resolve) => {
			this.committed = resolve
		})
	}
	arm(): void {
		this.armed = true
	}
	releaseCommit(): void {
		this.release?.()
	}
	async send(request: WorkerRequest): Promise<WorkerResponse> {
		const response = await this.leaderWorker.send(request)
		if (request.type === this.holdType && this.armed) {
			this.armed = false
			await new Promise<void>((resolve) => {
				this.release = resolve
				this.committed?.()
			})
		}
		return response
	}
	terminate(): void {}
}

/** A follower's relay whose leader worker can be replaced (a leader change). */
class SwitchableLink implements WorkerBridge {
	constructor(public target: WorkerBridge) {}
	send(request: WorkerRequest): Promise<WorkerResponse> {
		return this.target.send(request)
	}
	terminate(): void {}
}

type ChannelHandler = (event: { data: unknown }) => void

/** In-process BroadcastChannel, so tabs talk through the real follower/relay code. */
class MockBroadcastChannel {
	static channels = new Map<string, Set<MockBroadcastChannel>>()
	private readonly handlers = new Set<ChannelHandler>()
	constructor(public readonly name: string) {
		const set = MockBroadcastChannel.channels.get(name) ?? new Set()
		set.add(this)
		MockBroadcastChannel.channels.set(name, set)
	}
	postMessage(data: unknown): void {
		for (const peer of MockBroadcastChannel.channels.get(this.name) ?? []) {
			if (peer === this) continue
			for (const handler of peer.handlers) handler({ data })
		}
	}
	addEventListener(_type: 'message', handler: ChannelHandler): void {
		this.handlers.add(handler)
	}
	removeEventListener(_type: 'message', handler: ChannelHandler): void {
		this.handlers.delete(handler)
	}
	close(): void {
		MockBroadcastChannel.channels.get(this.name)?.delete(this)
	}
}

/**
 * A follower tab's bridge (the real {@link FollowerBroadcastBridge}) that runs `onAfter`
 * right after the first request `match` selects was answered: the moment a test hands
 * leadership to another worker, between two requests of the follower.
 */
class HandoverFollower implements WorkerBridge {
	private hook: { match: (request: WorkerRequest) => boolean; onAfter: () => void } | null = null
	constructor(readonly inner: FollowerBroadcastBridge) {}
	after(match: (request: WorkerRequest) => boolean, onAfter: () => void): void {
		this.hook = { match, onAfter }
	}
	async send(request: WorkerRequest): Promise<WorkerResponse> {
		const response = await this.inner.send(request)
		if (this.hook?.match(request)) {
			const { onAfter } = this.hook
			this.hook = null
			onAfter()
		}
		return response
	}
	terminate(): void {
		this.inner.terminate()
	}
}

const isInsertOf =
	(id: string) =>
	(request: WorkerRequest): boolean =>
		request.type === 'execute' && Array.isArray(request.params) && request.params[0] === id

const DB = 'idb-snapshot-ordering'

const insert = (adapter: IndexedDbAdapter, id: string) =>
	adapter.execute(
		'INSERT INTO todos (id, title, completed, _created_at, _updated_at) VALUES (?, ?, ?, ?, ?)',
		[id, id, 0, 1, 1],
	)

/** Simulate a tab that is gone without a final flush (crash, killed tab). */
function abandon(adapter: IndexedDbAdapter): void {
	;(adapter as unknown as { scheduler: { dispose(): void } }).scheduler.dispose()
}

/**
 * What a reload would restore, read without opening a new leader (which starts a lineage
 * and fences the stored snapshot, as a real reload does once the old tabs are gone): the
 * binary image when stored (a restore prefers it), else the JSON dump.
 */
async function reloadIds(_supportsExport?: boolean): Promise<string[]> {
	const { data, dump } = await loadSnapshotFromIndexedDB<DatabaseDump>(DB)
	if (data) {
		const image = new Database(Buffer.from(data))
		try {
			const rows = image.prepare('SELECT id FROM todos ORDER BY id').all() as Array<{ id: string }>
			return rows.map((row) => row.id)
		} finally {
			image.close()
		}
	}
	const todos = dump?.tables.find((table) => table.name === 'todos')
	return (todos?.rows ?? []).map((row) => String(row.id)).sort()
}

/** A real reload: a new leader on a fresh worker restored from IndexedDB. */
async function reopenIds(): Promise<string[]> {
	const reloaded = new IndexedDbAdapter({
		bridge: new BrowserWorkerSim(),
		dbName: DB,
		persistenceDebounceMs: 60_000,
	})
	await reloaded.open(minimalSchema)
	const rows = await reloaded.query<{ id: string }>('SELECT id FROM todos ORDER BY id')
	abandon(reloaded)
	return rows.map((row) => row.id)
}

describe('IndexedDB fallback: snapshots from two tabs never save out of order', () => {
	afterEach(async () => {
		await deleteFromIndexedDB(DB).catch(() => {})
	})

	for (const supportsExport of [false, true]) {
		const label = supportsExport ? 'binary snapshot and JSON dump' : 'JSON dump only (browsers)'

		test(`an older follower snapshot landing last does not replace a newer durable one (${label})`, async () => {
			const worker = new BrowserWorkerSim(supportsExport)
			const leader = new IndexedDbAdapter({
				bridge: worker,
				dbName: DB,
				persistenceDebounceMs: 60_000,
			})
			await leader.open(minimalSchema)
			const link = new SlowFollowerLink(worker)
			const follower = new IndexedDbAdapter({
				bridge: link,
				dbName: DB,
				persistenceDebounceMs: 60_000,
			})
			await follower.open(minimalSchema)

			await insert(leader, 'first')
			await leader.ensureDurable()

			// The follower's snapshot is taken in the worker (it sees only 'first'), then its
			// response is delayed: the dump's COMMIT, or for the binary path the image export
			// (the image is the part a restore prefers).
			link.holdType = supportsExport ? 'export' : 'commit'
			link.arm()
			const followerFlush = follower.flushPersistence()
			await link.commitReached

			// Meanwhile the leader writes and makes it durable.
			await insert(leader, 'second')
			await leader.ensureDurable()
			expect(await reloadIds(supportsExport)).toEqual(['first', 'second'])

			// The follower's older snapshot reaches IndexedDB last.
			link.releaseCommit()
			await followerFlush

			// Both tabs disappear without another flush; the resolved write must survive.
			abandon(leader)
			abandon(follower)
			expect(await reloadIds(supportsExport)).toEqual(['first', 'second'])
		})
	}

	test('a snapshot exported from a worker that was replaced never overwrites the new one', async () => {
		// Tab A leads on worker 1; tab B follows it.
		const oldWorker = new BrowserWorkerSim()
		const a = new IndexedDbAdapter({ bridge: oldWorker, dbName: DB, persistenceDebounceMs: 60_000 })
		await a.open(minimalSchema)
		await insert(a, 'old-durable')
		await a.ensureDurable()
		await insert(a, 'old-unsaved')

		const link = new SlowFollowerLink(oldWorker)
		const b = new IndexedDbAdapter({ bridge: link, dbName: DB, persistenceDebounceMs: 60_000 })
		await b.open(minimalSchema)
		link.arm()
		const staleFlush = b.flushPersistence()
		await link.commitReached

		// Tab A dies; tab C becomes the leader on a fresh worker restored from IndexedDB
		// (which does not hold 'old-unsaved' yet), and writes durably.
		abandon(a)
		const c = new IndexedDbAdapter({
			bridge: new BrowserWorkerSim(),
			dbName: DB,
			persistenceDebounceMs: 60_000,
		})
		await c.open(minimalSchema)
		await insert(c, 'new-durable')
		await c.ensureDurable()

		// B's export from the old worker lands now. Its state does not contain the new
		// leader's write, so it must not replace the newer snapshot.
		link.releaseCommit()
		await staleFlush
		expect(await reloadIds(false)).toEqual(['new-durable', 'old-durable'])

		// The new lineage keeps saving after the stale put was refused.
		await insert(c, 'new-later')
		await c.ensureDurable()
		abandon(b)
		abandon(c)
		expect(await reloadIds(false)).toEqual(['new-durable', 'new-later', 'old-durable'])
	})

	test("a save from a replaced worker database landing between the new leader's restore and its first save is refused, and its barrier rejects", async () => {
		// The interleaving from the review: A leads on worker 1; B follows and writes.
		const oldWorker = new BrowserWorkerSim()
		const a = new IndexedDbAdapter({ bridge: oldWorker, dbName: DB, persistenceDebounceMs: 60_000 })
		await a.open(minimalSchema)
		await insert(a, 'old-durable')
		await a.ensureDurable()

		const link = new SlowFollowerLink(oldWorker)
		const b = new IndexedDbAdapter({ bridge: link, dbName: DB, persistenceDebounceMs: 60_000 })
		await b.open(minimalSchema)
		await insert(b, 'b-write')
		link.arm()
		const bBarrier = b.ensureDurable()
		await link.commitReached

		// A dies; C leads on a fresh worker restored from IndexedDB (without 'b-write').
		abandon(a)
		const c = new IndexedDbAdapter({
			bridge: new BrowserWorkerSim(),
			dbName: DB,
			persistenceDebounceMs: 60_000,
		})
		await c.open(minimalSchema)

		// B's save lands before C's first save: it must be refused, never resolve.
		link.releaseCommit()
		await expect(bBarrier).rejects.toMatchObject({ context: { code: SNAPSHOT_SUPERSEDED } })

		await insert(c, 'c-write')
		await c.ensureDurable()
		abandon(b)
		abandon(c)
		expect(await reopenIds()).toEqual(['c-write', 'old-durable'])
	})

	test('a durability barrier spanning a leader change rejects for a write the replaced database lost', async () => {
		const oldWorker = new BrowserWorkerSim()
		const a = new IndexedDbAdapter({ bridge: oldWorker, dbName: DB, persistenceDebounceMs: 60_000 })
		await a.open(minimalSchema)
		await insert(a, 'base')
		await a.ensureDurable()

		// B writes into worker 1 and never saves it there.
		const relay = new SwitchableLink(oldWorker)
		const emitter = new SimpleEventEmitter()
		const errors: Array<{ code: string }> = []
		emitter.on('store:persistence-error', (event) => errors.push(event))
		const b = new IndexedDbAdapter({
			bridge: relay,
			dbName: DB,
			persistenceDebounceMs: 60_000,
			emitter,
		})
		await b.open(minimalSchema)
		await insert(b, 'b-lost')

		// A dies; C restores on worker 2 (without 'b-lost'); B now relays to C's worker.
		abandon(a)
		const newWorker = new BrowserWorkerSim()
		const c = new IndexedDbAdapter({ bridge: newWorker, dbName: DB, persistenceDebounceMs: 60_000 })
		await c.open(minimalSchema)
		relay.target = newWorker

		await expect(b.ensureDurable()).rejects.toMatchObject({
			context: { code: SNAPSHOT_SUPERSEDED },
		})
		expect(errors.some((event) => event.code === SNAPSHOT_SUPERSEDED)).toBe(true)
		// The loss is not forgotten: a retried barrier still covers 'b-lost' and rejects,
		// while the later write is still persisted (the snapshot is written first).
		await insert(b, 'b-after')
		await expect(b.ensureDurable()).rejects.toMatchObject({
			context: { code: SNAPSHOT_SUPERSEDED },
		})
		abandon(b)
		abandon(c)
		expect(await reopenIds()).toEqual(['b-after', 'base'])
		// A reload (a new adapter, a new lineage) starts clean: its barriers judge its writes.
		const reloaded = new IndexedDbAdapter({
			bridge: new BrowserWorkerSim(),
			dbName: DB,
			persistenceDebounceMs: 60_000,
		})
		await reloaded.open(minimalSchema)
		await insert(reloaded, 'after-reload')
		await expect(reloaded.ensureDurable()).resolves.toBeUndefined()
		abandon(reloaded)
	})

	test('a barrier resolves when another tab saved the write before its database was replaced', async () => {
		const oldWorker = new BrowserWorkerSim()
		const a = new IndexedDbAdapter({ bridge: oldWorker, dbName: DB, persistenceDebounceMs: 60_000 })
		await a.open(minimalSchema)
		const relay = new SwitchableLink(oldWorker)
		const b = new IndexedDbAdapter({ bridge: relay, dbName: DB, persistenceDebounceMs: 60_000 })
		await b.open(minimalSchema)
		await insert(b, 'b-saved')
		// A's snapshot holds B's write; then A dies and C takes over.
		await a.flushPersistence()
		abandon(a)
		const newWorker = new BrowserWorkerSim()
		const c = new IndexedDbAdapter({ bridge: newWorker, dbName: DB, persistenceDebounceMs: 60_000 })
		await c.open(minimalSchema)
		relay.target = newWorker
		await expect(b.ensureDurable()).resolves.toBeUndefined()
		abandon(b)
		abandon(c)
		expect(await reopenIds()).toEqual(['b-saved'])
	})

	test('a read-only transaction across a leader change is not a write: it is never reported lost', async () => {
		const oldWorker = new BrowserWorkerSim()
		const a = new IndexedDbAdapter({ bridge: oldWorker, dbName: DB, persistenceDebounceMs: 60_000 })
		await a.open(minimalSchema)
		await insert(a, 'base')
		await a.ensureDurable()
		const relay = new SwitchableLink(oldWorker)
		const b = new IndexedDbAdapter({ bridge: relay, dbName: DB, persistenceDebounceMs: 60_000 })
		await b.open(minimalSchema)
		// Only reads (as a backup snapshot or a fold-state read does), on worker 1.
		await b.transaction(async (tx) => {
			await tx.query('SELECT id FROM todos')
		})
		// A dies with no further save; C restores on worker 2; B now relays to it.
		abandon(a)
		const newWorker = new BrowserWorkerSim()
		const c = new IndexedDbAdapter({ bridge: newWorker, dbName: DB, persistenceDebounceMs: 60_000 })
		await c.open(minimalSchema)
		relay.target = newWorker
		await expect(b.ensureDurable()).resolves.toBeUndefined()
		// A later write of B is judged on its own, and saved.
		await insert(b, 'b-after')
		await expect(b.ensureDurable()).resolves.toBeUndefined()
		abandon(b)
		abandon(c)
		expect(await reopenIds()).toEqual(['b-after', 'base'])
	})

	const writesWithoutRowChanges: Array<[string, (tx: Transaction) => Promise<unknown>]> = [
		['changes only the schema', (tx) => tx.execute('CREATE TABLE extra (id TEXT PRIMARY KEY)')],
		['changes only user_version', (tx) => tx.execute('PRAGMA user_version = 7')],
		[
			'writes through a query (RETURNING)',
			(tx) =>
				tx.query(
					'INSERT INTO todos (id, title, completed, _created_at, _updated_at) VALUES (?, ?, ?, ?, ?) RETURNING id',
					['returned', 'returned', 0, 1, 1],
				),
		],
	]
	for (const [label, write] of writesWithoutRowChanges) {
		test(`a transaction that ${label} still counts as a write`, async () => {
			const oldWorker = new BrowserWorkerSim()
			const a = new IndexedDbAdapter({
				bridge: oldWorker,
				dbName: DB,
				persistenceDebounceMs: 60_000,
			})
			await a.open(minimalSchema)
			const relay = new SwitchableLink(oldWorker)
			const b = new IndexedDbAdapter({ bridge: relay, dbName: DB, persistenceDebounceMs: 60_000 })
			await b.open(minimalSchema)
			await b.transaction(async (tx) => {
				await write(tx)
			})
			// Not saved before worker 1 was replaced: reported lost, never resolved.
			abandon(a)
			const newWorker = new BrowserWorkerSim()
			const c = new IndexedDbAdapter({
				bridge: newWorker,
				dbName: DB,
				persistenceDebounceMs: 60_000,
			})
			await c.open(minimalSchema)
			relay.target = newWorker
			await expect(b.ensureDurable()).rejects.toMatchObject({
				context: { code: SNAPSHOT_SUPERSEDED },
			})
			abandon(b)
			abandon(c)
		})
	}

	test('a write saved by another tab stays proven saved after more than 32 leader changes', async () => {
		const oldWorker = new BrowserWorkerSim()
		const a = new IndexedDbAdapter({ bridge: oldWorker, dbName: DB, persistenceDebounceMs: 60_000 })
		await a.open(minimalSchema)
		const relay = new SwitchableLink(oldWorker)
		const b = new IndexedDbAdapter({ bridge: relay, dbName: DB, persistenceDebounceMs: 60_000 })
		await b.open(minimalSchema)
		await insert(b, 'b-saved')
		// B's unsaved lineage is pinned before the write returns.
		expect(await storedKeys()).toContain(`${DB}::pins`)
		// A's snapshot holds B's write; then A dies, and leadership changes 40 times
		// (each new leader restores on a fresh worker and starts a lineage) while B sleeps.
		await a.flushPersistence()
		abandon(a)
		let worker = new BrowserWorkerSim()
		for (let change = 0; change < 40; change++) {
			worker = new BrowserWorkerSim()
			const leader = new IndexedDbAdapter({
				bridge: worker,
				dbName: DB,
				persistenceDebounceMs: 60_000,
			})
			await leader.open(minimalSchema)
			abandon(leader)
		}
		relay.target = worker
		// The lineage B wrote in is 40 lineages back, yet still proven saved.
		await expect(b.ensureDurable()).resolves.toBeUndefined()
		// Closing releases B's pins, so the ancestry is bounded again.
		await b.close()
		expect(await storedKeys()).not.toContain(`${DB}::pins`)
		expect(await reopenIds()).toEqual(['b-saved'])
	})

	test('an unpinned ancestor beyond the recent ancestry is dropped', async () => {
		await startSnapshotLineage(DB, 'first')
		for (let change = 0; change < 40; change++) await startSnapshotLineage(DB, `l${change}`)
		const saved = await saveSnapshotToIndexedDB(DB, {
			dump: { tables: [] },
			data: null,
			version: { epoch: 1_000, lineage: 'last', seq: 0 },
		})
		expect(saved.ancestors).toHaveLength(32)
		expect(saved.ancestors.some((entry) => entry.lineage === 'first')).toBe(false)
	})

	test('a refused save is reported on store:persistence-error with code SNAPSHOT_SUPERSEDED', async () => {
		const oldWorker = new BrowserWorkerSim()
		const a = new IndexedDbAdapter({ bridge: oldWorker, dbName: DB, persistenceDebounceMs: 60_000 })
		await a.open(minimalSchema)
		const emitter = new SimpleEventEmitter()
		const errors: Array<{ code: string }> = []
		emitter.on('store:persistence-error', (event) => errors.push(event))
		const link = new SlowFollowerLink(oldWorker)
		const b = new IndexedDbAdapter({
			bridge: link,
			dbName: DB,
			persistenceDebounceMs: 60_000,
			emitter,
		})
		await b.open(minimalSchema)
		link.arm()
		const flush = b.flushPersistence()
		await link.commitReached
		abandon(a)
		const c = new IndexedDbAdapter({
			bridge: new BrowserWorkerSim(),
			dbName: DB,
			persistenceDebounceMs: 60_000,
		})
		await c.open(minimalSchema)
		link.releaseCommit()
		await flush
		expect(errors.map((event) => event.code)).toContain(SNAPSHOT_SUPERSEDED)
		abandon(b)
		abandon(c)
	})

	test('a lineage started before the database was deleted can never save over a recreated one', async () => {
		const worker = new BrowserWorkerSim()
		const stale = new IndexedDbAdapter({
			bridge: worker,
			dbName: DB,
			persistenceDebounceMs: 60_000,
		})
		await stale.open(minimalSchema)
		await insert(stale, 'deleted')
		await stale.ensureDurable()
		await insert(stale, 'deleted-later')

		await deleteFromIndexedDB(DB)
		// The stale tab (suspended through the delete) resumes and flushes: refused.
		await expect(stale.ensureDurable()).rejects.toMatchObject({
			context: { code: SNAPSHOT_SUPERSEDED },
		})
		expect((await loadSnapshotFromIndexedDB(DB)).dump).toBeNull()

		// A recreated database outranks the stale lineage, whose saves stay refused.
		const fresh = new IndexedDbAdapter({
			bridge: new BrowserWorkerSim(),
			dbName: DB,
			persistenceDebounceMs: 60_000,
		})
		await fresh.open(minimalSchema)
		await insert(fresh, 'recreated')
		await fresh.ensureDurable()
		await insert(stale, 'deleted-again')
		await expect(stale.ensureDurable()).rejects.toMatchObject({
			context: { code: SNAPSHOT_SUPERSEDED },
		})
		abandon(stale)
		abandon(fresh)
		expect(await reopenIds()).toEqual(['recreated'])
	})

	test('a stale save is refused, not silently dropped: it is reported as a persistence error', async () => {
		const started = await startSnapshotLineage(DB, 'a')
		const versionA = { epoch: started.epoch, lineage: 'a', seq: 5 }
		await saveSnapshotToIndexedDB(DB, { dump: { tables: [] }, data: null, version: versionA })
		await expect(
			saveSnapshotToIndexedDB(DB, {
				dump: { tables: [] },
				data: null,
				version: { epoch: started.epoch - 1, lineage: 'b', seq: 99 },
			}),
		).rejects.toMatchObject({ context: { code: SNAPSHOT_SUPERSEDED } })
		await expect(
			saveSnapshotToIndexedDB(DB, {
				dump: { tables: [] },
				data: null,
				version: { ...versionA, seq: 4 },
			}),
		).resolves.toMatchObject({ outcome: 'covered' })
		expect((await loadSnapshotFromIndexedDB(DB)).version).toEqual(versionA)
	})
})

describe('IndexedDB fallback: a write and its count never split across worker databases', () => {
	const cleanups: Array<() => void> = []
	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) cleanup()
		vi.unstubAllGlobals()
		await deleteFromIndexedDB(DB).catch(() => {})
	})

	/**
	 * A leader change between two requests of a follower, through the real multi-tab path
	 * (follower bridge -> BroadcastChannel relay -> transaction serializer -> worker): tab A
	 * leads on worker 1 and dies; tab C is promoted on worker 2 (restored from IndexedDB)
	 * and its relay answers the channel; follower B keeps the same bridge, and its request
	 * matching `id` was the last one worker 1 answered.
	 */
	async function leaderChangeAfter(id: string): Promise<{
		b: IndexedDbAdapter
		c: IndexedDbAdapter
	}> {
		MockBroadcastChannel.channels.clear()
		vi.stubGlobal('BroadcastChannel', MockBroadcastChannel)
		const channel = `kora-storage-${DB}`
		const oldWorker = new TransactionSerializingWorkerBridge(new BrowserWorkerSim())
		cleanups.push(() => oldWorker.terminate())
		const stopOld = startLeaderRpcRelay(channel, oldWorker)
		const a = new IndexedDbAdapter({ bridge: oldWorker, dbName: DB, persistenceDebounceMs: 60_000 })
		await a.open(minimalSchema)
		await insert(a, 'base')
		await a.ensureDurable()
		const follower = new HandoverFollower(new FollowerBroadcastBridge(channel, 5000))
		cleanups.push(() => follower.terminate())
		const b = new IndexedDbAdapter({ bridge: follower, dbName: DB, persistenceDebounceMs: 60_000 })
		await b.open(minimalSchema)
		abandon(a)
		const newWorker = new TransactionSerializingWorkerBridge(new BrowserWorkerSim())
		cleanups.push(() => newWorker.terminate())
		const c = new IndexedDbAdapter({ bridge: newWorker, dbName: DB, persistenceDebounceMs: 60_000 })
		await c.open(minimalSchema)
		follower.after(isInsertOf(id), () => {
			stopOld()
			cleanups.push(startLeaderRpcRelay(channel, newWorker))
		})
		return { b, c }
	}

	test("a follower's execute whose write ran on the replaced worker fails instead of being counted on the new one", async () => {
		const { b, c } = await leaderChangeAfter('b-split')
		// The write reached worker 1 only. It must not resolve as a write of worker 2's
		// database (whose snapshot never holds it): the caller is told to retry.
		await expect(insert(b, 'b-split')).rejects.toMatchObject({ code: 'BRIDGE_TERMINATED' })
		await expect(b.ensureDurable()).resolves.toBeUndefined()
		// Retried against the new leader, it is counted there and saved.
		await insert(b, 'b-split')
		await b.ensureDurable()
		abandon(b)
		abandon(c)
		expect(await reopenIds()).toEqual(['b-split', 'base'])
	})

	test("a follower's transaction split by a leader change commits nothing on the new worker", async () => {
		const { b, c } = await leaderChangeAfter('tx-first')
		await expect(
			b.transaction(async (tx) => {
				for (const id of ['tx-first', 'tx-second']) {
					await tx.execute(
						'INSERT INTO todos (id, title, completed, _created_at, _updated_at) VALUES (?, ?, ?, ?, ?)',
						[id, id, 0, 1, 1],
					)
				}
			}),
		).rejects.toMatchObject({ code: 'BRIDGE_TERMINATED' })
		// No fragment of the span ran as autocommits on the new leader's database.
		const rows = await c.query<{ id: string }>('SELECT id FROM todos ORDER BY id')
		expect(rows.map((row) => row.id)).toEqual(['base'])
		abandon(b)
		abandon(c)
	})
})

describe('IndexedDB fallback: opening and deleting write nothing but the version records', () => {
	afterEach(async () => {
		vi.restoreAllMocks()
		await deleteFromIndexedDB(DB).catch(() => {})
	})

	test('a full origin cannot make a database impossible to open: opening writes no copy of the data', async () => {
		const first = new IndexedDbAdapter({
			bridge: new BrowserWorkerSim(),
			dbName: DB,
			persistenceDebounceMs: 60_000,
		})
		await first.open(minimalSchema)
		await insert(first, 'kept')
		await first.ensureDurable()
		abandon(first)
		const original = IDBObjectStore.prototype.put
		vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
			this: IDBObjectStore,
			...args: Parameters<IDBObjectStore['put']>
		) {
			const [value] = args
			if (
				value instanceof Uint8Array ||
				(typeof value === 'object' && value && 'tables' in value)
			) {
				throw new DOMException('quota', 'QuotaExceededError')
			}
			return original.apply(this, args)
		})
		expect(await reopenIds()).toEqual(['kept'])
	})

	test('a lineage that replaces the data (the OPFS copy carried over) never vouches for writes of the stored snapshot it did not restore', async () => {
		const started = await startSnapshotLineage(DB, 'idb-copy')
		await saveSnapshotToIndexedDB(DB, {
			dump: { tables: [] },
			data: null,
			version: { epoch: started.epoch, lineage: 'idb-copy', seq: 3 },
		})
		await startSnapshotLineage(DB, 'from-opfs', 'replace')
		// A tab whose write was counted at seq 4 in the IndexedDB copy saves late: refused, and
		// the stored ancestry does not claim that copy, so its writes are reported lost instead
		// of being treated as carried over.
		await expect(
			saveSnapshotToIndexedDB(DB, {
				dump: { tables: [] },
				data: null,
				version: { epoch: started.epoch, lineage: 'idb-copy', seq: 4 },
			}),
		).rejects.toMatchObject({ context: { code: SNAPSHOT_SUPERSEDED, storedAncestors: [] } })
	})

	test('deleting the database removes everything but the epoch counter and writes nothing', async () => {
		const adapter = new IndexedDbAdapter({
			bridge: new BrowserWorkerSim(true),
			dbName: DB,
			persistenceDebounceMs: 60_000,
		})
		await adapter.open(minimalSchema)
		await insert(adapter, 'gone')
		await adapter.ensureDurable()
		abandon(adapter)
		const puts = vi.spyOn(IDBObjectStore.prototype, 'put')
		await deleteFromIndexedDB(DB)
		expect(puts).not.toHaveBeenCalled()
		expect(await storedKeys()).toEqual([`${DB}::epoch`])
	})
})

/** Every key of the persistence store (the IndexedDB fallback's whole state). */
async function storedKeys(): Promise<string[]> {
	const db = await new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open('kora-persistence', 1)
		request.onsuccess = () => resolve(request.result)
		request.onerror = () => reject(request.error)
	})
	try {
		return await new Promise<string[]>((resolve, reject) => {
			const request = db.transaction('databases').objectStore('databases').getAllKeys()
			request.onsuccess = () => resolve(request.result.map(String))
			request.onerror = () => reject(request.error)
		})
	} finally {
		db.close()
	}
}

describe('compareSnapshotVersions', () => {
	const stored = { epoch: 3, lineage: 'x', seq: 10 }
	test.each([
		['nothing versioned stored (deleted after this lineage started)', null, stored, 'superseded'],
		[
			'same lineage, first save over its fence',
			{ ...stored, seq: -1 },
			{ ...stored, seq: 0 },
			'write',
		],
		['same lineage, more commits', stored, { ...stored, seq: 11 }, 'write'],
		['same lineage, same commits', stored, stored, 'covered'],
		['same lineage, fewer commits', stored, { ...stored, seq: 9 }, 'covered'],
		['newer lineage, fewer commits', stored, { epoch: 4, lineage: 'y', seq: 0 }, 'write'],
		['older lineage, more commits', stored, { epoch: 2, lineage: 'w', seq: 500 }, 'superseded'],
		['same epoch, another lineage', stored, { epoch: 3, lineage: 'z', seq: 500 }, 'superseded'],
	] as const)('%s', (_label, before, incoming, expected) => {
		expect(compareSnapshotVersions(before, incoming)).toBe(expected)
	})
})

describe('IndexedDB fallback: snapshots stored before versions were recorded', () => {
	afterEach(async () => {
		await deleteFromIndexedDB(DB).catch(() => {})
	})

	/** The layout earlier releases wrote: dump and image keys, no version key. */
	async function writeLegacySnapshot(supportsExport: boolean): Promise<void> {
		const source = new IndexedDbAdapter({
			bridge: new BrowserWorkerSim(supportsExport),
			dbName: DB,
			persistenceDebounceMs: 60_000,
		})
		await source.open(minimalSchema)
		await insert(source, 'legacy')
		await source.flushPersistence()
		abandon(source)
		const { dump, data } = await loadSnapshotFromIndexedDB<unknown>(DB)
		await deleteFromIndexedDB(DB)
		await saveDumpToIndexedDB(DB, dump)
		if (data) await saveToIndexedDB(DB, data)
		expect((await loadSnapshotFromIndexedDB(DB)).version).toBeNull()
	}

	for (const supportsExport of [false, true]) {
		const label = supportsExport ? 'binary snapshot and JSON dump' : 'JSON dump only'

		test(`an unversioned snapshot loads, and the next save replaces it with a versioned one (${label})`, async () => {
			await writeLegacySnapshot(supportsExport)
			const adapter = new IndexedDbAdapter({
				bridge: new BrowserWorkerSim(supportsExport),
				dbName: DB,
				persistenceDebounceMs: 60_000,
			})
			await adapter.open(minimalSchema)
			expect(
				(await adapter.query<{ id: string }>('SELECT id FROM todos')).map((row) => row.id),
			).toEqual(['legacy'])
			await insert(adapter, 'after-upgrade')
			await adapter.ensureDurable()
			abandon(adapter)
			expect((await loadSnapshotFromIndexedDB(DB)).version).not.toBeNull()
			expect(await reloadIds(supportsExport)).toEqual(['after-upgrade', 'legacy'])
		})
	}

	test('a worker database opened by an earlier build (no snapshot state) is still saved', async () => {
		// A tab running an earlier build leads: its worker database has no snapshot state.
		const worker = new BrowserWorkerSim()
		const legacyLeader = new IndexedDbAdapter({
			bridge: worker,
			dbName: DB,
			persistenceDebounceMs: 60_000,
		})
		await legacyLeader.open(minimalSchema)
		await insert(legacyLeader, 'legacy-leader')
		await worker.send({
			id: 0,
			type: 'execute',
			sql: 'DROP TABLE temp._kora_idb_snapshot_state',
		})
		abandon(legacyLeader)

		const follower = new IndexedDbAdapter({
			bridge: worker,
			dbName: DB,
			persistenceDebounceMs: 60_000,
		})
		await follower.open(minimalSchema)
		await insert(follower, 'follower')
		await follower.ensureDurable()
		abandon(follower)
		expect(await reloadIds(false)).toEqual(['follower', 'legacy-leader'])
	})
})

/**
 * Abort a readwrite transaction right after its last write (the `::version` put) succeeded,
 * with no request pending: only `abort` fires, as when the commit itself fails (a quota
 * failure while writing the data to disk).
 */
function abortEveryReadwriteTransaction(): { restore(): void } {
	const original = IDBObjectStore.prototype.put
	const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
		this: IDBObjectStore,
		...args: Parameters<IDBObjectStore['put']>
	) {
		const request = original.apply(this, args)
		if (String(args[1]).endsWith('::version')) {
			const tx = this.transaction
			request.addEventListener('success', () => tx.abort())
		}
		return request
	})
	return { restore: () => spy.mockRestore() }
}

describe('IndexedDB snapshot transactions that abort', () => {
	afterEach(async () => {
		vi.restoreAllMocks()
		await deleteFromIndexedDB(DB).catch(() => {})
	})

	test('an aborted lineage start or snapshot save rejects with a PersistenceError instead of hanging', async () => {
		const aborting = abortEveryReadwriteTransaction()
		await expect(startSnapshotLineage(DB, 'x')).rejects.toBeInstanceOf(PersistenceError)
		await expect(
			saveSnapshotToIndexedDB(DB, {
				dump: { tables: [] },
				data: null,
				version: { epoch: 1, lineage: 'x', seq: 0 },
			}),
		).rejects.toBeInstanceOf(PersistenceError)
		aborting.restore()
	})

	test('ensureDurable rejects when the snapshot transaction aborts, and later barriers still settle', async () => {
		const adapter = new IndexedDbAdapter({
			bridge: new BrowserWorkerSim(),
			dbName: DB,
			persistenceDebounceMs: 60_000,
		})
		await adapter.open(minimalSchema)
		await insert(adapter, 'a')
		const aborting = abortEveryReadwriteTransaction()
		await expect(adapter.ensureDurable()).rejects.toBeInstanceOf(PersistenceError)
		aborting.restore()
		await expect(adapter.ensureDurable()).resolves.toBeUndefined()
		abandon(adapter)
		expect(await reloadIds()).toEqual(['a'])
	})
})
