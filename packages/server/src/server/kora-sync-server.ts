import type { KoraEventEmitter, Operation } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { SyncError, generateUUIDv7 } from '@korajs/core'
import type { AwarenessUpdateMessage, MessageSerializer } from '@korajs/sync'
import { JsonMessageSerializer } from '@korajs/sync'
import { AwarenessRelay } from '../awareness/awareness-relay'
import { ServerMetricsCollector, estimateByteSize } from '../diagnostics/server-metrics-collector'
import type { Logger } from '../logging/structured-logger'
import { createDefaultLogger } from '../logging/structured-logger'
import { ClientSession } from '../session/client-session'
import type { ServerStore } from '../store/server-store'
import { HttpServerTransport } from '../transport/http-server-transport'
import type { ServerTransport } from '../transport/server-transport'
import { WsServerTransport } from '../transport/ws-server-transport'
import type {
	AuthProvider,
	HttpSyncRequest,
	HttpSyncResponse,
	KoraSyncServerConfig,
	ServerStatus,
} from '../types'

const DEFAULT_MAX_CONNECTIONS = 0 // unlimited
const DEFAULT_BATCH_SIZE = 100
const DEFAULT_SCHEMA_VERSION = 1
const DEFAULT_HOST = '0.0.0.0'
const DEFAULT_PATH = '/'

/**
 * Minimal interface for a ws.WebSocketServer instance.
 * Allows dependency injection for testing without importing ws directly.
 */
export interface WsServerLike {
	on(event: string, listener: (...args: unknown[]) => void): void
	close(callback?: (err?: Error) => void): void
	address(): { port: number } | string | null
}

/**
 * Constructor type for creating a WebSocket server.
 */
export type WsServerConstructor = new (options: {
	port?: number
	host?: string
	path?: string
}) => WsServerLike

/**
 * Self-hosted sync server. Accepts WebSocket connections from clients,
 * handles the sync protocol, stores operations, and relays changes
 * between connected clients.
 *
 * Two modes of operation:
 * 1. **Standalone**: Call `start()` with a port — creates its own WebSocket server.
 * 2. **Attach**: Call `handleConnection(transport)` — attach to an existing HTTP server.
 */
export class KoraSyncServer {
	private readonly store: ServerStore
	private readonly auth: AuthProvider | null
	private readonly serializer: MessageSerializer
	private readonly emitter: KoraEventEmitter | null
	private readonly maxConnections: number
	private readonly batchSize: number
	private readonly schemaVersion: number
	private readonly port: number | undefined
	private readonly host: string
	private readonly path: string
	private readonly logger: Logger
	private readonly metrics: ServerMetricsCollector

	private readonly awarenessRelay = new AwarenessRelay()
	private readonly sessions = new Map<string, ClientSession>()
	private readonly httpClients = new Map<
		string,
		{ sessionId: string; transport: HttpServerTransport }
	>()
	private readonly httpSessionToClient = new Map<string, string>()
	private readonly serverVersion = '0.4.0'
	private wsServer: WsServerLike | null = null
	private running = false

	constructor(config: KoraSyncServerConfig) {
		this.store = config.store
		this.auth = config.auth ?? null
		this.serializer = config.serializer ?? new JsonMessageSerializer()
		this.emitter = config.emitter ?? null
		this.maxConnections = config.maxConnections ?? DEFAULT_MAX_CONNECTIONS
		this.batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE
		this.schemaVersion = config.schemaVersion ?? DEFAULT_SCHEMA_VERSION
		this.port = config.port
		this.host = config.host ?? DEFAULT_HOST
		this.path = config.path ?? DEFAULT_PATH
		this.logger = config.logger ?? createDefaultLogger()
		this.metrics = config.metricsCollector ?? new ServerMetricsCollector()
		this.metrics.setSchemaVersion(this.schemaVersion)

		// If no external emitter was provided, create an internal one for
		// subscribing to session events for metrics and logging.
		if (!this.emitter) {
			this.emitter = new SimpleEventEmitter()
		}
	}

	/**
	 * Subscribe to session-level events for metrics collection and logging.
	 * Called when a new session is created.
	 */
	private attachSessionEvents(sessionId: string, sessionEmitter: KoraEventEmitter): void {
		sessionEmitter.on('sync:connected', (event) => {
			this.metrics.recordHandshake(sessionId, event.nodeId)
			this.logger.log({
				timestamp: Date.now(),
				level: 'info',
				event: 'session.handshake',
				sessionId,
				nodeId: event.nodeId,
			})
		})

		sessionEmitter.on('sync:received', (event) => {
			const byteSize = estimateByteSize(event.operations)
			this.metrics.recordReceived(sessionId, event.batchSize, byteSize)
			this.logger.log({
				timestamp: Date.now(),
				level: 'info',
				event: 'operations.received',
				sessionId,
				count: event.batchSize,
				bytes: byteSize,
			})
		})

		sessionEmitter.on('sync:sent', (event) => {
			const byteSize = estimateByteSize(event.operations)
			this.metrics.recordSent(sessionId, event.batchSize, byteSize)
			this.logger.log({
				timestamp: Date.now(),
				level: 'info',
				event: 'operations.sent',
				sessionId,
				count: event.batchSize,
				bytes: byteSize,
			})
		})

		sessionEmitter.on('sync:disconnected', (event) => {
			this.logger.log({
				timestamp: Date.now(),
				level: 'info',
				event: 'session.disconnected',
				sessionId,
				details: { reason: event.reason },
			})
		})
	}

	/**
	 * Get the metrics collector for external access (e.g., HTTP endpoints).
	 */
	getMetricsCollector(): ServerMetricsCollector {
		return this.metrics
	}

	/**
	 * Get the logger for external access (e.g., event streaming).
	 */
	getLogger(): Logger {
		return this.logger
	}

	/**
	 * Start the WebSocket server in standalone mode.
	 *
	 * @param wsServerImpl - Optional WebSocket server constructor for testing
	 */
	async start(wsServerImpl?: WsServerConstructor): Promise<void> {
		if (this.running) {
			throw new SyncError('Server is already running', { port: this.port })
		}

		if (!wsServerImpl && this.port === undefined) {
			throw new SyncError(
				'Port is required for standalone mode. Provide port in config or use handleConnection() for attach mode.',
				{},
			)
		}

		if (wsServerImpl) {
			this.wsServer = new wsServerImpl({
				port: this.port,
				host: this.host,
				path: this.path,
			})
		} else {
			// Dynamic import of ws — only needed in standalone mode
			const { WebSocketServer } = await import('ws')
			this.wsServer = new WebSocketServer({
				port: this.port,
				host: this.host,
				path: this.path,
			})
		}

		this.wsServer.on('connection', (ws: unknown) => {
			const transport = new WsServerTransport(
				ws as import('../transport/ws-server-transport').WsWebSocket,
				{
					serializer: this.serializer,
				},
			)
			this.handleConnection(transport)
		})

		this.running = true
		this.logger.log({
			timestamp: Date.now(),
			level: 'info',
			event: 'server.started',
			details: { port: this.port, host: this.host, path: this.path },
		})
	}

	/**
	 * Stop the server. Closes all sessions and the WebSocket server.
	 */
	async stop(): Promise<void> {
		this.logger.log({
			timestamp: Date.now(),
			level: 'info',
			event: 'server.stopping',
			details: { connectedClients: this.sessions.size },
		})

		// Clean up awareness relay
		this.awarenessRelay.clear()

		// Close all active sessions (works in both standalone and attach mode)
		for (const session of this.sessions.values()) {
			session.close('server shutting down')
		}
		this.sessions.clear()
		this.httpClients.clear()
		this.httpSessionToClient.clear()

		// Close WebSocket server (standalone mode only)
		if (this.wsServer) {
			await new Promise<void>((resolve) => {
				this.wsServer?.close(() => resolve())
			})
			this.wsServer = null
		}

		this.running = false
		this.logger.log({
			timestamp: Date.now(),
			level: 'info',
			event: 'server.stopped',
		})
	}

	/**
	 * Handle one HTTP sync request for a long-polling client.
	 *
	 * A stable `clientId` identifies the logical connection across requests.
	 */
	async handleHttpRequest(request: HttpSyncRequest): Promise<HttpSyncResponse> {
		if (!request.clientId || request.clientId.trim().length === 0) {
			return { status: 400 }
		}

		const client = this.getOrCreateHttpClient(request.clientId)

		if (request.method === 'POST') {
			if (request.body === undefined) {
				return { status: 400 }
			}

			const payload = normalizeHttpBody(request.body, request.contentType)
			client.transport.receive(payload)
			return { status: 202 }
		}

		if (request.method === 'GET') {
			const polled = client.transport.poll(request.ifNoneMatch)
			return {
				status: polled.status,
				body: polled.body,
				headers: polled.headers,
			}
		}

		return {
			status: 405,
			headers: { allow: 'GET, POST' },
		}
	}

	/**
	 * Handle an incoming client connection (attach mode).
	 * Creates a new ClientSession for the transport.
	 *
	 * @param transport - The server transport for the new connection
	 * @returns The session ID
	 */
	handleConnection(transport: ServerTransport): string {
		// Check max connections
		if (this.maxConnections > 0 && this.sessions.size >= this.maxConnections) {
			transport.send({
				type: 'error',
				messageId: generateUUIDv7(),
				code: 'MAX_CONNECTIONS',
				message: `Server has reached maximum connections (${this.maxConnections})`,
				retriable: true,
			})
			transport.close(4029, 'max connections reached')
			this.metrics.recordError()
			this.logger.log({
				timestamp: Date.now(),
				level: 'warn',
				event: 'connection.rejected',
				details: { reason: 'max_connections', max: this.maxConnections },
			})
			throw new SyncError('Maximum connections reached', {
				current: this.sessions.size,
				max: this.maxConnections,
			})
		}

		const sessionId = generateUUIDv7()
		this.metrics.recordConnection(sessionId)

		// Create a per-session emitter so we can track events with session context.
		// The session emits events on this emitter, and we listen here for metrics + logging.
		const sessionEmitter = new SimpleEventEmitter()

		sessionEmitter.on('sync:connected', (event) => {
			this.metrics.recordHandshake(sessionId, event.nodeId)
			this.metrics.updateSessionState(sessionId, 'authenticated')
			this.logger.log({
				timestamp: Date.now(),
				level: 'info',
				event: 'session.handshake',
				sessionId,
				nodeId: event.nodeId,
			})
		})

		sessionEmitter.on('sync:received', (event) => {
			const byteSize = estimateOperationByteSize(event.operations)
			this.metrics.recordReceived(sessionId, event.batchSize, byteSize)
			this.logger.log({
				timestamp: Date.now(),
				level: 'info',
				event: 'operations.received',
				sessionId,
				count: event.batchSize,
				bytes: byteSize,
			})
		})

		sessionEmitter.on('sync:sent', (event) => {
			const byteSize = estimateOperationByteSize(event.operations)
			this.metrics.recordSent(sessionId, event.batchSize, byteSize)
			this.logger.log({
				timestamp: Date.now(),
				level: 'info',
				event: 'operations.sent',
				sessionId,
				count: event.batchSize,
				bytes: byteSize,
			})
		})

		sessionEmitter.on('sync:disconnected', () => {
			this.logger.log({
				timestamp: Date.now(),
				level: 'info',
				event: 'session.disconnected',
				sessionId,
			})
		})

		const session = new ClientSession({
			sessionId,
			transport,
			store: this.store,
			auth: this.auth ?? undefined,
			serializer: this.serializer,
			emitter: sessionEmitter,
			batchSize: this.batchSize,
			schemaVersion: this.schemaVersion,
			onRelay: (sourceSessionId, operations) => {
				this.handleRelay(sourceSessionId, operations)
			},
			onAwarenessUpdate: (sourceSessionId, message) => {
				this.handleAwarenessRelay(sourceSessionId, message)
			},
			onClose: (sid) => {
				this.handleSessionClose(sid)
			},
		})

		this.sessions.set(sessionId, session)
		session.start()

		this.logger.log({
			timestamp: Date.now(),
			level: 'info',
			event: 'session.connected',
			sessionId,
			details: { totalSessions: this.sessions.size },
		})

		return sessionId
	}

	/**
	 * Get the current server status.
	 */
	async getStatus(): Promise<ServerStatus> {
		const totalOps = await this.store.getOperationCount()
		const snapshot = this.metrics.getSnapshot(totalOps)
		return {
			running: this.running,
			connectedClients: snapshot.connectedClients,
			port: this.port ?? null,
			totalOperations: snapshot.totalOperations,
			uptime: snapshot.uptime,
			version: this.serverVersion,
			schemaVersion: this.schemaVersion,
			connectedNodeIds: snapshot.connectedNodeIds,
			peakConnections: snapshot.peakConnections,
			connectionsTotal: snapshot.connectionsTotal,
			operationsReceived: snapshot.operationsReceived,
			operationsSent: snapshot.operationsSent,
			errorCount: snapshot.errorCount,
		}
	}

	/**
	 * Get the number of currently connected clients.
	 */
	getConnectionCount(): number {
		return this.sessions.size
	}

	// --- Private ---

	private handleRelay(sourceSessionId: string, operations: Operation[]): void {
		const targetCount = this.sessions.size - 1
		const byteSize = estimateOperationByteSize(operations)
		this.metrics.recordSent(sourceSessionId, operations.length * targetCount, byteSize * targetCount)
		this.logger.log({
			timestamp: Date.now(),
			level: 'info',
			event: 'operations.relayed',
			sessionId: sourceSessionId,
			count: operations.length,
			bytes: byteSize * targetCount,
			details: { targetSessions: targetCount },
		})

		for (const [sessionId, session] of this.sessions) {
			if (sessionId === sourceSessionId) continue
			session.relayOperations(operations)
		}
	}

	private handleSessionClose(sessionId: string): void {
		this.metrics.recordDisconnection(sessionId)
		this.awarenessRelay.removeClient(sessionId)

		this.sessions.delete(sessionId)

		const clientId = this.httpSessionToClient.get(sessionId)
		if (clientId) {
			this.httpSessionToClient.delete(sessionId)
			this.httpClients.delete(clientId)
		}
	}

	private handleAwarenessRelay(
		sourceSessionId: string,
		message: AwarenessUpdateMessage,
	): void {
		// Register client with awareness relay if not already done
		const session = this.sessions.get(sourceSessionId)
		if (!session) return

		const transport = session.getTransport()
		if (!this.awarenessRelay.getClientCount() || !transport) {
			// First awareness update from this client -- register
		}
		this.awarenessRelay.addClient(sourceSessionId, message.clientId, transport)
		this.awarenessRelay.handleUpdate(sourceSessionId, message)
	}

	private getOrCreateHttpClient(clientId: string): {
		sessionId: string
		transport: HttpServerTransport
	} {
		const existing = this.httpClients.get(clientId)
		if (existing) {
			return existing
		}

		const transport = new HttpServerTransport(this.serializer)
		const sessionId = this.handleConnection(transport)
		const client = { sessionId, transport }

		this.httpClients.set(clientId, client)
		this.httpSessionToClient.set(sessionId, clientId)

		return client
	}
}

/**
 * Estimate the total byte size of serialized operations.
 * Used for bandwidth tracking.
 */
function estimateOperationByteSize(operations: Operation[]): number {
	let total = 0
	for (const op of operations) {
		total += JSON.stringify(op).length
	}
	return total
}

function normalizeHttpBody(body: string | Uint8Array, contentType?: string): string | Uint8Array {
	if (body instanceof Uint8Array) {
		return body
	}

	if (contentType?.includes('application/x-protobuf')) {
		return new TextEncoder().encode(body)
	}

	return body
}
