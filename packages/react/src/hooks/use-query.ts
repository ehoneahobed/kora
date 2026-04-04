import type { CollectionRecord, QueryBuilder } from '@kora/store'
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { QueryStore } from '../query-store/query-store'
import type { UseQueryOptions } from '../types'

/**
 * Frozen empty array returned when the query is disabled or before data loads.
 * Same reference prevents unnecessary re-renders.
 */
const EMPTY_ARRAY: readonly CollectionRecord[] = Object.freeze([])

const noopSubscribe = (_onStoreChange: () => void): (() => void) => {
	return () => {}
}

const disabledGetSnapshot = (): readonly CollectionRecord[] => EMPTY_ARRAY

/**
 * React hook for reactive queries against the local Kora store.
 *
 * Returns data synchronously from the local store — no loading spinners needed.
 * Re-renders automatically when the query results change due to mutations.
 * Uses `useSyncExternalStore` for React 18+ concurrent mode safety.
 *
 * @param query - A QueryBuilder instance (e.g., `store.collection('todos').where({ done: false })`)
 * @param options - Optional configuration (e.g., `{ enabled: false }` to skip the query)
 * @returns Readonly array of matching records
 *
 * @example
 * ```typescript
 * const todos = useQuery(app.todos.where({ completed: false }).orderBy('createdAt'))
 * ```
 */
export function useQuery(
	query: QueryBuilder,
	options?: UseQueryOptions,
): readonly CollectionRecord[] {
	const enabled = options?.enabled !== false

	// Compute a stable key from the query descriptor
	const descriptorKey = JSON.stringify(query.getDescriptor())

	// Track the current QueryStore instance
	const queryStoreRef = useRef<QueryStore | null>(null)
	const prevKeyRef = useRef<string | null>(null)

	// Create or reuse a QueryStore when the descriptor changes
	const queryStore = useMemo(() => {
		if (!enabled) {
			// Destroy previous if it exists
			if (queryStoreRef.current) {
				queryStoreRef.current.destroy()
				queryStoreRef.current = null
			}
			prevKeyRef.current = null
			return null
		}

		// If descriptor changed, destroy previous and create new
		if (prevKeyRef.current !== descriptorKey) {
			if (queryStoreRef.current) {
				queryStoreRef.current.destroy()
			}
			const newStore = new QueryStore(query)
			queryStoreRef.current = newStore
			prevKeyRef.current = descriptorKey
			return newStore
		}

		return queryStoreRef.current
	}, [descriptorKey, enabled, query])

	// Clean up on unmount
	useEffect(() => {
		return () => {
			if (queryStoreRef.current) {
				queryStoreRef.current.destroy()
				queryStoreRef.current = null
			}
		}
	}, [])

	return useSyncExternalStore(
		queryStore ? queryStore.subscribe : noopSubscribe,
		queryStore ? queryStore.getSnapshot : disabledGetSnapshot,
	)
}
