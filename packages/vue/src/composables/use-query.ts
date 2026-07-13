import type { CollectionRecord, QueryBuilder } from '@korajs/store'
import { assertQueryReady } from '@korajs/store'
import { type DeepReadonly, readonly, shallowRef, watch } from 'vue'
import { useKoraContext } from '../context'
import type { UseQueryOptions } from '../types'

const EMPTY_ARRAY: readonly unknown[] = Object.freeze([])

/**
 * Reactive query composable backed by the local Kora store.
 */
export function useQuery<T = CollectionRecord>(
	query: QueryBuilder<T>,
	options?: UseQueryOptions,
): DeepReadonly<ReturnType<typeof shallowRef<readonly T[]>>> {
	const { queryStoreCache } = useKoraContext()
	const enabled = options?.enabled !== false
	const snapshot = shallowRef<readonly T[]>(EMPTY_ARRAY as readonly T[])

	watch(
		() => (enabled ? JSON.stringify(query.getDescriptor()) : null),
		(key, _previous, onCleanup) => {
			if (!key) {
				snapshot.value = EMPTY_ARRAY as readonly T[]
				return
			}

			assertQueryReady(query as QueryBuilder<unknown>)
			const queryStore = queryStoreCache.getOrCreate(query)
			const unsubscribe = queryStore.subscribe(() => {
				snapshot.value = queryStore.getSnapshot()
			})
			snapshot.value = queryStore.getSnapshot()

			onCleanup(() => {
				unsubscribe()
				queryStoreCache.release(query as QueryBuilder<unknown>)
			})
		},
		{ immediate: true },
	)

	return readonly(snapshot)
}
