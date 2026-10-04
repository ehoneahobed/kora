import type { CollectionRecord, QueryBuilder, QueryStore, QueryStoreCache } from '@korajs/store'
import { assertQueryReady, queryKey } from '@korajs/store'
import { type Readable, readable } from 'svelte/store'
import { getKoraContext } from '../context'
import type { QueryState, UseQueryOptions } from '../types'

const EMPTY_ARRAY: readonly unknown[] = Object.freeze([])

/** A query input: a builder, or a readable store of one (null disables). */
export type QueryInput<T> = QueryBuilder<T> | Readable<QueryBuilder<T> | null | undefined>

function isQueryBuilder<T>(input: QueryInput<T>): input is QueryBuilder<T> {
	return typeof (input as { getDescriptor?: unknown }).getDescriptor === 'function'
}

function isReadable<V>(input: V | Readable<V>): input is Readable<V> {
	return (
		typeof input === 'object' &&
		input !== null &&
		typeof (input as { subscribe?: unknown }).subscribe === 'function'
	)
}

/** The STORE-12 error channel of a QueryStore, read structurally (older store builds lack it). */
function readQueryError(queryStore: QueryStore<unknown>): Error | null {
	const channel = queryStore as unknown as { getError?: () => Error | null }
	return typeof channel.getError === 'function' ? channel.getError() : null
}

/**
 * Follows the query and `enabled` inputs (values or readable stores), holding one
 * ref-counted QueryStore per descriptor and switching when the descriptor changes
 * (DX-7). Returns the teardown.
 */
function followQuery<T>(
	cache: QueryStoreCache,
	query: QueryInput<T>,
	options: UseQueryOptions | undefined,
	emit: (state: QueryState<T>) => void,
): () => void {
	let current: QueryBuilder<T> | null = isQueryBuilder(query) ? query : null
	const enabledInput = options?.enabled
	let enabled = isReadable(enabledInput) ? true : enabledInput !== false
	let activeKey: string | null = null
	let release: (() => void) | null = null
	let state: QueryState<T> = {
		data: EMPTY_ARRAY as readonly T[],
		error: null,
		ready: false,
	}

	const publish = (next: QueryState<T>): void => {
		if (next.data === state.data && next.error === state.error && next.ready === state.ready) {
			return
		}
		if (next.error && next.error !== state.error) options?.onError?.(next.error)
		state = next
		emit(state)
	}

	const apply = (): void => {
		const key = enabled && current ? queryKey(current.getDescriptor()) : null
		if (key === activeKey) return
		release?.()
		release = null
		activeKey = key
		if (!key || !current) {
			publish({ data: EMPTY_ARRAY as readonly T[], error: null, ready: false })
			return
		}
		const builder = current
		assertQueryReady(builder as QueryBuilder<unknown>)
		const queryStore = cache.getOrCreate(builder)
		const sync = (): void => {
			const loaded = queryStore.hasSnapshot()
			publish({
				// A descriptor switch keeps the previous rows until the new query answers.
				data: loaded ? queryStore.getSnapshot() : state.data,
				error: readQueryError(queryStore as QueryStore<unknown>),
				ready: loaded,
			})
		}
		const unsubscribe = queryStore.subscribe(sync)
		sync()
		release = () => {
			unsubscribe()
			cache.release(builder as QueryBuilder<unknown>)
		}
	}

	const stops: Array<() => void> = []
	if (!isQueryBuilder(query)) {
		stops.push(
			query.subscribe((next) => {
				current = next ?? null
				apply()
			}),
		)
	}
	if (isReadable(enabledInput)) {
		stops.push(
			enabledInput.subscribe((next) => {
				enabled = next !== false
				apply()
			}),
		)
	}
	apply()

	return () => {
		for (const stop of stops) stop()
		release?.()
		release = null
		activeKey = null
	}
}

/**
 * Create a Svelte readable store of a Kora query's rows.
 *
 * The query and `enabled` may be plain values or readable stores: pass a store (for
 * example a `derived` of your filter) and the rows follow it, re-subscribing when the
 * query's descriptor changes. A failed query is reported through `options.onError`,
 * or `console.error` without one; use {@link createQueryStateStore} to render it.
 *
 * @param query - A query builder, or a readable store of one (null disables)
 * @param options - `enabled` (value or readable store; default true) and `onError`
 * @returns A readable store of the current rows
 *
 * @example
 * ```ts
 * const filter = writable(false)
 * const todos = createQueryStore(derived(filter, (done) => app.todos.where({ completed: done })))
 * ```
 */
export function createQueryStore<T = CollectionRecord>(
	query: QueryInput<T>,
	options?: UseQueryOptions,
): Readable<readonly T[]> {
	const { queryStoreCache } = getKoraContext()
	const reporting: UseQueryOptions = {
		...options,
		onError:
			options?.onError ??
			((failure: Error) => {
				// Never swallowed: without a handler the failure is at least logged.
				reportUnhandled(failure)
			}),
	}
	return readable<readonly T[]>(EMPTY_ARRAY as readonly T[], (set) =>
		followQuery(queryStoreCache, query, reporting, (state) => set(state.data)),
	)
}

/**
 * Like {@link createQueryStore}, but the store holds `{ data, error, ready }`.
 *
 * @param query - A query builder, or a readable store of one
 * @param options - `enabled` and `onError`
 * @returns A readable store of the query state
 */
export function createQueryStateStore<T = CollectionRecord>(
	query: QueryInput<T>,
	options?: UseQueryOptions,
): Readable<QueryState<T>> {
	const { queryStoreCache } = getKoraContext()
	const initial: QueryState<T> = { data: EMPTY_ARRAY as readonly T[], error: null, ready: false }
	return readable<QueryState<T>>(initial, (set) =>
		followQuery(queryStoreCache, query, options, set),
	)
}

/**
 * Logs a query failure nobody handles. Read through globalThis because this package
 * builds without DOM or Node typings.
 */
function reportUnhandled(failure: Error): void {
	const host = globalThis as { console?: { error(...args: unknown[]): void } }
	host.console?.error('[Kora] createQueryStore failed:', failure)
}

/** Alias for {@link createQueryStore}. */
export const useQuery = createQueryStore

/** Alias for {@link createQueryStateStore}. */
export const useQueryState = createQueryStateStore
