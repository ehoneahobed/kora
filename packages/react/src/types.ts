import type {
	KoraAppLike as CoreKoraAppLike,
	KoraContextValue as CoreKoraContextValue,
	UseMutationOptions as CoreUseMutationOptions,
	UseMutationResultBase,
	UseQueryOptions as CoreUseQueryOptions,
} from '@korajs/core/bindings'
import type { Store, QueryStoreCache } from '@korajs/store'
import type { CursorInfo, SyncEngine, SyncStatusInfo } from '@korajs/sync'
import type { ReactNode } from 'react'
import type * as Y from 'yjs'

export type KoraAppLike = CoreKoraAppLike<Store, SyncEngine, QueryStoreCache>
export type KoraContextValue = CoreKoraContextValue<Store, SyncEngine, QueryStoreCache>
export type UseQueryOptions = CoreUseQueryOptions
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
}
