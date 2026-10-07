import type {
	KoraAppLike as CoreKoraAppLike,
	KoraContextValue as CoreKoraContextValue,
	UseMutationOptions as CoreUseMutationOptions,
	UseQueryOptions as CoreUseQueryOptions,
	UseMutationResultBase,
} from '@korajs/core/bindings'
import type { QueryStoreCache, Store } from '@korajs/store'
import type { CursorInfo, SyncEngine, SyncStatusInfo } from '@korajs/sync'
import type { Readable } from 'svelte/store'
import type * as Y from 'yjs'

export type KoraAppLike = CoreKoraAppLike<Store, SyncEngine, QueryStoreCache>
export type KoraContextValue = CoreKoraContextValue<Store, SyncEngine, QueryStoreCache>
/** Options for `createQueryStore` and `createQueryStateStore`. */
export interface UseQueryOptions extends Omit<CoreUseQueryOptions, 'enabled'> {
	/** When false, the query subscription is disabled. A value or a readable store. Defaults to true. */
	enabled?: boolean | Readable<boolean>
	/** Called when the query fails (STORE-12). `createQueryStore` logs to `console.error` without it. */
	onError?: (error: Error) => void
}

/** Value of `createQueryStateStore`. */
export interface QueryState<T> {
	/** The current rows (the last good rows while `error` is set). */
	data: readonly T[]
	/** The query's failure, or null. Cleared when results flow again. */
	error: Error | null
	/** False until the first result for the current query arrived. */
	ready: boolean
}
export type UseMutationOptions<
	TData,
	TArgs extends unknown[],
	TContext = void,
> = CoreUseMutationOptions<TData, TArgs, TContext>

export interface UseMutationResult<TData, TArgs extends unknown[]>
	extends UseMutationResultBase<TData, TArgs> {
	subscribeLoading: (fn: (value: boolean) => void) => () => void
	subscribeError: (fn: (value: Error | null) => void) => () => void
	readonly loading: boolean
	readonly isLoading: boolean
	readonly error: Error | null
}

/** @deprecated Use {@link KoraAppLike}. */
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
	/**
	 * True while local edits are not saved yet (a save pending or refused; see
	 * `error`). The edits stay in the document and the next edit saves them again.
	 */
	hasUnsavedChanges: boolean
	/** Save the document now, for example after a refused save. */
	retrySave: () => Promise<void>
	/** The full document state while edits are unsaved (for a recovery copy), else null. */
	getUnsavedState: () => Uint8Array | null
}
