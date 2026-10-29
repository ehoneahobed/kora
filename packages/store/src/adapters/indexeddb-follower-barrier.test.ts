import 'fake-indexeddb/auto'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { minimalSchema } from '../../tests/fixtures/test-schema'
import { PersistenceError } from '../errors'
import {
	FollowerBroadcastBridge,
	TransactionSerializingWorkerBridge,
	startLeaderRpcRelay,
} from '../multi-tab/tab-storage'
import { Store } from '../store/store'
import type { DatabaseDump } from './database-dump'
import { IndexedDbAdapter } from './indexeddb-adapter'
import { storageChannelName } from './opfs-names'
import type { WorkerBridge, WorkerRequest, WorkerResponse } from './sqlite-wasm-channel'
import { MockWorkerBridge } from './sqlite-wasm-mock-bridge'
import {
	SNAPSHOT_SUPERSEDED,
	deleteFromIndexedDB,
	loadSnapshotFromIndexedDB,
} from './sqlite-wasm-persistence'

/**
 * A follower tab's durability barrier is answered by the LEADER tab: one request, one
 * strict snapshot taken by the leader's persistence scheduler (shared with every barrier
 * waiting there), instead of the follower exporting the leader's database itself.
 *
 * The tabs talk through the real code: IndexedDbAdapter -> FollowerBroadcastBridge ->
 * (in-process BroadcastChannel) -> leader relay and barrier server -> leader scheduler.
 */

const DB = 'idb-follower-barrier'
const CHANNEL = storageChannelName(DB)

/** The browser worker: one live database shared by tabs, `open` idempotent. */
class BrowserWorkerSim implements WorkerBridge {
	private readonly inner = new MockWorkerBridge()
	private opened = false
	async send(request: WorkerRequest): Promise<WorkerResponse> {
		if (request.type === 'open') {
			if (this.opened) return { id: request.id, type: 'success' }
			this.opened = true
		}
		if (request.type === 'export') {
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

interface Gate {
	readonly reached: Promise<void>
	release(): void
}

/** Methods of the adapter the tests observe or hold (private in the class). */
interface AdapterInternals {
	exportDump(readPoint?: () => void): Promise<{ dump: DatabaseDump; version: unknown }>
	scheduler: { dispose(): void }
	stopBarrierServer: (() => void) | null
}
const internals = (adapter: IndexedDbAdapter): AdapterInternals =>
	adapter as unknown as AdapterInternals

/**
 * Count the snapshots (exports) an adapter takes. With `holdNext`, the next export is
 * taken at once but its result is held back until released: the snapshot is "in flight",
 * and it holds only what was committed when it was taken.
 */
function watchExports(adapter: IndexedDbAdapter): {
	count(): number
	holdNext(): Gate
	/** Hold the next export BEFORE it reads the database: barriers arriving meanwhile are in it. */
	holdNextBeforeRead(): Gate
	failWith(error: Error | null): void
} {
	const target = internals(adapter)
	const original = target.exportDump.bind(adapter)
	let count = 0
	let held: { reached: () => void; released: Promise<void> } | null = null
	let heldBefore: { reached: () => void; released: Promise<void> } | null = null
	let failure: Error | null = null
	target.exportDump = async (readPoint) => {
		count += 1
		if (failure) throw failure
		const before = heldBefore
		if (before) {
			heldBefore = null
			before.reached()
			await before.released
		}
		const result = await original(readPoint)
		const hold = held
		if (hold) {
			held = null
			hold.reached()
			await hold.released
		}
		return result
	}
	return {
		count: () => count,
		failWith(error) {
			failure = error
		},
		holdNextBeforeRead() {
			let reached: () => void = () => {}
			let release: () => void = () => {}
			const reachedPromise = new Promise<void>((resolve) => {
				reached = resolve
			})
			const released = new Promise<void>((resolve) => {
				release = resolve
			})
			heldBefore = { reached, released }
			return { reached: reachedPromise, release }
		},
		holdNext() {
			let reached: () => void = () => {}
			let release: () => void = () => {}
			const reachedPromise = new Promise<void>((resolve) => {
				reached = resolve
			})
			const released = new Promise<void>((resolve) => {
				release = resolve
			})
			held = { reached, released }
			return { reached: reachedPromise, release }
		},
	}
}

const insert = (adapter: IndexedDbAdapter, id: string) =>
	adapter.execute(
		'INSERT INTO todos (id, title, completed, _created_at, _updated_at) VALUES (?, ?, ?, ?, ?)',
		[id, id, 0, 1, 1],
	)

/** What a reload would restore from the stored JSON dump. */
async function storedIds(): Promise<string[]> {
	const { dump } = await loadSnapshotFromIndexedDB<DatabaseDump>(DB)
	const todos = dump?.tables.find((table) => table.name === 'todos')
	return (todos?.rows ?? []).map((row) => String(row.id)).sort()
}

/** Settled state of a promise without waiting for it. */
function track<T>(promise: Promise<T>): { state: () => 'pending' | 'resolved' | 'rejected' } {
	let state: 'pending' | 'resolved' | 'rejected' = 'pending'
	promise.then(
		() => {
			state = 'resolved'
		},
		() => {
			state = 'rejected'
		},
	)
	return { state: () => state }
}

describe('IndexedDB fallback: a follower barrier is answered by the leader tab', () => {
	const cleanups: Array<() => void> = []

	beforeEach(() => {
		MockBroadcastChannel.channels.clear()
		vi.stubGlobal('BroadcastChannel', MockBroadcastChannel)
	})

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) cleanup()
		vi.useRealTimers()
		vi.unstubAllGlobals()
		await deleteFromIndexedDB(DB).catch(() => {})
	})

	/** Tab A leads (relay + barrier server); tab B follows it through the channel. */
	async function openTabs(
		options: { followerEmitter?: SimpleEventEmitter; heartbeatMs?: number } = {},
	): Promise<{
		leader: IndexedDbAdapter
		follower: IndexedDbAdapter
		followerBridge: FollowerBroadcastBridge
		killLeader(): void
	}> {
		const worker = new TransactionSerializingWorkerBridge(new BrowserWorkerSim())
		cleanups.push(() => worker.terminate())
		const stopRelay = startLeaderRpcRelay(CHANNEL, worker, {
			...(options.heartbeatMs ? { heartbeatMs: options.heartbeatMs } : {}),
		})
		const leader = new IndexedDbAdapter({
			bridge: worker,
			dbName: DB,
			persistenceDebounceMs: 60_000,
			snapshotBarrierChannel: CHANNEL,
		})
		await leader.open(minimalSchema)
		const followerBridge = new FollowerBroadcastBridge(CHANNEL, 5000, 20)
		cleanups.push(() => followerBridge.terminate())
		const follower = new IndexedDbAdapter({
			bridge: followerBridge,
			dbName: DB,
			persistenceDebounceMs: 60_000,
			...(options.followerEmitter ? { emitter: options.followerEmitter } : {}),
		})
		await follower.open(minimalSchema)
		return {
			leader,
			follower,
			followerBridge,
			// The leader tab is gone: no relay, no barrier server, no snapshot, no heartbeat.
			killLeader: () => {
				stopRelay()
				internals(leader).stopBarrierServer?.()
				internals(leader).scheduler.dispose()
			},
		}
	}

	test('resolves only after the leader saved a snapshot holding the write, and the follower exports nothing', async () => {
		const { leader, follower } = await openTabs()
		const leaderExports = watchExports(leader)
		const followerExports = watchExports(follower)
		await insert(follower, 'f1')

		const inFlight = leaderExports.holdNext()
		const barrier = follower.ensureDurable()
		const barrierState = track(barrier)
		await inFlight.reached
		// The leader took the snapshot but has not saved it: nothing is stored, and the
		// follower's write is not durable.
		expect(barrierState.state()).toBe('pending')
		expect(await storedIds()).toEqual([])

		inFlight.release()
		await barrier
		expect(await storedIds()).toEqual(['f1'])
		expect(leaderExports.count()).toBe(1)
		expect(followerExports.count()).toBe(0)
	})

	test('concurrent barriers of the leader and a follower share one snapshot taken after both writes', async () => {
		const { leader, follower } = await openTabs()
		const leaderExports = watchExports(leader)
		const followerExports = watchExports(follower)

		// A snapshot is in flight (the leader's first write), holding only 'l1'.
		await insert(leader, 'l1')
		const first = leaderExports.holdNext()
		const firstBarrier = leader.ensureDurable()
		await first.reached

		// Both a follower write and a second leader write commit and ask for durability
		// while it is in flight: neither is in it, so both wait for the NEXT snapshot.
		await insert(follower, 'f1')
		await insert(leader, 'l2')
		const followerBarrier = follower.ensureDurable()
		const leaderBarrier = leader.ensureDurable()
		const followerState = track(followerBarrier)
		const leaderState = track(leaderBarrier)
		first.release()
		await firstBarrier
		await Promise.all([followerBarrier, leaderBarrier])

		expect(followerState.state()).toBe('resolved')
		expect(leaderState.state()).toBe('resolved')
		// One snapshot for the first barrier, ONE more for the two that came after it.
		expect(leaderExports.count()).toBe(2)
		expect(followerExports.count()).toBe(0)
		expect(await storedIds()).toEqual(['f1', 'l1', 'l2'])
	})

	test('barriers of the leader and a follower that arrive before the snapshot reads the database share it', async () => {
		const { leader, follower } = await openTabs()
		const leaderExports = watchExports(leader)

		await insert(leader, 'l1')
		const pendingRead = leaderExports.holdNextBeforeRead()
		const leaderBarrier = leader.ensureDurable()
		await pendingRead.reached
		// The leader's snapshot started but has not read the database: the follower's write
		// and barrier, and a second leader write and barrier, all land before it reads.
		await insert(follower, 'f1')
		await insert(leader, 'l2')
		const barriers = [leaderBarrier, follower.ensureDurable(), leader.ensureDurable()]
		pendingRead.release()
		await Promise.all(barriers)

		expect(leaderExports.count()).toBe(1)
		expect(await storedIds()).toEqual(['f1', 'l1', 'l2'])
	})

	test('two followers with concurrent barriers share the leader snapshot', async () => {
		const { leader, follower } = await openTabs()
		const secondBridge = new FollowerBroadcastBridge(CHANNEL, 5000, 20)
		cleanups.push(() => secondBridge.terminate())
		const second = new IndexedDbAdapter({
			bridge: secondBridge,
			dbName: DB,
			persistenceDebounceMs: 60_000,
		})
		await second.open(minimalSchema)
		const leaderExports = watchExports(leader)

		await insert(leader, 'l1')
		const first = leaderExports.holdNext()
		const firstBarrier = leader.ensureDurable()
		await first.reached
		await insert(follower, 'a')
		await insert(second, 'b')
		const barriers = [follower.ensureDurable(), second.ensureDurable()]
		first.release()
		await firstBarrier
		await Promise.all(barriers)

		expect(leaderExports.count()).toBe(2)
		expect(await storedIds()).toEqual(['a', 'b', 'l1'])
	})

	test('a failed leader snapshot rejects the follower barrier and reports it, and a later barrier recovers', async () => {
		const emitter = new SimpleEventEmitter()
		const errors: Array<{ code?: string }> = []
		emitter.on('store:persistence-error', (event) => errors.push(event))
		const { leader, follower } = await openTabs({ followerEmitter: emitter })
		const leaderExports = watchExports(leader)
		await insert(follower, 'f1')

		leaderExports.failWith(new DOMException('storage is full', 'QuotaExceededError'))
		await expect(follower.ensureDurable()).rejects.toBeInstanceOf(PersistenceError)
		expect(errors.some((event) => event.code === 'QUOTA_EXCEEDED')).toBe(true)
		expect(await storedIds()).toEqual([])

		// The write was never rolled back: once the leader can save, the next barrier holds it.
		leaderExports.failWith(null)
		await expect(follower.ensureDurable()).resolves.toBeUndefined()
		expect(await storedIds()).toEqual(['f1'])
	})

	test('a follower write fails with WRITE_NOT_DURABLE when the leader snapshot fails', async () => {
		const { leader, follower } = await openTabs()
		const store = new Store({
			schema: minimalSchema,
			adapter: follower,
			nodeId: 'follower-store',
		})
		await store.open()
		const leaderExports = watchExports(leader)

		leaderExports.failWith(new DOMException('storage is full', 'QuotaExceededError'))
		await expect(
			store.collection('todos').insert({ title: 'kept in memory' }),
		).rejects.toMatchObject({ code: 'WRITE_NOT_DURABLE' })

		leaderExports.failWith(null)
		await expect(store.collection('todos').insert({ title: 'saved' })).resolves.toBeDefined()
		const titles = (await store.collection('todos').where({}).exec()).map((row) => row.title)
		expect(titles).toContain('kept in memory')
		await store.close()
	})

	test('a leader killed mid-barrier never leaves the follower hanging or falsely durable', async () => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
		const { leader, follower, killLeader } = await openTabs({ heartbeatMs: 20 })
		const leaderExports = watchExports(leader)
		await vi.advanceTimersByTimeAsync(20)
		await insert(follower, 'f-lost')

		// The leader takes the snapshot, then dies before it is saved.
		const inFlight = leaderExports.holdNext()
		const barrier = follower.ensureDurable()
		const outcome = barrier.then(
			() => 'resolved',
			(error: unknown) => error,
		)
		await inFlight.reached
		killLeader()

		// No leader answers the request or the fallback: the follower gives up on its
		// own (watchdog), and the barrier rejects instead of waiting forever.
		const state = track(outcome)
		for (let tick = 0; tick < 50 && state.state() === 'pending'; tick++) {
			await vi.advanceTimersByTimeAsync(20)
		}
		const result = await outcome
		expect(result).not.toBe('resolved')
		expect(result).toMatchObject({ code: expect.stringMatching(/NO_LEADER|LEADER_UNRESPONSIVE/) })
		expect(await storedIds()).toEqual([])
	})

	test('a leader replaced mid-barrier: the barrier is re-issued to the new leader and rejects for a write no snapshot held', async () => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
		const { leader, follower, killLeader } = await openTabs({ heartbeatMs: 20 })
		const leaderExports = watchExports(leader)
		await vi.advanceTimersByTimeAsync(20)
		await insert(follower, 'f-lost')

		const inFlight = leaderExports.holdNext()
		const barrier = follower.ensureDurable()
		const outcome = barrier.then(
			() => 'resolved',
			(error: unknown) => error,
		)
		await inFlight.reached
		killLeader()
		// Tab C takes over on a fresh worker restored from IndexedDB, which has no snapshot yet.
		const newWorker = new TransactionSerializingWorkerBridge(new BrowserWorkerSim())
		cleanups.push(() => newWorker.terminate())
		const successor = new IndexedDbAdapter({
			bridge: newWorker,
			dbName: DB,
			persistenceDebounceMs: 60_000,
			snapshotBarrierChannel: CHANNEL,
		})
		await successor.open(minimalSchema)
		// As in the browser, the new leader's worker serves other tabs only after it restored.
		cleanups.push(startLeaderRpcRelay(CHANNEL, newWorker, { heartbeatMs: 20 }))

		const state = track(outcome)
		for (let tick = 0; tick < 50 && state.state() === 'pending'; tick++) {
			await vi.advanceTimersByTimeAsync(20)
		}
		// The write lived only in the dead leader's database: lost, and reported as such.
		await expect(outcome).resolves.toMatchObject({
			context: expect.objectContaining({ code: SNAPSHOT_SUPERSEDED }),
		})
		expect(await storedIds()).toEqual([])
	})

	test('a leader replaced mid-barrier: the barrier resolves when a stored snapshot already held the write', async () => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
		const { leader, follower, killLeader } = await openTabs({ heartbeatMs: 20 })
		const leaderExports = watchExports(leader)
		await vi.advanceTimersByTimeAsync(20)
		await insert(follower, 'f-saved')
		// The leader's own debounced snapshot saved the write, unknown to the follower.
		await leader.flushPersistence()
		expect(await storedIds()).toEqual(['f-saved'])

		const inFlight = leaderExports.holdNext()
		const barrier = follower.ensureDurable()
		const outcome = barrier.then(
			() => 'resolved',
			(error: unknown) => error,
		)
		await inFlight.reached
		killLeader()
		const newWorker = new TransactionSerializingWorkerBridge(new BrowserWorkerSim())
		cleanups.push(() => newWorker.terminate())
		const successor = new IndexedDbAdapter({
			bridge: newWorker,
			dbName: DB,
			persistenceDebounceMs: 60_000,
			snapshotBarrierChannel: CHANNEL,
		})
		await successor.open(minimalSchema)
		// As in the browser, the new leader's worker serves other tabs only after it restored.
		cleanups.push(startLeaderRpcRelay(CHANNEL, newWorker, { heartbeatMs: 20 }))

		const state = track(outcome)
		for (let tick = 0; tick < 50 && state.state() === 'pending'; tick++) {
			await vi.advanceTimersByTimeAsync(20)
		}
		// Durable because a snapshot of the old database held it, not because the new
		// leader said so.
		await expect(outcome).resolves.toBe('resolved')
		expect(await storedIds()).toEqual(['f-saved'])
	})

	test('a leader that is closing sends the follower to snapshot through the next leader at once', async () => {
		const { leader, follower } = await openTabs()
		const followerExports = watchExports(follower)
		await insert(follower, 'f1')
		// Closing leaders answer "going away" (no silence to wait out); the follower then
		// saves the snapshot itself through the worker that still serves.
		;(leader as unknown as { closing: boolean }).closing = true
		await expect(follower.ensureDurable()).resolves.toBeUndefined()
		expect(followerExports.count()).toBeGreaterThan(0)
		expect(await storedIds()).toEqual(['f1'])
	})
})
