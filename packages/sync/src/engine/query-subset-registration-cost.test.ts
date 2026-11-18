import { describe, expect, test, vi } from 'vitest'
import { createMemoryTransportPair } from '../transport/memory-transport'
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

function engine(): SyncEngine {
	return new SyncEngine({
		transport: createMemoryTransportPair().client,
		store: store(),
		config: { url: 'ws://t' },
	})
}

/** Milliseconds to register `n` views one at a time, then remove them all. */
function mountAndUnmount(n: number): number {
	const sync = engine()
	const started = performance.now()
	const removers: Array<() => void> = []
	for (let i = 0; i < n; i++) {
		removers.push(sync.registerQuerySubset({ collection: 'comments', where: { postId: `p${i}` } }))
	}
	for (const remove of removers) remove()
	return performance.now() - started
}

describe('registering many live query views', () => {
	test('1,500 views register and unregister in well under a second', () => {
		mountAndUnmount(50) // warm up
		const elapsed = mountAndUnmount(1500)
		console.log(`1500 views: ${elapsed.toFixed(0)} ms`)
		expect(elapsed).toBeLessThan(1000)
	}, 120_000)

	test('the cost grows about linearly: 4x the views take far less than 16x the time', () => {
		mountAndUnmount(50)
		const small = Math.max(mountAndUnmount(400), 1)
		const large = mountAndUnmount(1600)
		console.log(`400 views: ${small.toFixed(0)} ms, 1600 views: ${large.toFixed(0)} ms`)
		expect(large / small).toBeLessThan(8)
	}, 120_000)
})
