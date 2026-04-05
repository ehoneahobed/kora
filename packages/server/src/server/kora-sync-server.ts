import type { KoraEventEmitter, Operation } from '@kora/core'
import { SyncError, generateUUIDv7 } from '@kora/core'
import type { MessageSerializer } from '@kora/sync'
import { JsonMessageSerializer } from '@kora/sync'
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

	private readonly sessions = new Map<string, ClientSession>()
	private readonly httpClients = new Map<string, { sessionId: string; transport: HttpServerTransport }>()
	private readonly httpSessionToClient = new Map<string, string>()
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
	}

	/**
	 * Stop the server. Closes all sessions and the WebSocket server.
	 */
	async stop(): Promise<void> {
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
			throw new SyncError('Maximum connections reached', {
				current: this.sessions.size,
				max: this.maxConnections,
			})
		}

		const sessionId = generateUUIDv7()

		const session = new ClientSession({
			sessionId,
			transport,
			store: this.store,
			auth: this.auth ?? undefined,
			serializer: this.serializer,
			emitter: this.emitter ?? undefined,
			batchSize: this.batchSize,
			schemaVersion: this.schemaVersion,
			onRelay: (sourceSessionId, operations) => {
				this.handleRelay(sourceSessionId, operations)
			},
			onClose: (sid) => {
				this.handleSessionClose(sid)
			},
		})

		this.sessions.set(sessionId, session)
		session.start()

		return sessionId
	}

	/**
	 * Get the current server status.
	 */
	async getStatus(): Promise<ServerStatus> {
		return {
			running: this.running,
			connectedClients: this.sessions.size,
			port: this.port ?? null,
			totalOperations: await this.store.getOperationCount(),
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
		for (const [sessionId, session] of this.sessions) {
			if (sessionId === sourceSessionId) continue
			session.relayOperations(operations)
		}
	}

	private handleSessionClose(sessionId: string): void {
		this.sessions.delete(sessionId)

		const clientId = this.httpSessionToClient.get(sessionId)
		if (clientId) {
			this.httpSessionToClient.delete(sessionId)
			this.httpClients.delete(clientId)
		}
	}

	private getOrCreateHttpClient(clientId: string): { sessionId: string; transport: HttpServerTransport } {
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

function normalizeHttpBody(body: string | Uint8Array, contentType?: string): string | Uint8Array {
	if (body instanceof Uint8Array) {
		return body
	}

	if (contentType?.includes('application/x-protobuf')) {
		return new TextEncoder().encode(body)
	}

	return body
}
