import type { CollectionRecord, QueryBuilder } from '@korajs/store'
import { assertQueryReady } from '@korajs/store'
import { readable, type Readable } from 'svelte/store'
import { getKoraContext } from '../context'
import type { UseQueryOptions } from '../types'

const EMPTY_ARRAY: readonly unknown[] = Object.freeze([])

/**
 * Create a Svelte readable store for a static Kora query.
 *
 * For reactive filter changes, use {@link KoraQuery} which re-subscribes when the
 * query descriptor changes.
 */
export function createQueryStore<T = CollectionRecord>(
	query: QueryBuilder<T>,
	options?: UseQueryOptions,
): Readable<readonly T[]> {
	const { queryStoreCache } = getKoraContext()
	const enabled = options?.enabled !== false

	return readable<readonly T[]>(EMPTY_ARRAY as readonly T[], (set) => {
		if (!enabled) {
			set(EMPTY_ARRAY as readonly T[])
			return () => {}
		}

		assertQueryReady(query as QueryBuilder<unknown>)
		const queryStore = queryStoreCache.getOrCreate(query)
		const unsubscribe = queryStore.subscribe(() => {
			set(queryStore.getSnapshot())
		})
		set(queryStore.getSnapshot())

		return () => {
			unsubscribe()
			queryStoreCache.release(query as QueryBuilder<unknown>)
		}
	})
}

/** Alias for {@link createQueryStore}. */
export const useQuery = createQueryStore
