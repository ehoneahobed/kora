import type { CollectionRecord, QueryBuilder } from '@kora/store'
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { QueryStore } from '../query-store/query-store'
import type { UseQueryOptions } from '../types'

/**
 * Frozen empty array returned when the query is disabled or before data loads.
 * Same reference prevents unnecessary re-renders.
 */
const EMPTY_ARRAY: readonly unknown[] = Object.freeze([])

const noopSubscribe = (_onStoreChange: () => void): (() => void) => {
	return () => {}
}

/**
 * React hook for reactive queries against the local Kora store.
 *
 * Returns data synchronously from the local store — no loading spinners needed.
 * Re-renders automatically when the query results change due to mutations.
 * Uses `useSyncExternalStore` for React 18+ concurrent mode safety.
 *
 * The generic parameter `T` is inferred from the QueryBuilder, providing
 * full type safety when used with typed collection accessors.
 *
 * @param query - A QueryBuilder instance (e.g., `app.todos.where({ done: false })`)
 * @param options - Optional configuration (e.g., `{ enabled: false }` to skip the query)
 * @returns Readonly array of matching records
 *
 * @example
 * ```typescript
 * const todos = useQuery(app.todos.where({ completed: false }).orderBy('createdAt'))
 * // todos is typed as readonly InferRecord<typeof todoFields>[]
 * ```
 */
export function useQuery<T = CollectionRecord>(
	query: QueryBuilder<T>,
	options?: UseQueryOptions,
): readonly T[] {
	const enabled = options?.enabled !== false

	// Compute a stable key from the query descriptor
	const descriptorKey = JSON.stringify(query.getDescriptor())

	// Track the current QueryStore instance
	const queryStoreRef = useRef<QueryStore<T> | null>(null)
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
			const newStore = new QueryStore<T>(query)
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

	const disabledGetSnapshot = (): readonly T[] => EMPTY_ARRAY as readonly T[]

	return useSyncExternalStore(
		queryStore ? queryStore.subscribe : noopSubscribe,
		queryStore ? queryStore.getSnapshot : disabledGetSnapshot,
	)
}
