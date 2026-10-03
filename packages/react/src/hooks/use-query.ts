import type { CollectionRecord, QueryBuilder, QueryStore } from '@korajs/store'
import { assertQueryReady } from '@korajs/store'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useKoraContext } from '../context/kora-context'
import type { UseQueryOptions, UseQueryStateResult } from '../types'

const EMPTY_ARRAY: readonly unknown[] = Object.freeze([])

const noopSubscribe = (_onStoreChange: () => void): (() => void) => {
	return () => {}
}

// Server renders and the hydration pass have no local database: they render the
// empty list, and the client fills it in after hydration (DX-6).
const getServerSnapshot = (): readonly never[] => EMPTY_ARRAY as readonly never[]
const getNoError = (): Error | null => null

/**
 * The error channel a QueryStore exposes (STORE-12). Read structurally so this
 * binding works against a store build that predates it (no error state, as before).
 */
interface QueryStoreErrorChannel {
	getError?: () => Error | null
}

function readQueryError(queryStore: QueryStore<unknown> | null): Error | null {
	if (!queryStore) return null
	const channel = queryStore as unknown as QueryStoreErrorChannel
	return typeof channel.getError === 'function' ? channel.getError() : null
}

interface QuerySubscription<T> {
	data: readonly T[]
	error: Error | null
	ready: boolean
}

/**
 * Shared engine of {@link useQuery} and {@link useQueryState}: one ref-counted
 * QueryStore per query descriptor, read through useSyncExternalStore with stable
 * subscribe/getSnapshot, so a render never tears and an unchanged result never
 * re-renders.
 */
function useQuerySubscription<T>(
	query: QueryBuilder<T>,
	options: UseQueryOptions | undefined,
): QuerySubscription<T> {
	const { queryStoreCache } = useKoraContext()
	const enabled = options?.enabled !== false
	const descriptorKey = JSON.stringify(query.getDescriptor())
	const queryRef = useRef(query)
	queryRef.current = query
	const lastSnapshotRef = useRef<readonly T[]>(EMPTY_ARRAY as readonly T[])

	const [queryStore, setQueryStore] = useState<QueryStore<T> | null>(null)

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

	// The store's own subscribe is a stable arrow per QueryStore, so React subscribes
	// once per store, not once per render.
	const subscribe = enabled && queryStore ? queryStore.subscribe : noopSubscribe

	const getSnapshot = useCallback((): readonly T[] => {
		if (!enabled) {
			lastSnapshotRef.current = EMPTY_ARRAY as readonly T[]
			return lastSnapshotRef.current
		}
		if (!queryStore || !queryStore.hasSnapshot()) {
			// Keep the previous result while a new descriptor loads: no flash of empty.
			return lastSnapshotRef.current
		}
		const snapshot = queryStore.getSnapshot()
		lastSnapshotRef.current = snapshot
		return snapshot
	}, [enabled, queryStore])

	const getError = useCallback(
		(): Error | null => (enabled ? readQueryError(queryStore as QueryStore<unknown> | null) : null),
		[enabled, queryStore],
	)

	const data = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot as () => readonly T[])
	const error = useSyncExternalStore(subscribe, getError, getNoError)
	const ready = enabled && queryStore !== null && queryStore.hasSnapshot()

	return { data, error, ready }
}

/**
 * React hook for reactive queries against the local Kora store.
 *
 * Returns the current rows synchronously (no loading state for local data) and
 * re-renders only when the result set changes. The array keeps its identity while
 * the result is unchanged. On the server (`renderToString`, Next.js App Router) and
 * during hydration it returns `[]`; the rows arrive right after hydration.
 *
 * A query that fails (for example a where/orderBy on an unknown field) is thrown to
 * the nearest React error boundary, so the failure is visible instead of an empty
 * list. Pass `throwOnError: false`, or use {@link useQueryState}, to handle it inline.
 *
 * @param query - A query builder, for example `app.todos.where({ completed: false })`
 * @param options - `enabled` (default true) and `throwOnError` (default true)
 * @returns The current result rows
 *
 * @example
 * ```tsx
 * const todos = useQuery(app.todos.where({ completed: false }).orderBy('createdAt'))
 * ```
 */
export function useQuery<T = CollectionRecord>(
	query: QueryBuilder<T>,
	options?: UseQueryOptions,
): readonly T[] {
	const { data, error } = useQuerySubscription(query, options)
	if (error && options?.throwOnError !== false) {
		throw error
	}
	return data
}

/**
 * Like {@link useQuery}, but returns the error instead of throwing it.
 *
 * @param query - A query builder
 * @param options - `enabled` (default true); `throwOnError` is ignored
 * @returns `{ data, error, ready }`, the same object until one of them changes.
 *   `ready` is false until the first result for the current query has arrived.
 *
 * @example
 * ```tsx
 * const { data: todos, error } = useQueryState(app.todos.where({ completed: false }))
 * if (error) return <p role="alert">{error.message}</p>
 * ```
 */
export function useQueryState<T = CollectionRecord>(
	query: QueryBuilder<T>,
	options?: UseQueryOptions,
): UseQueryStateResult<T> {
	const { data, error, ready } = useQuerySubscription(query, options)
	return useMemo(() => ({ data, error, ready }), [data, error, ready])
}
