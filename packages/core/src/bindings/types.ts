import type { KoraEventEmitter } from '../events/events'
import type { ScopeMap } from '../scopes/build-scope-map'

/** Sync status shape consumed by framework binding hooks (matches {@link SyncStatusInfo} in `@korajs/sync`). */
export interface KoraBindingSyncStatus {
	status: 'connected' | 'syncing' | 'synced' | 'offline' | 'error' | 'schema-mismatch'
	pendingOperations: number
	lastSyncedAt: number | null
	lastSuccessfulPush: number | null
	lastSuccessfulPull: number | null
	conflicts: number
}

/** Minimal sync bridge surface exposed on `createApp().sync`. */
export interface KoraBindingSyncBridge {
	subscribeStatus(listener: (status: KoraBindingSyncStatus) => void): () => void
}

/**
 * Structural type for a Kora application instance from `createApp()`.
 * Framework packages specialize `TStore` and `TSyncEngine` with concrete types.
 */
export interface KoraAppLike<TStore = unknown, TSyncEngine = unknown, TQueryCache = unknown> {
	ready: Promise<void>
	events?: KoraEventEmitter
	sync?: KoraBindingSyncBridge | null
	getStore(): TStore
	getSyncEngine(): TSyncEngine | null
	getQueryStoreCache?(): TQueryCache
}

/** Value provided by framework `KoraProvider` implementations. */
export interface KoraContextValue<TStore = unknown, TSyncEngine = unknown, TQueryCache = unknown> {
	store: TStore
	syncEngine: TSyncEngine | null
	app: KoraAppLike<TStore, TSyncEngine, TQueryCache> | null
	events: KoraEventEmitter | null
	subscribeSyncStatus: KoraBindingSyncBridge['subscribeStatus'] | null
	queryStoreCache: TQueryCache
}

/** Options for reactive query bindings (`useQuery`, `createQueryStore`, etc.). */
export interface UseQueryOptions {
	/** When false, the query subscription is disabled. Defaults to true. */
	enabled?: boolean
}

/** Optimistic mutation lifecycle callbacks shared across framework bindings. */
export interface UseMutationOptions<TData, TArgs extends unknown[], TContext = void> {
	onMutate?: (...args: TArgs) => TContext | Promise<TContext>
	onRollback?: (context: TContext, ...args: TArgs) => void | Promise<void>
	onSuccess?: (data: TData, ...args: TArgs) => void
	onError?: (error: Error, ...args: TArgs) => void
	onSettled?: (data: TData | undefined, error: Error | null, ...args: TArgs) => void
}

/** Common mutation result surface (React uses plain values; Vue/Svelte extend this). */
export interface UseMutationResultBase<TData, TArgs extends unknown[]> {
	mutate: (...args: TArgs) => void
	mutateAsync: (...args: TArgs) => Promise<TData>
	reset: () => void
}

/**
 * Pre-built auth binding for `createApp({ sync: { authClient } })`.
 * Created by `createKoraAuthSync()` in `@korajs/auth`.
 */
export interface AuthSyncBinding {
	/** Returns the access token for sync handshake (empty string when signed out). */
	auth: () => Promise<{ token: string }>
	/** Builds a scope map from the current token and schema. */
	resolveScopeMap?: () => Promise<ScopeMap | undefined>
	/**
	 * Returns the device-bound sync node id from the token `dev` claim.
	 * Separate from the user id (`sub`).
	 */
	resolveNodeId?: () => Promise<string | undefined>
	/** Notifies when auth state changes so sync can refresh scope or reconnect. */
	subscribe?: (listener: () => void) => () => void
}
