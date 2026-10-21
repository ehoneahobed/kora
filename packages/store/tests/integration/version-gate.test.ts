import 'fake-indexeddb/auto'
import { type KoraEvent, defineSchema, t } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { IndexedDbAdapter } from '../../src/adapters/indexeddb-adapter'
import { SqliteWasmAdapter } from '../../src/adapters/sqlite-wasm-adapter'
import {
	SNAPSHOT_SUPERSEDED,
	startSnapshotLineage,
} from '../../src/adapters/sqlite-wasm-persistence'
import { BuildSupersededError, PersistenceError, StorageFormatAheadError } from '../../src/errors'
import { Store } from '../../src/index'
import { VersionGate } from '../../src/multi-tab/version-gate'
import type { StorageAdapter } from '../../src/types'
import {
	MockBroadcastChannel,
	MockLockManager,
	MockSqliteWorker,
	createOpenSeqCounter,
	flushMicrotasks,
	waitUntil,
} from '../fixtures/browser-sim'

/**
 * Version gate end to end on the browser storage paths (docs/design/version-gate.md,
 * section 10): tabs are adapters + stores sharing mock Web Locks, BroadcastChannels and
 * SQLite workers (one OPFS file per database; the IndexedDB fallback's workers each hold
 * an in-memory database restored from fake IndexedDB).
 */

const schema = defineSchema({
	version: 1,
	collections: {
		todos: { fields: { title: t.string(), done: t.boolean().default(false) } },
	},
})

let locks: MockLockManager
let allocate: (dbName: string) => Promise<number>
let dbCounter = 0

interface Tab {
	name: string
	gate: VersionGate
	adapter: StorageAdapter
	store: Store
	events: KoraEvent[]
}

function newGate(
	build: string,
	name: string,
	dbName: string,
	emitter: SimpleEventEmitter,
): VersionGate {
	return new VersionGate({
		dbName,
		build,
		emitter,
		runtime: {
			browser: true,
			locks,
			createChannel: (channel) => new MockBroadcastChannel(channel, name),
		},
		allocateOpenSeq: allocate,
		tabId: name,
		heartbeatMs: 5,
		waitingReportMs: 1,
		retryBackoffMs: { initial: 5, max: 5 },
	})
}

function recorder(): { emitter: SimpleEventEmitter; events: KoraEvent[] } {
	const emitter = new SimpleEventEmitter()
	const events: KoraEvent[] = []
	const emit = emitter.emit.bind(emitter)
	emitter.emit = ((event: KoraEvent) => {
		events.push(event)
		emit(event as never)
	}) as typeof emitter.emit
	return { emitter, events }
}

function opfsTab(build: string, name: string, dbName: string): Tab {
	const { emitter, events } = recorder()
	const gate = newGate(build, name, dbName, emitter)
	const adapter = new SqliteWasmAdapter({
		dbName,
		workerUrl: `/worker-${build}.js`,
		versionGate: gate,
		emitter,
	})
	const store = new Store({ schema, adapter, dbName, nodeId: `node-${name}`, emitter })
	return { name, gate, adapter, store, events }
}

function idbTab(build: string, name: string, dbName: string): Tab & { adapter: IndexedDbAdapter } {
	const { emitter, events } = recorder()
	const gate = newGate(build, name, dbName, emitter)
	const adapter = new IndexedDbAdapter({
		dbName,
		workerUrl: `/worker-${build}.js`,
		versionGate: gate,
		emitter,
		// Long debounce: nothing is saved unless a flush or barrier asks for it.
		persistenceDebounceMs: 60_000,
	})
	const store = new Store({ schema, adapter, dbName, nodeId: `node-${name}`, emitter })
	return { name, gate, adapter, store, events }
}

async function titles(store: Store): Promise<string[]> {
	const rows = await store.collection('todos').where({}).exec()
	return rows.map((row) => String(row.title)).sort()
}

function posted(type: string): number {
	return MockBroadcastChannel.posted.filter(
		(entry) => (entry.data as { type?: string })?.type === type,
	).length
}

beforeEach(() => {
	locks = new MockLockManager()
	allocate = createOpenSeqCounter()
	dbCounter += 1
	MockBroadcastChannel.reset()
	MockSqliteWorker.reset()
	vi.stubGlobal('navigator', { locks })
	vi.stubGlobal('BroadcastChannel', MockBroadcastChannel)
	vi.stubGlobal('Worker', MockSqliteWorker)
	let id = 0
	vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(
		() => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
	)
})

afterEach(() => {
	vi.unstubAllGlobals()
	vi.restoreAllMocks()
})

describe('OPFS (one database file, leader worker)', () => {
	test('old leader + new tab: the new tab leads its own worker; no request of the new build reaches the old one', async () => {
		const dbName = `vg-opfs-${dbCounter}`
		const old = opfsTab('A', 'old', dbName)
		await old.store.open()
		await old.store.collection('todos').insert({ title: 'before deploy' })

		const fresh = opfsTab('B', 'new', dbName)
		await fresh.store.open()

		expect(old.gate.getState()).toBe('retired')
		expect((fresh.adapter as SqliteWasmAdapter).isLeader()).toBe(true)
		// The old worker served only the old tab: one open, all before it was terminated.
		const oldWorkers = MockSqliteWorker.created.filter((worker) => worker.url === '/worker-A.js')
		expect(oldWorkers).toHaveLength(1)
		expect(oldWorkers[0]?.terminated).toBe(true)
		expect(
			MockSqliteWorker.log.filter((entry) => entry.url === '/worker-A.js' && entry.type === 'open'),
		).toHaveLength(1)
		expect(MockSqliteWorker.created.filter((worker) => worker.url === '/worker-B.js')).toHaveLength(
			1,
		)

		expect(await titles(fresh.store)).toEqual(['before deploy'])
		await expect(old.store.collection('todos').insert({ title: 'late' })).rejects.toBeInstanceOf(
			BuildSupersededError,
		)
		await expect(old.store.collection('todos').insert({ title: 'late' })).rejects.toMatchObject({
			code: 'BUILD_SUPERSEDED',
			collection: 'todos',
			operation: 'insert',
		})
		// Reads keep working, through the new build's leader.
		expect(await titles(old.store)).toEqual(['before deploy'])
		expect(await titles(fresh.store)).toEqual(['before deploy'])
		await fresh.store.close()
		await old.store.close()
	})

	test('old leader + old follower whose lock request is first in the queue: the follower never starts an old worker', async () => {
		const dbName = `vg-opfs-${dbCounter}`
		const leader = opfsTab('A', 'leader', dbName)
		await leader.store.open()
		const follower = opfsTab('A', 'follower', dbName)
		await follower.store.open()
		expect((follower.adapter as SqliteWasmAdapter).isLeader()).toBe(false)
		await follower.store.collection('todos').insert({ title: 'from follower' })

		// Neither old tab processes the new tab's hello yet.
		MockBroadcastChannel.hold('leader')
		MockBroadcastChannel.hold('follower')
		const fresh = opfsTab('B', 'new', dbName)
		const opening = fresh.store.open()
		await waitUntil(() => fresh.gate.getState() === 'waiting', 'new tab waiting')

		// The leader tab closes: the follower's queued request is granted the leader lock.
		await leader.store.close()
		await opening

		expect(follower.gate.getState()).toBe('retired')
		expect(MockSqliteWorker.created.filter((worker) => worker.url === '/worker-A.js')).toHaveLength(
			1,
		)
		expect((fresh.adapter as SqliteWasmAdapter).isLeader()).toBe(true)
		expect(await titles(fresh.store)).toEqual(['from follower'])
		MockBroadcastChannel.release('leader')
		MockBroadcastChannel.release('follower')
		await fresh.store.close()
		await follower.store.close()
	})

	test('a follower of the old build retires with its leader; the leader waits for it', async () => {
		const dbName = `vg-opfs-${dbCounter}`
		const leader = opfsTab('A', 'leader', dbName)
		await leader.store.open()
		const follower = opfsTab('A', 'follower', dbName)
		await follower.store.open()
		const fresh = opfsTab('B', 'new', dbName)
		await fresh.store.open()
		expect(leader.gate.getState()).toBe('retired')
		expect(follower.gate.getState()).toBe('retired')
		await expect(follower.store.collection('todos').insert({ title: 'x' })).rejects.toBeInstanceOf(
			BuildSupersededError,
		)
		await fresh.store.collection('todos').insert({ title: 'new build' })
		expect(await titles(follower.store)).toEqual(['new build'])
		await fresh.store.close()
	})

	test('a tab of the same build joins as a follower: no retirement', async () => {
		const dbName = `vg-opfs-${dbCounter}`
		const one = opfsTab('A', 'one', dbName)
		await one.store.open()
		const two = opfsTab('A', 'two', dbName)
		await two.store.open()
		await two.store.collection('todos').insert({ title: 'shared' })
		expect(await titles(one.store)).toEqual(['shared'])
		expect(one.gate.getState()).toBe('open')
		expect(two.gate.getState()).toBe('open')
		await two.store.close()
		await one.store.close()
	})

	test('closing an app whose open waits on the gate fails that open; it never opens storage', async () => {
		const dbName = `vg-opfs-${dbCounter}`
		const old = opfsTab('A', 'old', dbName)
		await old.store.open()
		MockBroadcastChannel.hold('old')
		const fresh = opfsTab('B', 'new', dbName)
		const opening = fresh.store.open()
		await waitUntil(() => fresh.gate.getState() === 'waiting', 'new tab waiting')
		await fresh.adapter.close()
		await expect(opening).rejects.toMatchObject({ code: 'VERSION_GATE_CLOSED' })
		expect(MockSqliteWorker.created.filter((worker) => worker.url === '/worker-B.js')).toHaveLength(
			0,
		)
		MockBroadcastChannel.release('old')
		await old.store.close()
	})

	test('the leader heartbeat carries the leader identity', async () => {
		const dbName = `vg-opfs-${dbCounter}`
		const one = opfsTab('A', 'one', dbName)
		await one.store.open()
		const serve = MockSqliteWorker.log.find((entry) => entry.type === 'serve')
		expect(serve).toBeDefined()
		expect(locks.heldNames()).toContain(`kora-gated-leader-${dbName}`)
		await one.store.close()
		expect(locks.heldNames()).toEqual([])
	})
})

describe('IndexedDB fallback (snapshots)', () => {
	test('old leader + new tab: the queued snapshot is flushed, later writes are refused, a reload holds every confirmed write', async () => {
		const dbName = `vg-idb-${dbCounter}`
		const old = idbTab('A', 'old', dbName)
		await old.store.open()
		await old.store.collection('todos').insert({ title: 'old confirmed' })
		expect(old.adapter.getVersionGate()?.getState()).toBe('open')

		const fresh = idbTab('B', 'new', dbName)
		await fresh.store.open()
		expect(old.gate.getState()).toBe('retired')
		// The new tab restored the snapshot the old tab flushed while retiring.
		expect(await titles(fresh.store)).toEqual(['old confirmed'])
		await expect(old.store.collection('todos').insert({ title: 'late' })).rejects.toBeInstanceOf(
			BuildSupersededError,
		)
		await fresh.store.collection('todos').insert({ title: 'new confirmed' })
		await fresh.store.close()

		const reload = idbTab('B', 'reload', dbName)
		await reload.store.open()
		expect(await titles(reload.store)).toEqual(['new confirmed', 'old confirmed'])
		await reload.store.close()
	})

	test('a non-transactional insert started before retirement: retirement waits; it is in the snapshot; nothing resolves after kora-build-retired', async () => {
		const dbName = `vg-idb-${dbCounter}`
		const old = idbTab('A', 'old', dbName)
		await old.store.open()

		let releaseCommit: () => void = () => {}
		let commitHeld = false
		MockSqliteWorker.intercept = (worker, request) => {
			if (worker.url === '/worker-A.js' && request.type === 'commit' && !commitHeld) {
				commitHeld = true
				return new Promise<void>((resolve) => {
					releaseCommit = resolve
				})
			}
		}
		let resolvedAfterRetired: boolean | null = null
		const insert = old.store
			.collection('todos')
			.insert({ title: 'in flight' })
			.then(() => {
				resolvedAfterRetired = posted('kora-build-retired') > 0
			})
		await waitUntil(() => commitHeld, 'commit held')

		const fresh = idbTab('B', 'new', dbName)
		const opening = fresh.store.open()
		await waitUntil(() => old.gate.getState() === 'retiring', 'old tab retiring')
		await flushMicrotasks(200)
		expect(posted('kora-build-retired')).toBe(0)
		expect(fresh.gate.getState()).toBe('waiting')
		// Writes started after the announcement are refused; the one in flight is not.
		await expect(old.store.collection('todos').insert({ title: 'refused' })).rejects.toBeInstanceOf(
			BuildSupersededError,
		)

		releaseCommit()
		await insert
		await opening
		expect(resolvedAfterRetired).toBe(false)
		expect(await titles(fresh.store)).toEqual(['in flight'])
		await fresh.store.close()
	})

	test('a failed durability barrier keeps the gate closed until a retry succeeds; SNAPSHOT_SUPERSEDED does not', async () => {
		const dbName = `vg-idb-${dbCounter}`
		const old = idbTab('A', 'old', dbName)
		await old.store.open()
		await old.store.collection('todos').insert({ title: 'unsaved' })

		let quotaFull = true
		const realBarrier = old.adapter.ensureDurable.bind(old.adapter)
		vi.spyOn(old.adapter, 'ensureDurable').mockImplementation(async () => {
			if (quotaFull) {
				throw new PersistenceError('QuotaExceededError: storage is full', { quotaExceeded: true })
			}
			return realBarrier()
		})

		const fresh = idbTab('B', 'new', dbName)
		const opening = fresh.store.open()
		await waitUntil(() => old.gate.snapshot().unsaved, 'old tab reports unsaved writes')
		await waitUntil(
			() =>
				fresh.events.some(
					(event) => event.type === 'store:build-gate-waiting' && event.reason === 'unsaved-writes',
				),
			'new tab reports unsaved-writes',
		)
		expect(
			old.events.some(
				(event) => event.type === 'store:persistence-error' && event.code === 'QUOTA_EXCEEDED',
			),
		).toBe(true)
		// Several retries later the tab lock is still held.
		await new Promise((resolve) => setTimeout(resolve, 30))
		expect(fresh.gate.getState()).toBe('waiting')
		expect(old.gate.getState()).toBe('retiring')
		// The explicit recovery path: the in-memory database as a dump.
		const dump = (await old.gate.exportRecoveryDump()) as { tables: Array<{ name: string }> }
		expect(dump.tables.some((table) => table.name === 'todos')).toBe(true)

		quotaFull = false
		old.gate.retryNow()
		await opening
		expect(old.gate.snapshot().unsaved).toBe(false)
		expect(await titles(fresh.store)).toEqual(['unsaved'])
		await fresh.store.close()

		// SNAPSHOT_SUPERSEDED: the writes already rejected; retirement continues.
		const db2 = `${dbName}-superseded`
		const older = idbTab('A', 'older', db2)
		await older.store.open()
		vi.spyOn(older.adapter, 'ensureDurable').mockRejectedValue(
			new PersistenceError('replaced', { code: SNAPSHOT_SUPERSEDED }),
		)
		const newer = idbTab('B', 'newer', db2)
		await newer.store.open()
		expect(older.gate.getState()).toBe('retired')
		await newer.store.close()
	})

	test('pagehide with a write inside the debounce: the tab lock is released only after the snapshot holding it is stored', async () => {
		const dbName = `vg-idb-${dbCounter}`
		const old = idbTab('A', 'old', dbName)
		await old.store.open()
		await old.store.collection('todos').insert({ title: 'debounced' })

		// The page freezes while its snapshot export is still running.
		let releaseExport: () => void = () => {}
		let exportHeld = false
		MockSqliteWorker.intercept = (worker, request) => {
			if (worker.url === '/worker-A.js' && request.type === 'begin' && !exportHeld) {
				exportHeld = true
				return new Promise<void>((resolve) => {
					releaseExport = resolve
				})
			}
		}
		await old.adapter.handleLifecycleEvent('freeze')
		await waitUntil(() => exportHeld, 'snapshot started')
		// A frozen page processes no messages.
		MockBroadcastChannel.hold('old')

		const fresh = idbTab('B', 'new', dbName)
		const opening = fresh.store.open()
		await waitUntil(
			() =>
				fresh.events.some(
					(event) => event.type === 'store:build-gate-waiting' && event.reason === 'unsaved-writes',
				),
			'new tab waits on unsaved writes',
		)
		expect(old.gate.getState()).toBe('open')

		releaseExport() // the old tab resumes long enough to finish its snapshot
		await opening
		expect(old.gate.getState()).toBe('suspended')
		expect(await titles(fresh.store)).toEqual(['debounced'])
		MockBroadcastChannel.release('old')

		// Back from the cache: discovery finds the newer build, the tab retires.
		await old.adapter.handleLifecycleEvent('resume')
		await waitUntil(() => old.gate.getState() === 'retired', 'old tab retired on resume')
		await expect(old.store.collection('todos').insert({ title: 'x' })).rejects.toBeInstanceOf(
			BuildSupersededError,
		)
		await fresh.store.close()
	})

	test('a clean tab releases at once on freeze', async () => {
		const dbName = `vg-idb-${dbCounter}`
		const one = idbTab('A', 'one', dbName)
		await one.store.open()
		await one.store.collection('todos').insert({ title: 'saved' })
		await one.adapter.flushPersistence()
		await one.adapter.handleLifecycleEvent('freeze')
		expect(one.gate.getState()).toBe('suspended')
		await one.adapter.handleLifecycleEvent('resume')
		await waitUntil(() => one.gate.getState() === 'open', 'reopened')
		expect(await titles(one.store)).toEqual(['saved'])
		await one.store.close()
	})
})

describe('storage format', () => {
	test('OPFS: a stored format newer than the code refuses the open, writes nothing', async () => {
		const dbName = `vg-format-${dbCounter}`
		const first = opfsTab('A', 'first', dbName)
		await first.store.open()
		await first.adapter.execute("UPDATE _kora_meta SET value = '2' WHERE key = 'storage_format'")
		await first.store.close()
		const before = MockSqliteWorker.fileFor(dbName)
		const rows = await before.send({
			id: 0,
			type: 'query',
			sql: 'SELECT COUNT(*) AS n FROM _kora_meta',
		})

		const later = opfsTab('A', 'later', dbName)
		const formatEvents: KoraEvent[] = later.events
		await expect(later.store.open()).rejects.toBeInstanceOf(StorageFormatAheadError)
		expect(formatEvents.some((event) => event.type === 'store:format-ahead')).toBe(true)
		const after = await before.send({
			id: 0,
			type: 'query',
			sql: 'SELECT COUNT(*) AS n FROM _kora_meta',
		})
		expect(after).toEqual(rows)
	})

	test('a new database stores format 1 once', async () => {
		const dbName = `vg-format-${dbCounter}`
		const tab = opfsTab('A', 'tab', dbName)
		await tab.store.open()
		const rows = await tab.adapter.query<{ value: string }>(
			"SELECT value FROM _kora_meta WHERE key = 'storage_format'",
		)
		expect(rows).toEqual([{ value: '1' }])
		await tab.store.close()
	})

	test('IndexedDB: a snapshot record of a newer format is refused before any fence is written', async () => {
		const dbName = `vg-format-idb-${dbCounter}`
		const tab = idbTab('A', 'tab', dbName)
		await tab.store.open()
		await tab.store.collection('todos').insert({ title: 'kept' })
		await tab.store.close()
		// A build with format 2 opened it.
		const request = indexedDB.open('kora-persistence', 1)
		await new Promise<void>((resolve, reject) => {
			request.onsuccess = () => {
				const db = request.result
				const tx = db.transaction('databases', 'readwrite')
				const store = tx.objectStore('databases')
				const read = store.get(`${dbName}::version`)
				read.onsuccess = () => {
					store.put({ ...(read.result as object), format: 2 }, `${dbName}::version`)
				}
				tx.oncomplete = () => {
					db.close()
					resolve()
				}
				tx.onerror = () => reject(tx.error)
			}
			request.onerror = () => reject(request.error)
		})
		await expect(startSnapshotLineage(dbName, 'lineage-x')).rejects.toBeInstanceOf(
			StorageFormatAheadError,
		)
		const reopened = idbTab('A', 'reopened', dbName)
		await expect(reopened.store.open()).rejects.toBeInstanceOf(StorageFormatAheadError)
	})
})
