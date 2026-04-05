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
	it('subscribes eagerly on construction', () => {
		const { queryBuilder } = createMockQueryBuilder()
		new QueryStore(queryBuilder)
		expect(queryBuilder.subscribe).toHaveBeenCalledTimes(1)
	})

	it('has snapshot populated after construction (from sync callback)', () => {
		const records = [createRecord('1', { title: 'Test' })]
		const { queryBuilder } = createMockQueryBuilder(records)
		const store = new QueryStore(queryBuilder)

		const snapshot = store.getSnapshot()
		expect(snapshot).toHaveLength(1)
		expect(snapshot[0]?.id).toBe('1')
		expect(Object.isFrozen(snapshot)).toBe(true)
	})

	it('returns frozen empty array when constructed with no results', () => {
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

		unsubA()
		triggerCallback([createRecord('1')])

		expect(listenerA).toHaveBeenCalledTimes(0)
		expect(listenerB).toHaveBeenCalledTimes(1)
	})

	it('destroy cleans up underlying subscription', () => {
		const { queryBuilder, unsubscribeSpy, triggerCallback } = createMockQueryBuilder([])
		const store = new QueryStore(queryBuilder)

		const listener = vi.fn()
		store.subscribe(listener)
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

		const snap1 = store.getSnapshot()
		triggerCallback([createRecord('1'), createRecord('2')])
		const snap2 = store.getSnapshot()

		expect(snap1).not.toBe(snap2)
		expect(snap1).toHaveLength(1)
		expect(snap2).toHaveLength(2)
	})
})
