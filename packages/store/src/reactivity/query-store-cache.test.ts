import { describe, expect, it, vi } from 'vitest'
import type { QueryBuilder } from '../query/query-builder'
import type { CollectionRecord, SubscriptionCallback } from '../types'
import { QueryStoreCache } from './query-store-cache'

function createMockQueryBuilder(
	descriptor: Record<string, unknown> = { collection: 'todos', where: {}, orderBy: [] },
): QueryBuilder {
	return {
		subscribe: vi.fn((_callback: SubscriptionCallback<CollectionRecord>) => vi.fn()),
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
		const qb2 = createMockQueryBuilder()

		const store1 = cache.getOrCreate(qb1)
		const store2 = cache.getOrCreate(qb2)

		expect(store1).toBe(store2)
		expect(cache.size).toBe(1)
	})

	it('destroys QueryStore when last reference is released', () => {
		const cache = new QueryStoreCache()
		const qb = createMockQueryBuilder()

		cache.getOrCreate(qb)
		cache.release(qb)
		expect(cache.size).toBe(0)
	})
})
