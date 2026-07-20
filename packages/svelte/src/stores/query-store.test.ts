import type {
	CollectionRecord,
	QueryBuilder,
	QueryStoreCache,
	SubscriptionCallback,
} from '@korajs/store'
import { QueryStoreCache as QueryStoreCacheClass } from '@korajs/store'
import { get } from 'svelte/store'
import { describe, expect, it, vi } from 'vitest'
import { createQueryStore, useQuery } from './query-store'

const queryStoreCache: QueryStoreCache = new QueryStoreCacheClass()

vi.mock('../context', () => ({
	getKoraContext: () => ({
		store: {},
		syncEngine: null,
		app: null,
		events: null,
		subscribeSyncStatus: null,
		queryStoreCache,
	}),
}))

function createMockQueryBuilder(
	initialResults: CollectionRecord[] = [],
	collection = 'todos',
): QueryBuilder {
	let capturedCallback: SubscriptionCallback<CollectionRecord> | null = null

	return {
		subscribe: vi.fn((callback: SubscriptionCallback<CollectionRecord>) => {
			capturedCallback = callback
			callback(initialResults)
			return vi.fn()
		}),
		getDescriptor: vi.fn().mockReturnValue({
			collection,
			where: {},
			orderBy: [],
		}),
	} as unknown as QueryBuilder
}

describe('createQueryStore', () => {
	it('returns readable store with initial results', () => {
		const query = createMockQueryBuilder([{ id: 'a', createdAt: 1, updatedAt: 1 }])
		const store = createQueryStore(query)
		expect(get(store).map((row) => row.id)).toEqual(['a'])
	})

	it('is aliased as useQuery', () => {
		expect(useQuery).toBe(createQueryStore)
	})

	it('returns an empty list and never subscribes when disabled', () => {
		const query = createMockQueryBuilder([{ id: 'a', createdAt: 1, updatedAt: 1 }], 'disabled')
		const store = createQueryStore(query, { enabled: false })

		// A store with no subscribers never runs its start fn; subscribe to trigger it.
		const stop = store.subscribe(() => {})
		expect(get(store)).toEqual([])
		expect(query.subscribe).not.toHaveBeenCalled()
		stop()
	})

	it('releases the query from the cache when the last subscriber stops', () => {
		const releaseSpy = vi.spyOn(queryStoreCache, 'release')
		const query = createMockQueryBuilder([{ id: 'a', createdAt: 1, updatedAt: 1 }], 'release')
		const store = createQueryStore(query)

		const stop = store.subscribe(() => {})
		expect(query.subscribe).toHaveBeenCalledTimes(1)
		stop()
		expect(releaseSpy).toHaveBeenCalledWith(query)
	})
})
