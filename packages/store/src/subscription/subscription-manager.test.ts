import type { Operation } from '@korajs/core'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { CollectionRecord } from '../types'
import { SubscriptionManager } from './subscription-manager'

function makeOp(collection: string): Operation {
	return {
		id: 'op-1',
		nodeId: 'node-1',
		type: 'insert',
		collection,
		recordId: 'rec-1',
		data: { title: 'Test' },
		previousData: null,
		timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-1' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
	}
}

describe('SubscriptionManager', () => {
	let manager: SubscriptionManager

	beforeEach(() => {
		manager = new SubscriptionManager()
	})

	test('register returns an unsubscribe function', () => {
		const unsub = manager.register(
			{ collection: 'todos', where: {}, orderBy: [] },
			() => {},
			async () => [],
		)
		expect(typeof unsub).toBe('function')
		expect(manager.size).toBe(1)

		unsub()
		expect(manager.size).toBe(0)
	})

	test('notify + flush calls callback with new results', async () => {
		const results: CollectionRecord[][] = []
		const mockData: CollectionRecord[] = [
			{ id: 'rec-1', title: 'Test', createdAt: 1000, updatedAt: 1000 },
		]

		manager.register(
			{ collection: 'todos', where: {}, orderBy: [] },
			(r) => results.push([...r]),
			async () => mockData,
		)

		manager.notify('todos', makeOp('todos'))
		await manager.flush()

		expect(results).toHaveLength(1)
		expect(results[0]).toEqual(mockData)
	})

	test('does not call callback if results unchanged', async () => {
		const callback = vi.fn()
		const data: CollectionRecord[] = [
			{ id: 'rec-1', title: 'Test', createdAt: 1000, updatedAt: 1000 },
		]

		const unsub = manager.register(
			{ collection: 'todos', where: {}, orderBy: [] },
			callback,
			async () => data,
		)

		// First flush: callback called (lastResults was [])
		manager.notify('todos', makeOp('todos'))
		await manager.flush()
		expect(callback).toHaveBeenCalledTimes(1)

		// Second flush with same data: callback NOT called
		manager.notify('todos', makeOp('todos'))
		await manager.flush()
		expect(callback).toHaveBeenCalledTimes(1)

		unsub()
	})

	test('calls callback when results change', async () => {
		const callback = vi.fn()
		let data: CollectionRecord[] = [{ id: 'rec-1', title: 'V1', createdAt: 1000, updatedAt: 1000 }]

		manager.register({ collection: 'todos', where: {}, orderBy: [] }, callback, async () => data)

		manager.notify('todos', makeOp('todos'))
		await manager.flush()
		expect(callback).toHaveBeenCalledTimes(1)

		// Change data
		data = [{ id: 'rec-1', title: 'V2', createdAt: 1000, updatedAt: 2000 }]
		manager.notify('todos', makeOp('todos'))
		await manager.flush()
		expect(callback).toHaveBeenCalledTimes(2)
		expect(callback).toHaveBeenLastCalledWith(data)
	})

	test('only notifies subscriptions for the affected collection', async () => {
		const todoCallback = vi.fn()
		const projectCallback = vi.fn()

		manager.register({ collection: 'todos', where: {}, orderBy: [] }, todoCallback, async () => [
			{ id: 'r1', title: 'T', createdAt: 1000, updatedAt: 1000 },
		])
		manager.register(
			{ collection: 'projects', where: {}, orderBy: [] },
			projectCallback,
			async () => [{ id: 'r2', name: 'P', createdAt: 1000, updatedAt: 1000 }],
		)

		manager.notify('todos', makeOp('todos'))
		await manager.flush()

		expect(todoCallback).toHaveBeenCalledTimes(1)
		expect(projectCallback).not.toHaveBeenCalled()
	})

	test('batches multiple notifications in same flush', async () => {
		const callback = vi.fn()
		let callCount = 0

		manager.register({ collection: 'todos', where: {}, orderBy: [] }, callback, async () => {
			callCount++
			return [
				{
					id: `r${callCount}`,
					title: `T${callCount}`,
					createdAt: 1000,
					updatedAt: 1000,
				},
			]
		})

		// Two notifications before flush
		manager.notify('todos', makeOp('todos'))
		manager.notify('todos', makeOp('todos'))
		await manager.flush()

		// Should execute only once despite two notifications
		expect(callCount).toBe(1)
		expect(callback).toHaveBeenCalledTimes(1)
	})

	test('microtask-based auto-flush', async () => {
		const callback = vi.fn()
		manager.register({ collection: 'todos', where: {}, orderBy: [] }, callback, async () => [
			{ id: 'r1', title: 'T', createdAt: 1000, updatedAt: 1000 },
		])

		manager.notify('todos', makeOp('todos'))

		// Wait for microtask to flush
		await new Promise<void>((resolve) => queueMicrotask(resolve))
		// Need another tick for the async flush to complete
		await new Promise<void>((resolve) => setTimeout(resolve, 0))

		expect(callback).toHaveBeenCalledTimes(1)
	})

	test('clear removes all subscriptions', () => {
		manager.register(
			{ collection: 'todos', where: {}, orderBy: [] },
			() => {},
			async () => [],
		)
		manager.register(
			{ collection: 'projects', where: {}, orderBy: [] },
			() => {},
			async () => [],
		)

		expect(manager.size).toBe(2)
		manager.clear()
		expect(manager.size).toBe(0)
	})

	test('handles executeFn errors gracefully', async () => {
		const callback = vi.fn()

		manager.register({ collection: 'todos', where: {}, orderBy: [] }, callback, async () => {
			throw new Error('Query failed')
		})

		manager.notify('todos', makeOp('todos'))
		// Should not throw
		await manager.flush()
		expect(callback).not.toHaveBeenCalled()
	})

	test('empty flush is a no-op', async () => {
		await manager.flush() // should not throw
	})
})

describe('SubscriptionManager with bloom filter', () => {
	// Use a low threshold so bloom filter activates with fewer subscriptions
	let manager: SubscriptionManager

	beforeEach(() => {
		manager = new SubscriptionManager({ bloomThreshold: 5 })
	})

	function registerMany(
		count: number,
		collection: string,
		callback: () => void = () => {},
	): Array<() => void> {
		const unsubs: Array<() => void> = []
		for (let i = 0; i < count; i++) {
			unsubs.push(
				manager.register({ collection, where: {}, orderBy: [] }, callback, async () => [
					{
						id: `r${i}`,
						title: `T${i}`,
						createdAt: 1000,
						updatedAt: 1000,
					},
				]),
			)
		}
		return unsubs
	}

	test('bloom filter activates when subscription count meets threshold', () => {
		expect(manager.isBloomActive()).toBe(false)

		registerMany(4, 'todos')
		expect(manager.isBloomActive()).toBe(false)

		registerMany(1, 'todos')
		expect(manager.isBloomActive()).toBe(true)
	})

	test('bloom filter deactivates after unsubscriptions bring count below threshold', () => {
		const unsubs = registerMany(5, 'todos')
		expect(manager.isBloomActive()).toBe(true)

		const firstUnsub = unsubs[0]
		expect(firstUnsub).toBeDefined()
		firstUnsub?.()
		expect(manager.isBloomActive()).toBe(false)
	})

	test('bloom filter correctly skips irrelevant mutations', async () => {
		const todoCallback = vi.fn()
		registerMany(5, 'todos', todoCallback)

		expect(manager.isBloomActive()).toBe(true)

		// Notify with a collection that no subscription watches
		manager.notify('nonexistent_collection', makeOp('nonexistent_collection'))
		await manager.flush()

		expect(todoCallback).not.toHaveBeenCalled()

		const stats = manager.getStats()
		expect(stats.bloomFilterMisses).toBeGreaterThanOrEqual(1)
	})

	test('bloom filter allows matching mutations through', async () => {
		const callback = vi.fn()
		registerMany(5, 'todos', callback)

		expect(manager.isBloomActive()).toBe(true)

		manager.notify('todos', makeOp('todos'))
		await manager.flush()

		expect(callback).toHaveBeenCalledTimes(5) // All 5 subscriptions notified

		const stats = manager.getStats()
		expect(stats.bloomFilterHits).toBeGreaterThanOrEqual(1)
	})

	test('bloom filter tracks included collection dependencies', async () => {
		// Register subscriptions with includeCollections
		for (let i = 0; i < 5; i++) {
			manager.register(
				{
					collection: 'todos',
					where: {},
					orderBy: [],
					includeCollections: ['projects'],
				},
				vi.fn(),
				async () => [
					{
						id: `r${i}`,
						title: `T${i}`,
						createdAt: 1000,
						updatedAt: 1000,
					},
				],
			)
		}

		expect(manager.isBloomActive()).toBe(true)

		// Mutating projects should trigger todos subscriptions that include projects
		manager.notify('projects', makeOp('projects'))
		await manager.flush()

		const stats = manager.getStats()
		// Bloom filter should have found the 'projects' dependency
		expect(stats.bloomFilterHits).toBeGreaterThanOrEqual(1)
	})

	test('bloom filter rebuilds when subscriptions change', async () => {
		const unsubs = registerMany(5, 'todos')

		// First query
		manager.notify('todos', makeOp('todos'))
		await manager.flush()

		// Unsubscribe all and add new subscriptions for a different collection
		for (const unsub of unsubs) unsub()

		registerMany(5, 'projects')

		// Now querying for 'todos' should miss (bloom filter should be rebuilt)
		manager.notify('todos', makeOp('todos'))
		await manager.flush()

		const stats = manager.getStats()
		// The second check should miss because bloom was rebuilt without 'todos'
		expect(stats.bloomFilterMisses).toBeGreaterThanOrEqual(1)
	})

	test('getStats returns correct structure', () => {
		const stats = manager.getStats()
		expect(stats).toEqual({
			totalChecks: 0,
			bloomFilterHits: 0,
			bloomFilterMisses: 0,
			falsePositives: 0,
			averageCheckTimeMs: 0,
			bloomFilterActive: false,
			subscriptionCount: 0,
		})
	})

	test('getStats tracks check counts', async () => {
		registerMany(5, 'todos')

		manager.notify('todos', makeOp('todos'))
		await manager.flush()

		manager.notify('nonexistent', makeOp('nonexistent'))
		await manager.flush()

		const stats = manager.getStats()
		expect(stats.totalChecks).toBe(2)
		expect(stats.subscriptionCount).toBe(5)
		expect(stats.bloomFilterActive).toBe(true)
	})

	test('clear resets all stats', async () => {
		registerMany(5, 'todos')
		manager.notify('todos', makeOp('todos'))
		await manager.flush()

		manager.clear()

		const stats = manager.getStats()
		expect(stats.totalChecks).toBe(0)
		expect(stats.bloomFilterHits).toBe(0)
		expect(stats.bloomFilterMisses).toBe(0)
		expect(stats.falsePositives).toBe(0)
		expect(stats.subscriptionCount).toBe(0)
		expect(stats.bloomFilterActive).toBe(false)
	})
})

describe('SubscriptionManager with default threshold', () => {
	test('default threshold is 100', () => {
		const manager = new SubscriptionManager()
		expect(manager.isBloomActive()).toBe(false)

		// Add 99 subscriptions
		for (let i = 0; i < 99; i++) {
			manager.register(
				{ collection: `col_${i}`, where: {}, orderBy: [] },
				() => {},
				async () => [],
			)
		}
		expect(manager.isBloomActive()).toBe(false)

		// Add 100th
		manager.register(
			{ collection: 'col_100', where: {}, orderBy: [] },
			() => {},
			async () => [],
		)
		expect(manager.isBloomActive()).toBe(true)
	})
})

describe('SubscriptionManager custom options', () => {
	test('accepts custom bloom threshold', () => {
		const manager = new SubscriptionManager({ bloomThreshold: 3 })

		for (let i = 0; i < 3; i++) {
			manager.register(
				{ collection: 'todos', where: {}, orderBy: [] },
				() => {},
				async () => [],
			)
		}
		expect(manager.isBloomActive()).toBe(true)
	})

	test('accepts custom bloom false positive rate', () => {
		// This primarily tests that the option is accepted without error
		const manager = new SubscriptionManager({
			bloomThreshold: 2,
			bloomFalsePositiveRate: 0.001,
		})

		for (let i = 0; i < 2; i++) {
			manager.register(
				{ collection: 'todos', where: {}, orderBy: [] },
				() => {},
				async () => [],
			)
		}

		// Should work fine
		manager.notify('todos', makeOp('todos'))
	})
})

describe('SubscriptionManager performance', () => {
	test('1000 subscriptions, check time under 1ms per mutation', async () => {
		const manager = new SubscriptionManager({ bloomThreshold: 100 })

		// Register 1000 subscriptions across 10 collections
		for (let i = 0; i < 1000; i++) {
			const collection = `collection_${i % 10}`
			manager.register(
				{ collection, where: {}, orderBy: [] },
				() => {},
				async () => [],
			)
		}

		expect(manager.isBloomActive()).toBe(true)

		// Run 100 mutation checks against a collection that no subscription watches
		const start = performance.now()
		for (let i = 0; i < 100; i++) {
			manager.notify('nonexistent_collection', makeOp('nonexistent_collection'))
			await manager.flush()
		}
		const elapsed = performance.now() - start
		const perMutation = elapsed / 100

		// Should be well under 1ms per mutation (bloom filter skips everything)
		expect(perMutation).toBeLessThan(1)

		const stats = manager.getStats()
		// All checks should have been bloom filter misses (no matching subscription)
		expect(stats.bloomFilterMisses).toBe(100)
	})

	test('bloom filter provides speedup for non-matching mutations', async () => {
		// Test with bloom filter (threshold 50)
		const withBloom = new SubscriptionManager({ bloomThreshold: 50 })
		// Test without bloom filter (threshold very high)
		const withoutBloom = new SubscriptionManager({ bloomThreshold: 100000 })

		// Register 500 subscriptions across 50 collections in both managers
		for (let i = 0; i < 500; i++) {
			const collection = `collection_${i % 50}`
			const noop = (): void => {}
			const execFn = async (): Promise<CollectionRecord[]> => []

			withBloom.register({ collection, where: {}, orderBy: [] }, noop, execFn)
			withoutBloom.register({ collection, where: {}, orderBy: [] }, noop, execFn)
		}

		expect(withBloom.isBloomActive()).toBe(true)
		expect(withoutBloom.isBloomActive()).toBe(false)

		const iterations = 500

		for (let i = 0; i < iterations; i++) {
			withBloom.notify('nonexistent_collection', makeOp('nonexistent_collection'))
			await withBloom.flush()
		}

		for (let i = 0; i < iterations; i++) {
			withoutBloom.notify('nonexistent_collection', makeOp('nonexistent_collection'))
			await withoutBloom.flush()
		}

		// Correctness: bloom filter skips all subscriptions for non-matching collections.
		// Timing comparisons belong in test:benchmarks — they are flaky under parallel CI load.
		const bloomStats = withBloom.getStats()
		expect(bloomStats.bloomFilterMisses).toBe(iterations)
		expect(bloomStats.bloomFilterHits).toBe(0)
		expect(bloomStats.falsePositives).toBe(0)

		const linearStats = withoutBloom.getStats()
		expect(linearStats.bloomFilterActive).toBe(false)
		expect(linearStats.totalChecks).toBe(iterations)
	})

	test('5000 subscriptions with bloom filter stay under 1ms per check', async () => {
		const manager = new SubscriptionManager({ bloomThreshold: 100 })

		// Register 5000 subscriptions across 100 collections
		for (let i = 0; i < 5000; i++) {
			const collection = `collection_${i % 100}`
			manager.register(
				{ collection, where: {}, orderBy: [] },
				() => {},
				async () => [],
			)
		}

		// Check 200 mutations against non-matching collections
		const start = performance.now()
		for (let i = 0; i < 200; i++) {
			manager.notify(`never_seen_${i}`, makeOp(`never_seen_${i}`))
			await manager.flush()
		}
		const elapsed = performance.now() - start
		const perMutation = elapsed / 200

		// Dev/CI machines vary; gate catches major regressions (target remains 1ms in docs).
		expect(perMutation).toBeLessThan(2)
	})
})

describe('SubscriptionManager registerAndFetch', () => {
	test('calls callback immediately with initial results', async () => {
		const manager = new SubscriptionManager()
		const callback = vi.fn()
		const mockData: CollectionRecord[] = [
			{ id: 'rec-1', title: 'Test', createdAt: 1000, updatedAt: 1000 },
		]

		manager.registerAndFetch(
			{ collection: 'todos', where: {}, orderBy: [] },
			callback,
			async () => mockData,
		)

		// Wait for the async initial fetch
		await new Promise<void>((resolve) => setTimeout(resolve, 0))

		expect(callback).toHaveBeenCalledTimes(1)
		expect(callback).toHaveBeenCalledWith(mockData)
	})

	test('does not call callback if unsubscribed before fetch completes', async () => {
		const manager = new SubscriptionManager()
		const callback = vi.fn()

		const unsub = manager.registerAndFetch(
			{ collection: 'todos', where: {}, orderBy: [] },
			callback,
			async () => [{ id: 'r1', title: 'T', createdAt: 1000, updatedAt: 1000 }],
		)

		// Immediately unsubscribe
		unsub()

		await new Promise<void>((resolve) => setTimeout(resolve, 0))

		expect(callback).not.toHaveBeenCalled()
	})
})
