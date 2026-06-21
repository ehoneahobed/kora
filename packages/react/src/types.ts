import type { KoraEventEmitter } from '@korajs/core'
import type { Store } from '@korajs/store'
import type { CursorInfo, SyncEngine, SyncStatusInfo } from '@korajs/sync'
import type { ReactNode } from 'react'
import type * as Y from 'yjs'

/**
 * A Kora application instance returned by createApp().
 * Defined here to avoid a hard dependency on the kora meta-package.
 */
export interface KoraAppLike {
	/** Resolves when the store is open and collections are ready. */
	ready: Promise<void>
	/** Framework event emitter (sync, store, merge, query). */
	events?: KoraEventEmitter
	/** Sync control when sync is configured. */
	sync?: {
		subscribeStatus(listener: (status: SyncStatusInfo) => void): () => void
	} | null
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
	/** The KoraApp instance (when provided via app prop). */
	app: KoraAppLike | null
	/** App event emitter (when using app prop). */
	events: KoraEventEmitter | null
	/** Event-driven sync status subscription from app.sync. */
	subscribeSyncStatus: ((listener: (status: SyncStatusInfo) => void) => () => void) | null
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
 * Options for optimistic updates and rollback in {@link useMutation}.
 */
export interface UseMutationOptions<TData, TArgs extends unknown[], TContext = void> {
	/**
	 * Runs before the mutation. Return a context value for rollback.
	 */
	onMutate?: (...args: TArgs) => TContext | Promise<TContext>
	/**
	 * Reverts optimistic changes when the mutation fails.
	 */
	onRollback?: (context: TContext, ...args: TArgs) => void | Promise<void>
	/** Called when the mutation succeeds. */
	onSuccess?: (data: TData, ...args: TArgs) => void
	/** Called when the mutation fails (after optional rollback). */
	onError?: (error: Error, ...args: TArgs) => void
	/** Called after success or failure. */
	onSettled?: (data: TData | undefined, error: Error | null, ...args: TArgs) => void
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
	/** Remote collaborators' cursor positions in this field. Empty if no sync engine. */
	cursors: CursorInfo[]
	/** Publish local cursor/selection to connected collaborators. No-op without sync. */
	setCursor: (anchor: number, head: number) => void
	/** Clear local cursor presence for this field. */
	clearCursor: () => void
}
