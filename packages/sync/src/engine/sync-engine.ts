import type {
	ApplyFailureReason,
	ApplyResult,
	KoraEventEmitter,
	Operation,
	SyncDiagnosticsSnapshot,
	VersionVector,
} from '@korajs/core'
import {
	APPLY_FAILURE_CODES,
	ClockDriftError,
	HybridLogicalClock,
	InvalidTimestampError,
	KoraError,
	RemoteClockDriftError,
	SyncError,
	applyOperationTransforms,
	defaultApplyFailureReason,
} from '@korajs/core'
import { AwarenessManager } from '../awareness/awareness-manager'
import type { AwarenessMessage, AwarenessState } from '../awareness/types'
import { BlobChunkChannel } from '../blob/blob-chunk-channel'
import {
	createDeltaCursorFromBatch,
	decodeDeltaCursor,
	encodeDeltaCursor,
	sliceOperationsAfterCursor,
} from '../delta/delta-cursor'
import { SyncMetricsCollector } from '../diagnostics/metrics-collector'
import type { MetricsCollectorConfig } from '../diagnostics/metrics-collector'
import type { SyncEncryptor } from '../encryption/sync-encryptor'
import type {
	AcknowledgmentMessage,
	AwarenessStateWire,
	AwarenessUpdateMessage,
	BlobChunkPushMessage,
	BlobChunkRequestMessage,
	BlobChunkResponseMessage,
	HandshakeResponseMessage,
	OperationBatchMessage,
	OperationRejectedMessage,
	SyncMessage,
	WireFormat,
	YjsDocUpdateMessage,
} from '../protocol/messages'
import { isSchemaMismatchReject } from '../protocol/schema-version'
import {
	NegotiatedMessageSerializer,
	versionVectorToWire,
	wireToVersionVector,
} from '../protocol/serializer'
import type { MessageSerializer } from '../protocol/serializer'
import { RichtextDocChannel } from '../richtext/richtext-doc-channel'
import {
	type SyncQuerySubset,
	dedupeQuerySubsets,
	querySubsetContains,
} from '../scopes/query-subset'
import { operationMatchesScope } from '../scopes/scope-filter'
import { scopeViewKey } from '../scopes/scope-view-key'
import type { SyncTransport } from '../transport/transport'
import type { DeltaCursor } from '../types'
import {
	type LocalNodeInfo,
	MemoryRejectedOperationStorage,
	type QuarantinedOperation,
	type QueueStorage,
	type RejectedOperation,
	type RejectedOperationStorage,
	type SyncConfig,
	type SyncScopeMap,
	type SyncState,
	type SyncStatePersistence,
	type SyncStatusInfo,
} from '../types'
import { MemoryQueueStorage } from './memory-queue-storage'
import type { OutboundBatch } from './outbound-queue'
import { OutboundQueue } from './outbound-queue'
import type { SyncStore } from './sync-store'

const DEFAULT_BATCH_SIZE = 100
const DEFAULT_SCHEMA_VERSION = 1
const DEFAULT_OUTBOUND_ACK_TIMEOUT_MS = 30000
const DEFAULT_OUTBOUND_RETRY_BASE_DELAY_MS = 250
const DEFAULT_OUTBOUND_RETRY_MAX_DELAY_MS = 30000
/**
 * How many own sequence numbers the engine reads from the op log at a time when it
 * (re)builds the upload set. Bounds memory during the one-time upgrade re-upload of a
 * device's whole history: the next chunk is read only once the previous one is resolved.
 * Large on purpose: an engine without sync-state persistence re-reads its history on
 * every start, and against a legacy (version-vector) server a relay of a later chunk
 * that overtakes a dropped earlier one leaves a vector gap on peers.
 */
const OWN_LOG_SCAN_CHUNK = 2000
/**
 * A delivered operation stamped further than this ahead of the trusted reference time
 * is quarantined instead of applied (SYNC-7). Matches the HLC's own refusal threshold.
 */
const MAX_REMOTE_FUTURE_MS = 5 * 60_000
/**
 * Consecutive failed durability barriers before uploads stop waiting for local durability
 * (RT-49). A transient failure (a busy IndexedDB transaction) postpones the upload and
 * retries; a persistent one (quota exceeded, a broken store) would otherwise withhold every
 * write from the reachable server while the app keeps writing into memory. Once the device
 * may lose its local tail anyway, the server is the better place for it: RT-35 recovery
 * (handshake raise, full resync, renumber on SEQUENCE_CONFLICT) restores it after a reload.
 */
const DURABILITY_FAILURES_BEFORE_DEGRADED = 3
/** Quarantine reason codes for inbound operations the client did not apply (W4). */
const QUARANTINE_CODES = {
	DECRYPT_FAILED: 'DECRYPT_FAILED',
	REMOTE_CLOCK_DRIFT: 'REMOTE_CLOCK_DRIFT',
	TRANSFORM_UNAVAILABLE: 'SCHEMA_TRANSFORM_UNAVAILABLE',
} as const

/** A taken outbound batch, from the moment it leaves the queue until it is resolved. */
interface InFlightUpload {
	batch: OutboundBatch
	/** Wire message id once sent; acks are matched to batches by it (SYNC-4). */
	messageId: string | null
	/** Session the batch was taken in; a batch from an older session is never sent. */
	epoch: number
	/** A retriable rejection hit this batch: back off before flushing again. */
	retryBackoff: boolean
}

/**
 * Valid state transitions for the sync engine state machine.
 */
/** Server error codes that end a session because its credential expired or was revoked. */
function isCredentialEndingCode(code: string): boolean {
	return code === 'AUTH_EXPIRED' || code === 'AUTH_REVOKED'
}

const VALID_TRANSITIONS: Record<SyncState, SyncState[]> = {
	disconnected: ['connecting'],
	connecting: ['handshaking', 'error', 'disconnected'],
	handshaking: ['syncing', 'error', 'disconnected'],
	syncing: ['streaming', 'error', 'disconnected'],
	streaming: ['disconnected', 'error'],
	error: ['disconnected'],
}

/**
 * Options for creating a SyncEngine.
 */
export interface SyncEngineOptions {
	/** Transport implementation (WebSocket, memory, etc.) */
	transport: SyncTransport
	/** Local store implementing SyncStore */
	store: SyncStore
	/** Sync configuration */
	config: SyncConfig
	/** Message serializer. Defaults to JSON. */
	serializer?: MessageSerializer
	/** Event emitter for DevTools integration */
	emitter?: KoraEventEmitter
	/** Queue storage for persistent outbound queue. Defaults to in-memory. */
	queueStorage?: QueueStorage
	/**
	 * Durable storage for operations the server rejected. Defaults to in-memory.
	 * Provide a store-backed implementation so rejections survive a page refresh.
	 */
	rejectedStorage?: RejectedOperationStorage
	/**
	 * Optional encryptor for end-to-end encryption.
	 * When provided, `data` and `previousData` fields of operations are encrypted
	 * before sending and decrypted after receiving. The server never sees plaintext data.
	 */
	encryptor?: SyncEncryptor
	/** Optional configuration for the metrics collector. */
	metricsConfig?: MetricsCollectorConfig
	/** Op-log backed sync state (last acked server vector, unsynced counts). */
	syncState?: SyncStatePersistence
}

/**
 * Diagnostics snapshot for debugging and support.
 */
export interface SyncDiagnostics {
	state: SyncState
	status: SyncStatusInfo
	nodeId: string
	url: string
	schemaVersion: number
	lastSyncedAt: number | null
	lastSuccessfulPush: number | null
	lastSuccessfulPull: number | null
	conflicts: number
	pendingOperations: number
	hasInFlightBatch: boolean
	reconnecting: boolean
	deliveryWatermark: number
	deliveryGapRepeatCount: number
	timestamp: number
}

let nextMessageId = 0
let nextQuerySubsetId = 0

/** Rejection code for a local operation the uplink scope refuses (recorded client-side). */
const OUT_OF_UPLINK_SCOPE = 'OUT_OF_UPLINK_SCOPE'
/** The server holds another operation of this node under the sequence number (RT-35). */
const SEQUENCE_CONFLICT = 'SEQUENCE_CONFLICT'
/**
 * Non-retriable rejection codes that never become a durable terminal marker (RT-36): the
 * operation was not refused for its content, so uploading it later may succeed.
 */
const NON_TERMINAL_REJECTION_CODES: ReadonlySet<string> = new Set([
	SEQUENCE_CONFLICT,
	'NODE_ID_MISMATCH',
	OUT_OF_UPLINK_SCOPE,
])
function generateMessageId(): string {
	return `msg-${Date.now()}-${nextMessageId++}`
}

/**
 * Upper bound on the number of per-view delivery watermarks retained (in memory and in
 * persistence). A client that churns through many distinct views (for example a search that
 * registers a fresh query subscription per keystroke) would otherwise accumulate an
 * unbounded number of `_kora_meta` rows. Cold views are evicted least-recently-used; the
 * default view and the live view are never evicted. Eviction is a storage/performance
 * tradeoff only, never a correctness one: an evicted view back-fills from 0 (deduplicated)
 * when next visited.
 */
const MAX_DELIVERY_VIEW_WATERMARKS = 64

/**
 * Deterministic JSON stringify with sorted object keys, so two equal values always
 * produce the identical string. Used to build a stable sync-view signature for keying the
 * per-view delivery watermark.
 */
function stableStringify(value: unknown): string {
	if (value === null || typeof value !== 'object') {
		return JSON.stringify(value) ?? 'null'
	}
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(',')}]`
	}
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
	return `{${entries.join(',')}}`
}

/**
 * Core sync orchestrator. Manages the sync lifecycle:
 * disconnected → connecting → handshaking → syncing → streaming
 *
 * Coordinates handshake, delta exchange, and real-time streaming
 * between a local store and a remote sync server.
 */
export class SyncEngine {
	private state: SyncState = 'disconnected'
	/** Listeners registered through {@link onStateChange}. */
	private readonly stateListeners = new Set<(state: SyncState) => void>()
	private readonly transport: SyncTransport
	private readonly store: SyncStore
	private readonly config: SyncConfig
	private readonly serializer: MessageSerializer
	private readonly emitter: KoraEventEmitter | null
	private readonly outboundQueue: OutboundQueue
	private readonly rejectedStorage: RejectedOperationStorage
	private readonly batchSize: number
	private readonly outboundAckTimeoutMs: number
	private readonly outboundRetryBaseDelayMs: number
	private readonly outboundRetryMaxDelayMs: number
	private readonly encryptor: SyncEncryptor | null
	private readonly awarenessManager: AwarenessManager
	private readonly richtextDocChannel: RichtextDocChannel
	private readonly blobChunkChannel: BlobChunkChannel
	private readonly metricsCollector: SyncMetricsCollector
	private readonly syncState: SyncStatePersistence | null

	private remoteVector: VersionVector = new Map()
	/** Runs before each outbound operation batch is sent (see setOutboundPreparer). */
	private outboundPreparer: ((operations: Operation[]) => Promise<void>) | null = null
	/**
	 * Per-device node token the server issued at this node id's first anonymous claim
	 * (RT-12). Presented in every handshake; persisted next to the node id when the
	 * sync-state persistence supports it, otherwise kept for this engine's lifetime.
	 */
	private nodeToken: string | null = null
	private lastAckedServerVector: VersionVector = new Map()
	private cachedUnsyncedCount = 0
	private lastSyncedAt: number | null = null
	private lastSuccessfulPush: number | null = null
	private lastSuccessfulPull: number | null = null
	private conflictCount = 0
	/**
	 * Every outbound batch taken from the queue and not yet resolved, keyed by queue batch
	 * id: handshake-delta and streaming batches alike. An ack resolves only the batch it
	 * names (SYNC-4); a close returns all of them to the queue.
	 */
	private readonly inFlightUploads = new Map<string, InFlightUpload>()
	/** Wire message id -> queue batch id, for ack and rejection correlation. */
	private readonly uploadByMessageId = new Map<string, string>()
	/** Incremented on every connect and every disconnect; stale async sends check it. */
	private sessionEpoch = 0
	/** Set by destroy(): the engine never connects or arms a timer again. */
	private destroyed = false
	private readonly statusListeners = new Set<() => void>()
	/**
	 * Contiguous acknowledged prefix of this device's own operations (W3 step 2): every
	 * own op with sequence <= this is stored on the server, terminally rejected and
	 * recorded, or not upload-eligible. Never advanced by a server-advertised vector.
	 */
	private ownAckedThrough = 0
	/** Node id the prefix belongs to (a rotation starts a new prefix at 0). */
	private ownTrackingNodeId: string | null = null
	/** Highest own sequence read from the op log this session (above the prefix). */
	private ownScannedThrough = 0
	/**
	 * Own sequences above the prefix that this session knows about, mapped to the ids of
	 * their operations that are still unresolved. An empty set marks a sequence resolved.
	 */
	private readonly ownUnresolved = new Map<number, Set<string>>()
	/** Ids resolved at sequences the log scan has not reached yet (skip on scan). */
	private readonly ownResolvedAhead = new Map<string, number>()
	private ownTrackingChain: Promise<void> = Promise.resolve()
	/** Inbound quarantine kept in memory when the engine has no sync-state persistence. */
	private readonly memoryQuarantine = new Map<string, QuarantinedOperation>()
	private outboundRetryAttempt = 0
	private outboundRetryTimer: ReturnType<typeof setTimeout> | null = null
	private reconnecting = false
	private schemaBlocked = false
	private clockBlocked = false
	private clockSkewMs: number | null = null
	private blobStorageEnabled = false
	private blobPossessionProof = false
	private suspensionReason: string | null = null
	private authRejected = false
	/**
	 * Set when the server ended the session with AUTH_EXPIRED or AUTH_REVOKED. The
	 * next connect asks the auth callback for a refreshed token (never the cached
	 * one the server just refused) and is cleared by an accepted handshake.
	 */
	private credentialRefreshRequired = false
	private serverFrontier: number | null = null
	private hasInFlightDeliveryBatch = false
	private blockedFailure: import('../types').ActiveApplyFailure | null = null
	private outboundAckTimer: ReturnType<typeof setTimeout> | null = null
	private startPromise: Promise<void> | null = null
	private stopPromise: Promise<void> | null = null
	private reconnectPromise: Promise<void> | null = null
	/** A node-id rotation started by NODE_ID_CLAIMED; the next connect waits for it (RT-21). */
	private nodeRotation: Promise<void> | null = null
	/**
	 * Node id of the current (or last) session. Usually the store's node id; while the
	 * engine adopts the unsynced writes of a node no live tab uses (RT-40) it is that
	 * node. A session uploads only operations authored under its node id.
	 */
	private sessionNodeId: string | null = null
	/** Node id the in-memory node token belongs to. */
	private nodeTokenNodeId: string | null = null
	/** Releases the lock held on an adopted node (RT-40); null when not adopting. */
	private releaseAdoption: (() => void) | null = null
	/**
	 * Ids of operations the server refused for good (RT-36). Cache of the durable markers,
	 * and the only record when the persistence layer has none (engine lifetime).
	 */
	private readonly terminalRejected = new Set<string>()
	/** Nodes accepted at a handshake, when the persistence layer keeps no registry. */
	private readonly memoryAcceptedNodes = new Set<string>()
	/** Every node id this database authored operations under (loaded at start). */
	private localNodeIds = new Set<string>()
	/** Local nodes whose unsynced writes are held for another principal (RT-38). */
	private heldNodeIds = new Set<string>()
	/** Unsynced, unqueued operations of other uploadable local nodes (RT-40), counted pending. */
	private otherNodesPending = 0
	/** Unsynced, unqueued operations of held nodes (RT-38), reported separately. */
	private heldPending = 0
	/**
	 * The server holds operations of this node that the device lost (RT-35): the delivery
	 * watermark was reset so the next session resyncs from 0, which fetches them back.
	 * The session ends once its in-flight uploads are resolved.
	 */
	private ownRecoveryPending = false
	/** Consecutive failed durability barriers before an upload (RT-49). */
	private durabilityFailures = 0
	/** Uploads proceed without local durability: the barrier failed persistently (RT-49). */
	private durabilityDegraded = false

	// Track delta exchange state
	private deltaBatchesReceived = 0
	private deltaReceiveComplete = false
	private deltaSendComplete = false
	/** Outbound delta batch message IDs awaiting ACK when strictHandshake is enabled */
	private pendingDeltaBatchAcks = new Set<string>()

	/**
	 * The effective scope for this sync session.
	 * Starts as the configured scopeMap. After handshake, may be replaced
	 * with the server-accepted scope (server is authoritative).
	 */
	private activeScope: SyncScopeMap | undefined
	/** Server-authoritative upload authorization, separate from the downloaded view. */
	private activeUplinkScope: SyncScopeMap | undefined
	/**
	 * The downlink scope the server accepted at the last handshake that named one
	 * (SYNC-11), persisted. The next handshake reports its key and that view's watermark
	 * so the server can resume the stream of an unchanged grant. Never sent as the
	 * requested scope: a later-widened grant must not be narrowed to it.
	 */
	private lastAcceptedScope: SyncScopeMap | null = null

	/** Live query subsets registered from reactive subscriptions */
	private querySubsets = new Map<string, SyncQuerySubset>()
	private staticQuerySubsets: SyncQuerySubset[] = []
	private querySubsetReconnectTimer: ReturnType<typeof setTimeout> | null = null

	/** Resume cursor for paginated initial sync (persisted across reconnects) */
	private resumeDeltaCursor: DeltaCursor | null = null
	private initialSyncTotalBatches = 0

	/**
	 * The delivery watermark for the CURRENT sync view: the highest server delivery
	 * sequence up to which every operation in the current view (scope + active query
	 * subscriptions) has been contiguously applied. Advanced only through the server's
	 * gap-free delivery stream (never through live relay), so it is a durable lower bound
	 * on what this client holds for this view. Reported at handshake to resume the stream.
	 *
	 * The watermark is keyed by view: switching views (a scope or subscription change)
	 * saves the current view's watermark and loads the target view's, so returning to a
	 * previously-synced view resumes exactly where it left off instead of re-syncing. This
	 * is correct because a view's watermark is a lower bound specific to that view's
	 * filter; a widened view is simply a different (initially unsynced) view.
	 */
	private deliveryWatermark = 0
	/**
	 * In-memory cache of watermark per view signature, preloaded from persistence at start
	 * so a view switch resolves synchronously (no race with the reconnect it triggers).
	 */
	private readonly deliverySignatureWatermarks = new Map<string, number>()
	private deliveryGapRepeatCount = 0
	private lastDeliveryGapKey: string | null = null

	constructor(options: SyncEngineOptions) {
		this.transport = options.transport
		this.store = options.store
		this.config = options.config
		this.serializer = options.serializer ?? new NegotiatedMessageSerializer('json')
		this.emitter = options.emitter ?? null
		this.batchSize = options.config.batchSize ?? DEFAULT_BATCH_SIZE
		this.outboundAckTimeoutMs =
			options.config.outboundAckTimeoutMs ?? DEFAULT_OUTBOUND_ACK_TIMEOUT_MS
		this.outboundRetryBaseDelayMs = Math.max(
			0,
			options.config.outboundRetryBaseDelayMs ?? DEFAULT_OUTBOUND_RETRY_BASE_DELAY_MS,
		)
		this.outboundRetryMaxDelayMs = Math.max(
			this.outboundRetryBaseDelayMs,
			options.config.outboundRetryMaxDelayMs ?? DEFAULT_OUTBOUND_RETRY_MAX_DELAY_MS,
		)
		this.encryptor = options.encryptor ?? null
		this.syncState = options.syncState ?? null
		this.activeScope = options.config.scopeMap
		this.activeUplinkScope = options.config.scopeMap

		const queueStorage = options.queueStorage ?? new MemoryQueueStorage()
		this.outboundQueue = new OutboundQueue(queueStorage)
		this.rejectedStorage = options.rejectedStorage ?? new MemoryRejectedOperationStorage()

		this.metricsCollector = new SyncMetricsCollector(options.metricsConfig)
		if (this.emitter) {
			this.metricsCollector.attachEmitter(this.emitter)
		}

		this.awarenessManager = new AwarenessManager({
			emitter: this.emitter ?? undefined,
		})

		this.richtextDocChannel = new RichtextDocChannel({
			largeDocThreshold: options.config.richtextDocChannelThreshold,
			onSend: (message: YjsDocUpdateMessage) => {
				if (this.state !== 'streaming') {
					return
				}
				this.transport.send(message)
			},
		})

		this.blobChunkChannel = new BlobChunkChannel({
			onSend: (
				message: BlobChunkRequestMessage | BlobChunkResponseMessage | BlobChunkPushMessage,
			) => {
				// Blob transfer needs an accepted handshake. Pushes may also go out while
				// syncing, so the bytes behind a handshake-delta operation reach the server
				// before the operation does (RT-11). A request dropped here is safe: the
				// puller times out and retries, and blob transfer is resumable.
				const live =
					this.state === 'streaming' ||
					(this.state === 'syncing' && message.type === 'blob-chunk-push')
				if (!live) {
					return
				}
				this.transport.send(message)
			},
		})

		// Wire awareness manager to send messages through the transport
		this.awarenessManager.onSend((message: AwarenessMessage) => {
			if (this.state !== 'streaming') return

			const wireMessage: SyncMessage = {
				type: 'awareness-update',
				messageId: generateMessageId(),
				clientId: message.clientId,
				states: awarenessStatesToWire(message.states),
			}
			this.transport.send(wireMessage)
		})
	}

	/**
	 * Start the sync engine: connect → handshake → delta exchange → streaming.
	 */
	async start(): Promise<void> {
		if (this.state === 'streaming') return
		if (this.startPromise) return this.startPromise

		this.startPromise = this.startInternal().finally(() => {
			this.startPromise = null
		})
		return this.startPromise
	}

	private async startInternal(): Promise<void> {
		if (this.stopPromise) {
			await this.stopPromise
		}
		if (this.nodeRotation) {
			await this.nodeRotation
		}
		if (this.state === 'streaming') return
		if (this.destroyed) return
		if (this.state !== 'disconnected') {
			await this.stop()
		}
		if (this.authRejected) {
			this.emitter?.emit({
				type: 'sync:suspended',
				reason: this.suspensionReason ?? 'auth-rejected',
			})
			return
		}

		if (this.config.authState) {
			const authState = await this.config.authState()
			if (authState.state === 'loading' || authState.state === 'signed-out') {
				this.suspensionReason = authState.state === 'loading' ? 'auth-loading' : 'auth-required'
				this.emitter?.emit({ type: 'sync:suspended', reason: this.suspensionReason })
				return
			}
		}
		this.suspensionReason = null
		// Each handshake reports the watermark of the REQUESTED view (SYNC-11). The server
		// resumes from it only when it serves exactly the requested scope; when it serves
		// another (it restarts that stream from 0), the response switches to that view.
		// Reporting the previously accepted view's watermark instead could make a server
		// that now serves the requested scope skip operations of it.
		{
			const previousSignature = this.deliverySignature()
			this.activeScope = this.config.scopeMap
			this.switchDeliveryView(previousSignature)
		}
		await this.outboundQueue.initialize()
		this.ownRecoveryPending = false
		await this.chooseSessionNode()
		{
			const sessionNode = this.currentNodeId()
			if (this.nodeTokenNodeId !== sessionNode) {
				// A token belongs to one node id: never present another node's (RT-38, RT-40).
				this.nodeToken = null
				this.nodeTokenNodeId = sessionNode
			}
		}
		if (this.syncState) {
			this.lastAckedServerVector = await this.syncState.loadLastAckedServerVector()
			if (this.nodeToken === null && this.syncState.loadNodeToken) {
				this.nodeToken = await this.syncState.loadNodeToken(this.currentNodeId())
			}
			if (this.syncState.loadDeltaCursor) {
				this.resumeDeltaCursor = await this.syncState.loadDeltaCursor()
			}
			// Preload every view's watermark so a view switch resolves synchronously.
			if (this.syncState.loadAllDeliveryWatermarks) {
				const all = await this.syncState.loadAllDeliveryWatermarks()
				for (const [signature, watermark] of Object.entries(all)) {
					this.deliverySignatureWatermarks.set(signature, watermark)
				}
			} else if (this.syncState.loadDeliveryWatermark) {
				// Fallback: load just the current (default) view's watermark.
				this.deliverySignatureWatermarks.set('', await this.syncState.loadDeliveryWatermark(''))
			}
			this.deliveryWatermark = this.deliverySignatureWatermarks.get(this.deliverySignature()) ?? 0
			if (this.syncState.loadAcceptedDownlinkScope) {
				this.lastAcceptedScope = await this.syncState.loadAcceptedDownlinkScope()
			}
			// Bound a set that predates the retention cap (older clients persisted views
			// without a limit); this one-time trim removes cold rows down to the cap.
			this.evictColdViewWatermarks()
		}
		await this.loadOwnTracking()
		await this.reconcileOutboundFromOpLog()
		await this.replayQuarantine()
		await this.refreshPendingCount()
		if (this.destroyed) return

		// Set up transport handlers
		this.transport.onMessage((msg) => this.enqueueMessage(msg))
		this.transport.onClose((reason) => this.handleTransportClose(reason))
		this.transport.onError((err) => this.handleTransportError(err))

		if (this.schemaBlocked) {
			throw new SyncError(
				'Sync is blocked due to schema version mismatch. Upgrade the app schema or align sync.schemaVersion with the server.',
				{ code: 'SCHEMA_MISMATCH_BLOCKED' },
			)
		}
		this.transitionTo('connecting')

		try {
			const forceRefresh = this.credentialRefreshRequired
			const authToken = this.config.auth
				? (await (forceRefresh ? this.config.auth({ forceRefresh: true }) : this.config.auth()))
						.token
				: undefined
			if (this.state !== 'connecting') return
			if (forceRefresh && !authToken) {
				// The refresh did not produce a token yet (offline, auth server down).
				// Handshaking with an empty or stale token would be refused as AUTH_FAILED
				// and suspend sync for good; fail this attempt so reconnection retries.
				throw new SyncError(
					'Waiting for refreshed credentials before reconnecting: the server ended the previous session because its credential expired or was revoked.',
					{
						code: 'AUTH_REFRESH_PENDING',
						fix: 'Sync reconnects automatically once the auth client can refresh its token. If the user was signed out, sign in again.',
					},
				)
			}

			await this.transport.connect(this.config.url, { authToken })
			if (this.state !== 'connecting' || this.destroyed) {
				await this.transport.disconnect()
				this.ensureDisconnected()
				return
			}
			this.sessionEpoch++
			this.transitionTo('handshaking')

			// Send handshake
			const localVector = this.store.getVersionVector()
			const activeQuerySubsets = this.getActiveQuerySubsets()
			const handshake: SyncMessage = {
				type: 'handshake',
				messageId: generateMessageId(),
				nodeId: this.currentNodeId(),
				versionVector: versionVectorToWire(localVector),
				schemaVersion: this.config.schemaVersion ?? DEFAULT_SCHEMA_VERSION,
				authToken,
				supportedWireFormats: ['json', 'protobuf'],
				...(this.config.scopeMap ? { syncScope: this.config.scopeMap } : {}),
				...(this.config.scopeExit ? { scopeExitPolicy: this.config.scopeExit } : {}),
				...(activeQuerySubsets.length > 0 ? { syncQueries: activeQuerySubsets } : {}),
				...(this.resumeDeltaCursor
					? { deltaCursor: encodeDeltaCursor(this.resumeDeltaCursor) }
					: {}),
				// Resume the server's gap-free delivery stream from our watermark. A server
				// that understands it drives server->client sync from delivery sequences; an
				// older server ignores it and falls back to the version-vector delta.
				lastDeliverySequence: this.deliveryWatermark,
				// The accepted view this client last streamed under, with its own watermark
				// (SYNC-11): a server that resolves the same scope again resumes from it.
				...this.acceptedViewHandshakeFields(),
				...(this.nodeToken ? { nodeToken: this.nodeToken } : {}),
				// Sequence numbers are reserved inside the writing transaction (W6), and a
				// SEQUENCE_CONFLICT is recovered from (RT-35), so the server may enforce
				// (node, sequence) uniqueness against this client (RT-37).
				sequenceReservation: true,
			}
			this.transport.send(handshake)
		} catch (err) {
			// Transport error/close handlers may have already transitioned to disconnected.
			// Guard against invalid state transitions.
			this.ensureDisconnected()
			throw err
		}
	}

	/**
	 * Stop the sync engine. Disconnects the transport.
	 */
	async stop(): Promise<void> {
		if (this.stopPromise) return this.stopPromise

		this.stopPromise = this.stopInternal().finally(() => {
			this.stopPromise = null
		})
		return this.stopPromise
	}

	private async stopInternal(): Promise<void> {
		// Every timer goes first, before any early return (SYNC-10): an engine that is
		// already disconnected (the server closed the session) still owns the awareness
		// cleanup interval and a pending query-subset reconnect.
		this.clearAllTimers()
		this.sessionEpoch++
		this.returnAllInFlightUploads()

		if (this.state === 'disconnected') {
			// The session may have ended without the transport being closed (an error the
			// engine gave up on): close it now so no socket is left open (SYNC-5).
			await this.closeTransportQuietly()
			return
		}

		try {
			await this.transport.disconnect()
		} finally {
			// The transport.disconnect() callback may have already transitioned
			// to 'disconnected' via handleTransportClose. Re-read the mutable field.
			this.ensureDisconnected()
		}
	}

	/**
	 * Stop for good (`app.close()`): disconnect, clear every timer and listener, and refuse
	 * any later start. Unlike stop(), nothing the engine scheduled can run afterwards.
	 */
	async destroy(): Promise<void> {
		this.destroyed = true
		await this.stop()
		this.clearAllTimers()
		this.endAdoption()
		this.statusListeners.clear()
	}

	/** Clear every timer the engine owns. */
	private clearAllTimers(): void {
		this.clearOutboundAckTimer()
		this.clearOutboundRetryTimer()
		this.awarenessManager.stopCleanupTimer()
		if (this.querySubsetReconnectTimer) {
			clearTimeout(this.querySubsetReconnectTimer)
			this.querySubsetReconnectTimer = null
		}
	}

	/** Close the transport, logging nothing: it may already be closed. */
	private async closeTransportQuietly(): Promise<void> {
		try {
			await this.transport.disconnect()
		} catch {
			// Already closed or never opened; the engine is disconnected either way.
		}
	}

	/**
	 * The engine gave up on this session (a message it could not process, a transport
	 * error, a server error): move to disconnected and close the transport (SYNC-5). The
	 * close starts synchronously in this same frame, so the socket is released before
	 * auto-reconnect (which is asynchronous) can open another one.
	 */
	private abandonSession(reason: string): void {
		this.handleTransportClose(reason)
		void this.closeTransportQuietly()
	}

	/**
	 * Subscribe to status changes that no event announces (an upload ack lowering the
	 * pending count, reaching streaming). Status bridges refresh on it, so a waiter such
	 * as `waitForSettled` sees the change immediately (RT-28).
	 */
	onStatusChange(listener: () => void): () => void {
		this.statusListeners.add(listener)
		return () => {
			this.statusListeners.delete(listener)
		}
	}

	private notifyStatusChange(): void {
		for (const listener of this.statusListeners) {
			try {
				listener()
			} catch {
				// A listener's failure must not affect sync.
			}
		}
	}

	private ensureDisconnected(): void {
		if (this.state !== 'disconnected') {
			this.transitionTo('disconnected')
		}
	}

	/**
	 * Push a local operation to the outbound queue.
	 * If streaming, flushes immediately.
	 *
	 * Uploads are judged against the UPLINK scope only. Query subsets narrow what
	 * this client downloads, never what it uploads: an edit that moves a record out
	 * of a reactive query's view must still reach the server (SYNC-1).
	 *
	 * Operations on collections that do not sync at all stay local-only by design.
	 * An operation on a synced collection that falls outside the uplink scope would
	 * be refused by the server, so it is recorded in the rejected store and
	 * surfaced as `sync:operation-rejected` (code `OUT_OF_UPLINK_SCOPE`) rather than
	 * kept as a silent local fork.
	 */
	async pushOperation(op: Operation): Promise<void> {
		if (!(await this.operationAllowedForUpload(op))) {
			await this.recordOutOfUplinkScope(op)
			// Not upload-eligible: resolved for the contiguous prefix (W3 step 2).
			await this.withOwnTracking(async () => {
				this.trackOwnOperation(op, false)
				await this.advanceOwnPrefixLocked()
			})
			return
		}

		await this.withOwnTracking(async () => {
			await this.outboundQueue.enqueue(op)
			this.trackOwnOperation(op, true)
		})
		await this.refreshPendingCount()
		if (this.state === 'streaming') {
			this.flushQueue()
		}
	}

	/**
	 * Mark the engine as being in a reconnection loop. When reconnecting,
	 * `getStatus()` returns 'offline' instead of 'syncing' for intermediate
	 * states (connecting, handshaking, syncing), since the user is effectively
	 * disconnected until reconnection succeeds.
	 */
	setReconnecting(value: boolean): void {
		this.reconnecting = value
	}

	/**
	 * Get the current developer-facing sync status.
	 */
	getStatus(): SyncStatusInfo {
		const pendingOperations = this.computePendingCount()
		const base = {
			phase: this.resolvePhase(),
			...(this.suspensionReason ? { reason: this.suspensionReason } : {}),
			reconnecting: this.reconnecting,
			pendingOperations,
			lastSyncedAt: this.lastSyncedAt,
			lastSuccessfulPush: this.lastSuccessfulPush,
			lastSuccessfulPull: this.lastSuccessfulPull,
			conflicts: this.conflictCount,
			heldOperations: this.computeHeldCount(),
			localDurability: this.durabilityDegraded ? ('degraded' as const) : ('durable' as const),
			clockSkewMs: this.clockSkewMs,
			inFlightUploadOperations: this.inFlightUploadCount(),
			hasInFlightDeliveryBatch: this.hasInFlightDeliveryBatch,
			activeViewId: this.deliverySignature(),
			activeViewComplete:
				this.state === 'streaming' &&
				!this.hasInFlightDeliveryBatch &&
				this.blockedFailure === null &&
				(this.serverFrontier === null || this.deliveryWatermark >= this.serverFrontier),
			initialSync: {
				complete: this.deltaReceiveComplete && this.deltaSendComplete,
				receivedBatches: this.deltaBatchesReceived,
				totalBatches: this.initialSyncTotalBatches || null,
				progress:
					this.initialSyncTotalBatches > 0
						? Math.min(1, this.deltaBatchesReceived / this.initialSyncTotalBatches)
						: null,
			},
			deliveryWatermark: this.deliveryWatermark,
			serverFrontier: this.serverFrontier,
			blockedFailure: this.blockedFailure,
		}
		if (this.suspensionReason) return { ...base, status: 'auth-required' }
		switch (this.state) {
			case 'disconnected':
				// A durable block outranks plain offline: the user must act
				// (fix the clock / upgrade the schema) before sync can resume.
				if (this.clockBlocked) {
					return { ...base, status: 'clock-error' }
				}
				if (this.schemaBlocked) {
					return { ...base, status: 'schema-mismatch' }
				}
				return { ...base, status: 'offline' }
			case 'connecting':
			case 'handshaking':
			case 'syncing':
				return { ...base, status: this.reconnecting ? 'reconnecting' : 'syncing' }
			case 'streaming':
				return { ...base, status: pendingOperations > 0 ? 'syncing' : 'synced' }
			case 'error':
				if (this.clockBlocked) {
					return { ...base, status: 'clock-error' }
				}
				return { ...base, status: this.schemaBlocked ? 'schema-mismatch' : 'error' }
		}
	}

	private resolvePhase(): import('../types').SyncPhase {
		if (this.suspensionReason) return 'suspended'
		if (this.blockedFailure || this.schemaBlocked || this.clockBlocked) return 'blocked'
		if (this.hasInFlightDeliveryBatch) return 'applying'
		if (this.inFlightUploads.size > 0) return 'uploading'
		switch (this.state) {
			case 'disconnected':
				return 'offline'
			case 'connecting':
				return 'connecting'
			case 'handshaking':
				return 'handshaking'
			case 'syncing':
				return 'receiving'
			case 'streaming':
				return 'streaming'
			case 'error':
				return 'blocked'
		}
	}

	/**
	 * True when the server rejected the client's schema version at handshake.
	 * Sync stays blocked until the app schema is upgraded or sync config changes.
	 */
	isSchemaBlocked(): boolean {
		return this.schemaBlocked
	}

	/**
	 * True when sync is blocked because this device's clock is too far ahead.
	 * Local writes continue to work and queue; only sync is paused.
	 */
	isClockBlocked(): boolean {
		return this.clockBlocked
	}

	/** serverTime - localTime measured at the last handshake, or null before first connect. */
	getClockSkewMs(): number | null {
		return this.clockSkewMs
	}

	/**
	 * Clears the clock block after the user corrects the device clock.
	 * Moves the engine back to `disconnected` so `start()` can run again.
	 */
	clearClockBlock(): void {
		this.clockBlocked = false
		if (this.state === 'error') {
			this.transitionTo('disconnected')
		}
	}

	/**
	 * Clears schema-mismatch block after upgrading the local schema / sync config.
	 * Moves the engine back to `disconnected` so `start()` can run again.
	 */
	clearSchemaBlock(): void {
		this.schemaBlocked = false
		if (this.state === 'error') {
			this.transitionTo('disconnected')
		}
	}

	/**
	 * Record a merge conflict. Called by the merge-aware sync store
	 * to increment the conflict counter for status reporting.
	 */
	recordConflict(): void {
		this.conflictCount++
	}

	/**
	 * Count of this device's own operations not yet stored on the server (or terminally
	 * rejected and recorded): queued, in flight, or above the acknowledged prefix.
	 */
	async getUnsyncedOperationCount(): Promise<number> {
		await this.refreshPendingCount()
		return this.getStatus().pendingOperations
	}

	/**
	 * Surface an inbound apply failure. `blocking` marks the stream as stalled on this op
	 * (the watermark does not pass it); `quarantined` means the op is durably recorded and
	 * the stream moves on, so it never marks the stream blocked, whatever `retriable` says
	 * (retriable there means the quarantine replays it later).
	 */
	private emitApplyFailure(
		op: Operation,
		result: Exclude<ApplyResult, 'applied' | 'duplicate'>,
		overrides?: Partial<ApplyFailureReason>,
		mode: 'default' | 'blocking' | 'quarantined' = 'default',
	): void {
		const reason = defaultApplyFailureReason(result, overrides)
		if (mode === 'blocking' || (mode === 'default' && reason.retriable)) {
			const prior = this.blockedFailure
			this.blockedFailure = {
				operationId: op.id,
				collection: op.collection,
				recordId: op.recordId,
				code: reason.code,
				message: reason.message,
				retriable: reason.retriable,
				firstSeenAt: prior?.operationId === op.id ? prior.firstSeenAt : Date.now(),
				retryCount: prior?.operationId === op.id ? prior.retryCount + 1 : 0,
			}
			this.emitter?.emit({
				type: prior?.operationId === op.id ? 'sync:apply-retrying' : 'sync:apply-blocked',
				failure: this.blockedFailure,
			})
		}
		this.emitter?.emit({
			type: 'sync:apply-failed',
			operationId: op.id,
			collection: op.collection,
			recordId: op.recordId,
			code: reason.code,
			message: reason.message,
			retriable: reason.retriable,
		})
	}

	/**
	 * Force an immediate reconnection attempt. If the engine is disconnected
	 * or in error state, restarts the sync. If already connected, no-op.
	 */
	async retryNow(): Promise<void> {
		if (this.schemaBlocked) return
		this.authRejected = false
		this.suspensionReason = null
		if (this.state === 'disconnected' || this.state === 'error') {
			this.reconnecting = false
			await this.start()
		}
	}

	/** Wake a permanent auth suspension after the binding reports a new auth state. */
	notifyAuthChanged(): void {
		this.authRejected = false
		this.suspensionReason = null
	}

	/**
	 * Atomically refresh the transport session. Overlapping callers share one
	 * reconnect, in-flight outbound batches are returned to the queue by stop(), and the
	 * next start handshakes with the latest auth token, sync scope, and query subsets.
	 */
	async reconnect(): Promise<void> {
		if (this.schemaBlocked) return
		if (this.reconnectPromise) return this.reconnectPromise

		this.reconnecting = false
		this.reconnectPromise = this.reconnectInternal().finally(() => {
			this.reconnectPromise = null
		})
		return this.reconnectPromise
	}

	private async reconnectInternal(): Promise<void> {
		await this.stop()
		await this.start()
	}

	/**
	 * Export a diagnostics snapshot for debugging and support tickets.
	 * Contains connection state, timing info, and queue metrics.
	 */
	exportDiagnostics(): SyncDiagnostics {
		return {
			state: this.state,
			status: this.getStatus(),
			nodeId: this.currentNodeId(),
			url: this.config.url,
			schemaVersion: this.config.schemaVersion ?? DEFAULT_SCHEMA_VERSION,
			lastSyncedAt: this.lastSyncedAt,
			lastSuccessfulPush: this.lastSuccessfulPush,
			lastSuccessfulPull: this.lastSuccessfulPull,
			conflicts: this.conflictCount,
			pendingOperations: this.outboundQueue.totalPending,
			hasInFlightBatch: this.inFlightUploads.size > 0,
			reconnecting: this.reconnecting,
			deliveryWatermark: this.deliveryWatermark,
			deliveryGapRepeatCount: this.deliveryGapRepeatCount,
			timestamp: Date.now(),
		}
	}

	/**
	 * Get the current internal state (for testing).
	 */
	getState(): SyncState {
		return this.state
	}

	/**
	 * Subscribe to internal state changes (SYNC-8). The reconnection loop uses it to
	 * count an attempt as successful only once the session reaches `streaming`, not
	 * when the handshake is merely sent.
	 *
	 * @param listener - Called with the new state after every transition
	 * @returns Unsubscribe function
	 */
	onStateChange(listener: (state: SyncState) => void): () => void {
		this.stateListeners.add(listener)
		return () => {
			this.stateListeners.delete(listener)
		}
	}

	/**
	 * Get the outbound queue (for testing).
	 */
	getOutboundQueue(): OutboundQueue {
		return this.outboundQueue
	}

	/**
	 * Update the sync scope map. Takes effect on the next connection attempt.
	 *
	 * When the scope changes (e.g., user switches organization), call this method
	 * then reconnect. The new scope will be sent in the handshake, and the server
	 * will send back data matching the new scope.
	 *
	 * Data that no longer matches the new scope is NOT deleted locally.
	 * It simply stops being synced.
	 *
	 * @param scopeMap - New per-collection scope filters, or undefined to remove scope
	 */
	updateScope(scopeMap: SyncScopeMap | undefined): void {
		const previousSignature = this.deliverySignature()
		this.activeScope = scopeMap
		// Until the server accepts distinct directional maps, preserve the legacy
		// shorthand semantics locally as well.
		this.activeUplinkScope = scopeMap
		// Also update the config so that the next handshake sends the new scope
		this.config.scopeMap = scopeMap
		this.switchDeliveryView(previousSignature)
	}

	/**
	 * A stable identifier for the current sync view: the auth/tenant scope plus the set of
	 * active query subscriptions, canonicalized so the same view always produces the same
	 * string. The delivery watermark is keyed by this, so each distinct view resumes from
	 * its own last position.
	 */
	private deliverySignature(): string {
		return this.deliverySignatureFor(this.activeScope)
	}

	/** The view signature {@link deliverySignature} gives under `scope` and today's subsets. */
	private deliverySignatureFor(scope: SyncScopeMap | undefined): string {
		const subsets = this.getActiveQuerySubsets()
		if (!scope && subsets.length === 0) {
			return '' // the default, unfiltered view (maps to the legacy watermark key)
		}
		const normalizedSubsets = subsets
			.map((s) => `${s.collection}:${stableStringify(s.where)}`)
			.sort()
		return stableStringify({ scope: scope ?? null, subsets: normalizedSubsets })
	}

	/**
	 * Handshake fields naming the accepted view this client last streamed under (SYNC-11):
	 * its canonical scope key and its delivery watermark. Omitted when no scope was ever
	 * accepted, or when it equals the requested scope (the requested watermark covers it).
	 */
	private acceptedViewHandshakeFields(): {
		acceptedScopeKey?: string
		acceptedScopeWatermark?: number
	} {
		const accepted = this.lastAcceptedScope
		if (accepted === null) return {}
		const key = scopeViewKey(accepted)
		if (key === scopeViewKey(this.activeScope)) return {}
		const watermark = this.deliverySignatureWatermarks.get(this.deliverySignatureFor(accepted))
		if (watermark === undefined) return {}
		return { acceptedScopeKey: key, acceptedScopeWatermark: watermark }
	}

	/** Persist the downlink scope the server accepted at this handshake (null: none). */
	private rememberAcceptedScope(accepted: SyncScopeMap | null): void {
		if (scopeViewKey(accepted) === scopeViewKey(this.lastAcceptedScope)) return
		this.lastAcceptedScope = accepted
		if (this.syncState?.saveAcceptedDownlinkScope) {
			this.syncState.saveAcceptedDownlinkScope(accepted).catch((error: unknown) => {
				// Losing it only costs a rescan from 0 at the next handshake.
				this.emitter?.emit({
					type: 'store:persistence-error',
					dbName: 'kora-oplog',
					message: error instanceof Error ? error.message : 'Saving the accepted scope failed',
					code: 'ACCEPTED_SCOPE_SAVE_FAILED',
				})
			})
		}
	}

	/**
	 * Switch the active delivery watermark to the current view after a scope or subscription
	 * change. The prior view's watermark is saved so returning to it resumes; the new view's
	 * watermark is restored from the in-memory cache (0 for a never-synced view, which then
	 * does a one-time resync under that view). No data is lost: a view's watermark is a lower
	 * bound for that specific view's filter.
	 */
	private switchDeliveryView(previousSignature: string): void {
		const nextSignature = this.deliverySignature()
		if (nextSignature === previousSignature) {
			return
		}
		this.setViewWatermark(previousSignature, this.deliveryWatermark)
		void this.persistDeliveryWatermark(this.deliveryWatermark, previousSignature)
		this.deliveryWatermark = this.deliverySignatureWatermarks.get(nextSignature) ?? 0
	}

	/**
	 * Record a view's watermark in the in-memory cache as the most-recently-used entry (the
	 * Map preserves insertion order, so re-inserting moves it to the tail), then evict cold
	 * views past the retention cap. This is the single place the cache is written, so LRU
	 * order and the size bound are always maintained together.
	 */
	private setViewWatermark(signature: string, watermark: number): void {
		this.deliverySignatureWatermarks.delete(signature)
		this.deliverySignatureWatermarks.set(signature, watermark)
		this.evictColdViewWatermarks()
	}

	/**
	 * Trim the per-view watermark cache to `MAX_DELIVERY_VIEW_WATERMARKS`, evicting the
	 * least-recently-used views. The default view ('') and the live view are never evicted
	 * (evicting the live view would force an immediate re-scan of what we are actively
	 * syncing). Each eviction also removes the persisted row, bounding storage. Safe by
	 * construction: an evicted view simply back-fills from 0 (deduplicated) when next seen.
	 */
	private evictColdViewWatermarks(): void {
		if (this.deliverySignatureWatermarks.size <= MAX_DELIVERY_VIEW_WATERMARKS) {
			return
		}
		const liveSignature = this.deliverySignature()
		for (const signature of this.deliverySignatureWatermarks.keys()) {
			if (this.deliverySignatureWatermarks.size <= MAX_DELIVERY_VIEW_WATERMARKS) {
				break
			}
			if (signature === '' || signature === liveSignature) {
				continue
			}
			this.deliverySignatureWatermarks.delete(signature)
			void this.deleteDeliveryWatermark(signature)
		}
	}

	/**
	 * Remove a view's persisted watermark row (best-effort; a persistence layer that omits
	 * the delete simply keeps the row, which is harmless).
	 */
	private async deleteDeliveryWatermark(signature: string): Promise<void> {
		if (!this.syncState?.deleteDeliveryWatermark) {
			return
		}
		await this.syncState.deleteDeliveryWatermark(signature)
	}

	/**
	 * Get the currently active scope map. Returns undefined if no scope is configured.
	 */
	getActiveScope(): SyncScopeMap | undefined {
		return this.activeScope
	}

	/** Get the server-accepted upload authorization scope. */
	getActiveUplinkScope(): SyncScopeMap | undefined {
		return this.activeUplinkScope
	}

	/**
	 * Register a live query subset that narrows synced data for a collection.
	 * Takes effect on the next connection; reconnects when already connected.
	 */
	registerQuerySubset(subset: SyncQuerySubset): () => void {
		if ((this.config.querySubsets?.mode ?? 'reactive') !== 'reactive') return () => {}
		const id = `query-${nextQuerySubsetId++}`
		const previousSignature = this.deliverySignature()
		const previousEffective = this.getActiveQuerySubsets()
		this.querySubsets.set(id, subset)
		// Registering or unregistering a subset changes the sync view. Switch the watermark
		// to the new view (resuming it if seen before, or resyncing it once if new); returning
		// to a previously-synced view resumes instead of re-syncing. The debounce coalesces a
		// burst of subscription changes into a single reconnect.
		this.switchDeliveryViewWithInheritance(previousSignature, previousEffective)
		if (this.deliverySignature() !== previousSignature) this.scheduleQuerySubsetReconnect()
		return () => {
			const sigBeforeRemove = this.deliverySignature()
			const effectiveBeforeRemove = this.getActiveQuerySubsets()
			this.querySubsets.delete(id)
			this.switchDeliveryViewWithInheritance(sigBeforeRemove, effectiveBeforeRemove)
			if (this.deliverySignature() !== sigBeforeRemove) this.scheduleQuerySubsetReconnect()
		}
	}

	private switchDeliveryViewWithInheritance(
		previousSignature: string,
		previousSubsets: SyncQuerySubset[],
	): void {
		const nextSubsets = this.getActiveQuerySubsets()
		const previousWatermark = this.deliveryWatermark
		this.switchDeliveryView(previousSignature)
		if (this.deliveryWatermark === 0 && querySubsetContains(previousSubsets, nextSubsets)) {
			this.deliveryWatermark = previousWatermark
			this.setViewWatermark(this.deliverySignature(), previousWatermark)
			void this.persistDeliveryWatermark(previousWatermark)
		}
	}

	/** Atomically replace the manifest used by static query-subset mode. */
	setQuerySubsets(subsets: SyncQuerySubset[]): void {
		if ((this.config.querySubsets?.mode ?? 'reactive') !== 'static')
			throw new Error('setQuerySubsets() requires sync.querySubsets.mode = "static"')
		const previousSignature = this.deliverySignature()
		const previousEffective = this.getActiveQuerySubsets()
		this.staticQuerySubsets = dedupeQuerySubsets(subsets)
		this.switchDeliveryViewWithInheritance(previousSignature, previousEffective)
		if (this.deliverySignature() !== previousSignature) this.scheduleQuerySubsetReconnect()
	}

	/**
	 * Returns deduplicated active query subsets from registered subscriptions.
	 */
	getActiveQuerySubsets(): SyncQuerySubset[] {
		const mode = this.config.querySubsets?.mode ?? 'reactive'
		if (mode === 'disabled') return []
		return mode === 'static'
			? this.staticQuerySubsets
			: dedupeQuerySubsets([...this.querySubsets.values()])
	}

	/**
	 * Get the awareness manager for collaborative presence.
	 * Use this to set local presence, observe remote collaborators,
	 * and track cursor positions in richtext fields.
	 */
	getAwarenessManager(): AwarenessManager {
		return this.awarenessManager
	}

	/**
	 * Optional side channel for incremental Yjs updates on large richtext fields.
	 */
	getRichtextDocChannel(): RichtextDocChannel {
		return this.richtextDocChannel
	}

	/**
	 * Side channel for out-of-band blob chunk transfer over the sync connection.
	 * The app layer bridges this to a `ChunkMessagePort` to pull/serve blob bytes.
	 */
	getBlobChunkChannel(): BlobChunkChannel {
		return this.blobChunkChannel
	}

	/**
	 * Whether the connected server persists blob bytes centrally (learned from the
	 * handshake response). When true, the app uploads the bytes behind `blob`
	 * fields so they stay available after the authoring device goes offline.
	 */
	isBlobStorageEnabled(): boolean {
		return this.blobStorageEnabled
	}

	/**
	 * Whether the connected server (peer-relay mode, no central storage) asks for the
	 * bytes behind blob references as proof of possession (RT-23). The server verifies
	 * and drops them; the app uploads exactly as for central storage.
	 */
	isBlobPossessionProofRequested(): boolean {
		return this.blobPossessionProof
	}

	/**
	 * Upload a blob chunk (or manifest) to the server, for central persistence or as
	 * proof of possession. A no-op unless the handshake was accepted (syncing or
	 * streaming) and the server advertised blob storage or asked for proofs.
	 */
	uploadBlobChunk(hash: string, bytes: Uint8Array): void {
		if (
			(this.state !== 'streaming' && this.state !== 'syncing') ||
			!(this.blobStorageEnabled || this.blobPossessionProof)
		) {
			return
		}
		this.blobChunkChannel.send({ type: 'blob-chunk-push', hash, bytes })
	}

	/**
	 * Register work that must reach the server before each outbound operation batch,
	 * on the same connection (messages are processed in order). Used to upload the
	 * bytes behind blob references first: the server only accepts a reference to
	 * content the writer can read or has uploaded (RT-11). Errors are ignored; the
	 * batch is sent regardless.
	 *
	 * @param preparer - Called with the operations about to be sent; null to remove
	 * @returns A function that removes this preparer
	 */
	setOutboundPreparer(preparer: ((operations: Operation[]) => Promise<void>) | null): () => void {
		this.outboundPreparer = preparer
		return () => {
			if (this.outboundPreparer === preparer) this.outboundPreparer = null
		}
	}

	// --- Private methods ---

	private messageChain: Promise<void> = Promise.resolve()

	private enqueueMessage(message: SyncMessage): void {
		// The server sends a credential-ending error and closes the socket right away.
		// The close is handled synchronously (and may start a reconnect) before this
		// queued message is processed, so record the need to refresh now (AUTH-11).
		if (message.type === 'error' && isCredentialEndingCode(message.code)) {
			this.credentialRefreshRequired = true
		}
		this.messageChain = this.messageChain
			.then(() => this.handleMessageAsync(message))
			.catch((error) => this.handleMessageFailure(error))
	}

	private async handleMessageAsync(message: SyncMessage): Promise<void> {
		switch (message.type) {
			case 'handshake-response':
				await this.handleHandshakeResponse(message)
				break
			case 'operation-batch':
				await this.handleOperationBatch(message)
				break
			case 'acknowledgment':
				await this.handleAcknowledgment(message)
				break
			case 'error':
				this.handleError(message)
				break
			case 'operation-rejected':
				await this.handleOperationRejected(message)
				break
			case 'awareness-update':
				this.handleAwarenessUpdate(message)
				break
			case 'yjs-doc-update':
				this.richtextDocChannel.deliver(message)
				break
			case 'blob-chunk-request':
			case 'blob-chunk-response':
			case 'blob-chunk-push':
				this.blobChunkChannel.deliver(message)
				break
		}
	}

	private handleMessageFailure(error: unknown): void {
		this.hasInFlightDeliveryBatch = false
		const reason = error instanceof Error ? error.message : 'Message handling failed'
		this.abandonSession(reason)
	}

	/**
	 * Compares server wall-clock time from the handshake with local time.
	 * Negative skew = this device's clock is fast (dangerous for LWW and rejected
	 * by server ingest beyond 60s). Positive skew = slow (accepted but surfaced).
	 * Zero developer work required: the result flows into sync status and events.
	 */
	private evaluateClockSkew(serverTime: number): void {
		const skewMs = serverTime - Date.now()
		this.clockSkewMs = skewMs
		const FAST_BLOCK_MS = 60_000
		const SLOW_WARN_MS = 10 * 60_000
		let severity: 'info' | 'slow-warning' | 'fast-blocked' = 'info'
		if (skewMs < -FAST_BLOCK_MS) {
			severity = 'fast-blocked'
		} else if (skewMs > SLOW_WARN_MS) {
			severity = 'slow-warning'
		}
		this.emitter?.emit({ type: 'sync:clock-skew', skewMs, severity, source: 'handshake' })
		if (severity === 'fast-blocked') {
			this.clockBlocked = true
		} else {
			// Auto-heal: an acceptable measured skew is authoritative proof the
			// device clock has been corrected, so a block engaged earlier (at a
			// previous handshake or via a server INVALID_TIMESTAMP reject) no
			// longer applies and must not require a manual clearClockBlock().
			this.clockBlocked = false
		}
	}

	private async handleHandshakeResponse(msg: HandshakeResponseMessage): Promise<void> {
		if (this.state !== 'handshaking') return

		this.blobStorageEnabled = msg.blobStorageEnabled === true
		this.blobPossessionProof = msg.blobPossessionProof === true

		if (typeof msg.serverTime === 'number') {
			this.evaluateClockSkew(msg.serverTime)
			if (this.clockBlocked) {
				this.metricsCollector.updateStatus('error')
				this.transitionTo('error')
				void this.transport.disconnect()
				return
			}
		}

		if (msg.accepted) {
			this.credentialRefreshRequired = false
		}

		if (!msg.accepted) {
			const reason = msg.rejectReason ?? 'Handshake rejected'
			if (isSchemaMismatchReject(msg.rejectReason)) {
				this.schemaBlocked = true
				const supportedMin = msg.supportedSchemaMin ?? msg.schemaVersion
				const supportedMax = msg.supportedSchemaMax ?? msg.schemaVersion
				this.emitter?.emit({
					type: 'sync:schema-mismatch',
					clientSchemaVersion: this.config.schemaVersion ?? DEFAULT_SCHEMA_VERSION,
					serverSchemaVersion: msg.schemaVersion,
					supportedMin,
					supportedMax,
					reason,
				})
				this.metricsCollector.updateStatus('error')
				this.transitionTo('error')
				void this.transport.disconnect()
				return
			}
			this.transitionTo('error')
			this.emitter?.emit({
				type: 'sync:disconnected',
				reason,
			})
			this.transitionTo('disconnected')
			void this.closeTransportQuietly()
			return
		}

		const sessionNode = this.currentNodeId()
		// Accepted as this node: from now on a refusal of it means another principal owns
		// it (RT-38). Recorded before anything is uploaded in this session.
		await this.recordNodeAccepted(sessionNode)

		if (typeof msg.nodeToken === 'string' && msg.nodeToken.length > 0) {
			this.nodeToken = msg.nodeToken
			this.nodeTokenNodeId = sessionNode
			await this.syncState?.saveNodeToken?.(msg.nodeToken, sessionNode)
			// The claim stays provisional until the server knows the token is saved:
			// confirm it now, so a lost response never locks this device out (RT-21).
			// Without persistence the token lives for this engine only; confirming would
			// tie the node to a secret the next process does not have, so don't.
			if (this.syncState?.saveNodeToken) {
				this.transport.send({
					type: 'acknowledgment',
					messageId: generateMessageId(),
					acknowledgedMessageId: msg.messageId,
					lastSequenceNumber: 0,
					nodeToken: msg.nodeToken,
				})
			}
		}

		this.remoteVector = wireToVersionVector(msg.versionVector)
		void this.persistLastAckedServerVector(this.remoteVector)

		// The server's accepted downlink scope is authoritative for what it delivers, so
		// the delivery watermark belongs to that view. When it differs from the requested
		// view (the one the handshake watermark was read under), switch views (SYNC-11):
		// the server restarts such a stream from 0, and only that view's own watermark
		// can tell the duplicates in it from operations this client never saw.
		const previousSignature = this.deliverySignature()
		const acceptedDownlink = msg.acceptedDownlinkScopes ?? msg.acceptedScope
		// A grant equal to the request (by canonical key) keeps the requested view: the
		// server resumed from the requested view's watermark, and a re-ordered copy of the
		// same scope must not switch to a differently keyed watermark.
		if (acceptedDownlink && scopeViewKey(acceptedDownlink) !== scopeViewKey(this.activeScope)) {
			this.activeScope = acceptedDownlink
		}
		this.activeUplinkScope = msg.acceptedUplinkScopes ?? msg.acceptedScope ?? this.activeScope
		this.switchDeliveryView(previousSignature)
		this.rememberAcceptedScope(acceptedDownlink ?? null)

		// If our watermark is ahead of the server's frontier, the server's log was rolled
		// back (for example a backup restore reset the delivery sequence). Reset to a full
		// resync so we do not sit above operations the server will re-send from the start.
		// The server independently resyncs such a client from 0, so the stream that follows
		// this response chains from 0 and this reset lets us apply it.
		if (
			typeof msg.serverMaxDeliverySequence === 'number' &&
			this.deliveryWatermark > msg.serverMaxDeliverySequence
		) {
			this.deliveryWatermark = 0
			this.setViewWatermark(this.deliverySignature(), 0)
			await this.persistDeliveryWatermark(0)
		}
		this.serverFrontier = msg.serverMaxDeliverySequence ?? null

		if (msg.selectedWireFormat) {
			this.setSerializerWireFormat(msg.selectedWireFormat)
		}

		if (this.config.scopeExit === 'retract' && this.activeScope && this.store.applyScopeNarrowing) {
			const narrowed = await this.store.applyScopeNarrowing(this.activeScope)
			for (const retraction of narrowed) {
				await this.applyScopeRetraction(retraction, false)
			}
		}

		// A server that holds MORE of this node's operations than the device's log (the
		// device lost the tail of its log, RT-35) is never trusted as an acknowledgment,
		// but the numbers it holds are taken: the counter moves past them before the next
		// write, and a full resync fetches the operations back.
		const advertisedOwn = this.remoteVector.get(sessionNode)
		const localOwn = this.store.getVersionVector().get(sessionNode) ?? 0
		// The persisted counter decides (raiseSequenceFloor reads it in a transaction): the
		// in-memory vector of a tab sharing the node may simply lag another tab's writes.
		if (
			advertisedOwn !== undefined &&
			advertisedOwn > localOwn &&
			this.store.raiseSequenceFloor &&
			(await this.store.raiseSequenceFloor(sessionNode, advertisedOwn))
		) {
			this.emitter?.emit({
				type: 'sync:local-node',
				nodeId: sessionNode,
				action: 'history-behind',
				localSequence: localOwn,
				serverSequence: advertisedOwn,
			})
			await this.resetDeliveryForFullResync()
			this.abandonSession(
				'The server holds operations of this device that its local database lost; resyncing them',
			)
			return
		}

		// A server that holds FEWER of this device's operations than the device believes
		// (a restored backup) lowers the acknowledged prefix, so the device re-uploads
		// them; the server dedups by id. A higher value is never trusted (RT-12, W3).
		// An ABSENT own entry means the server holds none of them (RT-45): every server
		// names the session's own node whenever it holds an operation of it (the entry is
		// never scope-filtered), so absence is the strongest "behind", never "unknown".
		const serverHoldsOwn = advertisedOwn ?? 0
		if (serverHoldsOwn < this.ownAckedThrough && this.ownTrackingNodeId === sessionNode) {
			this.emitter?.emit({
				type: 'sync:local-node',
				nodeId: sessionNode,
				action: 'server-behind',
				localSequence: this.ownAckedThrough,
				serverSequence: serverHoldsOwn,
			})
			await this.withOwnTracking(async () => {
				await this.lowerOwnPrefixLocked(serverHoldsOwn)
				await this.advanceOwnPrefixLocked()
			})
		}
		await this.refreshPendingCount()

		this.emitter?.emit({ type: 'sync:connected', nodeId: sessionNode })
		this.metricsCollector.recordConnected()
		this.metricsCollector.updateStatus('syncing')
		this.metricsCollector.recordSyncStarted()

		this.transitionTo('syncing')
		this.deltaBatchesReceived = 0
		this.deltaReceiveComplete = false
		this.deltaSendComplete = false
		this.pendingDeltaBatchAcks.clear()
		this.initialSyncTotalBatches = 0

		// Rebase must finish BEFORE the delta exchange starts so only the
		// re-stamped operation ids ever reach the wire.
		if (typeof msg.serverTime === 'number') {
			await this.maybeRebaseQueuedOperations(msg.serverTime)
		}

		// Send our delta to the server. Not awaited: the outbound preparer (blob bytes)
		// may need server messages that this message chain has yet to process.
		void this.sendDelta().catch((error) => {
			this.abandonSession(error instanceof Error ? error.message : 'Delta upload failed')
		})
		this.notifyStatusChange()
	}

	/**
	 * The server refused this session's node id (`NODE_ID_CLAIMED`). What happens to the
	 * node's unsynced writes depends on whether this database was ever accepted as it:
	 *
	 * - Never accepted (RT-21: the claim's token was lost before the device saw it, or
	 *   another device took the id first): no principal ever received these writes under
	 *   this node, so the never-sent ones are re-authored under a fresh node id and
	 *   uploaded. An operation flagged sent is never re-authored (RT-38): it may already
	 *   be stored, and a copy under a new id would store the change twice.
	 * - Accepted before (RT-38: another user signed in on a database shared between
	 *   users): the node belongs to the principal that used it, so its unsynced writes
	 *   are held for that principal, never re-authored or uploaded under another one. The
	 *   device moves to a node the signed-in principal may own (a held node not yet tried
	 *   in this refusal cycle, typically that user's own earlier node) or to a fresh one.
	 * - An adopted node (RT-40) is held; the store's own node is left as it is.
	 */
	private async rotateNodeIdentity(): Promise<void> {
		const refused = this.currentNodeId()
		const storeNode = this.store.getNodeId()
		this.returnAllInFlightUploads()
		try {
			if (refused !== storeNode) {
				await this.syncState?.markLocalNodeRefused?.(refused, true)
				this.heldNodeIds.add(refused)
				this.endAdoption()
				this.emitter?.emit({ type: 'sync:local-node', nodeId: refused, action: 'adoption-refused' })
				return
			}
			const rotate = this.store.rotateNodeId?.bind(this.store)
			if (!rotate) {
				this.emitter?.emit({ type: 'sync:suspended', reason: 'node-id-claimed' })
				return
			}
			if (await this.wasNodeAccepted(refused)) {
				await this.holdNodeAndSwitch(refused, rotate)
			} else {
				await this.reauthorUnsentAndRotate(refused, rotate)
			}
		} catch (error) {
			this.emitter?.emit({
				type: 'store:persistence-error',
				dbName: 'kora-oplog',
				message: error instanceof Error ? error.message : 'Node id rotation failed',
				code: 'NODE_ROTATION_FAILED',
			})
		}
	}

	/** RT-38: hold a refused, previously accepted node's writes and move to another node. */
	private async holdNodeAndSwitch(
		refused: string,
		rotate: (ids: string[]) => Promise<{ nodeId: string; operations: Operation[] }>,
	): Promise<void> {
		await this.syncState?.markLocalNodeRefused?.(refused, true)
		const held = await this.countUnsyncedOfNode(refused)
		this.emitter?.emit({
			type: 'sync:local-node',
			nodeId: refused,
			action: 'held',
			operationCount: held.count,
		})
		let target: string | null = null
		const switchTo = this.store.switchNodeId?.bind(this.store)
		if (switchTo && this.syncState?.listLocalNodes) {
			// A held node refused before the last accepted handshake was not tried in this
			// refusal cycle: it may be the signed-in principal's own node.
			const cycle = (await this.syncState.loadAcceptedCycle?.()) ?? 0
			const nodes = await this.syncState.listLocalNodes()
			const candidate = nodes.find(
				(node) =>
					node.nodeId !== refused &&
					node.held &&
					(node.refusedCycle === null || node.refusedCycle < cycle),
			)
			if (candidate) {
				await switchTo(candidate.nodeId)
				target = candidate.nodeId
			}
		}
		if (target === null) target = (await rotate([])).nodeId
		await this.afterIdentityChange()
		this.emitter?.emit({
			type: 'sync:node-id-rotated',
			previousNodeId: refused,
			nodeId: target,
			reenqueuedCount: 0,
			heldCount: held.count,
		})
	}

	/** RT-21: re-author a never-accepted node's never-sent writes under a fresh node. */
	private async reauthorUnsentAndRotate(
		refused: string,
		rotate: (ids: string[]) => Promise<{ nodeId: string; operations: Operation[] }>,
	): Promise<void> {
		await this.syncState?.markLocalNodeRefused?.(refused, false)
		const queuedIds = this.outboundQueue
			.getAll()
			.filter((op) => op.nodeId === refused && !this.outboundQueue.wasSent(op.id))
			.map((op) => op.id)
		const ids = new Set(queuedIds)
		// Own operations above the acknowledged prefix that were never read into the
		// queue (the unscanned tail) are unsynced too.
		const localSeq = this.store.getVersionVector().get(refused) ?? 0
		if (localSeq > this.ownAckedThrough) {
			const above = await this.store.getOperationRange(refused, this.ownAckedThrough + 1, localSeq)
			const candidates = above.filter(
				(op) =>
					op.nodeId === refused &&
					op.sequenceNumber > this.ownAckedThrough &&
					!this.isOwnOperationResolved(op) &&
					!this.outboundQueue.wasSent(op.id),
			)
			const terminal = await this.findTerminalRejections(candidates.map((op) => op.id))
			for (const op of candidates) {
				if (!terminal.has(op.id)) ids.add(op.id)
			}
		}
		const result = await rotate([...ids])
		await this.outboundQueue.replace(queuedIds, result.operations)
		await this.afterIdentityChange()
		this.emitter?.emit({
			type: 'sync:node-id-rotated',
			previousNodeId: refused,
			nodeId: result.nodeId,
			reenqueuedCount: result.operations.length,
		})
	}

	/** The store moved to another node id: the next session starts from it. */
	private async afterIdentityChange(): Promise<void> {
		this.nodeToken = null
		this.nodeTokenNodeId = null
		this.sessionNodeId = this.store.getNodeId()
		// The new node id has its own acknowledged prefix.
		await this.withOwnTracking(async () => {
			this.ownTrackingNodeId = null
			await this.loadOwnTrackingLocked()
		})
		await this.refreshPendingCount()
	}

	/** Whether a handshake as `nodeId` was ever accepted on this database. */
	private async wasNodeAccepted(nodeId: string): Promise<boolean> {
		if (this.memoryAcceptedNodes.has(nodeId)) return true
		if (!this.syncState?.listLocalNodes) return false
		const nodes = await this.syncState.listLocalNodes()
		return nodes.some((node) => node.nodeId === nodeId && node.accepted)
	}

	/**
	 * Re-stamps queued (never-acknowledged) operations whose timestamps are far
	 * enough in the future that the server would reject them, using the server's
	 * own handshake time as the trusted "now". This is the automatic recovery
	 * path after a user corrects a fast device clock: the queue drains
	 * immediately instead of waiting for real time to catch up.
	 */
	private async maybeRebaseQueuedOperations(serverTime: number): Promise<void> {
		// Optional store capability — hand-rolled SyncStore implementations
		// without it silently keep the old (blocked-until-time-catches-up) behavior.
		const rebase = this.store.rebaseUnsyncedOperations?.bind(this.store)
		if (!rebase) return

		// Only operations that never reached the wire may be re-stamped (W3 step 4): a
		// sent one may already be stored on the server with its ack lost, and re-stamping
		// it would upload the same change twice under two ids.
		const queued = this.outboundQueue
			.getAll()
			.filter((op) => op.nodeId === this.currentNodeId() && !this.outboundQueue.wasSent(op.id))
		if (queued.length === 0) return

		let maxQueuedWallTime = Number.NEGATIVE_INFINITY
		for (const op of queued) {
			if (op.timestamp.wallTime > maxQueuedWallTime) {
				maxQueuedWallTime = op.timestamp.wallTime
			}
		}

		// Mirror the server's ingest tolerance: ops within +60s of server time
		// would be accepted as-is, so rewriting them would churn ids for nothing.
		const SERVER_FUTURE_TOLERANCE_MS = 60_000
		if (maxQueuedWallTime <= serverTime + SERVER_FUTURE_TOLERANCE_MS) return

		try {
			const result = await rebase(
				queued.map((op) => op.id),
				serverTime,
			)
			await this.withOwnTracking(async () => {
				await this.outboundQueue.replace(
					queued.map((op) => op.id),
					result.operations,
				)
				// The rewritten ops keep their sequence numbers but get new ids.
				for (const [oldId, newId] of Object.entries(result.idMapping)) {
					for (const ids of this.ownUnresolved.values()) {
						if (ids.delete(oldId)) ids.add(newId)
					}
				}
			})
			this.emitter?.emit({
				type: 'sync:clock-rebase',
				rebasedCount: result.rebasedCount,
				maxSkewMs: maxQueuedWallTime - serverTime,
			})
		} catch (error) {
			// Never let a failed rebase crash the handshake: the old ops stay
			// queued, the server will reject them with INVALID_TIMESTAMP, and the
			// existing clock-block path takes over. Surface the failure through an
			// existing event type rather than swallowing it.
			this.emitter?.emit({
				type: 'store:persistence-error',
				dbName: 'kora-oplog',
				message: error instanceof Error ? error.message : 'Timestamp rebase failed',
				code: 'CLOCK_REBASE_FAILED',
			})
		}
	}

	/**
	 * Upload this device's unsynced operations as the handshake delta. The delta is the
	 * outbound queue itself (rebuilt from the op log above the acknowledged prefix), sent
	 * as tracked batches: nothing leaves the queue until the server acknowledges the batch
	 * that carried it (SYNC-4).
	 */
	private async sendDelta(): Promise<void> {
		const epoch = this.sessionEpoch
		const strict = this.config.strictHandshake === true
		const entries: InFlightUpload[] = []
		for (let entry = this.takeUpload(); entry; entry = this.takeUpload()) {
			entries.push(entry)
		}

		if (entries.length === 0) {
			const messageId = generateMessageId()
			if (strict) {
				this.pendingDeltaBatchAcks.add(messageId)
			}
			const emptyBatch: SyncMessage = {
				type: 'operation-batch',
				messageId,
				operations: [],
				isFinal: true,
				batchIndex: 0,
				totalBatches: 1,
			}
			this.transport.send(emptyBatch)
			if (!strict) {
				this.deltaSendComplete = true
				void this.checkDeltaComplete()
			}
			return
		}

		const totalBatches = entries.length
		this.initialSyncTotalBatches = Math.max(this.initialSyncTotalBatches, totalBatches)
		// One durability barrier for the whole delta (RT-35), not one per batch: flag every
		// batch sent first (flagging writes, which would dirty the store again between
		// batches), then make it all durable. sendUpload re-checks both, as no-ops; a
		// failure here surfaces there, per batch, and postpones that batch.
		try {
			for (const entry of entries) await this.outboundQueue.markSent(entry.batch.batchId)
			await this.awaitUploadDurability()
		} catch {
			// Reported by sendUpload, which retries the barrier before each batch.
		}
		for (const [i, entry] of entries.entries()) {
			if (this.sessionEpoch !== epoch) {
				// The session ended mid-delta: the rest goes back to the queue.
				if (this.inFlightUploads.get(entry.batch.batchId) === entry) this.returnUpload(entry)
				continue
			}
			const cursor = createDeltaCursorFromBatch(entry.batch.operations, i)
			await this.sendUpload(entry, {
				isFinal: i === totalBatches - 1,
				batchIndex: i,
				totalBatches,
				...(cursor ? { cursor: encodeDeltaCursor(cursor) } : {}),
				beforeSend: (messageId) => {
					if (strict) this.pendingDeltaBatchAcks.add(messageId)
				},
			})
		}

		if (!strict && this.sessionEpoch === epoch) {
			this.deltaSendComplete = true
			void this.checkDeltaComplete()
		}
	}

	private markDeltaSendCompleteIfReady(): void {
		if (this.config.strictHandshake && this.pendingDeltaBatchAcks.size > 0) {
			return
		}
		this.deltaSendComplete = true
		void this.checkDeltaComplete()
	}

	/** Take the next batch from the queue and track it until it is resolved. */
	private takeUpload(): InFlightUpload | null {
		const batch = this.outboundQueue.takeBatch(this.batchSize, this.isSessionOperation)
		if (!batch) return null
		const entry: InFlightUpload = {
			batch,
			messageId: null,
			epoch: this.sessionEpoch,
			retryBackoff: false,
		}
		this.inFlightUploads.set(batch.batchId, entry)
		return entry
	}

	/** Whether a taken batch still belongs to the live session (SYNC-10). */
	private isUploadCurrent(entry: InFlightUpload): boolean {
		return (
			this.inFlightUploads.get(entry.batch.batchId) === entry &&
			entry.epoch === this.sessionEpoch &&
			(this.state === 'syncing' || this.state === 'streaming')
		)
	}

	/** Return one taken batch to the queue and forget its tracking. */
	private returnUpload(entry: InFlightUpload): void {
		this.outboundQueue.returnBatch(entry.batch.batchId)
		this.inFlightUploads.delete(entry.batch.batchId)
		if (entry.messageId) this.uploadByMessageId.delete(entry.messageId)
		if (this.inFlightUploads.size === 0) this.clearOutboundAckTimer()
	}

	/** Return every taken batch to the queue (the session ended; nothing was resolved). */
	private returnAllInFlightUploads(): void {
		for (const entry of [...this.inFlightUploads.values()]) {
			this.outboundQueue.returnBatch(entry.batch.batchId)
		}
		this.inFlightUploads.clear()
		this.uploadByMessageId.clear()
		this.clearOutboundAckTimer()
	}

	/**
	 * The oldest batch taken from the queue and not yet resolved (diagnostics and
	 * tests); null when nothing is in flight.
	 */
	private get currentBatch(): OutboundBatch | null {
		const first = this.inFlightUploads.values().next()
		return first.done ? null : first.value.batch
	}

	private inFlightUploadCount(): number {
		let count = 0
		for (const entry of this.inFlightUploads.values()) count += entry.batch.operations.length
		return count
	}

	/**
	 * Prepare, encrypt and send one taken batch, then register its message id so the ack
	 * that names it resolves exactly this batch. Every await is followed by a check that
	 * the batch still belongs to the live session; a send that throws returns the batch
	 * to the queue instead of rejecting unhandled (SYNC-10).
	 *
	 * @returns The wire message id, or null when the batch was not sent.
	 */
	private async sendUpload(
		entry: InFlightUpload,
		frame: {
			isFinal: boolean
			batchIndex: number
			totalBatches?: number
			cursor?: string
			beforeSend?: (messageId: string) => void
		},
	): Promise<string | null> {
		// The server acknowledges a batch as "processed through sequence n", in the order
		// it processes them; sending own operations in sequence order keeps that a prefix.
		const operations = [...entry.batch.operations].sort(compareForUpload)
		const preparer = this.outboundPreparer
		if (preparer) {
			// Let the app send what the server needs BEFORE these operations (blob bytes,
			// so the server sees proof of possession before the reference, RT-11).
			try {
				await preparer(operations)
			} catch {
				// Best effort: the server decides on the operations themselves.
			}
			if (!this.isUploadCurrent(entry)) return null
		}

		let wireOperations = operations
		if (this.encryptor) {
			try {
				wireOperations = await this.encryptor.encryptBatch(operations)
			} catch (err) {
				// Nothing was sent: return the batch so no data is lost.
				if (this.inFlightUploads.get(entry.batch.batchId) === entry) this.returnUpload(entry)
				this.emitter?.emit({
					type: 'sync:disconnected',
					reason: err instanceof Error ? err.message : 'Encryption failed',
				})
				return null
			}
			if (!this.isUploadCurrent(entry)) return null
		}

		if (!this.isUploadCurrent(entry)) return null
		// Flag the operations as sent BEFORE they reach the wire: from then on they may be
		// stored on the server even if no ack ever arrives, so a rebase or a node rotation
		// must leave them (RT-38). Then make every local write durable (RT-35): the server
		// must never hold an operation, or the device lack a sent flag, that a reload could
		// lose. The in-memory flag is set synchronously, before the first await.
		try {
			await this.outboundQueue.markSent(entry.batch.batchId)
			await this.awaitUploadDurability()
		} catch (error) {
			if (this.inFlightUploads.get(entry.batch.batchId) === entry) this.returnUpload(entry)
			this.emitter?.emit({
				type: 'store:persistence-error',
				dbName: 'kora-oplog',
				message:
					error instanceof Error
						? `Upload postponed: local writes are not durable yet (${error.message})`
						: 'Upload postponed: local writes are not durable yet',
				code: 'UPLOAD_NOT_DURABLE',
			})
			this.scheduleOutboundRetry()
			return null
		}
		if (!this.isUploadCurrent(entry)) return null

		const messageId = generateMessageId()
		const message: SyncMessage = {
			type: 'operation-batch',
			messageId,
			operations: wireOperations.map((op) => this.serializer.encodeOperation(op)),
			isFinal: frame.isFinal,
			batchIndex: frame.batchIndex,
			...(frame.totalBatches !== undefined ? { totalBatches: frame.totalBatches } : {}),
			...(frame.cursor !== undefined ? { cursor: frame.cursor } : {}),
		}
		entry.messageId = messageId
		this.uploadByMessageId.set(messageId, entry.batch.batchId)
		frame.beforeSend?.(messageId)
		try {
			this.transport.send(message)
		} catch (error) {
			this.returnUpload(entry)
			this.pendingDeltaBatchAcks.delete(messageId)
			this.emitter?.emit({
				type: 'sync:disconnected',
				reason: error instanceof Error ? error.message : 'Send failed',
			})
			return null
		}
		this.startOutboundAckTimer()
		this.emitter?.emit({
			type: 'sync:sent',
			operations,
			batchSize: operations.length,
		})
		this.notifyStatusChange()
		return messageId
	}

	/**
	 * The durability barrier before an upload (RT-35), with a bounded number of failures
	 * (RT-49). Throws while the failures may be transient; after
	 * {@link DURABILITY_FAILURES_BEFORE_DEGRADED} consecutive failures it returns anyway
	 * (degraded mode, `localDurability: 'degraded'`, `sync:durability-degraded`) so the
	 * server keeps a durable copy. The barrier is still attempted every time: the first
	 * success leaves degraded mode (`sync:durability-restored`).
	 */
	private async awaitUploadDurability(): Promise<void> {
		if (!this.store.ensureDurable) return
		try {
			await this.store.ensureDurable()
		} catch (error) {
			this.durabilityFailures++
			if (this.durabilityDegraded) return
			if (this.durabilityFailures < DURABILITY_FAILURES_BEFORE_DEGRADED) throw error
			this.durabilityDegraded = true
			const message = error instanceof Error ? error.message : 'The local database is not durable'
			this.emitter?.emit({
				type: 'sync:durability-degraded',
				message,
				failedAttempts: this.durabilityFailures,
			})
			this.emitter?.emit({
				type: 'store:persistence-error',
				dbName: 'kora-oplog',
				message: `Uploading without local durability after ${this.durabilityFailures} failed attempts; the server holds the only durable copy of new writes (${message})`,
				code: 'DURABILITY_DEGRADED',
			})
			this.notifyStatusChange()
			return
		}
		this.durabilityFailures = 0
		if (this.durabilityDegraded) {
			this.durabilityDegraded = false
			this.emitter?.emit({ type: 'sync:durability-restored' })
			this.notifyStatusChange()
		}
	}

	private async handleOperationBatch(msg: OperationBatchMessage): Promise<void> {
		const isDeliveryBatch = msg.maxDeliverySequence !== undefined

		// Delivery-stream chain control. The server sends in-scope operations in delivery
		// order, each batch chaining base -> max. The watermark stays a sound, gap-free
		// lower bound, and a dropped batch recovers without a lost operation:
		if (isDeliveryBatch) {
			const base = msg.baseDeliverySequence ?? 0
			const max = msg.maxDeliverySequence ?? base
			if (base > this.deliveryWatermark) {
				// A gap: an earlier batch has not arrived. Do not apply out of order and do
				// not acknowledge, so the server's reliable retransmit (or the next handshake
				// resend from the watermark) redelivers the missing batch first.
				const gapKey = `${this.deliveryWatermark}:${base}`
				this.deliveryGapRepeatCount =
					this.lastDeliveryGapKey === gapKey ? this.deliveryGapRepeatCount + 1 : 1
				this.lastDeliveryGapKey = gapKey
				this.emitter?.emit({
					type: 'sync:delivery-gap',
					expectedBase: this.deliveryWatermark,
					receivedBase: base,
					currentWatermark: this.deliveryWatermark,
					messageId: msg.messageId,
					repeatCount: this.deliveryGapRepeatCount,
				})
				return
			}
			if (base < this.deliveryWatermark && max <= this.deliveryWatermark) {
				// Entirely below the watermark: a retransmit that crossed an ack, or a server
				// restarting the stream from 0 (it does so whenever the resolved scope differs
				// from the handshake scope). Re-acknowledge without re-applying, but still run
				// the initial-sync bookkeeping: a final batch must complete the handshake, or
				// the engine would sit in 'syncing' forever (NEW-SYNC-1).
				this.sendDeliveryAck(msg.messageId, this.deliveryWatermark)
				await this.recordReceivedBatch(msg, true, true, [], [])
				return
			}
			// base === watermark continues the chain. base < watermark < max straddles it:
			// the batch is applied whole (re-applying the part below the watermark is an
			// idempotent no-op) and the watermark advances to its max, so the next chained
			// batch (base == max) is not mistaken for a gap.
			this.hasInFlightDeliveryBatch = true
		}

		const operations = msg.operations.map((s) => this.serializer.decodeOperation(s))
		const deliverySequence = isDeliveryBatch ? (msg.maxDeliverySequence ?? null) : null

		// Whether every operation in this batch was durably applied, was a harmless
		// duplicate, or was durably quarantined. A retriable failure clears this so the
		// delivery watermark does not advance past the failed operation.
		let fullyApplied = true

		for (const retraction of msg.retractions ?? []) {
			try {
				await this.applyScopeRetraction(retraction, true)
			} catch {
				fullyApplied = false
			}
		}
		if ((msg.retractions?.length ?? 0) > 0) {
			await this.refreshPendingCount()
		}

		// Apply what the server delivered, in order (SYNC-2, NEW-SYNC-3): the server already
		// enforced the downlink scope and query view, and judging delivered operations
		// against the client's uplink scope dropped read-only data. Anything the client
		// deliberately does not apply is quarantined, never silently skipped.
		const received: Operation[] = []
		const quarantined: QuarantinedOperation[] = []
		for (const delivered of operations) {
			const outcome = await this.applyInbound(delivered, deliverySequence)
			if (outcome.operation) received.push(outcome.operation)
			if (outcome.kind === 'quarantine') quarantined.push(outcome.entry)
			else if (outcome.kind === 'stall') fullyApplied = false
		}

		if (received.length > 0) {
			this.lastSuccessfulPull = Date.now()
			this.emitter?.emit({
				type: 'sync:received',
				operations: received,
				batchSize: received.length,
			})
		}

		// Make the outcome durable BEFORE acknowledging. For a chained delivery batch the
		// quarantine rows and the watermark advance commit in one transaction, so the
		// watermark never passes an operation that is neither applied nor quarantined.
		const advance = isDeliveryBatch && fullyApplied && msg.maxDeliverySequence !== undefined
		if (advance && msg.maxDeliverySequence !== undefined) {
			this.deliveryGapRepeatCount = 0
			this.lastDeliveryGapKey = null
			const watermark = Math.max(this.deliveryWatermark, msg.maxDeliverySequence)
			await this.commitDeliveryProgress(quarantined, watermark)
			this.deliveryWatermark = watermark
			this.setViewWatermark(this.deliverySignature(), watermark)
			if (
				this.blockedFailure &&
				received.some((op) => op.id === this.blockedFailure?.operationId)
			) {
				const recovered = this.blockedFailure
				this.blockedFailure = null
				this.emitter?.emit({ type: 'sync:apply-recovered', failure: recovered })
			}
		} else if (!isDeliveryBatch && quarantined.length > 0) {
			// A legacy (version-vector) or relay batch has no watermark to move, but its
			// quarantined operations must still be recorded before the ack releases them.
			await this.commitDeliveryProgress(quarantined, null)
		}

		// Acknowledge the batch. A legacy (version-vector) batch is always acknowledged.
		// A delivery-stream batch is acknowledged only when it fully applied: a failed
		// delivery batch must NOT be acknowledged, so the server keeps re-sending it from
		// the client's last acknowledged position rather than releasing it.
		if (!isDeliveryBatch || advance) {
			const lastOp = operations[operations.length - 1]
			const ack: SyncMessage = {
				type: 'acknowledgment',
				messageId: generateMessageId(),
				acknowledgedMessageId: msg.messageId,
				lastSequenceNumber: lastOp ? lastOp.sequenceNumber : 0,
				...(advance && msg.maxDeliverySequence !== undefined
					? { deliverySequence: this.deliveryWatermark }
					: {}),
			}
			this.transport.send(ack)

			this.emitter?.emit({
				type: 'sync:acknowledged',
				sequenceNumber: lastOp ? lastOp.sequenceNumber : 0,
			})
		}
		this.hasInFlightDeliveryBatch = false

		await this.recordReceivedBatch(msg, isDeliveryBatch, fullyApplied, received, operations)
		this.notifyStatusChange()
	}

	/**
	 * Initial-sync bookkeeping for a received batch: progress, the legacy resume cursor,
	 * and completion on the final batch. Runs for duplicate batches too (NEW-SYNC-1).
	 */
	private async recordReceivedBatch(
		msg: OperationBatchMessage,
		isDeliveryBatch: boolean,
		fullyApplied: boolean,
		received: Operation[],
		operations: Operation[],
	): Promise<void> {
		if (this.state !== 'syncing') {
			return
		}
		this.deltaBatchesReceived++
		const totalBatches = msg.totalBatches ?? this.initialSyncTotalBatches
		if (msg.totalBatches !== undefined) {
			this.initialSyncTotalBatches = msg.totalBatches
		}
		this.metricsCollector.updateInitialSyncProgress(this.deltaBatchesReceived, totalBatches)

		// The version-vector resume cursor is only used for the legacy (non-delivery)
		// delta path. A delivery stream resumes from the watermark instead.
		if (!isDeliveryBatch) {
			const cursorFromBatch =
				msg.cursor !== undefined
					? decodeDeltaCursor(msg.cursor)
					: createDeltaCursorFromBatch(received.length > 0 ? received : operations, msg.batchIndex)
			if (cursorFromBatch) {
				this.resumeDeltaCursor = cursorFromBatch
				await this.persistDeltaCursor(cursorFromBatch)
			}
		}

		// A delivery batch with a retriable failure must not complete initial sync (its
		// operations still need to arrive), so completion is gated on fullyApplied.
		if (msg.isFinal && (!isDeliveryBatch || fullyApplied)) {
			this.deltaReceiveComplete = true
			this.resumeDeltaCursor = null
			await this.persistDeltaCursor(null)
			this.metricsCollector.recordSyncCompleted()
			await this.checkDeltaComplete()
		}
	}

	/**
	 * Apply one delivered operation. Outcomes:
	 * - `applied`: applied, a duplicate, or a merge-decided skip (the record is settled);
	 * - `quarantine`: deliberately not applied and to be recorded durably (unknown
	 *   collection, transform unavailable, rejected or deferred apply, far-future
	 *   timestamp, undecryptable payload, referential failure), with `sync:apply-failed`;
	 * - `stall`: a retriable failure; the watermark must not pass it (or the engine
	 *   cannot record a quarantine durably), so the server re-sends it.
	 */
	private async applyInbound(
		delivered: Operation,
		deliverySequence: number | null,
	): Promise<
		| { kind: 'applied'; operation: Operation }
		| { kind: 'quarantine'; entry: QuarantinedOperation; operation: Operation | null }
		| { kind: 'stall'; operation: Operation | null }
	> {
		const quarantine = (
			op: Operation,
			code: string,
			message: string,
			result: Exclude<ApplyResult, 'applied' | 'duplicate'>,
			retriable: boolean,
			decrypted: Operation | null,
		):
			| { kind: 'quarantine'; entry: QuarantinedOperation; operation: Operation | null }
			| { kind: 'stall'; operation: Operation | null } => {
			if (!this.canQuarantine()) {
				// No durable quarantine next to a durable watermark: stall rather than lose.
				this.emitApplyFailure(op, result, { code, message, retriable }, 'blocking')
				return { kind: 'stall', operation: decrypted }
			}
			this.emitApplyFailure(op, result, { code, message, retriable }, 'quarantined')
			return {
				kind: 'quarantine',
				operation: decrypted,
				entry: { operation: op, deliverySequence, code, message, quarantinedAt: Date.now() },
			}
		}

		// Decrypt per operation (ENC-2): one undecryptable operation (another key, a
		// corrupted payload) is quarantined; the session and every other operation go on.
		let op = delivered
		if (this.encryptor) {
			try {
				op = await this.encryptor.decryptOperation(delivered)
			} catch (error) {
				return quarantine(
					delivered,
					QUARANTINE_CODES.DECRYPT_FAILED,
					error instanceof Error ? error.message : 'Failed to decrypt operation',
					'rejected',
					true,
					null,
				)
			}
		}

		// A far-future timestamp is never applied: adopting it would make every later
		// local edit lose to it until real time caught up (SYNC-7). The HLC also refuses
		// it once warm; this check covers a cold clock and does not depend on the store.
		const reference = Date.now() + (this.clockSkewMs ?? 0)
		if (op.timestamp.wallTime > reference + MAX_REMOTE_FUTURE_MS) {
			return quarantine(
				op,
				QUARANTINE_CODES.REMOTE_CLOCK_DRIFT,
				`Operation timestamp ${op.timestamp.wallTime} is more than ${MAX_REMOTE_FUTURE_MS}ms ahead of the reference time ${reference}; it is kept and retried once time catches up.`,
				'rejected',
				true,
				op,
			)
		}

		const targetSchemaVersion = this.config.schemaVersion ?? DEFAULT_SCHEMA_VERSION
		const transforms = this.config.operationTransforms ?? []
		const transformed =
			transforms.length > 0 ? applyOperationTransforms(op, targetSchemaVersion, transforms) : op
		if (transformed === null) {
			return quarantine(
				op,
				QUARANTINE_CODES.TRANSFORM_UNAVAILABLE,
				`No transform from schema v${op.schemaVersion} to v${targetSchemaVersion} for this operation; it is kept and replayed after an upgrade.`,
				'skipped',
				false,
				op,
			)
		}

		try {
			const result = await this.store.applyRemoteOperation(transformed)
			if (result === 'applied' || result === 'duplicate') {
				return { kind: 'applied', operation: op }
			}
			if (result === 'skipped' && this.store.hasCollection?.(transformed.collection) === true) {
				// A merge decision (for example a local update outranking a remote delete):
				// the record is settled; nothing to keep.
				this.emitApplyFailure(transformed, result, undefined, 'quarantined')
				return { kind: 'applied', operation: op }
			}
			const reason = defaultApplyFailureReason(result)
			return quarantine(transformed, reason.code, reason.message, result, reason.retriable, op)
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Apply failed'
			const code =
				error instanceof SyncError
					? error.code
					: error instanceof KoraError
						? error.code
						: error instanceof Error && 'code' in error && typeof error.code === 'string'
							? error.code
							: APPLY_FAILURE_CODES.APPLY_FAILED
			if (error instanceof ClockDriftError) {
				// This device's own clock is broken: a local condition, not the operation's
				// fault. Stall (blocking) so it is retried once the clock is fixed.
				this.emitApplyFailure(
					transformed,
					'rejected',
					{ code: APPLY_FAILURE_CODES.CLOCK_DRIFT, message: error.message, retriable: false },
					'blocking',
				)
				return { kind: 'stall', operation: op }
			}
			if (error instanceof RemoteClockDriftError || error instanceof InvalidTimestampError) {
				return quarantine(transformed, code, message, 'rejected', true, op)
			}
			if (code === APPLY_FAILURE_CODES.REFERENTIAL_INTEGRITY) {
				// Not appliable now (for example a child whose parent is outside this view);
				// kept and replayed rather than stalling every later operation.
				return quarantine(transformed, code, message, 'rejected', false, op)
			}
			// Anything else may be transient (a busy database): the store did not take
			// custody, so stall; the server re-sends it.
			this.emitApplyFailure(transformed, 'rejected', { code, message, retriable: true }, 'blocking')
			return { kind: 'stall', operation: op }
		}
	}

	/**
	 * Whether a not-applied operation can be recorded so the watermark may pass it: with
	 * a durable quarantine, or when nothing is durable (no persisted watermark either, so
	 * a restart re-delivers everything anyway).
	 */
	private canQuarantine(): boolean {
		if (!this.syncState) return true
		if (this.syncState.saveQuarantine) return true
		return !this.syncState.saveDeliveryWatermark
	}

	/**
	 * Record quarantined operations and (for a delivery batch) the watermark advance in
	 * one durable step.
	 */
	private async commitDeliveryProgress(
		quarantined: QuarantinedOperation[],
		watermark: number | null,
	): Promise<void> {
		const signature = this.deliverySignature()
		if (quarantined.length > 0 && this.syncState?.saveQuarantine) {
			await this.syncState.saveQuarantine(
				quarantined,
				watermark === null ? undefined : { signature, watermark },
			)
			return
		}
		for (const entry of quarantined) {
			this.memoryQuarantine.set(entry.operation.id, entry)
		}
		if (watermark !== null) {
			await this.persistDeliveryWatermark(watermark, signature)
		}
	}

	/** Every inbound operation held in quarantine (durable when persistence supports it). */
	async getQuarantinedOperations(): Promise<QuarantinedOperation[]> {
		if (this.syncState?.loadQuarantine) {
			return this.syncState.loadQuarantine()
		}
		return [...this.memoryQuarantine.values()]
	}

	/**
	 * Try to apply every quarantined operation again, oldest delivery first and in HLC
	 * order within a delivery. Runs on start (after a schema upgrade the unknown
	 * collection now exists; after time catches up a far-future op is acceptable) and on
	 * demand. Applied operations leave the quarantine; the rest stay.
	 *
	 * @returns How many operations left the quarantine.
	 */
	async retryQuarantinedOperations(): Promise<number> {
		return this.replayQuarantine()
	}

	private async replayQuarantine(): Promise<number> {
		const entries = await this.getQuarantinedOperations()
		if (entries.length === 0) return 0
		entries.sort(
			(a, b) =>
				(a.deliverySequence ?? 0) - (b.deliverySequence ?? 0) ||
				HybridLogicalClock.compare(a.operation.timestamp, b.operation.timestamp),
		)
		const released: string[] = []
		for (const entry of entries) {
			let outcome: Awaited<ReturnType<SyncEngine['applyInboundQuietly']>>
			try {
				outcome = await this.applyInboundQuietly(entry.operation)
			} catch {
				outcome = false
			}
			if (outcome) {
				released.push(entry.operation.id)
				this.emitter?.emit({
					type: 'sync:apply-recovered',
					failure: {
						operationId: entry.operation.id,
						collection: entry.operation.collection,
						recordId: entry.operation.recordId,
						code: entry.code,
						message: entry.message,
						retriable: true,
						firstSeenAt: entry.quarantinedAt,
						retryCount: 0,
					},
				})
			}
		}
		if (released.length === 0) return 0
		if (this.syncState?.removeQuarantine) {
			await this.syncState.removeQuarantine(released)
		}
		for (const id of released) this.memoryQuarantine.delete(id)
		return released.length
	}

	/** Re-apply a quarantined operation; true when it no longer needs to be kept. */
	private async applyInboundQuietly(stored: Operation): Promise<boolean> {
		let op = stored
		if (this.encryptor) {
			try {
				op = await this.encryptor.decryptOperation(stored)
			} catch {
				return false
			}
		}
		const reference = Date.now() + (this.clockSkewMs ?? 0)
		if (op.timestamp.wallTime > reference + MAX_REMOTE_FUTURE_MS) return false
		const targetSchemaVersion = this.config.schemaVersion ?? DEFAULT_SCHEMA_VERSION
		const transforms = this.config.operationTransforms ?? []
		const transformed =
			transforms.length > 0 ? applyOperationTransforms(op, targetSchemaVersion, transforms) : op
		if (transformed === null) return false
		const result = await this.store.applyRemoteOperation(transformed)
		if (result === 'applied' || result === 'duplicate') return true
		return result === 'skipped' && this.store.hasCollection?.(transformed.collection) === true
	}

	/** Acknowledge a delivery batch (used for duplicates) without re-applying it. */
	private sendDeliveryAck(acknowledgedMessageId: string, deliverySequence: number): void {
		const ack: SyncMessage = {
			type: 'acknowledgment',
			messageId: generateMessageId(),
			acknowledgedMessageId,
			lastSequenceNumber: 0,
			deliverySequence,
		}
		this.transport.send(ack)
	}

	/**
	 * An acknowledgment resolves exactly the upload batch it names (SYNC-4): operations
	 * the server processed (sequence <= `lastSequenceNumber`) leave the queue and count
	 * toward the acknowledged prefix; the rest return to the queue for retry. An ack that
	 * names no tracked batch (a node-token confirmation echo, a batch from an older
	 * session) resolves nothing.
	 */
	private async handleAcknowledgment(msg: AcknowledgmentMessage): Promise<void> {
		if (this.state === 'syncing' && this.config.strictHandshake) {
			this.pendingDeltaBatchAcks.delete(msg.acknowledgedMessageId)
			this.markDeltaSendCompleteIfReady()
		}

		const batchId = this.uploadByMessageId.get(msg.acknowledgedMessageId)
		const entry = batchId === undefined ? undefined : this.inFlightUploads.get(batchId)
		if (!entry || batchId === undefined) {
			return
		}
		this.uploadByMessageId.delete(msg.acknowledgedMessageId)
		this.inFlightUploads.delete(batchId)
		if (this.inFlightUploads.size === 0) {
			this.clearOutboundAckTimer()
		} else {
			this.startOutboundAckTimer()
		}

		const { acknowledged, returned } = await this.outboundQueue.acknowledgeThrough(
			batchId,
			msg.lastSequenceNumber,
		)
		if (acknowledged.length > 0) {
			const now = Date.now()
			this.lastSyncedAt = now
			this.lastSuccessfulPush = now
		}
		await this.withOwnTracking(async () => {
			for (const op of acknowledged) this.markOwnResolved(op)
			await this.advanceOwnPrefixLocked()
		})
		await this.refreshPendingCount()
		if (this.maybeEndSessionForNodeWork()) return

		// Continue flushing if more ops in queue
		const backoff = entry.retryBackoff || returned.length > 0
		if (this.state === 'streaming' && this.hasUploadable()) {
			if (backoff) {
				this.scheduleOutboundRetry()
			} else {
				this.outboundRetryAttempt = 0
				this.flushQueue()
			}
		} else if (!backoff) {
			this.outboundRetryAttempt = 0
		}
		this.notifyStatusChange()
	}

	private handleError(msg: { code: string; message: string; retriable: boolean }): void {
		if (msg.code === 'INVALID_TIMESTAMP') {
			// The server refused the batch at its first future-stamped operation and stored
			// none of the future-stamped ones, so a clock rebase may re-stamp them.
			const limit = Date.now() + (this.clockSkewMs ?? 0) + 60_000
			const refused = this.outboundQueue
				.getInFlight()
				.filter((op) => op.timestamp.wallTime > limit)
				.map((op) => op.id)
			this.outboundQueue.clearSent(refused)
		}
		// In-flight outbound batches will never be acknowledged now. Return them to the
		// queue so they are retried, instead of wedging every future flush behind a batch
		// that can never clear.
		this.sessionEpoch++
		this.returnAllInFlightUploads()
		// The server usually closes the socket right after an error, so the close may
		// already have moved the engine to disconnected. The error still carries
		// meaning (auth rejection, clock block, credential refresh): record it either way.
		const live = this.state !== 'disconnected'
		if (live) {
			this.transitionTo('error')
		}
		if (isCredentialEndingCode(msg.code)) {
			// The server ended this session because its credential expired or was
			// revoked (AUTH-11). Not fatal and not a sign-out: refresh, then reconnect.
			// A truly revoked device is refused at the next handshake (AUTH_FAILED), or
			// its refresh is rejected and the auth client signs it out.
			this.credentialRefreshRequired = true
		}
		if (msg.code === 'NODE_ID_CLAIMED' && !this.nodeRotation) {
			// Another device holds this node id (for example the node token issued at the
			// first claim was lost). Move to a fresh node id with every unsynced write;
			// the next connect uses it (RT-21).
			this.nodeRotation = this.rotateNodeIdentity().finally(() => {
				this.nodeRotation = null
			})
		}
		if (msg.code === 'AUTH_FAILED' || msg.code === 'DEVICE_REVOKED') {
			this.authRejected = true
			this.suspensionReason = msg.code === 'DEVICE_REVOKED' ? 'device-revoked' : 'auth-rejected'
			this.emitter?.emit({ type: 'sync:auth-failed', reason: msg.message })
			this.emitter?.emit({ type: 'sync:suspended', reason: this.suspensionReason })
		}
		if (msg.code === 'INVALID_TIMESTAMP') {
			// The server refused an operation stamped too far in the future: this
			// device's clock is (or was) fast. Block sync so the queue is preserved
			// and the app can tell the user to fix the clock.
			this.clockBlocked = true
			this.emitter?.emit({
				type: 'sync:clock-skew',
				skewMs: this.clockSkewMs ?? Number.NaN,
				severity: 'fast-blocked',
				source: 'server-reject',
			})
			if (live) {
				this.emitter?.emit({ type: 'sync:disconnected', reason: msg.message })
			}
			// Stay in 'error' (clock-error status) until the server closes the session or
			// the app clears the block; the block, not the socket, is what stops sync.
			return
		}
		if (live) {
			this.emitter?.emit({ type: 'sync:disconnected', reason: msg.message })
			this.transitionTo('disconnected')
			// The engine ended this session: release the socket too (SYNC-5).
			void this.closeTransportQuietly()
		}
	}

	/**
	 * Handle a per-operation rejection: divert the op out of the pending outbound
	 * queue (so it is never retried or resurrected on reconnect), record it in the
	 * durable rejected store (so it is kept and explainable), and emit an event so
	 * the app can reconcile. Unlike {@link handleError}, this is a normal per-op
	 * signal, so the connection stays up.
	 */
	private async applyScopeRetraction(
		retraction: { collection: string; recordId: string },
		applyToStore: boolean,
	): Promise<void> {
		if (applyToStore) {
			if (!this.store.applyScopeRetraction) {
				throw new Error('The configured sync store does not support scope retractions')
			}
			await this.store.applyScopeRetraction(retraction.collection, retraction.recordId)
		}
		const quarantined = await this.outboundQueue.rejectRecord(
			retraction.collection,
			retraction.recordId,
		)
		await this.recordTerminalRejections(quarantined, 'SCOPE_RETRACTED')
		for (const operation of quarantined) {
			await this.rejectedStorage.record({
				operationId: operation.id,
				collection: operation.collection,
				recordId: operation.recordId,
				code: 'SCOPE_RETRACTED',
				message: 'Authorization changed before this operation could be uploaded.',
				retriable: false,
				rejectedAt: Date.now(),
			})
		}
		if (quarantined.length > 0) {
			await this.withOwnTracking(async () => {
				for (const operation of quarantined) this.markOwnResolved(operation)
				await this.advanceOwnPrefixLocked()
			})
		}
		this.emitter?.emit({
			type: 'sync:scope-retracted',
			collection: retraction.collection,
			recordId: retraction.recordId,
			quarantinedOperationIds: quarantined.map((operation) => operation.id),
		})
	}

	private async handleOperationRejected(msg: OperationRejectedMessage): Promise<void> {
		if (msg.retriable) {
			// The op stays in its batch; the batch's ack stops short of it and returns it
			// to the queue. Back off before retrying that batch's leftovers.
			for (const entry of this.inFlightUploads.values()) {
				if (entry.batch.operations.some((op) => op.id === msg.operationId)) {
					entry.retryBackoff = true
				}
			}
			await this.refreshPendingCount()
			this.emitter?.emit({
				type: 'sync:operation-rejected',
				operationId: msg.operationId,
				collection: msg.collection,
				recordId: msg.recordId,
				code: msg.code,
				message: msg.message,
				retriable: true,
			})
			return
		}

		if (msg.code === SEQUENCE_CONFLICT && (await this.recoverSequenceConflict(msg.operationId))) {
			return
		}

		// The durable marker comes first (RT-36): once the prefix passes this op, only the
		// marker stops a later rescan of the device's history from submitting it again.
		const refusedOp = this.findQueuedOperation(msg.operationId)
		if (refusedOp && !NON_TERMINAL_REJECTION_CODES.has(msg.code)) {
			await this.recordTerminalRejections([refusedOp], msg.code)
		}
		const removed = await this.outboundQueue.reject(msg.operationId)

		await this.rejectedStorage.record({
			operationId: msg.operationId,
			collection: msg.collection,
			recordId: msg.recordId,
			code: msg.code,
			message: msg.message,
			retriable: msg.retriable,
			rejectedAt: Date.now(),
		})
		// Terminally rejected AND recorded: resolved for the acknowledged prefix.
		if (removed) {
			await this.withOwnTracking(async () => {
				this.markOwnResolved(removed)
				await this.advanceOwnPrefixLocked()
			})
		}

		// The rejected op left the pending set, so the app-visible pending count
		// must be refreshed or it would over-count forever.
		await this.refreshPendingCount()

		this.emitter?.emit({
			type: 'sync:operation-rejected',
			operationId: msg.operationId,
			collection: msg.collection,
			recordId: msg.recordId,
			code: msg.code,
			message: msg.message,
			retriable: msg.retriable,
		})
	}

	/**
	 * Every operation the server rejected that has not yet been reconciled. The app
	 * uses this (alongside the `sync:operation-rejected` event) to surface failed
	 * submissions and decide whether to roll back or resubmit.
	 */
	getRejectedOperations(): Promise<RejectedOperation[]> {
		return this.rejectedStorage.list()
	}

	/**
	 * Forget rejected operations by id once the app has reconciled them (rolled the
	 * optimistic write back or resubmitted a corrected op).
	 */
	clearRejectedOperations(operationIds: string[]): Promise<void> {
		return this.rejectedStorage.remove(operationIds)
	}

	private async checkDeltaComplete(): Promise<void> {
		if (!this.deltaSendComplete || !this.deltaReceiveComplete) {
			return
		}

		// Idempotent: multiple final delta batches can race during handshake.
		if (this.state !== 'syncing') {
			return
		}

		this.lastSyncedAt = Date.now()
		this.transitionTo('streaming')

		// Start awareness cleanup timer now that we're streaming
		this.awarenessManager.startCleanupTimer()

		// Re-broadcast local awareness state to the new connection
		const localState = this.awarenessManager.getLocalState()
		if (localState) {
			this.awarenessManager.setLocalState(localState)
		}

		// Flush any queued operations accumulated during delta exchange. Delta batches
		// still awaiting their acks stay in flight: only their acks resolve them.
		if (this.hasUploadable()) {
			this.flushQueue()
		}

		await this.refreshPendingCount()
		this.notifyStatusChange()
		this.maybeEndSessionForNodeWork()
	}

	// --- Own-operation upload tracking (W3: contiguous acknowledged prefix) ---

	/** Serialize every read-modify-write of the own-operation tracking. */
	private withOwnTracking<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.ownTrackingChain.then(fn)
		this.ownTrackingChain = run.then(
			() => undefined,
			() => undefined,
		)
		return run
	}

	private async loadOwnTracking(): Promise<void> {
		await this.withOwnTracking(() => this.loadOwnTrackingLocked())
	}

	/**
	 * Load the acknowledged prefix for the current node id, once per node id (an engine
	 * restart keeps its in-memory progress). A persistence layer that has never stored a
	 * prefix under this contract means an upgrade from a release that persisted a MAX:
	 * that value can hide a lost op below it, so the prefix restarts at 0 and the device
	 * re-uploads its own history once, chunk by chunk (the server dedups by id). The
	 * prefix is persisted as it advances, so the re-upload resumes where it stopped.
	 */
	private async loadOwnTrackingLocked(): Promise<void> {
		const nodeId = this.currentNodeId()
		if (this.ownTrackingNodeId === nodeId) return
		let prefix = 0
		if (this.syncState?.loadOwnAckedThrough) {
			const stored = await this.syncState.loadOwnAckedThrough(nodeId)
			if (stored === null) {
				await this.syncState.saveOwnAckedThrough?.(nodeId, 0)
			} else {
				prefix = stored
			}
		} else if (this.syncState) {
			prefix = this.lastAckedServerVector.get(nodeId) ?? 0
		}
		this.ownTrackingNodeId = nodeId
		this.ownAckedThrough = prefix
		this.ownScannedThrough = prefix
		this.ownUnresolved.clear()
		this.ownResolvedAhead.clear()
	}

	/**
	 * Register an own operation. `unresolved` ops are queued for upload; the others are
	 * already resolved (not upload-eligible). An op at or below the prefix (a sequence
	 * that was a gap when the prefix passed it) lowers the prefix: re-uploading is safe,
	 * skipping is not.
	 */
	private trackOwnOperation(op: Operation, unresolved: boolean): void {
		if (op.nodeId !== this.ownTrackingNodeId) return
		const seq = op.sequenceNumber
		if (seq <= this.ownAckedThrough) {
			if (!unresolved) return
			this.ownAckedThrough = seq - 1
			this.ownScannedThrough = Math.min(this.ownScannedThrough, seq - 1)
			void this.persistOwnPrefix()
		}
		const ids = this.ownUnresolved.get(seq) ?? new Set<string>()
		if (unresolved) ids.add(op.id)
		this.ownUnresolved.set(seq, ids)
	}

	/** Mark an own operation resolved (stored, terminally rejected, or not eligible). */
	private markOwnResolved(op: Operation): void {
		if (op.nodeId !== this.ownTrackingNodeId || op.sequenceNumber <= this.ownAckedThrough) return
		const ids = this.ownUnresolved.get(op.sequenceNumber)
		if (ids) {
			ids.delete(op.id)
		} else if (op.sequenceNumber <= this.ownScannedThrough) {
			this.ownUnresolved.set(op.sequenceNumber, new Set())
		}
		if (op.sequenceNumber > this.ownScannedThrough) {
			// The scan has not reached this sequence: remember the id so the scan does not
			// take the op for an unsent one and upload it again.
			this.ownResolvedAhead.set(op.id, op.sequenceNumber)
		}
	}

	private isOwnOperationResolved(op: Operation): boolean {
		if (op.sequenceNumber <= this.ownAckedThrough) return true
		const ids = this.ownUnresolved.get(op.sequenceNumber)
		return ids !== undefined && !ids.has(op.id) && !this.outboundQueue.has(op.id)
	}

	/**
	 * Lower the prefix (the server holds fewer of this device's operations than it
	 * believed) and forget what this session knew above it: the next advance rescans the
	 * log from there and re-enqueues what is missing.
	 */
	private async lowerOwnPrefixLocked(sequence: number): Promise<void> {
		const target = Math.max(0, sequence)
		if (target >= this.ownAckedThrough) return
		this.ownAckedThrough = target
		this.ownScannedThrough = target
		this.ownUnresolved.clear()
		this.ownResolvedAhead.clear()
		await this.persistOwnPrefix()
	}

	/**
	 * Advance the prefix over every resolved own sequence, reading the next chunk of the
	 * op log whenever it reaches a sequence this session has not examined yet. Reading a
	 * chunk enqueues its upload-eligible operations (and flushes when streaming), so the
	 * one-time upgrade re-upload proceeds chunk by chunk as acks arrive.
	 */
	private async advanceOwnPrefixLocked(): Promise<void> {
		if (this.ownTrackingNodeId !== this.currentNodeId()) return
		const localSeq = this.store.getVersionVector().get(this.ownTrackingNodeId) ?? 0
		const start = this.ownAckedThrough
		let scanned = false
		for (;;) {
			const next = this.ownAckedThrough + 1
			if (next > localSeq && !this.ownUnresolved.has(next)) break
			const ids = this.ownUnresolved.get(next)
			if (ids === undefined) {
				if (next > this.ownScannedThrough) {
					await this.scanOwnLog(next, Math.min(localSeq, next + OWN_LOG_SCAN_CHUNK - 1))
					scanned = true
					continue
				}
				// Examined, yet nothing registered: a hole in the log (a compacted or never
				// written sequence). Nothing there can be uploaded.
				this.ownUnresolved.set(next, new Set())
				continue
			}
			if (ids.size > 0) break
			this.ownUnresolved.delete(next)
			this.ownAckedThrough = next
			// Everything at or below the prefix is settled, so it counts as examined.
			if (next > this.ownScannedThrough) this.ownScannedThrough = next
		}
		if (this.ownAckedThrough !== start) {
			for (const [id, seq] of this.ownResolvedAhead) {
				if (seq <= this.ownScannedThrough) this.ownResolvedAhead.delete(id)
			}
			await this.persistOwnPrefix()
		}
		if (scanned && this.state === 'streaming' && this.hasUploadable()) {
			this.flushQueue()
		}
	}

	/**
	 * Read own operations [from, to] from the op log and register each sequence: an
	 * upload-eligible op not yet queued is enqueued; an ineligible one is recorded and
	 * resolved; a sequence with no op is resolved. Every sequence in the range ends up
	 * registered, which guarantees the advance loop makes progress.
	 */
	private async scanOwnLog(from: number, to: number): Promise<void> {
		const nodeId = this.ownTrackingNodeId
		if (nodeId === null || to < from) {
			this.ownScannedThrough = Math.max(this.ownScannedThrough, to)
			return
		}
		const ops = await this.store.getOperationRange(nodeId, from, to)
		const bySeq = new Map<number, Operation[]>()
		for (const op of ops) {
			if (op.nodeId !== nodeId || op.sequenceNumber < from || op.sequenceNumber > to) continue
			const list = bySeq.get(op.sequenceNumber) ?? []
			list.push(op)
			bySeq.set(op.sequenceNumber, list)
		}
		// Operations the server refused for good stay refused (RT-36): they are resolved,
		// never enqueued again, whatever today's state would make of them.
		const terminal = await this.findTerminalRejections(
			ops.filter((op) => !this.outboundQueue.has(op.id)).map((op) => op.id),
		)
		const eligible: Operation[] = []
		for (let seq = from; seq <= to; seq++) {
			const ids = this.ownUnresolved.get(seq) ?? new Set<string>()
			this.ownUnresolved.set(seq, ids)
			for (const op of bySeq.get(seq) ?? []) {
				if (this.ownResolvedAhead.delete(op.id)) continue
				if (ids.has(op.id)) continue
				if (terminal.has(op.id)) continue
				if (this.outboundQueue.has(op.id)) {
					ids.add(op.id)
					continue
				}
				if (await this.operationAllowedForUpload(op)) {
					eligible.push(op)
					ids.add(op.id)
				} else {
					await this.recordOutOfUplinkScope(op)
				}
			}
		}
		// One causal re-sort for the whole chunk, not one per operation.
		await this.outboundQueue.enqueueMany(eligible)
		this.ownScannedThrough = Math.max(this.ownScannedThrough, to)
	}

	private async persistOwnPrefix(): Promise<void> {
		const nodeId = this.ownTrackingNodeId
		if (!this.syncState || nodeId === null) return
		const prefix = this.ownAckedThrough
		await this.syncState.saveOwnAckedThrough?.(nodeId, prefix)
		// Mirror the prefix (exactly, never a max) into the acked server vector, which
		// compaction reads to decide which own operations the server already holds.
		const vector = new Map(this.lastAckedServerVector)
		vector.set(nodeId, prefix)
		this.lastAckedServerVector = vector
		await this.syncState.saveLastAckedServerVector(vector)
	}

	private async persistLastAckedServerVector(vector: VersionVector): Promise<void> {
		if (!this.syncState) {
			return
		}
		// Other nodes' entries record what the server advertised; a local node's entry is
		// only ever its acknowledged prefix (persistOwnPrefix), never an advertised value:
		// compaction reads it, and an advertised max can hide an unsynced op below it.
		const nodeId = this.currentNodeId()
		const others = new Map(vector)
		others.delete(nodeId)
		for (const local of this.localNodeIds) others.delete(local)
		const merged = this.syncState.mergeServerVectors(this.lastAckedServerVector, others)
		if (this.ownTrackingNodeId === nodeId) merged.set(nodeId, this.ownAckedThrough)
		this.lastAckedServerVector = merged
		await this.syncState.saveLastAckedServerVector(merged)
	}

	/**
	 * Refresh the pending count: own operations not yet stored on the server (queued or
	 * in flight), plus the own operations above the prefix not read from the log yet.
	 * Computed from the client's own acknowledgments only, so it drops the moment the
	 * server acknowledges, without waiting for a later handshake (RT-28).
	 */
	async refreshPendingCount(): Promise<void> {
		const previous = this.cachedUnsyncedCount
		this.cachedUnsyncedCount = this.computePendingCount()
		if (this.cachedUnsyncedCount !== previous) this.notifyStatusChange()
	}

	/** Synchronous pending count (see {@link refreshPendingCount}). */
	private computePendingCount(): number {
		let unscanned = 0
		const nodeId = this.ownTrackingNodeId
		if (nodeId !== null) {
			const localSeq = this.store.getVersionVector().get(nodeId) ?? 0
			unscanned = Math.max(0, localSeq - this.ownScannedThrough)
			for (const seq of this.ownUnresolved.keys()) {
				if (seq > this.ownScannedThrough && seq <= localSeq) unscanned--
			}
			unscanned = Math.max(0, unscanned)
		}
		// Queued operations of held nodes are reported separately (heldOperations, RT-38).
		const heldQueued =
			this.heldNodeIds.size === 0
				? 0
				: this.outboundQueue.countMatching((op) => this.heldNodeIds.has(op.nodeId))
		return this.outboundQueue.totalPending - heldQueued + unscanned + this.otherNodesPending
	}

	/** Unsynced operations held for a principal that is not signed in (RT-38). */
	private computeHeldCount(): number {
		if (this.heldNodeIds.size === 0) return 0
		return (
			this.heldPending + this.outboundQueue.countMatching((op) => this.heldNodeIds.has(op.nodeId))
		)
	}

	/**
	 * This device's operations not yet stored on the server (queued or in flight).
	 */
	async getPendingSyncOperations(): Promise<Operation[]> {
		return [
			...this.outboundQueue.getInFlight(),
			...this.outboundQueue.peek(Number.MAX_SAFE_INTEGER),
		]
	}

	/**
	 * Rebuild the upload set from the op log: every own operation above the acknowledged
	 * prefix that is upload-eligible is queued (first chunk now, the rest as acks move
	 * the prefix). Persisted queue entries that are already resolved are dropped.
	 */
	private async reconcileOutboundFromOpLog(): Promise<void> {
		await this.withOwnTracking(async () => {
			const nodeId = this.ownTrackingNodeId
			const stale = this.outboundQueue
				.getAll()
				.filter((op) => op.nodeId === nodeId && op.sequenceNumber <= this.ownAckedThrough)
				.map((op) => op.id)
			if (stale.length > 0) {
				await this.outboundQueue.removeByIds(stale)
			}
			for (const op of this.outboundQueue.getAll()) {
				this.trackOwnOperation(op, true)
			}
			await this.advanceOwnPrefixLocked()
		})
	}

	// --- Local nodes, terminal rejections and own-history recovery (Phase 2) ---

	/** Node id of the current session: the store's own, or an adopted node's (RT-40). */
	private currentNodeId(): string {
		return this.sessionNodeId ?? this.store.getNodeId()
	}

	/** A session uploads only operations authored under its own node id (RT-38, RT-40). */
	private readonly isSessionOperation = (op: Operation): boolean =>
		op.nodeId === this.currentNodeId()

	/** Whether the queue holds an operation this session may upload. */
	private hasUploadable(): boolean {
		return this.outboundQueue.hasOperationsMatching(this.isSessionOperation)
	}

	/** A queued or in-flight operation by id. */
	private findQueuedOperation(operationId: string): Operation | undefined {
		return (
			this.outboundQueue.getInFlight().find((op) => op.id === operationId) ??
			this.outboundQueue.getAll().find((op) => op.id === operationId)
		)
	}

	/**
	 * Pick the node this session runs as (RT-40). A local node other than the store's own
	 * that still has unsynced writes, is not held for another principal (RT-38), was not
	 * refused in this refusal cycle, and is used by no live tab (its lock is free) is
	 * adopted: the session runs as that node, uploads its writes with their original
	 * identity (no re-authoring, so a write its tab sent before closing is deduplicated by
	 * id), and ends once they are stored; the next session picks again. Also counts the
	 * other local nodes' unsynced writes, so they are reported (pending, or held).
	 */
	private async chooseSessionNode(): Promise<void> {
		this.endAdoption()
		const storeNode = this.store.getNodeId()
		this.sessionNodeId = storeNode
		this.otherNodesPending = 0
		this.heldPending = 0
		this.heldNodeIds = new Set()
		this.localNodeIds = new Set([storeNode])
		const syncState = this.syncState
		if (!syncState?.listLocalNodes) return
		let nodes: LocalNodeInfo[]
		let cycle = 0
		try {
			nodes = await syncState.listLocalNodes()
			cycle = (await syncState.loadAcceptedCycle?.()) ?? 0
		} catch (error) {
			this.emitter?.emit({
				type: 'store:persistence-error',
				dbName: 'kora-oplog',
				message: error instanceof Error ? error.message : 'Reading the local node registry failed',
				code: 'NODE_REGISTRY_FAILED',
			})
			return
		}
		for (const node of nodes) this.localNodeIds.add(node.nodeId)
		let adopted = false
		for (const node of nodes) {
			if (node.nodeId === storeNode) continue
			if (node.held) this.heldNodeIds.add(node.nodeId)
			const unsynced = await this.countUnsyncedOfNode(node.nodeId)
			if (unsynced.count === 0) {
				if (!node.held) await this.forgetDrainedNode(node.nodeId)
				continue
			}
			if (node.held) {
				this.heldPending += unsynced.notQueued
				continue
			}
			const refusedThisCycle = node.refusedCycle !== null && node.refusedCycle >= cycle
			if (!adopted && !refusedThisCycle && this.store.claimLocalNode) {
				const release = await this.store.claimLocalNode(node.nodeId)
				if (release) {
					adopted = true
					this.releaseAdoption = release
					this.sessionNodeId = node.nodeId
					this.emitter?.emit({
						type: 'sync:local-node',
						nodeId: node.nodeId,
						action: 'adoption-started',
						operationCount: unsynced.count,
					})
					continue
				}
			}
			this.otherNodesPending += unsynced.notQueued
		}
		if (adopted) {
			// While adopting, the store's own unsynced tail is not tracked by this session.
			this.otherNodesPending += (await this.countUnsyncedOfNode(storeNode)).notQueued
		}
	}

	/**
	 * A local node's own operations above its acknowledged prefix that are not
	 * terminally rejected: `count` all of them, `notQueued` those not in the queue.
	 */
	private async countUnsyncedOfNode(nodeId: string): Promise<{ count: number; notQueued: number }> {
		const localSeq = this.store.getVersionVector().get(nodeId) ?? 0
		let prefix = 0
		if (this.syncState?.loadOwnAckedThrough) {
			prefix = (await this.syncState.loadOwnAckedThrough(nodeId)) ?? 0
		} else {
			prefix = this.lastAckedServerVector.get(nodeId) ?? 0
		}
		if (localSeq <= prefix) return { count: 0, notQueued: 0 }
		const ops = (await this.store.getOperationRange(nodeId, prefix + 1, localSeq)).filter(
			(op) => op.nodeId === nodeId && op.sequenceNumber > prefix,
		)
		const terminal = await this.findTerminalRejections(ops.map((op) => op.id))
		const unsynced = ops.filter((op) => !terminal.has(op.id))
		return {
			count: unsynced.length,
			notQueued: unsynced.filter((op) => !this.outboundQueue.has(op.id)).length,
		}
	}

	/** Forget a drained, non-held local node no live tab uses (bounds the registry). */
	private async forgetDrainedNode(nodeId: string): Promise<void> {
		if (!this.syncState?.forgetLocalNode || !this.store.claimLocalNode) return
		const release = await this.store.claimLocalNode(nodeId)
		if (!release) return
		try {
			await this.syncState.forgetLocalNode(nodeId)
			this.localNodeIds.delete(nodeId)
		} finally {
			release()
		}
	}

	/** Release the lock on an adopted node (RT-40). */
	private endAdoption(): void {
		const release = this.releaseAdoption
		this.releaseAdoption = null
		release?.()
	}

	/** Record an accepted handshake as `nodeId` (RT-38), durably when supported. */
	private async recordNodeAccepted(nodeId: string): Promise<void> {
		this.memoryAcceptedNodes.add(nodeId)
		this.heldNodeIds.delete(nodeId)
		try {
			await this.syncState?.markLocalNodeAccepted?.(nodeId)
		} catch (error) {
			this.emitter?.emit({
				type: 'store:persistence-error',
				dbName: 'kora-oplog',
				message: error instanceof Error ? error.message : 'Recording the accepted node failed',
				code: 'NODE_REGISTRY_FAILED',
			})
		}
	}

	/** Which of these operation ids the server refused for good (RT-36). */
	private async findTerminalRejections(operationIds: string[]): Promise<Set<string>> {
		const found = new Set<string>()
		const unknown: string[] = []
		for (const id of operationIds) {
			if (this.terminalRejected.has(id)) found.add(id)
			else unknown.push(id)
		}
		if (unknown.length > 0 && this.syncState?.findTerminalRejections) {
			for (const id of await this.syncState.findTerminalRejections(unknown)) {
				found.add(id)
				this.terminalRejected.add(id)
			}
		}
		return found
	}

	/** Record durable terminal-rejection markers (RT-36). */
	private async recordTerminalRejections(operations: Operation[], code: string): Promise<void> {
		if (operations.length === 0 || NON_TERMINAL_REJECTION_CODES.has(code)) return
		for (const op of operations) this.terminalRejected.add(op.id)
		const rejectedAt = Date.now()
		await this.syncState?.recordTerminalRejections?.(
			operations.map((op) => ({
				operationId: op.id,
				nodeId: op.nodeId,
				sequenceNumber: op.sequenceNumber,
				code,
				rejectedAt,
			})),
		)
	}

	/**
	 * Restart server->client delivery from 0 at the next session, for the requested and the
	 * accepted views. A full resync includes this client's own operations (a resumed one
	 * does not), which is how operations the device lost come back (RT-35).
	 */
	private async resetDeliveryForFullResync(): Promise<void> {
		const signatures = new Set([
			this.deliverySignature(),
			this.deliverySignatureFor(this.config.scopeMap),
		])
		if (this.lastAcceptedScope) signatures.add(this.deliverySignatureFor(this.lastAcceptedScope))
		this.deliveryWatermark = 0
		for (const signature of signatures) {
			this.setViewWatermark(signature, 0)
			await this.persistDeliveryWatermark(0, signature)
		}
	}

	/**
	 * The server refused an upload with `SEQUENCE_CONFLICT`: it holds another operation of
	 * this node under that number, one this device lost (RT-35: a reload inside the
	 * IndexedDB snapshot window, a restored older copy). Not a refusal of the write: it
	 * gets a fresh number above everything the server holds (same id and content) and is
	 * uploaded again, and the session ends once its uploads are resolved so the next one
	 * resyncs from 0 and fetches the lost operation back.
	 *
	 * @returns Whether the conflict was recovered (false: treat as a plain rejection)
	 */
	private async recoverSequenceConflict(operationId: string): Promise<boolean> {
		const node = this.currentNodeId()
		const op = this.findQueuedOperation(operationId)
		const resequence = this.store.resequenceOperation?.bind(this.store)
		if (!op || op.nodeId !== node || !resequence) return false
		const floor = Math.max(this.remoteVector.get(node) ?? 0, op.sequenceNumber)
		const renumbered = await resequence(op.id, node, floor)
		await this.withOwnTracking(async () => {
			// Out of its batch, so the batch's ack cannot resolve it under the old number.
			await this.outboundQueue.reject(op.id)
			// The old number belongs to the server's operation.
			this.markOwnResolved(op)
			if (renumbered) {
				await this.outboundQueue.enqueue(renumbered)
				this.trackOwnOperation(renumbered, true)
			}
			await this.advanceOwnPrefixLocked()
		})
		this.emitter?.emit({
			type: 'sync:local-node',
			nodeId: node,
			action: 'history-behind',
			localSequence: op.sequenceNumber,
			serverSequence: floor,
		})
		await this.resetDeliveryForFullResync()
		this.ownRecoveryPending = true
		await this.refreshPendingCount()
		this.maybeEndSessionForNodeWork()
		return true
	}

	/**
	 * End the session when it has done its node work and nothing is in flight: an own-
	 * history recovery is pending (RT-35: reconnect to resync from 0), or an adopted node's
	 * writes are all stored (RT-40: reconnect as the next node, or this tab's own).
	 *
	 * @returns Whether the session was ended
	 */
	private maybeEndSessionForNodeWork(): boolean {
		if (this.state !== 'streaming' && this.state !== 'syncing') return false
		if (this.inFlightUploads.size > 0) return false
		if (this.ownRecoveryPending) {
			this.ownRecoveryPending = false
			this.abandonSession('Resyncing operations of this device that its local database lost')
			return true
		}
		const node = this.currentNodeId()
		if (node === this.store.getNodeId() || this.state !== 'streaming') return false
		if (this.hasUploadable()) return false
		const localSeq = this.store.getVersionVector().get(node) ?? 0
		if (this.ownTrackingNodeId !== node || this.ownAckedThrough < localSeq) return false
		this.emitter?.emit({ type: 'sync:local-node', nodeId: node, action: 'adoption-completed' })
		this.endAdoption()
		this.abandonSession('Uploaded the unsynced writes of a closed tab; reconnecting')
		return true
	}

	private flushQueue(): void {
		if (this.state !== 'streaming') return
		if (this.inFlightUploads.size > 0) return // one streaming batch in flight at a time
		if (this.outboundRetryTimer) return // Transient rejection backoff is active
		if (!this.hasUploadable()) return

		const entry = this.takeUpload()
		if (!entry) return
		void this.sendUpload(entry, { isFinal: true, batchIndex: 0 }).catch(() => {
			if (this.inFlightUploads.get(entry.batch.batchId) === entry) this.returnUpload(entry)
		})
	}

	private startOutboundAckTimer(): void {
		this.clearOutboundAckTimer()
		if (this.outboundAckTimeoutMs <= 0 || this.destroyed) return
		const epoch = this.sessionEpoch
		this.outboundAckTimer = setTimeout(() => {
			void this.handleOutboundAckTimeout(epoch)
		}, this.outboundAckTimeoutMs)
	}

	private clearOutboundAckTimer(): void {
		if (!this.outboundAckTimer) return
		clearTimeout(this.outboundAckTimer)
		this.outboundAckTimer = null
	}

	private scheduleOutboundRetry(): void {
		if (this.outboundRetryTimer || !this.hasUploadable() || this.destroyed) return
		const delay = Math.min(
			this.outboundRetryMaxDelayMs,
			this.outboundRetryBaseDelayMs * 2 ** this.outboundRetryAttempt,
		)
		this.outboundRetryAttempt += 1
		this.outboundRetryTimer = setTimeout(() => {
			this.outboundRetryTimer = null
			if (this.state === 'streaming') this.flushQueue()
		}, delay)
	}

	private clearOutboundRetryTimer(): void {
		if (!this.outboundRetryTimer) return
		clearTimeout(this.outboundRetryTimer)
		this.outboundRetryTimer = null
	}

	/** No ack arrived in time: return every batch in flight and reconnect. */
	private async handleOutboundAckTimeout(epoch: number): Promise<void> {
		this.outboundAckTimer = null
		if (epoch !== this.sessionEpoch || this.inFlightUploads.size === 0) return

		const batchIds = [...this.inFlightUploads.keys()].join(', ')
		this.sessionEpoch++
		this.returnAllInFlightUploads()
		await this.refreshPendingCount()

		if (this.state === 'disconnected') return

		const reason = `Timed out waiting for acknowledgment of outbound batch ${batchIds}`
		try {
			await this.transport.disconnect()
		} finally {
			this.ensureDisconnected()
			this.emitter?.emit({ type: 'sync:disconnected', reason })
		}
	}

	private handleAwarenessUpdate(msg: AwarenessUpdateMessage): void {
		const awarenessMessage: AwarenessMessage = {
			type: 'awareness',
			clientId: msg.clientId,
			states: wireToAwarenessStates(msg.states),
		}
		this.awarenessManager.handleRemoteMessage(awarenessMessage)
	}

	private handleTransportClose(reason: string): void {
		this.clearOutboundRetryTimer()
		this.awarenessManager.stopCleanupTimer()
		// Return in-flight batches to the queue: nothing unacknowledged is resolved.
		this.sessionEpoch++
		this.returnAllInFlightUploads()

		if (this.schemaBlocked) {
			return
		}

		if (this.state !== 'disconnected') {
			this.emitter?.emit({ type: 'sync:disconnected', reason })
			this.transitionTo('disconnected')
			this.notifyStatusChange()
		}
	}

	private handleTransportError(err: Error): void {
		// A transport error ends the session; close the transport so the socket is
		// released before any reconnect opens another (SYNC-5).
		if (this.state !== 'disconnected') {
			this.transitionTo('error')
			this.emitter?.emit({ type: 'sync:disconnected', reason: err.message })
			this.transitionTo('disconnected')
			this.sessionEpoch++
			this.returnAllInFlightUploads()
			void this.closeTransportQuietly()
			this.notifyStatusChange()
		}
	}

	private transitionTo(newState: SyncState): void {
		const validTargets = VALID_TRANSITIONS[this.state]
		if (!validTargets.includes(newState)) {
			throw new SyncError(`Invalid sync state transition: ${this.state} → ${newState}`, {
				from: this.state,
				to: newState,
			})
		}
		this.state = newState
		for (const listener of [...this.stateListeners]) {
			try {
				listener(newState)
			} catch {
				// A listener must never break a state transition.
			}
		}
	}

	private setSerializerWireFormat(format: WireFormat): void {
		if (typeof this.serializer.setWireFormat === 'function') {
			this.serializer.setWireFormat(format)
		}
	}

	/**
	 * Upload predicate: the UPLINK scope only, never query subsets (SYNC-1). Query
	 * subsets describe what this client wants to download; the server authorizes
	 * uploads independently of the client's downloaded view.
	 */
	private async operationAllowedForUpload(op: Operation): Promise<boolean> {
		// Fast path: the bare operation already carries the scope fields.
		if (this.matchesUplinkScope(op)) {
			return true
		}
		// A partial update or delete may not restate the scope fields. Backfill the
		// record's current fields before deciding, so an in-scope edit to an
		// unrelated field is never dropped.
		const fullRecord = await this.readRecordForBackfill(op)
		if (!fullRecord) {
			return false
		}
		return this.matchesUplinkScope(op, fullRecord)
	}

	/**
	 * Record a local operation that the uplink scope refuses, so it is visible to
	 * the app instead of silently diverging from the server. Operations on
	 * collections that are not synced in either direction are local-only by design
	 * and are not recorded.
	 *
	 * Such an operation counts as resolved for the contiguous acknowledged prefix: it is
	 * recorded here and never uploaded (W3 step 2).
	 */
	private async recordOutOfUplinkScope(op: Operation): Promise<void> {
		const uplink = this.activeUplinkScope
		if (!uplink) return
		const syncsCollection =
			uplink[op.collection] !== undefined || this.activeScope?.[op.collection] !== undefined
		if (!syncsCollection) return

		const message = `Operation on "${op.collection}" record "${op.recordId}" is outside this client's upload scope and was not sent to the server. The local change is not synced; roll it back or move the record back into scope.`
		await this.rejectedStorage.record({
			operationId: op.id,
			collection: op.collection,
			recordId: op.recordId,
			code: OUT_OF_UPLINK_SCOPE,
			message,
			retriable: false,
			rejectedAt: Date.now(),
		})
		this.emitter?.emit({
			type: 'sync:operation-rejected',
			operationId: op.id,
			collection: op.collection,
			recordId: op.recordId,
			code: OUT_OF_UPLINK_SCOPE,
			message,
			retriable: false,
		})
	}

	/**
	 * Whether an operation falls inside the uplink scope. Query subsets never apply to
	 * uploads (SYNC-1), and nothing applies to inbound operations: the client applies
	 * what the server delivered (SYNC-2).
	 */
	private matchesUplinkScope(op: Operation, fullRecord?: Record<string, unknown> | null): boolean {
		// A client judging its own local view may trust previousData: this is not a
		// cross-tenant visibility decision (the server judges those on its own rows).
		return operationMatchesScope(op, this.activeUplinkScope, fullRecord, {
			includePreviousData: true,
		})
	}

	private async readRecordForBackfill(op: Operation): Promise<Record<string, unknown> | null> {
		if (!this.store.readRecordFields) {
			return null
		}
		try {
			return await this.store.readRecordFields(op.collection, op.recordId)
		} catch {
			return null
		}
	}

	private async persistDeltaCursor(cursor: DeltaCursor | null): Promise<void> {
		if (!this.syncState?.saveDeltaCursor) {
			return
		}
		await this.syncState.saveDeltaCursor(cursor)
	}

	private async persistDeliveryWatermark(
		watermark: number,
		signature = this.deliverySignature(),
	): Promise<void> {
		if (!this.syncState?.saveDeliveryWatermark) {
			return
		}
		await this.syncState.saveDeliveryWatermark(signature, watermark)
	}

	private scheduleQuerySubsetReconnect(): void {
		if (this.querySubsetReconnectTimer) {
			clearTimeout(this.querySubsetReconnectTimer)
		}

		this.querySubsetReconnectTimer = setTimeout(() => {
			this.querySubsetReconnectTimer = null
			if (this.state === 'streaming' || this.state === 'syncing' || this.state === 'handshaking') {
				void this.reconnectForQuerySubsets()
			}
		}, 500)
	}

	private async reconnectForQuerySubsets(): Promise<void> {
		await this.reconnect()
	}
}

/**
 * Upload order inside a batch: by node, then sequence. For this device's own operations
 * sequence order is a causal order (each local op follows the ones before it), and it
 * makes the server's "processed through sequence n" ack an exact prefix of the batch.
 */
function compareForUpload(a: Operation, b: Operation): number {
	if (a.nodeId !== b.nodeId) return a.nodeId < b.nodeId ? -1 : 1
	return a.sequenceNumber - b.sequenceNumber
}

// --- Awareness wire format conversion helpers ---

/**
 * Convert internal awareness states to wire format for transport.
 */
function awarenessStatesToWire(
	states: Record<number, AwarenessState | null>,
): Record<string, AwarenessStateWire | null> {
	const wire: Record<string, AwarenessStateWire | null> = {}
	for (const [clientId, state] of Object.entries(states)) {
		if (state === null) {
			wire[clientId] = null
		} else {
			const wireState: AwarenessStateWire = {
				user: { ...state.user },
			}
			if (state.cursor) {
				wireState.cursor = { ...state.cursor }
			}
			wire[clientId] = wireState
		}
	}
	return wire
}

/**
 * Convert wire format awareness states to internal representation.
 */
function wireToAwarenessStates(
	wire: Record<string, AwarenessStateWire | null>,
): Record<number, AwarenessState | null> {
	const states: Record<number, AwarenessState | null> = {}
	for (const [clientId, wireState] of Object.entries(wire)) {
		if (wireState === null) {
			states[Number(clientId)] = null
		} else {
			const state: AwarenessState = {
				user: { ...wireState.user },
			}
			if (wireState.cursor) {
				state.cursor = { ...wireState.cursor }
			}
			states[Number(clientId)] = state
		}
	}
	return states
}
