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
	KoraError,
	SyncError,
	applyOperationTransforms,
	defaultApplyFailureReason,
} from '@korajs/core'
import { topologicalSort } from '@korajs/core/internal'
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
	operationMatchesQuerySubsets,
} from '../scopes/query-subset'
import { operationMatchesScope } from '../scopes/scope-filter'
import type { SyncTransport } from '../transport/transport'
import type { DeltaCursor } from '../types'
import {
	MemoryRejectedOperationStorage,
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

/**
 * Valid state transitions for the sync engine state machine.
 */
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
	timestamp: number
}

let nextMessageId = 0
let nextQuerySubsetId = 0
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
	private readonly transport: SyncTransport
	private readonly store: SyncStore
	private readonly config: SyncConfig
	private readonly serializer: MessageSerializer
	private readonly emitter: KoraEventEmitter | null
	private readonly outboundQueue: OutboundQueue
	private readonly rejectedStorage: RejectedOperationStorage
	private readonly batchSize: number
	private readonly encryptor: SyncEncryptor | null
	private readonly awarenessManager: AwarenessManager
	private readonly richtextDocChannel: RichtextDocChannel
	private readonly blobChunkChannel: BlobChunkChannel
	private readonly metricsCollector: SyncMetricsCollector
	private readonly syncState: SyncStatePersistence | null

	private remoteVector: VersionVector = new Map()
	private lastAckedServerVector: VersionVector = new Map()
	private cachedUnsyncedCount = 0
	private lastSyncedAt: number | null = null
	private lastSuccessfulPush: number | null = null
	private lastSuccessfulPull: number | null = null
	private conflictCount = 0
	private currentBatch: OutboundBatch | null = null
	private reconnecting = false
	private schemaBlocked = false
	private clockBlocked = false
	private clockSkewMs: number | null = null
	private blobStorageEnabled = false

	// Track delta exchange state
	private deltaBatchesReceived = 0
	private deltaReceiveComplete = false
	private deltaSendComplete = false
	/** Op ids sent during handshake delta — removed from outbound queue to avoid duplicate send */
	private deltaSentOpIds: string[] = []
	/** Outbound delta batch message IDs awaiting ACK when strictHandshake is enabled */
	private pendingDeltaBatchAcks = new Set<string>()

	/**
	 * The effective scope for this sync session.
	 * Starts as the configured scopeMap. After handshake, may be replaced
	 * with the server-accepted scope (server is authoritative).
	 */
	private activeScope: SyncScopeMap | undefined

	/** Live query subsets registered from reactive subscriptions */
	private querySubsets = new Map<string, SyncQuerySubset>()
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

	constructor(options: SyncEngineOptions) {
		this.transport = options.transport
		this.store = options.store
		this.config = options.config
		this.serializer = options.serializer ?? new NegotiatedMessageSerializer('json')
		this.emitter = options.emitter ?? null
		this.batchSize = options.config.batchSize ?? DEFAULT_BATCH_SIZE
		this.encryptor = options.encryptor ?? null
		this.syncState = options.syncState ?? null
		this.activeScope = options.config.scopeMap

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
				// Blob transfer is only meaningful once the connection reaches steady
				// state. A request dropped here is safe: the puller times out and
				// retries, and blob transfer is resumable.
				if (this.state !== 'streaming') {
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
		if (this.state !== 'disconnected') {
			throw new SyncError('Cannot start sync engine: not in disconnected state', {
				currentState: this.state,
			})
		}

		await this.outboundQueue.initialize()
		if (this.syncState) {
			this.lastAckedServerVector = await this.syncState.loadLastAckedServerVector()
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
			// Bound a set that predates the retention cap (older clients persisted views
			// without a limit); this one-time trim removes cold rows down to the cap.
			this.evictColdViewWatermarks()
		}
		await this.reconcileOutboundFromOpLog()
		await this.refreshPendingCount()

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
			const authToken = this.config.auth ? (await this.config.auth()).token : undefined

			await this.transport.connect(this.config.url, { authToken })
			this.transitionTo('handshaking')

			// Send handshake
			const localVector = this.store.getVersionVector()
			const activeQuerySubsets = this.getActiveQuerySubsets()
			const handshake: SyncMessage = {
				type: 'handshake',
				messageId: generateMessageId(),
				nodeId: this.store.getNodeId(),
				versionVector: versionVectorToWire(localVector),
				schemaVersion: this.config.schemaVersion ?? DEFAULT_SCHEMA_VERSION,
				authToken,
				supportedWireFormats: ['json', 'protobuf'],
				...(this.config.scopeMap ? { syncScope: this.config.scopeMap } : {}),
				...(activeQuerySubsets.length > 0 ? { syncQueries: activeQuerySubsets } : {}),
				...(this.resumeDeltaCursor
					? { deltaCursor: encodeDeltaCursor(this.resumeDeltaCursor) }
					: {}),
				// Resume the server's gap-free delivery stream from our watermark. A server
				// that understands it drives server->client sync from delivery sequences; an
				// older server ignores it and falls back to the version-vector delta.
				lastDeliverySequence: this.deliveryWatermark,
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
		if (this.state === 'disconnected') return

		// Stop awareness tracking
		this.awarenessManager.stopCleanupTimer()

		// Return any in-flight batch back to queue
		if (this.currentBatch) {
			this.outboundQueue.returnBatch(this.currentBatch.batchId)
			this.currentBatch = null
		}

		try {
			await this.transport.disconnect()
		} finally {
			// The transport.disconnect() callback may have already transitioned
			// to 'disconnected' via handleTransportClose. Re-read the mutable field.
			this.ensureDisconnected()
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
	 * Operations outside the configured sync scope are silently skipped
	 * because they should remain local-only and not be sent to the server.
	 */
	async pushOperation(op: Operation): Promise<void> {
		if (!(await this.operationAllowedForSync(op))) {
			return
		}

		if (this.syncState) {
			this.cachedUnsyncedCount++
		}

		await this.outboundQueue.enqueue(op)
		if (this.syncState) {
			await this.refreshPendingCount()
		}
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
		const pendingOperations = this.syncState
			? this.cachedUnsyncedCount
			: this.outboundQueue.totalPending
		const base = {
			pendingOperations,
			lastSyncedAt: this.lastSyncedAt,
			lastSuccessfulPush: this.lastSuccessfulPush,
			lastSuccessfulPull: this.lastSuccessfulPull,
			conflicts: this.conflictCount,
			clockSkewMs: this.clockSkewMs,
		}
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
				// During reconnection attempts, show 'offline' instead of 'syncing'
				// since the user is disconnected and reconnection is in progress.
				return { ...base, status: this.reconnecting ? 'offline' : 'syncing' }
			case 'streaming':
				return { ...base, status: pendingOperations > 0 ? 'syncing' : 'synced' }
			case 'error':
				if (this.clockBlocked) {
					return { ...base, status: 'clock-error' }
				}
				return { ...base, status: this.schemaBlocked ? 'schema-mismatch' : 'error' }
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
	 * Count of local operations not yet covered by the last acked server vector (op-log source of truth).
	 */
	async getUnsyncedOperationCount(): Promise<number> {
		await this.refreshPendingCount()
		return this.getStatus().pendingOperations
	}

	private emitApplyFailure(
		op: Operation,
		result: Exclude<ApplyResult, 'applied' | 'duplicate'>,
		overrides?: Partial<ApplyFailureReason>,
	): void {
		const reason = defaultApplyFailureReason(result, overrides)
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
		if (this.state === 'disconnected' || this.state === 'error') {
			this.reconnecting = false
			await this.start()
		}
	}

	/**
	 * Export a diagnostics snapshot for debugging and support tickets.
	 * Contains connection state, timing info, and queue metrics.
	 */
	exportDiagnostics(): SyncDiagnostics {
		return {
			state: this.state,
			status: this.getStatus(),
			nodeId: this.store.getNodeId(),
			url: this.config.url,
			schemaVersion: this.config.schemaVersion ?? DEFAULT_SCHEMA_VERSION,
			lastSyncedAt: this.lastSyncedAt,
			lastSuccessfulPush: this.lastSuccessfulPush,
			lastSuccessfulPull: this.lastSuccessfulPull,
			conflicts: this.conflictCount,
			pendingOperations: this.outboundQueue.totalPending,
			hasInFlightBatch: this.currentBatch !== null,
			reconnecting: this.reconnecting,
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
		const subsets = this.getActiveQuerySubsets()
		if (!this.activeScope && subsets.length === 0) {
			return '' // the default, unfiltered view (maps to the legacy watermark key)
		}
		const normalizedSubsets = subsets
			.map((s) => `${s.collection}:${stableStringify(s.where)}`)
			.sort()
		return stableStringify({ scope: this.activeScope ?? null, subsets: normalizedSubsets })
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

	/**
	 * Register a live query subset that narrows synced data for a collection.
	 * Takes effect on the next connection; reconnects when already connected.
	 */
	registerQuerySubset(subset: SyncQuerySubset): () => void {
		const id = `query-${nextQuerySubsetId++}`
		const previousSignature = this.deliverySignature()
		this.querySubsets.set(id, subset)
		// Registering or unregistering a subset changes the sync view. Switch the watermark
		// to the new view (resuming it if seen before, or resyncing it once if new); returning
		// to a previously-synced view resumes instead of re-syncing. The debounce coalesces a
		// burst of subscription changes into a single reconnect.
		this.switchDeliveryView(previousSignature)
		this.scheduleQuerySubsetReconnect()
		return () => {
			const sigBeforeRemove = this.deliverySignature()
			this.querySubsets.delete(id)
			this.switchDeliveryView(sigBeforeRemove)
			this.scheduleQuerySubsetReconnect()
		}
	}

	/**
	 * Returns deduplicated active query subsets from registered subscriptions.
	 */
	getActiveQuerySubsets(): SyncQuerySubset[] {
		return dedupeQuerySubsets([...this.querySubsets.values()])
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
	 * Upload a blob chunk (or manifest) to the server for central persistence.
	 * A no-op unless connected and the server advertised blob storage.
	 */
	uploadBlobChunk(hash: string, bytes: Uint8Array): void {
		if (this.state !== 'streaming' || !this.blobStorageEnabled) {
			return
		}
		this.blobChunkChannel.send({ type: 'blob-chunk-push', hash, bytes })
	}

	// --- Private methods ---

	private messageChain: Promise<void> = Promise.resolve()

	private enqueueMessage(message: SyncMessage): void {
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
				this.handleAcknowledgment(message)
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
		const reason = error instanceof Error ? error.message : 'Message handling failed'
		this.handleTransportClose(reason)
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

		if (typeof msg.serverTime === 'number') {
			this.evaluateClockSkew(msg.serverTime)
			if (this.clockBlocked) {
				this.metricsCollector.updateStatus('error')
				this.transitionTo('error')
				void this.transport.disconnect()
				return
			}
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
			return
		}

		this.remoteVector = wireToVersionVector(msg.versionVector)
		void this.persistLastAckedServerVector(this.remoteVector)

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

		if (msg.selectedWireFormat) {
			this.setSerializerWireFormat(msg.selectedWireFormat)
		}

		// If the server sent back an accepted scope, use it as the authoritative scope.
		// The server may have narrowed or augmented the client's requested scope
		// based on the auth context.
		if (msg.acceptedScope) {
			this.activeScope = msg.acceptedScope
		}

		this.emitter?.emit({ type: 'sync:connected', nodeId: this.store.getNodeId() })
		this.metricsCollector.recordConnected()
		this.metricsCollector.updateStatus('syncing')
		this.metricsCollector.recordSyncStarted()

		this.transitionTo('syncing')
		this.deltaBatchesReceived = 0
		this.deltaReceiveComplete = false
		this.deltaSendComplete = false
		this.deltaSentOpIds = []
		this.pendingDeltaBatchAcks.clear()
		this.initialSyncTotalBatches = 0

		// Rebase must finish BEFORE the delta exchange starts so only the
		// re-stamped operation ids ever reach the wire.
		if (typeof msg.serverTime === 'number') {
			await this.maybeRebaseQueuedOperations(msg.serverTime)
		}

		// Send our delta to the server
		this.sendDelta()
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

		const queued = this.outboundQueue.getAll()
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
			await this.outboundQueue.replaceAll(result.operations)
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

	private async sendDelta(): Promise<void> {
		const localVector = this.store.getVersionVector()
		const allMissingOps = await this.collectDelta(localVector, this.remoteVector)

		const missingOps = await this.filterAllowedForSync(allMissingOps)

		this.deltaSentOpIds = missingOps.map((op) => op.id)

		if (missingOps.length === 0) {
			const messageId = generateMessageId()
			if (this.config.strictHandshake) {
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
			if (!this.config.strictHandshake) {
				this.deltaSendComplete = true
				void this.checkDeltaComplete()
			}
			return
		}

		// Paginate into batches
		const sorted = topologicalSort(missingOps)
		const totalBatches = Math.ceil(sorted.length / this.batchSize)
		this.initialSyncTotalBatches = Math.max(this.initialSyncTotalBatches, totalBatches)

		for (let i = 0; i < totalBatches; i++) {
			const start = i * this.batchSize
			const batchOps = sorted.slice(start, start + this.batchSize)
			const batchCursor = createDeltaCursorFromBatch(batchOps, i)

			// Encrypt data fields before serialization if E2E encryption is enabled
			const opsToSerialize = this.encryptor ? await this.encryptor.encryptBatch(batchOps) : batchOps

			const serializedOps = opsToSerialize.map((op) => this.serializer.encodeOperation(op))

			const messageId = generateMessageId()
			if (this.config.strictHandshake) {
				this.pendingDeltaBatchAcks.add(messageId)
			}
			const batchMsg: SyncMessage = {
				type: 'operation-batch',
				messageId,
				operations: serializedOps,
				isFinal: i === totalBatches - 1,
				batchIndex: i,
				totalBatches,
				...(batchCursor ? { cursor: encodeDeltaCursor(batchCursor) } : {}),
			}
			this.transport.send(batchMsg)

			this.emitter?.emit({
				type: 'sync:sent',
				operations: batchOps,
				batchSize: batchOps.length,
			})
		}

		if (!this.config.strictHandshake) {
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

	private async collectDelta(
		localVector: VersionVector,
		remoteVector: VersionVector,
	): Promise<Operation[]> {
		const missing: Operation[] = []
		for (const [nodeId, localSeq] of localVector) {
			const remoteSeq = remoteVector.get(nodeId) ?? 0
			if (localSeq > remoteSeq) {
				const ops = await this.store.getOperationRange(nodeId, remoteSeq + 1, localSeq)
				missing.push(...ops)
			}
		}
		return missing
	}

	private async handleOperationBatch(msg: OperationBatchMessage): Promise<void> {
		const isDeliveryBatch = msg.maxDeliverySequence !== undefined

		// Delivery-stream chain control. The server sends in-scope operations in delivery
		// order, each batch chaining base -> max. Three cases keep the watermark a sound,
		// gap-free lower bound and let a dropped batch recover without a lost operation:
		if (isDeliveryBatch) {
			const base = msg.baseDeliverySequence ?? 0
			if (base > this.deliveryWatermark) {
				// A gap: an earlier batch has not arrived. Do not apply out of order and do
				// not acknowledge, so the server's reliable retransmit (or the next handshake
				// resend from the watermark) redelivers the missing batch first.
				return
			}
			if (base < this.deliveryWatermark) {
				// A duplicate of an already-applied batch (a retransmit that crossed an ack).
				// Re-acknowledge so the server can release it, but do not re-apply or move the
				// watermark backward.
				this.sendDeliveryAck(msg.messageId, this.deliveryWatermark)
				return
			}
			// base === watermark: this batch continues the chain; apply it in order below.
		}

		const deserialized = msg.operations.map((s) => this.serializer.decodeOperation(s))

		// Decrypt data fields after deserialization if E2E encryption is enabled
		const operations = this.encryptor
			? await this.encryptor.decryptBatch(deserialized)
			: deserialized

		const inScopeOps = await this.filterAllowedForSync(operations)

		const targetSchemaVersion = this.config.schemaVersion ?? DEFAULT_SCHEMA_VERSION
		const transforms = this.config.operationTransforms ?? []

		// Whether every operation in this batch was durably applied (or was a harmless
		// duplicate). A retriable failure clears this so the delivery watermark does not
		// advance past the failed operation, which is what makes a transient apply failure
		// recoverable instead of silently skipped.
		let fullyApplied = true

		// Apply each in-scope operation; per-op failures must not block batch ACK
		for (const op of inScopeOps) {
			const transformed =
				transforms.length > 0 ? applyOperationTransforms(op, targetSchemaVersion, transforms) : op
			if (transformed === null) {
				continue
			}

			try {
				const result = await this.store.applyRemoteOperation(transformed)
				if (result === 'skipped' || result === 'rejected' || result === 'deferred') {
					this.emitApplyFailure(transformed, result)
				}
			} catch (error) {
				// Any throw means the store did NOT take custody of the operation, so the
				// delivery watermark must not advance past it (whether the error is retriable
				// or terminal). Inbound operations are authoritative and are not diverted to a
				// rejected store the way the client's own rejected outbound operations are, so
				// advancing here would silently lose the operation with no way to recover it.
				// Stalling instead surfaces the failure (an emitted event) and re-fetches the
				// operation on the next exchange; a genuinely un-appliable inbound operation
				// (for example a scope that includes a child but excludes its parent) becomes a
				// visible, diagnosable stall rather than silent data loss.
				fullyApplied = false
				if (error instanceof ClockDriftError) {
					this.emitApplyFailure(transformed, 'rejected', {
						code: APPLY_FAILURE_CODES.CLOCK_DRIFT,
						message: error.message,
						retriable: false,
					})
					continue
				}
				const message = error instanceof Error ? error.message : 'Apply failed'
				const code =
					error instanceof SyncError
						? error.code
						: error instanceof KoraError
							? error.code
							: error instanceof Error && 'code' in error && typeof error.code === 'string'
								? error.code
								: APPLY_FAILURE_CODES.APPLY_FAILED
				const retriable = code !== APPLY_FAILURE_CODES.REFERENTIAL_INTEGRITY
				this.emitApplyFailure(transformed, 'rejected', { code, message, retriable })
			}
		}

		if (inScopeOps.length > 0) {
			this.lastSuccessfulPull = Date.now()
			this.emitter?.emit({
				type: 'sync:received',
				operations: inScopeOps,
				batchSize: inScopeOps.length,
			})
		}

		// Acknowledge the batch. A legacy (version-vector) batch is always acknowledged.
		// A delivery-stream batch is acknowledged only when it fully applied: a failed
		// delivery batch must NOT be acknowledged, so the server keeps re-sending it from
		// the client's last acknowledged position rather than releasing it (which would
		// strand the client until an unrelated reconnect).
		const deliveryFullyApplied = isDeliveryBatch && fullyApplied
		if (!isDeliveryBatch || deliveryFullyApplied) {
			const lastOp = operations[operations.length - 1]
			const ack: SyncMessage = {
				type: 'acknowledgment',
				messageId: generateMessageId(),
				acknowledgedMessageId: msg.messageId,
				lastSequenceNumber: lastOp ? lastOp.sequenceNumber : 0,
				...(deliveryFullyApplied && msg.maxDeliverySequence !== undefined
					? { deliverySequence: msg.maxDeliverySequence }
					: {}),
			}
			this.transport.send(ack)

			this.emitter?.emit({
				type: 'sync:acknowledged',
				sequenceNumber: lastOp ? lastOp.sequenceNumber : 0,
			})
		}

		// Advance the delivery watermark only for a chained delivery batch that fully
		// applied. This is the single place the watermark moves, so it always reflects a
		// gap-free prefix of the server's in-scope stream.
		if (isDeliveryBatch && fullyApplied && msg.maxDeliverySequence !== undefined) {
			this.deliveryWatermark = msg.maxDeliverySequence
			this.setViewWatermark(this.deliverySignature(), this.deliveryWatermark)
			await this.persistDeliveryWatermark(this.deliveryWatermark)
		}

		if (this.state === 'syncing') {
			this.deltaBatchesReceived++
			const totalBatches = msg.totalBatches ?? this.initialSyncTotalBatches
			if (msg.totalBatches !== undefined) {
				this.initialSyncTotalBatches = msg.totalBatches
			}
			this.metricsCollector.updateInitialSyncProgress(this.deltaBatchesReceived, totalBatches)

			// The version-vector resume cursor is only used for the legacy (non-delivery)
			// delta path. A delivery stream resumes from the watermark instead, so leave the
			// cursor untouched for those batches.
			if (!isDeliveryBatch) {
				const cursorFromBatch =
					msg.cursor !== undefined
						? decodeDeltaCursor(msg.cursor)
						: createDeltaCursorFromBatch(
								inScopeOps.length > 0 ? inScopeOps : operations,
								msg.batchIndex,
							)
				if (cursorFromBatch) {
					this.resumeDeltaCursor = cursorFromBatch
					await this.persistDeltaCursor(cursorFromBatch)
				}
			}

			// A delivery stream advances the watermark only when the batch fully applied; a
			// batch with a retriable failure must not complete initial sync (its operations
			// still need to arrive), so gate completion on fullyApplied for delivery batches.
			if (msg.isFinal && (!isDeliveryBatch || fullyApplied)) {
				this.deltaReceiveComplete = true
				this.resumeDeltaCursor = null
				await this.persistDeltaCursor(null)
				this.metricsCollector.recordSyncCompleted()
				void this.checkDeltaComplete()
			}
		}
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

	private handleAcknowledgment(msg: AcknowledgmentMessage): void {
		if (this.state === 'syncing' && this.config.strictHandshake) {
			this.pendingDeltaBatchAcks.delete(msg.acknowledgedMessageId)
			this.markDeltaSendCompleteIfReady()
		}

		if (this.currentBatch) {
			this.outboundQueue.acknowledge(this.currentBatch.batchId)
			this.currentBatch = null
			const now = Date.now()
			this.lastSyncedAt = now
			this.lastSuccessfulPush = now
		}

		void this.advanceLastAckedForLocalNode(msg.lastSequenceNumber).then(() =>
			this.refreshPendingCount(),
		)

		// Continue flushing if more ops in queue
		if (this.state === 'streaming' && this.outboundQueue.hasOperations) {
			this.flushQueue()
		}
	}

	private handleError(msg: { code: string; message: string; retriable: boolean }): void {
		// An in-flight outbound batch will never be acknowledged now. Return it to the
		// queue so it is retried, instead of leaving `currentBatch` set — which would
		// wedge every future flush behind a batch that can never clear (real-time
		// outbound sync would stall until the transport happened to reconnect).
		if (this.currentBatch) {
			this.outboundQueue.returnBatch(this.currentBatch.batchId)
			this.currentBatch = null
		}
		this.transitionTo('error')
		if (msg.code === 'AUTH_FAILED') {
			this.emitter?.emit({ type: 'sync:auth-failed', reason: msg.message })
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
			this.emitter?.emit({ type: 'sync:disconnected', reason: msg.message })
			return
		}
		this.emitter?.emit({ type: 'sync:disconnected', reason: msg.message })
		this.transitionTo('disconnected')
	}

	/**
	 * Handle a per-operation rejection: divert the op out of the pending outbound
	 * queue (so it is never retried or resurrected on reconnect), record it in the
	 * durable rejected store (so it is kept and explainable), and emit an event so
	 * the app can reconcile. Unlike {@link handleError}, this is a normal per-op
	 * signal, so the connection stays up.
	 */
	private async handleOperationRejected(msg: OperationRejectedMessage): Promise<void> {
		await this.outboundQueue.reject(msg.operationId)

		await this.rejectedStorage.record({
			operationId: msg.operationId,
			collection: msg.collection,
			recordId: msg.recordId,
			code: msg.code,
			message: msg.message,
			retriable: msg.retriable,
			rejectedAt: Date.now(),
		})

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

		// Ops already sent in sendDelta() must not be flushed again from the outbound queue
		if (this.deltaSentOpIds.length > 0) {
			await this.outboundQueue.removeByIds(this.deltaSentOpIds)
			this.deltaSentOpIds = []
		}

		if (this.syncState) {
			const localNodeId = this.store.getNodeId()
			const localSeq = this.store.getVersionVector().get(localNodeId) ?? 0
			if (localSeq > 0) {
				await this.advanceLastAckedForLocalNode(localSeq)
			}
		}

		// Flush any queued operations accumulated during delta exchange
		if (this.outboundQueue.hasOperations) {
			this.flushQueue()
		}

		await this.refreshPendingCount()
	}

	/**
	 * Effective server vector: persisted last-ack merged with live handshake remote vector.
	 */
	private getEffectiveServerVector(): VersionVector {
		if (!this.syncState) {
			return this.remoteVector
		}
		return this.syncState.mergeServerVectors(this.lastAckedServerVector, this.remoteVector)
	}

	private async persistLastAckedServerVector(vector: VersionVector): Promise<void> {
		if (!this.syncState) {
			return
		}
		this.lastAckedServerVector = this.syncState.mergeServerVectors(
			this.lastAckedServerVector,
			vector,
		)
		await this.syncState.saveLastAckedServerVector(this.lastAckedServerVector)
	}

	private async advanceLastAckedForLocalNode(lastSequenceNumber: number): Promise<void> {
		if (!this.syncState || lastSequenceNumber <= 0) {
			return
		}
		const nodeId = this.store.getNodeId()
		const merged = new Map(this.lastAckedServerVector)
		merged.set(nodeId, Math.max(merged.get(nodeId) ?? 0, lastSequenceNumber))
		this.lastAckedServerVector = merged
		await this.syncState.saveLastAckedServerVector(merged)
	}

	/**
	 * Refresh cached unsynced count from op log vs effective server vector.
	 */
	async refreshPendingCount(): Promise<void> {
		if (!this.syncState) {
			this.cachedUnsyncedCount = this.outboundQueue.totalPending
			return
		}
		this.cachedUnsyncedCount = await this.syncState.countUnsyncedOperations(
			this.getEffectiveServerVector(),
		)
	}

	/**
	 * Returns operations the server has not yet acknowledged (op-log source of truth).
	 */
	async getPendingSyncOperations(): Promise<Operation[]> {
		if (!this.syncState) {
			return this.outboundQueue.peek(Number.MAX_SAFE_INTEGER)
		}
		return this.syncState.getUnsyncedOperations(this.getEffectiveServerVector())
	}

	/**
	 * Hydrate the outbound queue from unsynced ops in the op log (deduped by operation id).
	 */
	private async reconcileOutboundFromOpLog(): Promise<void> {
		if (this.syncState) {
			const unsynced = await this.syncState.getUnsyncedOperations(this.getEffectiveServerVector())
			for (const op of unsynced) {
				await this.outboundQueue.enqueue(op)
			}
			return
		}

		const localNodeId = this.store.getNodeId()
		const localVector = this.store.getVersionVector()
		const localSeq = localVector.get(localNodeId) ?? 0
		if (localSeq === 0) {
			return
		}

		const ops = await this.store.getOperationRange(localNodeId, 1, localSeq)
		const inScope = await this.filterAllowedForSync(ops)
		for (const op of inScope) {
			await this.outboundQueue.enqueue(op)
		}
	}

	private flushQueue(): void {
		if (this.currentBatch) return // Already have an in-flight batch
		if (!this.outboundQueue.hasOperations) return

		const batch = this.outboundQueue.takeBatch(this.batchSize)
		if (!batch) return

		this.currentBatch = batch

		if (this.encryptor) {
			// Encryption is async — encrypt then send. Errors return the batch to the queue.
			this.encryptor.encryptBatch(batch.operations).then(
				(encrypted) => {
					const serializedOps = encrypted.map((op) => this.serializer.encodeOperation(op))
					const batchMsg: SyncMessage = {
						type: 'operation-batch',
						messageId: generateMessageId(),
						operations: serializedOps,
						isFinal: true,
						batchIndex: 0,
					}
					this.transport.send(batchMsg)

					this.emitter?.emit({
						type: 'sync:sent',
						operations: batch.operations,
						batchSize: batch.operations.length,
					})
				},
				(err) => {
					// If encryption fails, return the batch to the queue so no data is lost
					this.outboundQueue.returnBatch(batch.batchId)
					this.currentBatch = null
					this.emitter?.emit({
						type: 'sync:disconnected',
						reason: err instanceof Error ? err.message : 'Encryption failed',
					})
				},
			)
		} else {
			const serializedOps = batch.operations.map((op) => this.serializer.encodeOperation(op))
			const batchMsg: SyncMessage = {
				type: 'operation-batch',
				messageId: generateMessageId(),
				operations: serializedOps,
				isFinal: true,
				batchIndex: 0,
			}
			this.transport.send(batchMsg)

			this.emitter?.emit({
				type: 'sync:sent',
				operations: batch.operations,
				batchSize: batch.operations.length,
			})
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
		// Return in-flight batch to queue
		if (this.currentBatch) {
			this.outboundQueue.returnBatch(this.currentBatch.batchId)
			this.currentBatch = null
		}

		if (this.schemaBlocked) {
			return
		}

		if (this.state !== 'disconnected') {
			this.emitter?.emit({ type: 'sync:disconnected', reason })
			this.transitionTo('disconnected')
		}
	}

	private handleTransportError(err: Error): void {
		// Transport errors during connecting should transition to error
		if (this.state !== 'disconnected') {
			this.transitionTo('error')
			this.emitter?.emit({ type: 'sync:disconnected', reason: err.message })
			this.transitionTo('disconnected')
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
	}

	private setSerializerWireFormat(format: WireFormat): void {
		if (typeof this.serializer.setWireFormat === 'function') {
			this.serializer.setWireFormat(format)
		}
	}

	private async operationAllowedForSync(op: Operation): Promise<boolean> {
		// Fast path: the bare operation already carries the scope / subset fields
		// (inserts, or an op that restates them). No record read needed.
		if (this.matchesScopeAndSubsets(op)) {
			return true
		}
		// It failed on the bare op. That may be a genuine out-of-scope op, OR a partial
		// update / delete that simply does not restate the scope / subset field. Backfill
		// the record's current fields and re-check before dropping it, so we never fail
		// to sync an in-scope edit just because it changed an unrelated field.
		const fullRecord = await this.readRecordForBackfill(op)
		if (!fullRecord) {
			return false
		}
		return this.matchesScopeAndSubsets(op, fullRecord)
	}

	private matchesScopeAndSubsets(
		op: Operation,
		fullRecord?: Record<string, unknown> | null,
	): boolean {
		if (!operationMatchesScope(op, this.activeScope, fullRecord)) {
			return false
		}
		return operationMatchesQuerySubsets(op, this.getActiveQuerySubsets(), fullRecord)
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

	private async filterAllowedForSync(ops: Operation[]): Promise<Operation[]> {
		const allowed: Operation[] = []
		for (const op of ops) {
			if (await this.operationAllowedForSync(op)) {
				allowed.push(op)
			}
		}
		return allowed
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
		await this.stop()
		await this.start()
	}
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
