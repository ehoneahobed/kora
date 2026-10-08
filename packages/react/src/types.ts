import type {
	KoraAppLike as CoreKoraAppLike,
	KoraContextValue as CoreKoraContextValue,
	UseMutationOptions as CoreUseMutationOptions,
	UseQueryOptions as CoreUseQueryOptions,
	UseMutationResultBase,
} from '@korajs/core/bindings'
import type { QueryStoreCache, Store } from '@korajs/store'
import type { CursorInfo, SyncEngine, SyncStatusInfo } from '@korajs/sync'
import type { ReactNode } from 'react'
import type * as Y from 'yjs'

export type KoraAppLike = CoreKoraAppLike<Store, SyncEngine, QueryStoreCache>
export type KoraContextValue = CoreKoraContextValue<Store, SyncEngine, QueryStoreCache>
/** Options for {@link useQuery} and {@link useQueryState}. */
export interface UseQueryOptions extends CoreUseQueryOptions {
	/**
	 * When true (default), `useQuery` throws a failed query to the nearest error
	 * boundary. When false it keeps returning the last good rows; read the error with
	 * `useQueryState`. Ignored by `useQueryState`, which always returns the error.
	 */
	throwOnError?: boolean
}

/** Result of `useQueryState`. */
export interface UseQueryStateResult<T> {
	/** The current rows (the last good rows while `error` is set). */
	data: readonly T[]
	/** The query's failure, or null. Cleared when results flow again. */
	error: Error | null
	/** False until the first result for the current query arrived (always false on the server). */
	ready: boolean
}
export type UseMutationOptions<
	TData,
	TArgs extends unknown[],
	TContext = void,
> = CoreUseMutationOptions<TData, TArgs, TContext>

/**
 * Props for the KoraProvider component.
 *
 * Accepts either an `app` instance (recommended, from createApp()) or
 * explicit `store` + `syncEngine` props (advanced use case).
 */
export interface KoraProviderProps {
	app?: KoraAppLike
	store?: Store
	syncEngine?: SyncEngine | null
	fallback?: ReactNode
	children?: ReactNode
}

export interface UseMutationResult<TData, TArgs extends unknown[]>
	extends UseMutationResultBase<TData, TArgs> {
	isLoading: boolean
	error: Error | null
}

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
