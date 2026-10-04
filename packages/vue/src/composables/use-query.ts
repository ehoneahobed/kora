import type { CollectionRecord, QueryBuilder, QueryStore } from '@korajs/store'
import { assertQueryReady, queryKey } from '@korajs/store'
import {
	type DeepReadonly,
	type MaybeRefOrGetter,
	type ShallowRef,
	readonly,
	shallowRef,
	toValue,
	watch,
} from 'vue'
import { useKoraContext } from '../context'
import type { UseQueryOptions, UseQueryStateResult } from '../types'

const EMPTY_ARRAY: readonly unknown[] = Object.freeze([])

/** A query input: a builder, a ref to one, or a getter (`() => app.todos.where(...)`). */
export type QueryInput<T> = MaybeRefOrGetter<QueryBuilder<T> | null | undefined>

/** The STORE-12 error channel of a QueryStore, read structurally (older store builds lack it). */
function readQueryError(queryStore: QueryStore<unknown>): Error | null {
	const channel = queryStore as unknown as { getError?: () => Error | null }
	return typeof channel.getError === 'function' ? channel.getError() : null
}

/**
 * Shared engine of {@link useQuery} and {@link useQueryState}: tracks the query and
 * `enabled` reactively (refs, getters, props), subscribes to one ref-counted
 * QueryStore per descriptor, and releases it when the descriptor changes or the
 * scope is disposed (DX-7).
 */
function useQuerySubscription<T>(
	query: QueryInput<T>,
	options: UseQueryOptions | undefined,
): {
	data: ShallowRef<readonly T[]>
	error: ShallowRef<Error | null>
	ready: ShallowRef<boolean>
} {
	const { queryStoreCache } = useKoraContext()
	const data = shallowRef<readonly T[]>(EMPTY_ARRAY as readonly T[])
	const error = shallowRef<Error | null>(null)
	const ready = shallowRef(false)

	watch(
		() => {
			const enabled = toValue(options?.enabled) !== false
			const current = enabled ? toValue(query) : null
			return current ? queryKey(current.getDescriptor()) : null
		},
		(key, _previous, onCleanup) => {
			const current = key ? toValue(query) : null
			if (!current) {
				data.value = EMPTY_ARRAY as readonly T[]
				error.value = null
				ready.value = false
				return
			}

			assertQueryReady(current as QueryBuilder<unknown>)
			const queryStore = queryStoreCache.getOrCreate(current)
			const sync = (): void => {
				const failure = readQueryError(queryStore as QueryStore<unknown>)
				if (failure !== error.value) {
					error.value = failure
					if (failure) options?.onError?.(failure)
				}
				if (queryStore.hasSnapshot()) {
					data.value = queryStore.getSnapshot()
					ready.value = true
				}
			}
			const unsubscribe = queryStore.subscribe(sync)
			// A descriptor switch keeps the previous rows until the new query answers.
			ready.value = false
			sync()

			onCleanup(() => {
				unsubscribe()
				queryStoreCache.release(current as QueryBuilder<unknown>)
			})
		},
		{ immediate: true },
	)

	return { data, error, ready }
}

/**
 * Reactive query composable backed by the local Kora store.
 *
 * The query and `enabled` may be plain values, refs or getters: pass a getter to
 * follow props or refs, and the composable re-subscribes when the query's descriptor
 * changes (and releases the old subscription). A failed query is reported through
 * `options.onError`, or `console.error` without one; use {@link useQueryState} to
 * render the error.
 *
 * @param query - A query builder, a ref to one, or a getter returning one (null disables)
 * @param options - `enabled` (value, ref or getter; default true) and `onError`
 * @returns A readonly shallow ref of the current rows
 *
 * @example
 * ```ts
 * const props = defineProps<{ done: boolean }>()
 * const todos = useQuery(() => app.todos.where({ completed: props.done }))
 * ```
 */
export function useQuery<T = CollectionRecord>(
	query: QueryInput<T>,
	options?: UseQueryOptions,
): DeepReadonly<ShallowRef<readonly T[]>> {
	const reporting: UseQueryOptions = {
		...options,
		onError:
			options?.onError ??
			((failure: Error) => {
				// Never swallowed: without a handler the failure is at least logged.
				console.error('[Kora] useQuery failed:', failure)
			}),
	}
	return readonly(useQuerySubscription(query, reporting).data)
}

/**
 * Like {@link useQuery}, but also returns the query's error and whether the first
 * result has arrived.
 *
 * @param query - A query builder, a ref to one, or a getter returning one
 * @param options - `enabled` and `onError`
 * @returns `{ data, error, ready }` as readonly refs
 */
export function useQueryState<T = CollectionRecord>(
	query: QueryInput<T>,
	options?: UseQueryOptions,
): UseQueryStateResult<T> {
	const { data, error, ready } = useQuerySubscription(query, options)
	return { data: readonly(data), error: readonly(error), ready: readonly(ready) }
}
