import type { Operation } from '@kora/core'

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
export const SYNC_STATUSES = ['connected', 'syncing', 'synced', 'offline', 'error'] as const
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
}

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
	/** Number of operations per batch. Defaults to 100. */
	batchSize?: number
	/** Initial reconnection delay in ms. Defaults to 1000. */
	reconnectInterval?: number
	/** Maximum reconnection delay in ms. Defaults to 30000. */
	maxReconnectInterval?: number
	/** Schema version of this client. */
	schemaVersion?: number
}

/**
 * Context passed to sync scope functions.
 */
export interface SyncScopeContext {
	userId?: string
	[key: string]: unknown
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
