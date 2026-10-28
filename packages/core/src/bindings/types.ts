import type { KoraEventEmitter } from '../events/events'
import type { OfflineStatus } from '../offline/offline-status'
import type { ScopeMap } from '../scopes/build-scope-map'

/** Sync status shape consumed by framework binding hooks (matches {@link SyncStatusInfo} in `@korajs/sync`). */
export interface KoraBindingSyncStatus {
	status:
		| 'connected'
		| 'reconnecting'
		| 'syncing'
		| 'synced'
		| 'offline'
		| 'error'
		| 'schema-mismatch'
		| 'clock-error'
		| 'auth-required'
		| 'encryption-locked'
	reconnecting: boolean
	pendingOperations: number
	lastSyncedAt: number | null
	lastSuccessfulPush: number | null
	lastSuccessfulPull: number | null
	conflicts: number
	/** serverTime - localTime in ms at last handshake; negative = device clock is fast. */
	clockSkewMs: number | null
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
	/** Offline readiness (`app.offline`); absent on apps built before it existed. */
	offline?: {
		status(): OfflineStatus
		subscribe(listener: (status: OfflineStatus) => void): () => void
	}
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
	/**
	 * The server permanently refused this write, possibly long after it resolved locally
	 * (offline, then synced later). Called at most once per write, while the component
	 * that made it is mounted. See {@link MutationRejection}.
	 */
	onRejected?: (rejection: MutationRejection<TArgs>) => void
}

/**
 * A write made through `useMutation` that the sync server permanently refused.
 *
 * One `mutate()` call is one write: every operation the call committed, including a
 * delete's referential cascades and every operation of an `app.transaction()` /
 * `app.mutation()` it ran. The first refused operation of the write is reported.
 */
export interface MutationRejection<TArgs extends unknown[] = unknown[]> {
	/** Stable, machine-readable reason (`WINDOW_CLOSED`, `ACCESS_DENIED`, `SCOPE_RETRACTED`, ...). */
	code: string
	/** Human-readable reason from the server (or the device, for scope refusals). */
	message: string
	/** Collection of the refused operation. */
	collection: string
	/** Record of the refused operation. */
	recordId: string
	/** Id of the refused operation. */
	operationId: string
	/** Every operation id the write produced, in commit order (several for a transaction). */
	operationIds: readonly string[]
	/**
	 * True when the device already undid the refused operation: the record shows what
	 * the server holds again. False when the write is kept locally but not synced
	 * (`OUT_OF_UPLINK_SCOPE`, `NODE_ID_MISMATCH`, `SEQUENCE_CONFLICT`).
	 */
	reverted: boolean
	/** The arguments the write was called with. */
	args: TArgs
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
	/**
	 * Returns the access token for sync handshake (empty string when signed out).
	 * Called with `{ forceRefresh: true }` after the server ended the session with
	 * `AUTH_EXPIRED` / `AUTH_REVOKED`: refresh instead of returning the cached token.
	 */
	auth: (options?: { forceRefresh?: boolean }) => Promise<{ token: string }>
	/** Resolve whether sync may currently open a transport. Tokens are never used as readiness signals. */
	resolveSyncState?: () => Promise<AuthSyncState>
	/** Builds a scope map from the current token and schema. */
	resolveScopeMap?: () => Promise<ScopeMap | undefined>
	/**
	 * Returns the device-bound sync node id from the token `dev` claim.
	 * Separate from the user id (`sub`).
	 */
	resolveNodeId?: () => Promise<string | undefined>
	/** Returns the authenticated user id used for local store namespacing. */
	resolveUserId?: () => Promise<string | undefined>
	/** Notifies when auth state changes so sync can refresh scope or reconnect. */
	subscribe?: (listener: () => void) => () => void
}

/** Authentication state consumed by the sync and auth-isolated store lifecycles. */
export type AuthSyncState =
	| { state: 'loading' }
	| { state: 'signed-out'; mayConnectAnonymously: false }
	| { state: 'anonymous'; mayConnectAnonymously: true }
	| {
			state: 'authenticated'
			userId: string
			/**
			 * Fresh access token, or null while authenticated-offline: the identity
			 * is known from stored credentials but no fresh token can be minted now.
			 * The local store opens either way; a sync transport waits for a token.
			 */
			token: string | null
			/** Device id of the stored credentials, when known. */
			deviceId?: string
			/** True while the session is authenticated-offline (or locked). */
			offline?: boolean
			/**
			 * True when the offline grace period ran out or the device clock moved
			 * backwards. The UI should lock; local data is never wiped.
			 */
			locked?: boolean
	  }
