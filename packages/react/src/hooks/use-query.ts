import type { CollectionRecord, QueryBuilder } from '@korajs/store'
import { assertQueryReady } from '@korajs/store'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useKoraContext } from '../context/kora-context'
import type { UseQueryOptions } from '../types'

const EMPTY_ARRAY: readonly unknown[] = Object.freeze([])

const noopSubscribe = (_onStoreChange: () => void): (() => void) => {
	return () => {}
}

/**
 * React hook for reactive queries against the local Kora store.
 */
export function useQuery<T = CollectionRecord>(
	query: QueryBuilder<T>,
	options?: UseQueryOptions,
): readonly T[] {
	const { queryStoreCache } = useKoraContext()
	const enabled = options?.enabled !== false
	const descriptorKey = JSON.stringify(query.getDescriptor())
	const queryRef = useRef(query)
	queryRef.current = query

	const [queryStore, setQueryStore] = useState<import('@korajs/store').QueryStore<T> | null>(null)

	useEffect(() => {
		if (!enabled) {
			setQueryStore(null)
			return
		}

		const currentQuery = queryRef.current
		assertQueryReady(currentQuery)
		const store = queryStoreCache.getOrCreate(currentQuery)
		setQueryStore(store)

		return () => {
			queryStoreCache.release(currentQuery as QueryBuilder<unknown>)
			setQueryStore(null)
		}
	}, [descriptorKey, enabled, queryStoreCache])

	const disabledGetSnapshot = (): readonly T[] => EMPTY_ARRAY as readonly T[]

	return useSyncExternalStore(
		queryStore ? queryStore.subscribe : noopSubscribe,
		queryStore ? queryStore.getSnapshot : disabledGetSnapshot,
	)
}
