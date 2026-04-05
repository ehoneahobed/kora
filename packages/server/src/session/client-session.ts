import type { KoraEventEmitter, Operation } from '@korajs/core'
import { SyncError, generateUUIDv7 } from '@korajs/core'
import { topologicalSort } from '@korajs/core/internal'
import type {
	HandshakeMessage,
	MessageSerializer,
	OperationBatchMessage,
	SyncMessage,
	WireFormat,
} from '@korajs/sync'
import {
	NegotiatedMessageSerializer,
	versionVectorToWire,
	wireToVersionVector,
} from '@korajs/sync'
import type { ServerStore } from '../store/server-store'
import { operationMatchesScopes } from '../scopes/server-scope-filter'
import type { ServerTransport } from '../transport/server-transport'
import type { AuthContext, AuthProvider } from '../types'

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
	/** Called when this session has operations to relay to other sessions */
	onRelay?: RelayCallback
	/** Called when this session closes */
	onClose?: (sessionId: string) => void
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

	private readonly sessionId: string
	private readonly transport: ServerTransport
	private readonly store: ServerStore
	private readonly auth: AuthProvider | null
	private readonly serializer: MessageSerializer
	private readonly emitter: KoraEventEmitter | null
	private readonly batchSize: number
	private readonly schemaVersion: number
	private readonly onRelay: RelayCallback | null
	private readonly onClose: ((sessionId: string) => void) | null

	constructor(options: ClientSessionOptions) {
		this.sessionId = options.sessionId
		this.transport = options.transport
		this.store = options.store
		this.auth = options.auth ?? null
		this.serializer = options.serializer ?? new NegotiatedMessageSerializer('json')
		this.emitter = options.emitter ?? null
		this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
		this.schemaVersion = options.schemaVersion ?? DEFAULT_SCHEMA_VERSION
		this.onRelay = options.onRelay ?? null
		this.onClose = options.onClose ?? null
	}

	/**
	 * Start handling messages from the client transport.
	 */
	start(): void {
		this.transport.onMessage((msg) => this.handleMessage(msg))
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

		const visibleOperations = operations.filter((op) =>
			operationMatchesScopes(op, this.authContext?.scopes),
		)
		if (visibleOperations.length === 0) return

		const serializedOps = visibleOperations.map((op) => this.serializer.encodeOperation(op))
		const msg: SyncMessage = {
			type: 'operation-batch',
			messageId: generateUUIDv7(),
			operations: serializedOps,
			isFinal: true,
			batchIndex: 0,
		}
		this.transport.send(msg)
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

	// --- Private protocol handlers ---

	private handleMessage(message: SyncMessage): void {
		switch (message.type) {
			case 'handshake':
				this.handleHandshake(message)
				break
			case 'operation-batch':
				this.handleOperationBatch(message)
				break
			// Acknowledgments from clients are noted but no action needed on server
			case 'acknowledgment':
				break
			case 'error':
				break
		}
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

		// Send handshake response with server's version vector
		const serverVector = this.store.getVersionVector()
		const selectedWireFormat = selectWireFormat(msg.supportedWireFormats)
		this.setSerializerWireFormat(selectedWireFormat)
		const response: SyncMessage = {
			type: 'handshake-response',
			messageId: generateUUIDv7(),
			nodeId: this.store.getNodeId(),
			versionVector: versionVectorToWire(serverVector),
			schemaVersion: this.schemaVersion,
			accepted: true,
			selectedWireFormat,
		}
		this.transport.send(response)

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

		for (const op of operations) {
			if (!operationMatchesScopes(op, this.authContext?.scopes)) {
				continue
			}

			const result = await this.store.applyRemoteOperation(op)
			if (result === 'applied') {
				applied.push(op)
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
		this.transport.send(ack)

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
				const visible = ops.filter((op) => operationMatchesScopes(op, this.authContext?.scopes))
				missing.push(...visible)
			}
		}

		if (missing.length === 0) {
			// Send empty final batch to signal delta is complete
			const emptyBatch: SyncMessage = {
				type: 'operation-batch',
				messageId: generateUUIDv7(),
				operations: [],
				isFinal: true,
				batchIndex: 0,
			}
			this.transport.send(emptyBatch)
			return
		}

		// Sort causally and paginate
		const sorted = topologicalSort(missing)
		const totalBatches = Math.ceil(sorted.length / this.batchSize)

		for (let i = 0; i < totalBatches; i++) {
			const start = i * this.batchSize
			const batchOps = sorted.slice(start, start + this.batchSize)
			const serializedOps = batchOps.map((op) => this.serializer.encodeOperation(op))

			const batchMsg: SyncMessage = {
				type: 'operation-batch',
				messageId: generateUUIDv7(),
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
	}

	private sendError(code: string, message: string, retriable: boolean): void {
		const errorMsg: SyncMessage = {
			type: 'error',
			messageId: generateUUIDv7(),
			code,
			message,
			retriable,
		}
		this.transport.send(errorMsg)
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
