import type { Operation, VersionVector } from '@korajs/core'
import { KoraError } from '@korajs/core'
import type { SyncEncryptionConfig } from './encryption/types'

// Re-export for convenience — consumers can import from '@korajs/sync' types
export type { SyncEncryptionConfig }

/**
 * Internal sync engine states. Used for state machine transitions.
 */
export const SYNC_STATES = [
	'disconnected',
	'connecting',
	'handshaking',
	'syncing',
	'streaming',
	'error',
] as const
export type SyncState = (typeof SYNC_STATES)[number]

/**
 * Developer-facing sync status. Simplified view of the internal state.
 */
export const SYNC_STATUSES = [
	'connected',
	'syncing',
	'synced',
	'offline',
	'clock-error',
	'error',
	'schema-mismatch',
] as const
export type SyncStatus = (typeof SYNC_STATUSES)[number]

/**
 * Sync status information exposed to developers.
 */
export interface SyncStatusInfo {
	/** Current developer-facing status */
	status: SyncStatus
	/** Number of operations waiting to be sent */
	pendingOperations: number
	/** Timestamp of last successful sync (null if never synced) */
	lastSyncedAt: number | null
	/** Timestamp of last successful push to the server (null if never pushed) */
	lastSuccessfulPush: number | null
	/** Timestamp of last successful pull from the server (null if never pulled) */
	lastSuccessfulPull: number | null
	/** Number of merge conflicts encountered during this session */
	conflicts: number
	/** serverTime - localTime in ms measured at the last handshake, or null before first connect. Negative = this device's clock is fast. */
	clockSkewMs: number | null
}

/**
 * Per-collection sync scope map. Maps collection names to field-value filters.
 * Empty filter `{}` means no restriction (all records visible).
 * Missing collection means hidden (no records visible for that collection).
 */
export type SyncScopeMap = Record<string, Record<string, unknown>>

/**
 * Sync configuration provided by the developer.
 */
export interface SyncConfig {
	/** WebSocket or HTTP URL for the sync server */
	url: string
	/** Transport type to use. Defaults to 'websocket'. */
	transport?: 'websocket' | 'http'
	/** Auth provider function. Called before each connection attempt. */
	auth?: () => Promise<{ token: string }>
	/** Sync scopes per collection. Limits which records sync to this client. */
	scopes?: Record<string, (ctx: SyncScopeContext) => Record<string, unknown>>
	/**
	 * Pre-computed per-collection sync scope map. Sent to the server in the handshake.
	 * Built automatically by createApp from schema scope declarations + flat scope values.
	 */
	scopeMap?: SyncScopeMap
	/** Number of operations per batch. Defaults to 100. */
	batchSize?: number
	/** Initial reconnection delay in ms. Defaults to 1000. */
	reconnectInterval?: number
	/** Maximum reconnection delay in ms. Defaults to 30000. */
	maxReconnectInterval?: number
	/** Schema version of this client. */
	schemaVersion?: number
	/** Start sync automatically when the engine is created. Defaults to false. */
	autoConnect?: boolean
	/**
	 * When true, wait for server ACKs on all outbound handshake delta batches before
	 * entering streaming. Improves backpressure for large initial syncs.
	 */
	strictHandshake?: boolean
	/** Optional operation transforms for cross-schema-version sync. */
	operationTransforms?: import('@korajs/core').OperationTransform[]
	/**
	 * Richtext snapshot size (bytes) at which the optional Yjs doc channel is used.
	 * Defaults to 4096.
	 */
	richtextDocChannelThreshold?: number
	/**
	 * End-to-end encryption configuration.
	 * When enabled, `data` and `previousData` fields are encrypted before sending
	 * over the wire. The server never sees plaintext user data.
	 */
	encryption?: SyncEncryptionConfig
}

/**
 * Context passed to sync scope functions.
 */
export interface SyncScopeContext {
	userId?: string
	[key: string]: unknown
}

/**
 * Persists last-acked server version vector and computes unsynced operations from the op log.
 */
export interface DeltaCursor {
	/** ID of the last fully applied operation in the previous delta stream */
	lastOperationId: string
	/** Zero-based batch index where the cursor was recorded */
	batchIndex: number
}

export interface SyncStatePersistence {
	loadLastAckedServerVector(): Promise<VersionVector>
	saveLastAckedServerVector(vector: VersionVector): Promise<void>
	mergeServerVectors(a: VersionVector, b: VersionVector): VersionVector
	countUnsyncedOperations(serverVector: VersionVector): Promise<number>
	getUnsyncedOperations(serverVector: VersionVector): Promise<Operation[]>
	/** Resume position for paginated initial sync (optional). */
	loadDeltaCursor?(): Promise<DeltaCursor | null>
	saveDeltaCursor?(cursor: DeltaCursor | null): Promise<void>
}

/**
 * Interface for persisting the outbound operation queue.
 * Operations must survive page refreshes and be sent when connection is re-established.
 */
export interface QueueStorage {
	/** Load all queued operations from persistent storage */
	load(): Promise<Operation[]>
	/** Persist an operation to the queue */
	enqueue(op: Operation): Promise<void>
	/** Remove acknowledged operations by their IDs */
	dequeue(ids: string[]): Promise<void>
	/** Return number of operations in storage */
	count(): Promise<number>
}

/**
 * Thrown when an operation violates sync scope constraints.
 * This can happen when:
 * - A client tries to push an operation outside its configured scope
 * - The server rejects an operation because it falls outside the client's scope
 */
export class ScopeViolationError extends KoraError {
	constructor(
		public readonly operationId: string,
		public readonly collection: string,
		public readonly scope: Record<string, unknown>,
		message?: string,
	) {
		super(
			message ?? `Operation "${operationId}" in collection "${collection}" violates sync scope`,
			'SCOPE_VIOLATION',
			{ operationId, collection, scope },
		)
		this.name = 'ScopeViolationError'
	}
}

/**
 * Thrown when a sync scope configuration is invalid.
 */
export class InvalidScopeError extends KoraError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, 'INVALID_SCOPE', context)
		this.name = 'InvalidScopeError'
	}
}
