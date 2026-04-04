import type { CollectionRecord, QueryBuilder, SubscriptionCallback } from '@kora/store'
import { describe, expect, it, vi } from 'vitest'
import { QueryStoreCache } from './query-store-cache'

function createMockQueryBuilder(
	descriptor: Record<string, unknown> = { collection: 'todos', where: {}, orderBy: [] },
): QueryBuilder {
	return {
		subscribe: vi.fn((_callback: SubscriptionCallback<CollectionRecord>) => {
			return vi.fn()
		}),
		getDescriptor: vi.fn().mockReturnValue(descriptor),
	} as unknown as QueryBuilder
}

describe('QueryStoreCache', () => {
	it('creates a new QueryStore on first access', () => {
		const cache = new QueryStoreCache()
		const qb = createMockQueryBuilder()

		const store = cache.getOrCreate(qb)
		expect(store).toBeDefined()
		expect(cache.size).toBe(1)
	})

	it('reuses QueryStore for same descriptor', () => {
		const cache = new QueryStoreCache()
		const qb1 = createMockQueryBuilder()
		const qb2 = createMockQueryBuilder() // same descriptor

		const store1 = cache.getOrCreate(qb1)
		const store2 = cache.getOrCreate(qb2)

		expect(store1).toBe(store2)
		expect(cache.size).toBe(1)
	})

	it('creates different QueryStores for different descriptors', () => {
		const cache = new QueryStoreCache()
		const qb1 = createMockQueryBuilder({ collection: 'todos', where: {}, orderBy: [] })
		const qb2 = createMockQueryBuilder({
			collection: 'projects',
			where: {},
			orderBy: [],
		})

		const store1 = cache.getOrCreate(qb1)
		const store2 = cache.getOrCreate(qb2)

		expect(store1).not.toBe(store2)
		expect(cache.size).toBe(2)
	})

	it('destroys QueryStore when last reference is released', () => {
		const cache = new QueryStoreCache()
		const qb = createMockQueryBuilder()

		cache.getOrCreate(qb)
		expect(cache.size).toBe(1)

		cache.release(qb)
		expect(cache.size).toBe(0)
	})

	it('keeps QueryStore alive while references remain', () => {
		const cache = new QueryStoreCache()
		const qb1 = createMockQueryBuilder()
		const qb2 = createMockQueryBuilder() // same descriptor

		cache.getOrCreate(qb1)
		cache.getOrCreate(qb2) // refCount = 2

		cache.release(qb1) // refCount = 1
		expect(cache.size).toBe(1)

		cache.release(qb2) // refCount = 0
		expect(cache.size).toBe(0)
	})

	it('clear destroys all cached QueryStores', () => {
		const cache = new QueryStoreCache()
		cache.getOrCreate(createMockQueryBuilder({ collection: 'a', where: {}, orderBy: [] }))
		cache.getOrCreate(createMockQueryBuilder({ collection: 'b', where: {}, orderBy: [] }))
		expect(cache.size).toBe(2)

		cache.clear()
		expect(cache.size).toBe(0)
	})

	it('release is a no-op for unknown descriptor', () => {
		const cache = new QueryStoreCache()
		const qb = createMockQueryBuilder()

		// Should not throw
		cache.release(qb)
		expect(cache.size).toBe(0)
	})
})
