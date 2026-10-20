import 'fake-indexeddb/auto'
import { afterEach, describe, expect, test } from 'vitest'
import { minimalSchema } from '../../tests/fixtures/test-schema'
import { PersistenceError } from '../errors'
import { IndexedDbAdapter } from './indexeddb-adapter'
import type { WorkerBridge, WorkerRequest, WorkerResponse } from './sqlite-wasm-channel'
import { MockWorkerBridge } from './sqlite-wasm-mock-bridge'
import {
	compareSnapshotVersions,
	deleteFromIndexedDB,
	loadSnapshotFromIndexedDB,
	saveDumpToIndexedDB,
	saveSnapshotToIndexedDB,
	saveToIndexedDB,
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
		if (request.type === 'commit' && this.armed) {
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

/** A reload: a fresh worker database restored from what IndexedDB holds. */
async function reloadIds(supportsExport: boolean): Promise<string[]> {
	const reloaded = new IndexedDbAdapter({
		bridge: new BrowserWorkerSim(supportsExport),
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

			// The follower's snapshot export commits in the worker (it sees only 'first'),
			// then its response is delayed.
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

	test('a stale save is refused, not silently dropped: it is reported as a persistence error', async () => {
		const versionA = { epoch: 2, lineage: 'a', seq: 5 }
		await saveSnapshotToIndexedDB(DB, { dump: { tables: [] }, data: null, version: versionA })
		await expect(
			saveSnapshotToIndexedDB(DB, {
				dump: { tables: [] },
				data: null,
				version: { epoch: 1, lineage: 'b', seq: 99 },
			}),
		).rejects.toThrow(PersistenceError)
		await expect(
			saveSnapshotToIndexedDB(DB, {
				dump: { tables: [] },
				data: null,
				version: { ...versionA, seq: 4 },
			}),
		).resolves.toBe('covered')
		expect((await loadSnapshotFromIndexedDB(DB)).version).toEqual(versionA)
	})
})

describe('compareSnapshotVersions', () => {
	const stored = { epoch: 3, lineage: 'x', seq: 10 }
	test.each([
		['nothing versioned stored (first save, or a pre-upgrade snapshot)', null, stored, 'write'],
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
