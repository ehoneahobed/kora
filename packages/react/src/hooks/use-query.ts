import type { CollectionRecord, QueryBuilder } from '@korajs/store'
import { assertQueryReady } from '@korajs/store'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
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
	const lastSnapshotRef = useRef<readonly T[]>(EMPTY_ARRAY as readonly T[])

	const [queryStore, setQueryStore] = useState<import('@korajs/store').QueryStore<T> | null>(null)

	// biome-ignore lint/correctness/useExhaustiveDependencies: descriptorKey intentionally re-runs the effect when the query descriptor changes, even though the effect reads the query via queryRef
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
		}
	}, [descriptorKey, enabled, queryStoreCache])

	const getSnapshot = useCallback((): readonly T[] => {
		if (!enabled) {
			lastSnapshotRef.current = EMPTY_ARRAY as readonly T[]
			return lastSnapshotRef.current
		}
		if (!queryStore) {
			return lastSnapshotRef.current
		}
		if (!queryStore.hasSnapshot()) {
			return lastSnapshotRef.current
		}
		const snapshot = queryStore.getSnapshot()
		lastSnapshotRef.current = snapshot
		return snapshot
	}, [enabled, queryStore])

	return useSyncExternalStore(queryStore ? queryStore.subscribe : noopSubscribe, getSnapshot)
}
