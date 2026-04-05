import type { Store } from '@korajs/store'
import type { SyncEngine } from '@korajs/sync'
import type { ReactNode } from 'react'
import type * as Y from 'yjs'

/**
 * A Kora application instance returned by createApp().
 * Defined here to avoid a hard dependency on the kora meta-package.
 */
export interface KoraAppLike {
	/** Resolves when the store is open and collections are ready. */
	ready: Promise<void>
	/** Get the underlying Store instance. */
	getStore(): Store
	/** Get the underlying SyncEngine instance. Null if sync not configured. */
	getSyncEngine(): SyncEngine | null
}

/**
 * Value provided by KoraProvider via React context.
 */
export interface KoraContextValue {
	/** The local Kora store instance */
	store: Store
	/** Optional sync engine for remote synchronization */
	syncEngine: SyncEngine | null
}

/**
 * Props for the KoraProvider component.
 *
 * Accepts either an `app` instance (recommended, from createApp()) or
 * explicit `store` + `syncEngine` props (advanced use case).
 */
export interface KoraProviderProps {
	/** A KoraApp instance from createApp(). Extracts store and syncEngine automatically. */
	app?: KoraAppLike
	/** The local Kora store instance (alternative to app prop). */
	store?: Store
	/** Optional sync engine for remote synchronization (used with store prop). */
	syncEngine?: SyncEngine | null
	/** Fallback content to render while app.ready is resolving. Defaults to null. */
	fallback?: ReactNode
	/** Child components */
	children?: ReactNode
}

/**
 * Options for the useQuery hook.
 */
export interface UseQueryOptions {
	/** Set to false to disable the subscription (query won't execute). Defaults to true. */
	enabled?: boolean
}

/**
 * Result from the useMutation hook.
 */
export interface UseMutationResult<TData, TArgs extends unknown[]> {
	/** Fire-and-forget mutation. Catches errors silently (sets error state). */
	mutate: (...args: TArgs) => void
	/** Promise-returning mutation. Throws on error. */
	mutateAsync: (...args: TArgs) => Promise<TData>
	/** Whether a mutation is currently in progress */
	isLoading: boolean
	/** The last error that occurred, or null */
	error: Error | null
	/** Reset isLoading and error state */
	reset: () => void
}

/**
 * Result from the useRichText hook.
 */
export interface UseRichTextResult {
	/** Shared Yjs document backing this field. */
	doc: Y.Doc
	/** Y.Text instance to bind to editor integrations. */
	text: Y.Text
	/** Undo local changes made to this richtext field. */
	undo: () => void
	/** Redo previously undone local changes. */
	redo: () => void
	/** True when undo can be applied. */
	canUndo: boolean
	/** True when redo can be applied. */
	canRedo: boolean
	/** True once the record field has been loaded into the Y.Doc. */
	ready: boolean
	/** Last hook error (load/persist), if any. */
	error: Error | null
}
