import type {
	CollectionRecord,
	QueryBuilder,
	QueryStoreCache,
	SubscriptionCallback,
} from '@korajs/store'
import { QueryStoreCache as QueryStoreCacheClass } from '@korajs/store'
import { get } from 'svelte/store'
import { describe, expect, it, vi } from 'vitest'
import { createQueryStore } from './query-store'

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

function createMockQueryBuilder(initialResults: CollectionRecord[] = []): QueryBuilder {
	let capturedCallback: SubscriptionCallback<CollectionRecord> | null = null

	return {
		subscribe: vi.fn((callback: SubscriptionCallback<CollectionRecord>) => {
			capturedCallback = callback
			callback(initialResults)
			return vi.fn()
		}),
		getDescriptor: vi.fn().mockReturnValue({
			collection: 'todos',
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
})
