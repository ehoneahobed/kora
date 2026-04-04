import type { KoraEventEmitter, Operation, VersionVector } from '@kora/core'
import { SyncError } from '@kora/core'
import { topologicalSort } from '@kora/core/internal'
import type {
	AcknowledgmentMessage,
	HandshakeResponseMessage,
	OperationBatchMessage,
	SyncMessage,
} from '../protocol/messages'
import {
	JsonMessageSerializer,
	versionVectorToWire,
	wireToVersionVector,
} from '../protocol/serializer'
import type { MessageSerializer } from '../protocol/serializer'
import type { SyncTransport } from '../transport/transport'
import type { SyncConfig, SyncState, SyncStatusInfo } from '../types'
import type { QueueStorage } from '../types'
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
}

let nextMessageId = 0
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

	private remoteVector: VersionVector = new Map()
	private lastSyncedAt: number | null = null
	private currentBatch: OutboundBatch | null = null

	// Track delta exchange state
	private deltaBatchesReceived = 0
	private deltaReceiveComplete = false
	private deltaSendComplete = false

	constructor(options: SyncEngineOptions) {
		this.transport = options.transport
		this.store = options.store
		this.config = options.config
		this.serializer = options.serializer ?? new JsonMessageSerializer()
		this.emitter = options.emitter ?? null
		this.batchSize = options.config.batchSize ?? DEFAULT_BATCH_SIZE

		const queueStorage = options.queueStorage ?? new MemoryQueueStorage()
		this.outboundQueue = new OutboundQueue(queueStorage)
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

		// Set up transport handlers
		this.transport.onMessage((msg) => this.handleMessage(msg))
		this.transport.onClose((reason) => this.handleTransportClose(reason))
		this.transport.onError((err) => this.handleTransportError(err))

		this.transitionTo('connecting')

		try {
			const authToken = this.config.auth ? (await this.config.auth()).token : undefined

			await this.transport.connect(this.config.url, { authToken })
			this.transitionTo('handshaking')

			// Send handshake
			const localVector = this.store.getVersionVector()
			const handshake: SyncMessage = {
				type: 'handshake',
				messageId: generateMessageId(),
				nodeId: this.store.getNodeId(),
				versionVector: versionVectorToWire(localVector),
				schemaVersion: this.config.schemaVersion ?? DEFAULT_SCHEMA_VERSION,
				authToken,
			}
			this.transport.send(handshake)
		} catch (err) {
			this.transitionTo('error')
			this.transitionTo('disconnected')
			throw err
		}
	}

	/**
	 * Stop the sync engine. Disconnects the transport.
	 */
	async stop(): Promise<void> {
		if (this.state === 'disconnected') return

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
	 */
	async pushOperation(op: Operation): Promise<void> {
		await this.outboundQueue.enqueue(op)
		if (this.state === 'streaming') {
			this.flushQueue()
		}
	}

	/**
	 * Get the current developer-facing sync status.
	 */
	getStatus(): SyncStatusInfo {
		const pendingOperations = this.outboundQueue.totalPending
		switch (this.state) {
			case 'disconnected':
				return { status: 'offline', pendingOperations, lastSyncedAt: this.lastSyncedAt }
			case 'connecting':
			case 'handshaking':
			case 'syncing':
				return { status: 'syncing', pendingOperations, lastSyncedAt: this.lastSyncedAt }
			case 'streaming':
				return {
					status: pendingOperations > 0 ? 'syncing' : 'synced',
					pendingOperations,
					lastSyncedAt: this.lastSyncedAt,
				}
			case 'error':
				return { status: 'error', pendingOperations, lastSyncedAt: this.lastSyncedAt }
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

	// --- Private methods ---

	private handleMessage(message: SyncMessage): void {
		switch (message.type) {
			case 'handshake-response':
				this.handleHandshakeResponse(message)
				break
			case 'operation-batch':
				this.handleOperationBatch(message)
				break
			case 'acknowledgment':
				this.handleAcknowledgment(message)
				break
			case 'error':
				this.handleError(message)
				break
		}
	}

	private handleHandshakeResponse(msg: HandshakeResponseMessage): void {
		if (this.state !== 'handshaking') return

		if (!msg.accepted) {
			this.transitionTo('error')
			this.emitter?.emit({
				type: 'sync:disconnected',
				reason: msg.rejectReason ?? 'Handshake rejected',
			})
			this.transitionTo('disconnected')
			return
		}

		this.remoteVector = wireToVersionVector(msg.versionVector)
		this.emitter?.emit({ type: 'sync:connected', nodeId: this.store.getNodeId() })

		this.transitionTo('syncing')
		this.deltaBatchesReceived = 0
		this.deltaReceiveComplete = false
		this.deltaSendComplete = false

		// Send our delta to the server
		this.sendDelta()
	}

	private async sendDelta(): Promise<void> {
		const localVector = this.store.getVersionVector()
		const missingOps = await this.collectDelta(localVector, this.remoteVector)

		if (missingOps.length === 0) {
			// No ops to send — send empty final batch
			const emptyBatch: SyncMessage = {
				type: 'operation-batch',
				messageId: generateMessageId(),
				operations: [],
				isFinal: true,
				batchIndex: 0,
			}
			this.transport.send(emptyBatch)
			this.deltaSendComplete = true
			this.checkDeltaComplete()
			return
		}

		// Paginate into batches
		const sorted = topologicalSort(missingOps)
		const totalBatches = Math.ceil(sorted.length / this.batchSize)

		for (let i = 0; i < totalBatches; i++) {
			const start = i * this.batchSize
			const batchOps = sorted.slice(start, start + this.batchSize)
			const serializedOps = batchOps.map((op) => this.serializer.encodeOperation(op))

			const batchMsg: SyncMessage = {
				type: 'operation-batch',
				messageId: generateMessageId(),
				operations: serializedOps,
				isFinal: i === totalBatches - 1,
				batchIndex: i,
			}
			this.transport.send(batchMsg)

			this.emitter?.emit({
				type: 'sync:sent',
				operations: batchOps,
				batchSize: batchOps.length,
			})
		}

		this.deltaSendComplete = true
		this.checkDeltaComplete()
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
		const operations = msg.operations.map((s) => this.serializer.decodeOperation(s))

		// Apply each operation to the local store
		for (const op of operations) {
			await this.store.applyRemoteOperation(op)
		}

		if (operations.length > 0) {
			this.emitter?.emit({
				type: 'sync:received',
				operations,
				batchSize: operations.length,
			})
		}

		// Send acknowledgment
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
			if (msg.isFinal) {
				this.deltaReceiveComplete = true
				this.checkDeltaComplete()
			}
		}
	}

	private handleAcknowledgment(msg: AcknowledgmentMessage): void {
		if (this.currentBatch) {
			this.outboundQueue.acknowledge(this.currentBatch.batchId)
			this.currentBatch = null
			this.lastSyncedAt = Date.now()
		}

		// Continue flushing if more ops in queue
		if (this.state === 'streaming' && this.outboundQueue.hasOperations) {
			this.flushQueue()
		}
	}

	private handleError(msg: { code: string; message: string; retriable: boolean }): void {
		this.transitionTo('error')
		this.emitter?.emit({ type: 'sync:disconnected', reason: msg.message })
		this.transitionTo('disconnected')
	}

	private checkDeltaComplete(): void {
		if (this.deltaSendComplete && this.deltaReceiveComplete) {
			this.lastSyncedAt = Date.now()
			this.transitionTo('streaming')

			// Flush any queued operations accumulated during delta exchange
			if (this.outboundQueue.hasOperations) {
				this.flushQueue()
			}
		}
	}

	private flushQueue(): void {
		if (this.currentBatch) return // Already have an in-flight batch
		if (!this.outboundQueue.hasOperations) return

		const batch = this.outboundQueue.takeBatch(this.batchSize)
		if (!batch) return

		this.currentBatch = batch

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

	private handleTransportClose(reason: string): void {
		// Return in-flight batch to queue
		if (this.currentBatch) {
			this.outboundQueue.returnBatch(this.currentBatch.batchId)
			this.currentBatch = null
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
}
