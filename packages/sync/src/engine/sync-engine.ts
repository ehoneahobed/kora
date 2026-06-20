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
	HandshakeResponseMessage,
	OperationBatchMessage,
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
import type {
	QueueStorage,
	SyncConfig,
	SyncScopeMap,
	SyncState,
	SyncStatePersistence,
	SyncStatusInfo,
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
	private readonly batchSize: number
	private readonly encryptor: SyncEncryptor | null
	private readonly awarenessManager: AwarenessManager
	private readonly richtextDocChannel: RichtextDocChannel
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
		if (!this.operationAllowedForSync(op)) {
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
		}
		switch (this.state) {
			case 'disconnected':
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
		this.activeScope = scopeMap
		// Also update the config so that the next handshake sends the new scope
		this.config.scopeMap = scopeMap
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
		this.querySubsets.set(id, subset)
		this.scheduleQuerySubsetReconnect()
		return () => {
			this.querySubsets.delete(id)
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
				this.handleHandshakeResponse(message)
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
			case 'awareness-update':
				this.handleAwarenessUpdate(message)
				break
			case 'yjs-doc-update':
				this.richtextDocChannel.deliver(message)
				break
		}
	}

	private handleMessageFailure(error: unknown): void {
		const reason = error instanceof Error ? error.message : 'Message handling failed'
		this.handleTransportClose(reason)
	}

	private handleHandshakeResponse(msg: HandshakeResponseMessage): void {
		if (this.state !== 'handshaking') return

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

		// Send our delta to the server
		this.sendDelta()
	}

	private async sendDelta(): Promise<void> {
		const localVector = this.store.getVersionVector()
		const allMissingOps = await this.collectDelta(localVector, this.remoteVector)

		const missingOps = allMissingOps.filter((op) => this.operationAllowedForSync(op))

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
		const deserialized = msg.operations.map((s) => this.serializer.decodeOperation(s))

		// Decrypt data fields after deserialization if E2E encryption is enabled
		const operations = this.encryptor
			? await this.encryptor.decryptBatch(deserialized)
			: deserialized

		const inScopeOps = operations.filter((op) => this.operationAllowedForSync(op))

		const targetSchemaVersion = this.config.schemaVersion ?? DEFAULT_SCHEMA_VERSION
		const transforms = this.config.operationTransforms ?? []

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
				this.emitApplyFailure(transformed, 'rejected', {
					code,
					message,
					retriable: code !== APPLY_FAILURE_CODES.REFERENTIAL_INTEGRITY,
				})
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

		// Send acknowledgment for the original batch (server tracks by batch, not per-op)
		const lastOp = operations[operations.length - 1]
		const ack: SyncMessage = {
			type: 'acknowledgment',
			messageId: generateMessageId(),
			acknowledgedMessageId: msg.messageId,
			lastSequenceNumber: lastOp ? lastOp.sequenceNumber : 0,
		}
		this.transport.send(ack)

		this.emitter?.emit({
			type: 'sync:acknowledged',
			sequenceNumber: lastOp ? lastOp.sequenceNumber : 0,
		})

		if (this.state === 'syncing') {
			this.deltaBatchesReceived++
			const totalBatches = msg.totalBatches ?? this.initialSyncTotalBatches
			if (msg.totalBatches !== undefined) {
				this.initialSyncTotalBatches = msg.totalBatches
			}
			this.metricsCollector.updateInitialSyncProgress(this.deltaBatchesReceived, totalBatches)

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

			if (msg.isFinal) {
				this.deltaReceiveComplete = true
				this.resumeDeltaCursor = null
				await this.persistDeltaCursor(null)
				this.metricsCollector.recordSyncCompleted()
				void this.checkDeltaComplete()
			}
		}
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
		this.transitionTo('error')
		if (msg.code === 'AUTH_FAILED') {
			this.emitter?.emit({ type: 'sync:auth-failed', reason: msg.message })
		}
		this.emitter?.emit({ type: 'sync:disconnected', reason: msg.message })
		this.transitionTo('disconnected')
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
		const inScope = ops.filter((op) => this.operationAllowedForSync(op))
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

	private operationAllowedForSync(op: Operation): boolean {
		if (!operationMatchesScope(op, this.activeScope)) {
			return false
		}
		return operationMatchesQuerySubsets(op, this.getActiveQuerySubsets())
	}

	private async persistDeltaCursor(cursor: DeltaCursor | null): Promise<void> {
		if (!this.syncState?.saveDeltaCursor) {
			return
		}
		await this.syncState.saveDeltaCursor(cursor)
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
