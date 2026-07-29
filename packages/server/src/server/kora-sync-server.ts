import type { BlobRef, KoraEventEmitter, Operation } from '@korajs/core'
import { SyncError, generateUUIDv7, isBlobRef } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import type { AwarenessUpdateMessage, MessageSerializer, YjsDocUpdateMessage } from '@korajs/sync'
import { JsonMessageSerializer } from '@korajs/sync'
import {
	type ApplyServerOperationResult,
	applyServerOperation,
} from '../apply/apply-server-operation'
import type { OperationValidator } from '../apply/operation-validator'
import { AwarenessRelay } from '../awareness/awareness-relay'
import { ServerMetricsCollector, estimateByteSize } from '../diagnostics/server-metrics-collector'
import type { Logger } from '../logging/structured-logger'
import { createDefaultLogger } from '../logging/structured-logger'
import { BlobChunkRelay } from '../richtext/blob-chunk-relay'
import { YjsDocRelay } from '../richtext/yjs-doc-relay'
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
import { type ProductionHttpRouteContext, createRouteContext } from './route-context'

const DEFAULT_MAX_CONNECTIONS = 0 // unlimited
const DEFAULT_BATCH_SIZE = 100
const DEFAULT_SCHEMA_VERSION = 1
const DEFAULT_HOST = '0.0.0.0'
const DEFAULT_PATH = '/'
/** How often to retransmit relay batches connected clients have not acknowledged. */
const RELAY_RETRANSMIT_INTERVAL_MS = 2000

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
	private readonly supportedSchemaVersions: { min: number; max: number }
	private readonly port: number | undefined
	private readonly host: string
	private readonly path: string
	private readonly logger: Logger
	private readonly metrics: ServerMetricsCollector

	private readonly awarenessRelay = new AwarenessRelay()
	private readonly yjsDocRelay = new YjsDocRelay()
	private readonly blobChunkRelay: BlobChunkRelay
	private readonly persistBlobChunk:
		| ((hash: string, bytes: Uint8Array) => Promise<void> | void)
		| null
	private readonly maxOperationBytes: number | undefined
	private readonly maxOpsPerMinute: number | undefined
	private readonly validateOperation: OperationValidator | undefined
	private readonly koraContext: ProductionHttpRouteContext
	private readonly sessions = new Map<string, ClientSession>()
	private readonly httpClients = new Map<
		string,
		{ sessionId: string; transport: HttpServerTransport }
	>()
	private readonly httpSessionToClient = new Map<string, string>()
	// Informational value reported by getStatus(). Keep in sync with the
	// @korajs/server package version on release; it is not used for protocol negotiation.
	private readonly serverVersion = '1.0.0-beta.0'
	private wsServer: WsServerLike | null = null
	private running = false
	/**
	 * Periodic tick that retransmits relay batches connected clients have not
	 * acknowledged, so a relay dropped by a lossy transport is redelivered instead of
	 * leaving that client with a permanent version-vector gap (a lost operation).
	 */
	private relayRetransmitTimer: ReturnType<typeof setInterval> | null = null
	/**
	 * Relay operations a client never acknowledged before it disconnected, buffered by
	 * client node id so they can be redelivered on its next connection. Bounded per
	 * node and expired by age so a client that never returns cannot grow this forever.
	 */
	private readonly orphanedRelaysByNode = new Map<
		string,
		{ ops: Operation[]; bufferedAtMs: number }
	>()
	private static readonly MAX_ORPHANED_RELAY_OPS_PER_NODE = 5000
	private static readonly ORPHANED_RELAY_TTL_MS = 5 * 60_000

	constructor(config: KoraSyncServerConfig) {
		this.store = config.store
		this.auth = config.auth ?? null
		this.serializer = config.serializer ?? new JsonMessageSerializer()
		this.emitter = config.emitter ?? null
		this.maxConnections = config.maxConnections ?? DEFAULT_MAX_CONNECTIONS
		this.batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE
		this.schemaVersion = config.schemaVersion ?? DEFAULT_SCHEMA_VERSION
		this.supportedSchemaVersions = config.supportedSchemaVersions ?? {
			min: this.schemaVersion,
			max: this.schemaVersion,
		}
		this.port = config.port
		this.host = config.host ?? DEFAULT_HOST
		this.path = config.path ?? DEFAULT_PATH
		this.logger = config.logger ?? createDefaultLogger()
		this.metrics = config.metricsCollector ?? new ServerMetricsCollector()
		this.metrics.setSchemaVersion(this.schemaVersion)
		this.blobChunkRelay = new BlobChunkRelay(config.resolveBlobChunk)
		this.persistBlobChunk = config.persistBlobChunk ?? null
		this.maxOperationBytes = config.maxOperationBytes
		this.maxOpsPerMinute = config.maxOpsPerMinute
		this.validateOperation = config.validateOperation
		// One trusted data-plane context, shared by custom HTTP routes (via
		// production-server) and by the operation validator. It holds no per-request
		// state; the closures only reach back into `this` when actually invoked.
		this.koraContext = createRouteContext(this, this.store)

		// If no external emitter was provided, create an internal one for
		// subscribing to session events for metrics and logging.
		if (!this.emitter) {
			this.emitter = new SimpleEventEmitter()
		}

		// Retransmit relays a client hasn't acked within one interval. Started here (not
		// in start()) so it also runs for embedded/in-memory servers that never call
		// start(). unref() so it never keeps the process alive; cleared in stop().
		this.relayRetransmitTimer = setInterval(() => {
			this.retransmitPendingRelays(RELAY_RETRANSMIT_INTERVAL_MS)
		}, RELAY_RETRANSMIT_INTERVAL_MS)
		this.relayRetransmitTimer.unref?.()
	}

	/**
	 * Retransmit relay batches that connected clients have not acknowledged within
	 * `staleMs`. Called on a periodic tick and directly by tests. Redelivering an
	 * already-applied operation is harmless (clients dedup by content-addressed id).
	 */
	retransmitPendingRelays(staleMs = 0): void {
		for (const session of this.sessions.values()) {
			session.retransmitPendingRelays(staleMs)
		}
		this.expireOrphanedRelays()
	}

	/**
	 * Buffer relay operations a disconnected client never acknowledged, keyed by its
	 * node id, deduped by operation id and bounded by count. Redelivered when the
	 * client reconnects (see {@link takeOrphanedRelays}).
	 */
	private bufferOrphanedRelays(nodeId: string, ops: Operation[]): void {
		if (ops.length === 0) return
		const existing = this.orphanedRelaysByNode.get(nodeId)
		const merged = existing ? existing.ops : []
		const seen = new Set(merged.map((op) => op.id))
		for (const op of ops) {
			if (!seen.has(op.id)) {
				merged.push(op)
				seen.add(op.id)
			}
		}
		// Keep only the most recent ops if the buffer is oversized.
		const bounded =
			merged.length > KoraSyncServer.MAX_ORPHANED_RELAY_OPS_PER_NODE
				? merged.slice(merged.length - KoraSyncServer.MAX_ORPHANED_RELAY_OPS_PER_NODE)
				: merged
		this.orphanedRelaysByNode.set(nodeId, { ops: bounded, bufferedAtMs: Date.now() })
	}

	/** Remove and return a node's buffered orphaned relay operations, if any. */
	private takeOrphanedRelays(nodeId: string): Operation[] {
		const entry = this.orphanedRelaysByNode.get(nodeId)
		if (!entry) return []
		this.orphanedRelaysByNode.delete(nodeId)
		return entry.ops
	}

	/** Drop buffered orphaned relays older than the TTL (client never returned). */
	private expireOrphanedRelays(): void {
		if (this.orphanedRelaysByNode.size === 0) return
		const cutoff = Date.now() - KoraSyncServer.ORPHANED_RELAY_TTL_MS
		for (const [nodeId, entry] of this.orphanedRelaysByNode) {
			if (entry.bufferedAtMs <= cutoff) {
				this.orphanedRelaysByNode.delete(nodeId)
			}
		}
	}

	/**
	 * The trusted, scoped data-plane context (`apply` / `query` / `findById`).
	 * Shared with the production server so HTTP routes, the operation validator,
	 * and `server.kora` are all the same object over the same pipeline.
	 */
	getKoraContext(): ProductionHttpRouteContext {
		return this.koraContext
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

		// Stop the relay retransmit tick and drop buffered orphaned relays.
		if (this.relayRetransmitTimer) {
			clearInterval(this.relayRetransmitTimer)
			this.relayRetransmitTimer = null
		}
		this.orphanedRelaysByNode.clear()

		// Clean up awareness relay
		this.awarenessRelay.clear()
		this.yjsDocRelay.clear()
		this.blobChunkRelay.clear()

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
			logger: this.logger,
			batchSize: this.batchSize,
			schemaVersion: this.schemaVersion,
			supportedSchemaVersions: this.supportedSchemaVersions,
			onRelay: (sourceSessionId, operations) => {
				this.handleRelay(sourceSessionId, operations)
			},
			onAwarenessUpdate: (sourceSessionId, message) => {
				this.handleAwarenessRelay(sourceSessionId, message)
			},
			onYjsDocUpdate: (sourceSessionId, message) => {
				this.handleYjsDocRelay(sourceSessionId, message)
			},
			onBlobChunkRequest: (sourceSessionId, message) => {
				this.blobChunkRelay.handleRequest(sourceSessionId, message)
			},
			onBlobChunkResponse: (sourceSessionId, message) => {
				this.blobChunkRelay.handleResponse(sourceSessionId, message)
			},
			...(this.persistBlobChunk ? { persistBlobChunk: this.persistBlobChunk } : {}),
			// Only forward when configured, so an unset server value leaves the
			// session on its own documented default rather than `undefined`.
			...(this.maxOperationBytes !== undefined
				? { maxOperationBytes: this.maxOperationBytes }
				: {}),
			...(this.maxOpsPerMinute !== undefined ? { maxOpsPerMinute: this.maxOpsPerMinute } : {}),
			...(this.validateOperation
				? { validateOperation: this.validateOperation, koraContext: this.koraContext }
				: {}),
			onClose: (sid) => {
				this.handleSessionClose(sid)
			},
			onOrphanedRelays: (nodeId, ops) => {
				this.bufferOrphanedRelays(nodeId, ops)
			},
			takeOrphanedRelays: (nodeId) => this.takeOrphanedRelays(nodeId),
		})

		this.sessions.set(sessionId, session)
		this.yjsDocRelay.addClient(sessionId, transport)
		this.blobChunkRelay.addClient(sessionId, transport)
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
	 * Apply a server-originated operation (for example one created by a custom
	 * HTTP route) through the same validated pipeline that incoming client
	 * operations use — Tier 2 constraints, referential integrity, and cascade
	 * side effects — then relay every applied operation to connected clients.
	 *
	 * Because the operation did not come from a client session, it is relayed to
	 * ALL sessions (there is no source session to exclude). Each session still
	 * applies its own per-scope visibility filter in `relayOperations`, so a
	 * client only receives the operation if it falls within that client's scope.
	 *
	 * @param op - A fully-formed, server-originated operation to apply
	 * @returns The apply result, including any server-generated side-effect ops
	 */
	async applyLocalOperation(op: Operation): Promise<ApplyServerOperationResult> {
		const result = await applyServerOperation(this.store, op)

		if (result.result === 'applied' && result.appliedOperations.length > 0) {
			for (const session of this.sessions.values()) {
				session.relayOperations(result.appliedOperations)
			}
		}

		return result
	}

	/**
	 * Relay already-applied, server-originated operations to every connected client.
	 * Used by the conditional route apply, which commits its operations atomically
	 * through the store (bypassing {@link applyLocalOperation}) and then fans them
	 * out. Each session still enforces its own per-scope visibility filter.
	 *
	 * @param operations - Operations that have already been committed to the store
	 */
	relayServerOperations(operations: Operation[]): void {
		if (operations.length === 0) {
			return
		}
		for (const session of this.sessions.values()) {
			session.relayOperations(operations)
		}
	}

	/**
	 * Collect every blob reference still reachable from live records on the server.
	 *
	 * This is the live set for garbage-collecting the server's central blob store:
	 * pass the result to `collectBlobGarbage(blobStore, liveRefs)` from
	 * `@korajs/store` to reclaim bytes no record references any more. Only
	 * collections that declare a `blob` field are scanned.
	 *
	 * @returns Every live blob reference across all collections
	 */
	async getLiveBlobRefs(): Promise<BlobRef[]> {
		const schema = this.store.getSchema()
		if (!schema) {
			return []
		}
		const refs: BlobRef[] = []
		for (const [name, collection] of Object.entries(schema.collections)) {
			const hasBlobField = Object.values(collection.fields).some((field) => field.kind === 'blob')
			if (!hasBlobField) {
				continue
			}
			const records = await this.store.materializeCollection(name)
			for (const record of records) {
				for (const value of Object.values(record)) {
					if (isBlobRef(value)) {
						refs.push(value)
					}
				}
			}
		}
		return refs
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
		this.metrics.recordSent(
			sourceSessionId,
			operations.length * targetCount,
			byteSize * targetCount,
		)
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
		this.yjsDocRelay.removeClient(sessionId)
		this.blobChunkRelay.removeClient(sessionId)

		this.sessions.delete(sessionId)

		const clientId = this.httpSessionToClient.get(sessionId)
		if (clientId) {
			this.httpSessionToClient.delete(sessionId)
			this.httpClients.delete(clientId)
		}
	}

	private handleAwarenessRelay(sourceSessionId: string, message: AwarenessUpdateMessage): void {
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

	private handleYjsDocRelay(sourceSessionId: string, message: YjsDocUpdateMessage): void {
		if (!this.sessions.has(sourceSessionId)) {
			return
		}
		this.yjsDocRelay.handleUpdate(sourceSessionId, message)
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
