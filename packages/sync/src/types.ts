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
	'reconnecting',
	'syncing',
	'synced',
	'offline',
	'clock-error',
	'error',
	'schema-mismatch',
	'auth-required',
] as const
export type SyncStatus = (typeof SYNC_STATUSES)[number]

export type SyncPhase =
	| 'suspended'
	| 'offline'
	| 'connecting'
	| 'authenticating'
	| 'handshaking'
	| 'uploading'
	| 'receiving'
	| 'applying'
	| 'streaming'
	| 'blocked'

export interface ActiveApplyFailure {
	operationId: string
	collection: string
	recordId: string
	code: string
	message: string
	retriable: boolean
	firstSeenAt: number
	retryCount: number
}

/**
 * Sync status information exposed to developers.
 */
export interface SyncStatusInfo {
	/** Current developer-facing status */
	status: SyncStatus
	phase?: SyncPhase
	reason?: string
	/** True when the engine is actively trying to re-establish a transport session. */
	reconnecting: boolean
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
	/**
	 * Unsynced writes of another user who shared this local database (RT-38): the server
	 * refused their node for the signed-in principal, so they wait, not counted in
	 * `pendingOperations`, until that user signs in again on this device. Use
	 * `store.namespaceByAuthUser` to give each user their own database instead.
	 */
	heldOperations?: number
	/** serverTime - localTime in ms measured at the last handshake, or null before first connect. Negative = this device's clock is fast. */
	clockSkewMs: number | null
	inFlightUploadOperations?: number
	hasInFlightDeliveryBatch?: boolean
	activeViewId?: string
	activeViewComplete?: boolean
	initialSync?: {
		complete: boolean
		receivedBatches: number
		totalBatches: number | null
		progress: number | null
	}
	deliveryWatermark?: number
	serverFrontier?: number | null
	blockedFailure?: ActiveApplyFailure | null
}

export interface SyncSettlementOptions {
	upload?: boolean
	download?: 'active-view' | false
	timeoutMs?: number
	signal?: AbortSignal
}

export type SyncSettlementResult =
	| { outcome: 'settled'; status: SyncStatusInfo }
	| { outcome: 'offline'; status: SyncStatusInfo }
	| { outcome: 'suspended'; reason: string; status: SyncStatusInfo }
	| { outcome: 'blocked'; failure: ActiveApplyFailure; status: SyncStatusInfo }
	| { outcome: 'timeout'; status: SyncStatusInfo }
	| { outcome: 'aborted'; status: SyncStatusInfo }

/**
 * Per-collection sync scope map. Maps collection names to field-value filters.
 * Empty filter `{}` means no restriction (all records visible).
 * Missing collection means hidden (no records visible for that collection).
 */
export type SyncScopeMap = Record<string, Record<string, unknown>>

/** Options passed to {@link SyncConfig.auth}. */
export interface SyncAuthRequest {
	/**
	 * True when the server ended the previous session because its credential
	 * expired or was revoked. A cached token must not be reused.
	 */
	forceRefresh?: boolean
}

/**
 * Sync configuration provided by the developer.
 */
export interface SyncConfig {
	/** WebSocket or HTTP URL for the sync server */
	url: string
	/** Transport type to use. Defaults to 'websocket'. */
	transport?: 'websocket' | 'http'
	/**
	 * Auth provider function. Called before each connection attempt. After the
	 * server ends a session with `AUTH_EXPIRED` or `AUTH_REVOKED` it is called
	 * with `{ forceRefresh: true }`: return a freshly refreshed token, never the
	 * cached one the server just refused.
	 */
	auth?: (options?: SyncAuthRequest) => Promise<{ token: string }>
	/** Auth readiness gate. A suspended result prevents transport creation and retries. */
	authState?: () => Promise<{
		state: 'loading' | 'signed-out' | 'anonymous' | 'authenticated'
		mayConnectAnonymously?: boolean
	}>
	querySubsets?: { mode?: 'reactive' | 'static' | 'disabled' }
	/** Client-local behavior for records leaving the accepted downlink scope. Defaults to `retain`. */
	scopeExit?: 'retain' | 'retract'
	/** Sync scopes per collection. Limits which records sync to this client. */
	scopes?: Record<string, (ctx: SyncScopeContext) => Record<string, unknown>>
	/**
	 * Pre-computed per-collection sync scope map. Sent to the server in the handshake.
	 * Built automatically by createApp from schema scope declarations + flat scope values.
	 */
	scopeMap?: SyncScopeMap
	/** Number of operations per batch. Defaults to 100. */
	batchSize?: number
	/**
	 * Maximum time to wait for the server to acknowledge an outbound batch before
	 * treating the connection as stalled. The batch is returned to the durable
	 * outbound queue before disconnecting so it can be retried on reconnect.
	 * Defaults to 30000ms. Set to 0 to disable the watchdog.
	 */
	outboundAckTimeoutMs?: number
	/** Initial delay before resending a transiently rejected outbound operation. Defaults to 250ms. */
	outboundRetryBaseDelayMs?: number
	/** Maximum transient-operation retry delay. Defaults to 30000ms. */
	outboundRetryMaxDelayMs?: number
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
	/**
	 * The delivery watermark for a sync view, keyed by an opaque view signature (the auth
	 * scope plus active query subscriptions). Persisted per view so a restarted client
	 * resumes each view's gap-free stream from the right point, and switching views does not
	 * re-sync a view already synced. The empty-string signature is the default, unfiltered
	 * view. Optional: a persistence layer that omits these falls back to re-sync on restart.
	 */
	loadDeliveryWatermark?(signature: string): Promise<number>
	saveDeliveryWatermark?(signature: string, watermark: number): Promise<void>
	/** Load every persisted view watermark, keyed by signature. */
	loadAllDeliveryWatermarks?(): Promise<Record<string, number>>
	/**
	 * Delete a persisted view watermark. Used to bound the number of stored view watermarks
	 * (a cold view is evicted from the client's cache and its persisted row removed). Safe:
	 * an evicted view back-fills from 0 (deduplicated) when next visited.
	 */
	deleteDeliveryWatermark?(signature: string): Promise<void>
	/**
	 * The per-device node token the server issued at this node id's first anonymous
	 * claim (RT-12), stored next to the node id so the device can reconnect with it.
	 * Optional: without it the token lives only as long as the sync engine.
	 */
	loadNodeToken?(nodeId?: string): Promise<string | null>
	/**
	 * `nodeId` names the node the token was issued for: a database that authors under
	 * several node ids (a rotated identity, per-tab isolation) keeps one token per node.
	 */
	saveNodeToken?(token: string, nodeId?: string): Promise<void>
	/**
	 * The contiguous acknowledged prefix of this device's own operations (W3): the highest
	 * sequence s such that every own operation with sequence <= s is stored on the server,
	 * terminally rejected and recorded, or was never upload-eligible. Keyed by node id, so
	 * a rotated node starts from 0. Returns null when nothing was ever recorded under this
	 * contract (a device upgrading from a release that persisted a max, not a prefix): the
	 * engine then re-uploads the device's own history once, from 0; the server dedups by id.
	 * Optional: without it the engine trusts the own entry of the last acked server vector.
	 */
	loadOwnAckedThrough?(nodeId: string): Promise<number | null>
	saveOwnAckedThrough?(nodeId: string, sequence: number): Promise<void>
	/**
	 * Durable inbound quarantine (W4): delivered operations the client deliberately did
	 * not apply (unknown collection, transform unavailable, deferred or rejected apply,
	 * far-future timestamp, undecryptable payload). When `watermark` is given, the rows and
	 * the delivery watermark advance MUST be written in one transaction, so the watermark
	 * never passes an operation that is neither applied nor recorded here. Optional: a
	 * persistence layer without it keeps the old behaviour (the watermark stalls instead).
	 */
	saveQuarantine?(
		entries: QuarantinedOperation[],
		watermark?: { signature: string; watermark: number },
	): Promise<void>
	/** Every quarantined operation, oldest delivery first. */
	loadQuarantine?(): Promise<QuarantinedOperation[]>
	/** Remove quarantined operations once applied (replay) or reconciled. */
	removeQuarantine?(operationIds: string[]): Promise<void>
	/**
	 * The downlink scope the server last accepted for this device (SYNC-11). The next
	 * handshake reports its canonical key and that view's delivery watermark next to the
	 * requested view's, so a server that resolves the same scope again resumes the
	 * stream instead of restarting it from 0. Never sent as the requested scope.
	 * Optional; without it every handshake with a server-chosen scope rescans from 0.
	 */
	loadAcceptedDownlinkScope?(): Promise<SyncScopeMap | null>
	saveAcceptedDownlinkScope?(scope: SyncScopeMap | null): Promise<void>
	/**
	 * Durable terminal-rejection markers (RT-36): operations the server refused with a
	 * non-retriable rejection. Never cleared (unlike the app's rejected list), so a
	 * rescan of the device's own history never submits a refused operation again.
	 * Optional: without them the engine remembers refusals for its own lifetime only.
	 */
	recordTerminalRejections?(entries: TerminalRejectionRecord[]): Promise<void>
	/** Which of these operation ids carry a terminal-rejection marker. */
	findTerminalRejections?(operationIds: string[]): Promise<Set<string>>
	/**
	 * The node ids this database authored operations under (RT-38, RT-40), with what the
	 * sync server said about each. Optional: without it the engine tracks only the
	 * current node and keeps the pre-Phase-2 behaviour for refused nodes.
	 */
	listLocalNodes?(): Promise<LocalNodeInfo[]>
	/** Record an accepted handshake as `nodeId`; starts a new refusal cycle. */
	markLocalNodeAccepted?(nodeId: string): Promise<void>
	/** Record that the server refused `nodeId`; `held` holds its unsynced writes. */
	markLocalNodeRefused?(nodeId: string, held: boolean): Promise<void>
	/** The current refusal cycle (count of accepted handshakes). */
	loadAcceptedCycle?(): Promise<number>
	/** Forget a non-current local node with nothing left to upload (bounds the registry). */
	forgetLocalNode?(nodeId: string): Promise<void>
}

/** A terminally rejected operation, as recorded in the durable markers (RT-36). */
export interface TerminalRejectionRecord {
	operationId: string
	nodeId: string | null
	sequenceNumber: number | null
	code: string
	rejectedAt: number
}

/** A node id this database authored operations under (RT-38, RT-40). */
export interface LocalNodeInfo {
	nodeId: string
	/** A handshake as this node was accepted at least once. */
	accepted: boolean
	/** Refused after acceptance: its unsynced writes belong to a principal not signed in. */
	held: boolean
	/** Refusal cycle in which the server last refused it, or null. */
	refusedCycle: number | null
}

/**
 * A delivered operation the client deliberately did not apply, kept durably so it is
 * never silently lost and can be replayed (on start, after a schema upgrade, or on demand).
 */
export interface QuarantinedOperation {
	/** The operation as delivered (still encrypted when decryption failed). */
	operation: Operation
	/** Delivery sequence of the batch that carried it, or null for a legacy batch. */
	deliverySequence: number | null
	/** Machine-readable reason (for example `APPLY_SKIPPED`, `REMOTE_CLOCK_DRIFT`). */
	code: string
	/** Human-readable explanation. */
	message: string
	/** Wall-clock time (ms) it was quarantined. Display only. */
	quarantinedAt: number
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
	/**
	 * Record that these queued operations were put on the wire at least once. A sent
	 * operation may already be stored on the server (its ack can be lost), so it must
	 * never be re-stamped by a clock rebase (W3 step 4). Optional: without it the flag
	 * lives for the engine's lifetime only.
	 */
	markSent?(ops: Operation[]): Promise<void>
	/** Ids of queued operations recorded by {@link markSent}. */
	loadSentIds?(): Promise<string[]>
}

/**
 * A record of one outbound operation the server permanently refused. Preserved so
 * a rejected op is explainable and reconcilable rather than silently lost.
 */
export interface RejectedOperation {
	/** Content-addressed id of the rejected operation. */
	operationId: string
	/** Collection the operation targeted. */
	collection: string
	/** Record the operation targeted. */
	recordId: string
	/** Stable, machine-readable reason code from the server. */
	code: string
	/** Human-readable explanation. */
	message: string
	/** Whether resubmitting the identical operation may later succeed. */
	retriable: boolean
	/** Wall-clock time (ms since epoch) the rejection was recorded. Display only. */
	rejectedAt: number
}

/**
 * Interface for durably persisting operations the server rejected, so the record
 * survives a page refresh. Keyed by operation id (idempotent on re-rejection).
 */
export interface RejectedOperationStorage {
	/** Record (or overwrite) a rejected operation. */
	record(rejected: RejectedOperation): Promise<void>
	/** List all recorded rejected operations. */
	list(): Promise<RejectedOperation[]>
	/** Remove rejected operations by their operation ids (after the app reconciles them). */
	remove(operationIds: string[]): Promise<void>
}

/**
 * In-memory {@link RejectedOperationStorage}. The default when no durable store is
 * provided; suitable for tests and ephemeral sessions.
 */
export class MemoryRejectedOperationStorage implements RejectedOperationStorage {
	private readonly rejected = new Map<string, RejectedOperation>()

	async record(rejected: RejectedOperation): Promise<void> {
		this.rejected.set(rejected.operationId, rejected)
	}

	async list(): Promise<RejectedOperation[]> {
		return [...this.rejected.values()]
	}

	async remove(operationIds: string[]): Promise<void> {
		for (const id of operationIds) {
			this.rejected.delete(id)
		}
	}
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
