import type {
	KoraAppLike as CoreKoraAppLike,
	KoraContextValue as CoreKoraContextValue,
	UseMutationOptions as CoreUseMutationOptions,
	UseQueryOptions as CoreUseQueryOptions,
	UseMutationResultBase,
} from '@korajs/core/bindings'
import type { QueryStoreCache, Store } from '@korajs/store'
import type { CursorInfo, SyncEngine, SyncStatusInfo } from '@korajs/sync'
import type { DeepReadonly, MaybeRefOrGetter, ShallowRef, VNode } from 'vue'
import type * as Y from 'yjs'

export type KoraAppLike = CoreKoraAppLike<Store, SyncEngine, QueryStoreCache>
export type KoraContextValue = CoreKoraContextValue<Store, SyncEngine, QueryStoreCache>
/** Options for `useQuery` and `useQueryState`. */
export interface UseQueryOptions extends Omit<CoreUseQueryOptions, 'enabled'> {
	/** When false, the query subscription is disabled. A value, ref or getter. Defaults to true. */
	enabled?: MaybeRefOrGetter<boolean | undefined>
	/** Called when the query fails (STORE-12). `useQuery` logs to `console.error` without it. */
	onError?: (error: Error) => void
}

/** Result of `useQueryState`. */
export interface UseQueryStateResult<T> {
	/** The current rows (the last good rows while `error` is set). */
	data: DeepReadonly<ShallowRef<readonly T[]>>
	/** The query's failure, or null. Cleared when results flow again. */
	error: Readonly<ShallowRef<Error | null>>
	/** False until the first result for the current query arrived. */
	ready: Readonly<ShallowRef<boolean>>
}
export type UseMutationOptions<
	TData,
	TArgs extends unknown[],
	TContext = void,
> = CoreUseMutationOptions<TData, TArgs, TContext>

export interface KoraProviderProps {
	app?: KoraAppLike
	store?: Store
	syncEngine?: SyncEngine | null
	fallback?: VNode | string | null
}

export interface UseMutationResult<TData, TArgs extends unknown[]>
	extends UseMutationResultBase<TData, TArgs> {
	isLoading: Readonly<{ value: boolean }>
	error: Readonly<{ value: Error | null }>
}

/** @deprecated Use {@link KoraAppLike} via {@link useApp}. */
export type KoraAppHandle = KoraAppLike

export interface UseRichTextResult {
	doc: Y.Doc
	text: Y.Text
	undo: () => void
	redo: () => void
	canUndo: boolean
	canRedo: boolean
	ready: boolean
	error: Error | null
	cursors: CursorInfo[]
	setCursor: (anchor: number, head: number) => void
	clearCursor: () => void
}
