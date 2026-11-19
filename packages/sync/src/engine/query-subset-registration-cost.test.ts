import { describe, expect, test, vi } from 'vitest'
import { createMemoryTransportPair } from '../transport/memory-transport'
import type { SyncStatePersistence } from '../types'
import { SyncEngine } from './sync-engine'
import type { SyncStore } from './sync-store'

/**
 * A long list whose rows each mount their own live query registers thousands of narrow views
 * one at a time, on the main thread. Each registration must cost about the same however many
 * are mounted (it used to recompute the whole view several times: O(n²) for n views).
 */
function store(): SyncStore {
	return {
		getVersionVector: () => new Map(),
		getNodeId: () => 'device-node',
		applyRemoteOperation: vi.fn(async () => 'applied' as const),
		getOperationRange: vi.fn(async () => []),
	}
}

/**
 * With `startingUp`, the engine has persisted sync state whose watermarks it has not read yet
 * (it is not started): the window at app start where the first screen's queries mount.
 */
function engine(startingUp = false): SyncEngine {
	return new SyncEngine({
		transport: createMemoryTransportPair().client,
		store: store(),
		config: { url: 'ws://t' },
		...(startingUp ? { syncState: pendingState() } : {}),
	})
}

/** Sync state the engine has not loaded yet (nothing here is called before a start). */
function pendingState(): SyncStatePersistence {
	return {
		loadLastAckedServerVector: async () => new Map(),
		saveLastAckedServerVector: async () => {},
		mergeServerVectors: (a) => a,
		countUnsyncedOperations: async () => 0,
		getUnsyncedOperations: async () => [],
	}
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/**
 * Milliseconds for a list of `n` rows to mount (each registering its view in the same tick, as
 * one render does), the view to switch, and the list to unmount, switching back.
 */
async function listMountAndUnmount(n: number, startingUp = false): Promise<number> {
	const sync = engine(startingUp)
	const started = performance.now()
	const removers: Array<() => void> = []
	for (let i = 0; i < n; i++) {
		removers.push(sync.registerQuerySubset({ collection: 'comments', where: { postId: `p${i}` } }))
	}
	await tick()
	for (const remove of removers) remove()
	await tick()
	return performance.now() - started
}

/** Milliseconds to register `n` views one per microtask (rows appearing one by one), then remove them. */
async function oneByOne(n: number, startingUp = false): Promise<number> {
	const sync = engine(startingUp)
	const removers: Array<() => void> = []
	let spent = 0
	for (let i = 0; i < n; i++) {
		const started = performance.now()
		removers.push(sync.registerQuerySubset({ collection: 'comments', where: { postId: `p${i}` } }))
		await Promise.resolve()
		spent += performance.now() - started
	}
	for (const remove of removers) {
		const started = performance.now()
		remove()
		await Promise.resolve()
		spent += performance.now() - started
	}
	return spent
}

describe('registering many live query views', () => {
	test('a list of 1,500 rows mounts and unmounts its views in well under a second', async () => {
		await listMountAndUnmount(50) // warm up
		const elapsed = await listMountAndUnmount(1500)
		console.log(`list of 1500: ${elapsed.toFixed(0)} ms`)
		expect(elapsed).toBeLessThan(1000)
	}, 120_000)

	// Rendering and effects mount rows across microtasks; the view switches once for all of them.
	test('views mounted one by one across microtasks: 1,500 in well under a second', async () => {
		await oneByOne(50)
		const elapsed = await oneByOne(1500)
		console.log(`one by one 1500: ${elapsed.toFixed(0)} ms`)
		expect(elapsed).toBeLessThan(1000)
	}, 120_000)

	// At app start the stored watermarks are still being read; registrations then only decide
	// whether to reconnect, and must not rebuild the whole view each time either.
	test('while the stored watermarks load: a list of 1,500 rows in well under a second', async () => {
		await listMountAndUnmount(50, true)
		const elapsed = await listMountAndUnmount(1500, true)
		console.log(`list of 1500 while starting: ${elapsed.toFixed(0)} ms`)
		expect(elapsed).toBeLessThan(1000)
	}, 120_000)

	test('while the stored watermarks load: 1,500 views one by one in well under a second', async () => {
		await oneByOne(50, true)
		const elapsed = await oneByOne(1500, true)
		console.log(`one by one 1500 while starting: ${elapsed.toFixed(0)} ms`)
		expect(elapsed).toBeLessThan(1000)
	}, 120_000)
})
