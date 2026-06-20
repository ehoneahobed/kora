import type { KoraEventEmitter, Operation } from '@korajs/core'
import { SyncError, generateUUIDv7 } from '@korajs/core'
import { topologicalSort } from '@korajs/core/internal'
import type {
	AwarenessUpdateMessage,
	HandshakeMessage,
	MessageSerializer,
	OperationBatchMessage,
	SyncMessage,
	WireFormat,
	YjsDocUpdateMessage,
} from '@korajs/sync'
import {
	type DeltaCursor,
	NegotiatedMessageSerializer,
	SCHEMA_MISMATCH_PREFIX,
	type SyncQuerySubset,
	createDeltaCursorFromBatch,
	decodeDeltaCursor,
	dedupeQuerySubsets,
	encodeDeltaCursor,
	isClientSchemaVersionSupported,
	operationMatchesQuerySubsets,
	sliceOperationsAfterCursor,
	versionVectorToWire,
	wireToVersionVector,
} from '@korajs/sync'
import { applyServerOperation } from '../apply/apply-server-operation'
import { resolveSessionScopes } from '../scopes/resolve-session-scopes'
import { operationMatchesScopes } from '../scopes/server-scope-filter'
import type { ServerStore } from '../store/server-store'
import type { ServerTransport } from '../transport/server-transport'
import type { AuthContext, AuthProvider } from '../types'
import { isOperationTimestampValid } from './operation-validation'
import {
	DEFAULT_MAX_OPERATION_BYTES,
	DEFAULT_MAX_OPS_PER_MINUTE,
	SessionRateLimiter,
	validateOperationSize,
} from './session-operation-limits'

const DEFAULT_BATCH_SIZE = 100
const DEFAULT_SCHEMA_VERSION = 1

/**
 * Possible states for a client session.
 */
export type SessionState = 'connected' | 'authenticated' | 'syncing' | 'streaming' | 'closed'

/**
 * Callback invoked when a session has new operations to relay to other sessions.
 */
export type RelayCallback = (sourceSessionId: string, operations: Operation[]) => void

/**
 * Callback invoked when a session receives an awareness update to relay to other sessions.
 */
export type AwarenessRelayCallback = (
	sourceSessionId: string,
	message: AwarenessUpdateMessage,
) => void

/**
 * Callback invoked when a session receives a Yjs doc channel update to relay.
 */
export type YjsDocRelayCallback = (sourceSessionId: string, message: YjsDocUpdateMessage) => void

/**
 * Options for creating a ClientSession.
 */
export interface ClientSessionOptions {
	/** Unique session identifier */
	sessionId: string
	/** Transport for this client connection */
	transport: ServerTransport
	/** Server-side operation store */
	store: ServerStore
	/** Authentication provider (optional) */
	auth?: AuthProvider
	/** Message serializer */
	serializer?: MessageSerializer
	/** Event emitter for DevTools integration */
	emitter?: KoraEventEmitter
	/** Max operations per sync batch */
	batchSize?: number
	/** Schema version the server expects */
	schemaVersion?: number
	/** Inclusive client schema versions accepted at handshake */
	supportedSchemaVersions?: { min: number; max: number }
	/** Called when this session has operations to relay to other sessions */
	onRelay?: RelayCallback
	/** Called when this session receives an awareness update to broadcast */
	onAwarenessUpdate?: AwarenessRelayCallback
	/** Called when this session receives a Yjs doc channel update to broadcast */
	onYjsDocUpdate?: YjsDocRelayCallback
	/** Called when this session closes */
	onClose?: (sessionId: string) => void
	/** Maximum serialized operation size in bytes. Defaults to 256 KiB. */
	maxOperationBytes?: number
	/** Maximum operations accepted per minute for this session. Defaults to 600. */
	maxOpsPerMinute?: number
}

/**
 * Handles the sync protocol for a single connected client.
 *
 * Lifecycle: connected → (authenticated) → syncing → streaming → closed
 *
 * The session:
 * 1. Receives a handshake from the client
 * 2. Authenticates if an AuthProvider is configured
 * 3. Sends back a HandshakeResponse with the server's version vector
 * 4. Computes and sends the server's delta to the client (paginated)
 * 5. Processes incoming operation batches from the client
 * 6. Transitions to streaming for real-time bidirectional sync
 * 7. Relays new operations to other sessions via the RelayCallback
 */
export class ClientSession {
	private state: SessionState = 'connected'
	private clientNodeId: string | null = null
	private authContext: AuthContext | null = null
	private syncQuerySubsets: SyncQuerySubset[] = []
	private resumeDeltaCursor: DeltaCursor | null = null

	private readonly sessionId: string
	private readonly transport: ServerTransport
	private readonly store: ServerStore
	private readonly auth: AuthProvider | null
	private readonly serializer: MessageSerializer
	private readonly emitter: KoraEventEmitter | null
	private readonly batchSize: number
	private readonly schemaVersion: number
	private readonly supportedSchemaVersions: { min: number; max: number }
	private readonly onRelay: RelayCallback | null
	private readonly onAwarenessUpdate: AwarenessRelayCallback | null
	private readonly onYjsDocUpdate: YjsDocRelayCallback | null
	private readonly onClose: ((sessionId: string) => void) | null
	private readonly maxOperationBytes: number
	private readonly maxOpsPerMinute: number
	private readonly rateLimiter: SessionRateLimiter

	constructor(options: ClientSessionOptions) {
		this.sessionId = options.sessionId
		this.transport = options.transport
		this.store = options.store
		this.auth = options.auth ?? null
		this.serializer = options.serializer ?? new NegotiatedMessageSerializer('json')
		this.emitter = options.emitter ?? null
		this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
		this.schemaVersion = options.schemaVersion ?? DEFAULT_SCHEMA_VERSION
		const supported = options.supportedSchemaVersions
		this.supportedSchemaVersions = supported ?? {
			min: this.schemaVersion,
			max: this.schemaVersion,
		}
		this.onRelay = options.onRelay ?? null
		this.onAwarenessUpdate = options.onAwarenessUpdate ?? null
		this.onYjsDocUpdate = options.onYjsDocUpdate ?? null
		this.onClose = options.onClose ?? null
		this.maxOperationBytes = options.maxOperationBytes ?? DEFAULT_MAX_OPERATION_BYTES
		this.maxOpsPerMinute = options.maxOpsPerMinute ?? DEFAULT_MAX_OPS_PER_MINUTE
		this.rateLimiter = new SessionRateLimiter(this.maxOpsPerMinute)
	}

	/**
	 * Start handling messages from the client transport.
	 */
	start(): void {
		this.transport.onMessage((msg) => this.enqueueMessage(msg))
		this.transport.onClose((_code, _reason) => this.handleTransportClose())
		this.transport.onError((_err) => {
			// Transport errors during active session cause close
			if (this.state !== 'closed') {
				this.handleTransportClose()
			}
		})
	}

	/**
	 * Relay operations from another session to this client.
	 * Only relays if the session is in streaming state and transport is connected.
	 */
	relayOperations(operations: Operation[]): void {
		if (this.state !== 'streaming' || !this.transport.isConnected()) return
		if (operations.length === 0) return

		const visibleOperations = operations.filter((op) => this.operationVisibleToClient(op))
		if (visibleOperations.length === 0) return

		const serializedOps = visibleOperations.map((op) => this.serializer.encodeOperation(op))
		const msg: SyncMessage = {
			type: 'operation-batch',
			messageId: generateUUIDv7(),
			operations: serializedOps,
			isFinal: true,
			batchIndex: 0,
		}
		this.sendToClient(msg)
	}

	/**
	 * Close this session.
	 */
	close(reason?: string): void {
		if (this.state === 'closed') return
		this.state = 'closed'

		if (this.transport.isConnected()) {
			this.transport.close(1000, reason ?? 'session closed')
		}

		this.onClose?.(this.sessionId)
	}

	// --- Getters ---

	getState(): SessionState {
		return this.state
	}

	getSessionId(): string {
		return this.sessionId
	}

	getClientNodeId(): string | null {
		return this.clientNodeId
	}

	getAuthContext(): AuthContext | null {
		return this.authContext
	}

	isStreaming(): boolean {
		return this.state === 'streaming'
	}

	/**
	 * Get the transport for this session.
	 * Used by the awareness relay to send messages to this client.
	 */
	getTransport(): ServerTransport {
		return this.transport
	}

	// --- Private protocol handlers ---

	private messageChain: Promise<void> = Promise.resolve()

	/** Send to the client when the transport is still connected; no-op otherwise. */
	private sendToClient(message: SyncMessage): boolean {
		if (!this.transport.isConnected()) {
			return false
		}
		try {
			this.transport.send(message)
			return true
		} catch {
			return false
		}
	}

	private enqueueMessage(message: SyncMessage): void {
		this.messageChain = this.messageChain
			.then(() => this.handleMessageAsync(message))
			.catch((error) => this.handleMessageFailure(error))
	}

	private async handleMessageAsync(message: SyncMessage): Promise<void> {
		switch (message.type) {
			case 'handshake':
				await this.handleHandshake(message)
				break
			case 'operation-batch':
				await this.handleOperationBatch(message)
				break
			case 'acknowledgment':
				break
			case 'error':
				break
			case 'awareness-update':
				this.handleAwarenessUpdate(message)
				break
			case 'yjs-doc-update':
				this.handleYjsDocUpdate(message)
				break
		}
	}

	private handleMessageFailure(error: unknown): void {
		const reason = error instanceof Error ? error.message : 'Message handling failed'
		this.sendError('SYNC_ERROR', reason, true)
		this.close(reason)
	}

	private async handleHandshake(msg: HandshakeMessage): Promise<void> {
		// Only accept handshake in 'connected' state (prevent duplicate handshakes)
		if (this.state !== 'connected') {
			this.sendError('DUPLICATE_HANDSHAKE', 'Handshake already completed', false)
			return
		}

		this.clientNodeId = msg.nodeId

		// Authenticate if provider is configured
		if (this.auth) {
			const token = msg.authToken ?? ''
			const context = await this.auth.authenticate(token)
			if (!context) {
				this.sendError('AUTH_FAILED', 'Authentication failed', false)
				this.close('authentication failed')
				return
			}
			this.authContext = context
			this.state = 'authenticated'
		}

		// Merge handshake sync scopes with auth scopes using schema sync rules.
		const resolvedScopes = resolveSessionScopes(this.store.getSchema(), {
			handshakeScope: msg.syncScope,
			authScopes: this.authContext?.scopes,
		})

		if (resolvedScopes) {
			if (this.authContext) {
				this.authContext = { ...this.authContext, scopes: resolvedScopes }
			} else {
				this.authContext = { userId: msg.nodeId, scopes: resolvedScopes }
			}
		}

		if (msg.syncQueries && msg.syncQueries.length > 0) {
			this.syncQuerySubsets = dedupeQuerySubsets(msg.syncQueries)
		} else {
			this.syncQuerySubsets = []
		}

		this.resumeDeltaCursor = msg.deltaCursor ? decodeDeltaCursor(msg.deltaCursor) : null

		const serverVector = this.store.getVersionVector()
		const selectedWireFormat = selectWireFormat(msg.supportedWireFormats)
		this.setSerializerWireFormat(selectedWireFormat)

		if (!isClientSchemaVersionSupported(msg.schemaVersion, this.supportedSchemaVersions)) {
			const { min, max } = this.supportedSchemaVersions
			const response: SyncMessage = {
				type: 'handshake-response',
				messageId: generateUUIDv7(),
				nodeId: this.store.getNodeId(),
				versionVector: versionVectorToWire(serverVector),
				schemaVersion: this.schemaVersion,
				accepted: false,
				rejectReason: `${SCHEMA_MISMATCH_PREFIX}: client schema version ${msg.schemaVersion} not in supported range [${min}, ${max}]`,
				supportedSchemaMin: min,
				supportedSchemaMax: max,
			}
			this.sendToClient(response)
			this.close('schema version mismatch')
			return
		}

		// Send handshake response with server's version vector and accepted scope
		const response: SyncMessage = {
			type: 'handshake-response',
			messageId: generateUUIDv7(),
			nodeId: this.store.getNodeId(),
			versionVector: versionVectorToWire(serverVector),
			schemaVersion: this.schemaVersion,
			accepted: true,
			selectedWireFormat,
			// Confirm the accepted scope so the client knows what data will be synced.
			// This may differ from what the client requested if auth scopes are narrower.
			...(this.authContext?.scopes ? { acceptedScope: this.authContext.scopes } : {}),
		}
		this.sendToClient(response)

		this.emitter?.emit({ type: 'sync:connected', nodeId: msg.nodeId })

		// Transition to syncing and send delta
		this.state = 'syncing'
		const clientVector = wireToVersionVector(msg.versionVector)
		await this.sendDelta(clientVector)

		// Transition to streaming after delta is sent
		this.state = 'streaming'
	}

	private async handleOperationBatch(msg: OperationBatchMessage): Promise<void> {
		const operations = msg.operations.map((s) => this.serializer.decodeOperation(s))
		const applied: Operation[] = []
		const rejected: Operation[] = []

		for (const op of operations) {
			if (!this.operationVisibleToClient(op)) {
				rejected.push(op)
				continue
			}

			if (!isOperationTimestampValid(op)) {
				this.sendError(
					'INVALID_TIMESTAMP',
					`Operation "${op.id}" timestamp is too far in the future`,
					false,
				)
				continue
			}

			if (!this.rateLimiter.allow(1)) {
				this.sendError(
					'RATE_LIMIT',
					`Session exceeded operation rate limit (${String(this.maxOpsPerMinute)} ops/min)`,
					true,
				)
				continue
			}

			const sizeCheck = validateOperationSize(op, this.maxOperationBytes)
			if (!sizeCheck.valid) {
				this.sendError(
					'OPERATION_TOO_LARGE',
					sizeCheck.message ?? `Operation "${op.id}" is too large`,
					false,
				)
				continue
			}

			try {
				const applyResult = await applyServerOperation(this.store, op)
				if (applyResult.rejection) {
					this.sendError(applyResult.rejection.code, applyResult.rejection.message, false)
					continue
				}
				if (applyResult.result === 'applied') {
					applied.push(...applyResult.appliedOperations)
				}
			} catch {
				// Per-op failure must not block batch acknowledgment
			}
		}

		// Send scope violation errors for rejected operations so the client
		// knows its writes were rejected rather than silently dropped.
		if (rejected.length > 0) {
			for (const op of rejected) {
				this.sendError(
					'SCOPE_VIOLATION',
					`Operation "${op.id}" in collection "${op.collection}" is outside the client's sync scope`,
					false,
				)
			}
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
			messageId: generateUUIDv7(),
			acknowledgedMessageId: msg.messageId,
			lastSequenceNumber: lastOp ? lastOp.sequenceNumber : 0,
		}
		this.sendToClient(ack)

		// Relay only newly applied operations to other sessions
		if (applied.length > 0) {
			this.onRelay?.(this.sessionId, applied)
		}
	}

	private async sendDelta(clientVector: Map<string, number>): Promise<void> {
		const serverVector = this.store.getVersionVector()
		const missing: Operation[] = []

		for (const [nodeId, serverSeq] of serverVector) {
			const clientSeq = clientVector.get(nodeId) ?? 0
			if (serverSeq > clientSeq) {
				const ops = await this.store.getOperationRange(nodeId, clientSeq + 1, serverSeq)
				const visible = ops.filter((op) => this.operationVisibleToClient(op))
				missing.push(...visible)
			}
		}

		if (missing.length === 0) {
			const emptyBatch: SyncMessage = {
				type: 'operation-batch',
				messageId: generateUUIDv7(),
				operations: [],
				isFinal: true,
				batchIndex: 0,
				totalBatches: 1,
			}
			this.sendToClient(emptyBatch)
			return
		}

		const sorted = topologicalSort(missing)
		const afterCursor = sliceOperationsAfterCursor(sorted, this.resumeDeltaCursor)
		const totalBatches = Math.ceil(afterCursor.length / this.batchSize)

		if (afterCursor.length === 0) {
			const emptyBatch: SyncMessage = {
				type: 'operation-batch',
				messageId: generateUUIDv7(),
				operations: [],
				isFinal: true,
				batchIndex: this.resumeDeltaCursor?.batchIndex ?? 0,
				totalBatches: 1,
			}
			this.sendToClient(emptyBatch)
			return
		}

		for (let i = 0; i < totalBatches; i++) {
			const start = i * this.batchSize
			const batchOps = afterCursor.slice(start, start + this.batchSize)
			const serializedOps = batchOps.map((op) => this.serializer.encodeOperation(op))
			const batchCursor = createDeltaCursorFromBatch(batchOps, i)

			const batchMsg: SyncMessage = {
				type: 'operation-batch',
				messageId: generateUUIDv7(),
				operations: serializedOps,
				isFinal: i === totalBatches - 1,
				batchIndex: i,
				totalBatches,
				...(batchCursor ? { cursor: encodeDeltaCursor(batchCursor) } : {}),
			}
			this.sendToClient(batchMsg)

			this.emitter?.emit({
				type: 'sync:sent',
				operations: batchOps,
				batchSize: batchOps.length,
			})
		}
	}

	private operationVisibleToClient(op: Operation): boolean {
		if (!operationMatchesScopes(op, this.authContext?.scopes)) {
			return false
		}
		return operationMatchesQuerySubsets(op, this.syncQuerySubsets)
	}

	private handleAwarenessUpdate(msg: AwarenessUpdateMessage): void {
		// Relay awareness updates to the server for broadcasting to other clients.
		// Awareness is purely ephemeral -- no persistence.
		this.onAwarenessUpdate?.(this.sessionId, msg)
	}

	private handleYjsDocUpdate(msg: YjsDocUpdateMessage): void {
		this.onYjsDocUpdate?.(this.sessionId, msg)
	}

	private sendError(code: string, message: string, retriable: boolean): void {
		const errorMsg: SyncMessage = {
			type: 'error',
			messageId: generateUUIDv7(),
			code,
			message,
			retriable,
		}
		this.sendToClient(errorMsg)
	}

	private setSerializerWireFormat(format: WireFormat): void {
		if (typeof this.serializer.setWireFormat === 'function') {
			this.serializer.setWireFormat(format)
		}
	}

	private handleTransportClose(): void {
		if (this.state === 'closed') return
		this.state = 'closed'
		this.emitter?.emit({ type: 'sync:disconnected', reason: 'transport closed' })
		this.onClose?.(this.sessionId)
	}
}

function selectWireFormat(supportedWireFormats?: WireFormat[]): WireFormat {
	if (supportedWireFormats?.includes('protobuf')) {
		return 'protobuf'
	}

	return 'json'
}
