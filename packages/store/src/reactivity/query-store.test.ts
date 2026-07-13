import type { CollectionRecord, QueryBuilder, SubscriptionCallback } from '@korajs/store'
import { describe, expect, it, vi } from 'vitest'
import { QueryStore } from './query-store'

function createMockQueryBuilder(initialResults: CollectionRecord[] = []): {
	queryBuilder: QueryBuilder
	triggerCallback: (results: CollectionRecord[]) => void
	unsubscribeSpy: ReturnType<typeof vi.fn>
} {
	let capturedCallback: SubscriptionCallback<CollectionRecord> | null = null
	const unsubscribeSpy = vi.fn()

	const queryBuilder = {
		subscribe: vi.fn((callback: SubscriptionCallback<CollectionRecord>) => {
			capturedCallback = callback
			// Simulate registerAndFetch: call callback immediately with initial results
			callback(initialResults)
			return unsubscribeSpy
		}),
		getDescriptor: vi.fn().mockReturnValue({
			collection: 'todos',
			where: {},
			orderBy: [],
		}),
	} as unknown as QueryBuilder

	const triggerCallback = (results: CollectionRecord[]) => {
		if (capturedCallback) {
			capturedCallback(results)
		}
	}

	return { queryBuilder, triggerCallback, unsubscribeSpy }
}

function createRecord(id: string, data: Record<string, unknown> = {}): CollectionRecord {
	return { id, createdAt: 1000, updatedAt: 1000, ...data }
}

describe('QueryStore', () => {
	it('does not subscribe until first listener attaches', () => {
		const { queryBuilder } = createMockQueryBuilder()
		new QueryStore(queryBuilder)
		expect(queryBuilder.subscribe).not.toHaveBeenCalled()
	})

	it('starts subscription when first listener attaches via subscribe()', () => {
		const { queryBuilder } = createMockQueryBuilder()
		const store = new QueryStore(queryBuilder)

		store.subscribe(vi.fn())
		expect(queryBuilder.subscribe).toHaveBeenCalledTimes(1)
	})

	it('populates snapshot after subscribe (from sync callback)', () => {
		const records = [createRecord('1', { title: 'Test' })]
		const { queryBuilder } = createMockQueryBuilder(records)
		const store = new QueryStore(queryBuilder)

		// Before subscribe, snapshot is empty
		expect(store.getSnapshot()).toEqual([])

		store.subscribe(vi.fn())

		// After subscribe, snapshot is populated (mock calls callback synchronously)
		const snapshot = store.getSnapshot()
		expect(snapshot).toHaveLength(1)
		expect(snapshot[0]?.id).toBe('1')
		expect(Object.isFrozen(snapshot)).toBe(true)
	})

	it('returns frozen empty array before subscribe', () => {
		const { queryBuilder } = createMockQueryBuilder([])
		const store = new QueryStore(queryBuilder)

		const snapshot = store.getSnapshot()
		expect(snapshot).toEqual([])
		expect(Object.isFrozen(snapshot)).toBe(true)
	})

	it('notifies listeners on data change', () => {
		const { queryBuilder, triggerCallback } = createMockQueryBuilder([])
		const store = new QueryStore(queryBuilder)

		const listener = vi.fn()
		store.subscribe(listener)
		listener.mockClear() // Clear initial delivery notification

		triggerCallback([createRecord('2')])
		expect(listener).toHaveBeenCalledTimes(1)
		expect(store.getSnapshot()).toHaveLength(1)
	})

	it('supports multiple listeners', () => {
		const { queryBuilder, triggerCallback } = createMockQueryBuilder([])
		const store = new QueryStore(queryBuilder)

		const listenerA = vi.fn()
		const listenerB = vi.fn()
		store.subscribe(listenerA)
		store.subscribe(listenerB)
		// Clear counts from initial subscription delivery
		listenerA.mockClear()
		listenerB.mockClear()

		triggerCallback([createRecord('1')])

		expect(listenerA).toHaveBeenCalledTimes(1)
		expect(listenerB).toHaveBeenCalledTimes(1)
	})

	it('unsubscribes individual listener without affecting others', () => {
		const { queryBuilder, triggerCallback } = createMockQueryBuilder([])
		const store = new QueryStore(queryBuilder)

		const listenerA = vi.fn()
		const listenerB = vi.fn()
		const unsubA = store.subscribe(listenerA)
		store.subscribe(listenerB)
		// Clear counts from initial subscription delivery
		listenerA.mockClear()
		listenerB.mockClear()

		unsubA()
		triggerCallback([createRecord('1')])

		expect(listenerA).toHaveBeenCalledTimes(0)
		expect(listenerB).toHaveBeenCalledTimes(1)
	})

	it('stops underlying subscription when last listener detaches', () => {
		const { queryBuilder, unsubscribeSpy } = createMockQueryBuilder([])
		const store = new QueryStore(queryBuilder)

		const unsub = store.subscribe(vi.fn())
		expect(unsubscribeSpy).not.toHaveBeenCalled()

		unsub()
		expect(unsubscribeSpy).toHaveBeenCalledTimes(1)
	})

	it('restarts subscription when new listener attaches after all detached', () => {
		const { queryBuilder, unsubscribeSpy } = createMockQueryBuilder([])
		const store = new QueryStore(queryBuilder)

		// First subscribe/unsubscribe cycle
		const unsub1 = store.subscribe(vi.fn())
		expect(queryBuilder.subscribe).toHaveBeenCalledTimes(1)
		unsub1()
		expect(unsubscribeSpy).toHaveBeenCalledTimes(1)

		// Second subscribe cycle — restarts the subscription
		store.subscribe(vi.fn())
		expect(queryBuilder.subscribe).toHaveBeenCalledTimes(2)
	})

	it('handles StrictMode double-mount: subscribe → unsubscribe → resubscribe', () => {
		const records = [createRecord('1', { title: 'Test' })]
		const { queryBuilder, triggerCallback, unsubscribeSpy } = createMockQueryBuilder(records)
		const store = new QueryStore(queryBuilder)

		// Mount: subscribe
		const listener1 = vi.fn()
		const unsub1 = store.subscribe(listener1)
		expect(store.getSnapshot()).toHaveLength(1)

		// StrictMode unmount: unsubscribe
		unsub1()
		expect(unsubscribeSpy).toHaveBeenCalledTimes(1)

		// StrictMode remount: subscribe again
		const listener2 = vi.fn()
		store.subscribe(listener2)
		expect(queryBuilder.subscribe).toHaveBeenCalledTimes(2)
		expect(store.getSnapshot()).toHaveLength(1)
		// Clear count from initial subscription delivery on remount
		listener2.mockClear()

		// Data updates still work after remount
		triggerCallback([createRecord('1'), createRecord('2')])
		expect(listener2).toHaveBeenCalledTimes(1)
		expect(store.getSnapshot()).toHaveLength(2)
	})

	it('destroy cleans up underlying subscription', () => {
		const { queryBuilder, unsubscribeSpy, triggerCallback } = createMockQueryBuilder([])
		const store = new QueryStore(queryBuilder)

		const listener = vi.fn()
		store.subscribe(listener)
		listener.mockClear() // Clear initial delivery notification
		expect(unsubscribeSpy).not.toHaveBeenCalled()

		store.destroy()
		expect(unsubscribeSpy).toHaveBeenCalledTimes(1)

		// Triggering after destroy should not notify
		triggerCallback([createRecord('1')])
		expect(listener).toHaveBeenCalledTimes(0)

		// Snapshot should be empty after destroy
		expect(store.getSnapshot()).toEqual([])
	})

	it('returns new frozen snapshot on each update', () => {
		const { queryBuilder, triggerCallback } = createMockQueryBuilder([createRecord('1')])
		const store = new QueryStore(queryBuilder)

		store.subscribe(vi.fn())
		const snap1 = store.getSnapshot()
		triggerCallback([createRecord('1'), createRecord('2')])
		const snap2 = store.getSnapshot()

		expect(snap1).not.toBe(snap2)
		expect(snap1).toHaveLength(1)
		expect(snap2).toHaveLength(2)
	})

	it('does not start duplicate subscriptions for multiple concurrent listeners', () => {
		const { queryBuilder } = createMockQueryBuilder([])
		const store = new QueryStore(queryBuilder)

		store.subscribe(vi.fn())
		store.subscribe(vi.fn())

		// Only one underlying subscription should exist
		expect(queryBuilder.subscribe).toHaveBeenCalledTimes(1)
	})
})
