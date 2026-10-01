import type { BlobRef, KoraEventEmitter, Operation, OperationTransform } from '@korajs/core'
import { KoraError, SyncError, generateUUIDv7, isBlobRef } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import type { AwarenessUpdateMessage, MessageSerializer, YjsDocUpdateMessage } from '@korajs/sync'
import { HTTP_SYNC_SESSION_HEADER, JsonMessageSerializer } from '@korajs/sync'
import {
	type ApplyServerOperationOptions,
	type ApplyServerOperationResult,
	applyServerOperation,
} from '../apply/apply-server-operation'
import type { OperationValidator } from '../apply/operation-validator'
import { NoAuthProvider } from '../auth/no-auth'
import { AwarenessRelay } from '../awareness/awareness-relay'
import { ServerMetricsCollector, estimateByteSize } from '../diagnostics/server-metrics-collector'
import type { Logger } from '../logging/structured-logger'
import { createDefaultLogger } from '../logging/structured-logger'
import { BlobChunkRelay } from '../richtext/blob-chunk-relay'
import { YjsDocRelay } from '../richtext/yjs-doc-relay'
import { ClientSession } from '../session/client-session'
import type { MaterializedRecord, ServerStore } from '../store/server-store'
import { HttpServerTransport } from '../transport/http-server-transport'
import type { ServerTransport } from '../transport/server-transport'
import { WsServerTransport } from '../transport/ws-server-transport'
import type {
	AuthContext,
	AuthProvider,
	HttpSyncRequest,
	HttpSyncResponse,
	KoraSyncServerConfig,
	ServerStatus,
	TerminateSessionsFilter,
} from '../types'
import { type ProductionHttpRouteContext, createRouteContext } from './route-context'

const DEFAULT_MAX_CONNECTIONS = 0 // unlimited
const DEFAULT_BATCH_SIZE = 100
const DEFAULT_SCHEMA_VERSION = 1
const DEFAULT_HOST = '0.0.0.0'
const DEFAULT_PATH = '/'
const DEFAULT_RELAY_RETRANSMIT_INTERVAL_MS = 2000
const DEFAULT_DELIVERY_POLL_INTERVAL_MS = 2000
const DEFAULT_HTTP_SESSION_IDLE_TIMEOUT_MS = 2 * 60_000
/** Bytes of randomness in a server-issued HTTP session id (256 bits). */
const HTTP_SESSION_ID_BYTES = 32
/** Default largest WebSocket message accepted (the ws library default is 100 MiB). */
export const DEFAULT_MAX_MESSAGE_BYTES = 32 * 1024 * 1024

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
	maxPayload?: number
}) => WsServerLike

function validateIntervalOption(name: string, value: number): number {
	if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
		throw new SyncError(`${name} must be a non-negative integer number of milliseconds`, {
			[name]: value,
		})
	}
	return value
}

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
	private readonly relayRetransmitIntervalMs: number
	private readonly deliveryPollIntervalMs: number
	private readonly schemaVersion: number
	private readonly supportedSchemaVersions: { min: number; max: number }
	private readonly operationTransforms: OperationTransform[]
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
	private readonly maxOpsPerBatch: number | undefined
	private readonly maxMessageBytes: number
	private readonly blobLimits: NonNullable<KoraSyncServerConfig['blobLimits']>
	private readonly validateOperation: OperationValidator | undefined
	private readonly koraContext: ProductionHttpRouteContext
	private readonly sessions = new Map<string, ClientSession>()
	/**
	 * HTTP long-poll sessions by their server-issued, high-entropy id (RT-2). Each is
	 * bound to the principal that opened it; every request must re-authenticate as it.
	 */
	private readonly httpSessions = new Map<string, HttpSessionEntry>()
	/** Internal ClientSession id -> HTTP session id, for cleanup on close. */
	private readonly httpSessionIdBySession = new Map<string, string>()
	private readonly httpSessionIdleTimeoutMs: number
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
	private deliveryPollTimer: ReturnType<typeof setInterval> | null = null
	private lastObservedDeliverySequence = 0
	private deliveryPollInFlight = false
	/** Unsubscribes from the auth provider's revocation feed (AUTH-11). */
	private revocationUnsubscribe: (() => void) | null = null
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
		const storeSchemaVersion = this.store.getSchema()?.version
		if (
			config.schemaVersion !== undefined &&
			storeSchemaVersion !== undefined &&
			config.schemaVersion !== storeSchemaVersion
		) {
			throw new SyncError('Sync schema version does not match the configured store schema.', {
				syncSchemaVersion: config.schemaVersion,
				storeSchemaVersion,
			})
		}
		this.auth = config.auth ?? null
		this.serializer = config.serializer ?? new JsonMessageSerializer()
		this.emitter = config.emitter ?? null
		this.maxConnections = config.maxConnections ?? DEFAULT_MAX_CONNECTIONS
		this.batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE
		this.relayRetransmitIntervalMs = validateIntervalOption(
			'relayRetransmitIntervalMs',
			config.relayRetransmitIntervalMs ?? DEFAULT_RELAY_RETRANSMIT_INTERVAL_MS,
		)
		this.deliveryPollIntervalMs = validateIntervalOption(
			'deliveryPollIntervalMs',
			config.deliveryPollIntervalMs ?? DEFAULT_DELIVERY_POLL_INTERVAL_MS,
		)
		this.schemaVersion = config.schemaVersion ?? storeSchemaVersion ?? DEFAULT_SCHEMA_VERSION
		this.supportedSchemaVersions = config.supportedSchemaVersions ?? {
			min: this.schemaVersion,
			max: this.schemaVersion,
		}
		this.operationTransforms = config.operationTransforms ?? []
		this.port = config.port
		this.host = config.host ?? DEFAULT_HOST
		this.path = config.path ?? DEFAULT_PATH
		this.logger = config.logger ?? createDefaultLogger()
		this.metrics = config.metricsCollector ?? new ServerMetricsCollector()
		this.metrics.setSchemaVersion(this.schemaVersion)
		this.blobLimits = config.blobLimits ?? {}
		this.blobChunkRelay = new BlobChunkRelay(config.resolveBlobChunk, {
			...(this.blobLimits.maxPendingRequestsPerSession !== undefined
				? { maxPendingPerSession: this.blobLimits.maxPendingRequestsPerSession }
				: {}),
			...(this.blobLimits.pendingRequestTtlMs !== undefined
				? { pendingTtlMs: this.blobLimits.pendingRequestTtlMs }
				: {}),
		})
		this.httpSessionIdleTimeoutMs = validateIntervalOption(
			'httpSessionIdleTimeoutMs',
			config.httpSessionIdleTimeoutMs ?? DEFAULT_HTTP_SESSION_IDLE_TIMEOUT_MS,
		)
		this.maxMessageBytes = config.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES
		this.persistBlobChunk = config.persistBlobChunk ?? null
		this.maxOperationBytes = config.maxOperationBytes
		this.maxOpsPerMinute = config.maxOpsPerMinute
		if (
			config.maxOpsPerBatch !== undefined &&
			(!Number.isInteger(config.maxOpsPerBatch) || config.maxOpsPerBatch < 1)
		) {
			throw new SyncError('maxOpsPerBatch must be a positive integer', {
				maxOpsPerBatch: config.maxOpsPerBatch,
			})
		}
		this.maxOpsPerBatch = config.maxOpsPerBatch
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

		this.ensureRevocationSubscribed()
	}

	/**
	 * Follow the auth provider's revocation feed, when it has one, so revoking a
	 * device or user ends its live sessions without any wiring by the app.
	 */
	private ensureRevocationSubscribed(): void {
		if (this.revocationUnsubscribe || !this.auth?.onRevoke) return
		this.revocationUnsubscribe = this.auth.onRevoke((event) => {
			this.terminateSessions({
				...(event.userId !== undefined ? { userId: event.userId } : {}),
				...(event.deviceId !== undefined ? { deviceId: event.deviceId } : {}),
			})
		})
	}

	/**
	 * End live sync sessions whose credential was revoked (AUTH-11).
	 *
	 * Each matching session receives a retriable `AUTH_REVOKED` (or `AUTH_EXPIRED`)
	 * error and is closed. The client refreshes its credentials and re-handshakes,
	 * so the server authenticates it again: a still-valid device reconnects, a
	 * revoked one is refused. Sessions still in their handshake are refused as soon
	 * as their principal is known.
	 *
	 * `createKoraAuthServer().bindSyncServer(server)` calls this on device revoke,
	 * sign-out, password reset or change, and admin revoke. A provider exposing
	 * `onRevoke` (the built-in one does) is followed automatically.
	 *
	 * @param filter - `userId` ends every session of that user; with `deviceId`,
	 *   only that device's sessions. At least one of the two is required.
	 * @returns The number of established sessions that were closed
	 *
	 * @example
	 * ```typescript
	 * server.terminateSessions({ userId: 'u1', deviceId: 'laptop' })
	 * ```
	 */
	terminateSessions(filter: TerminateSessionsFilter): number {
		if (filter.userId === undefined && filter.deviceId === undefined) {
			throw new KoraError(
				'terminateSessions needs a userId or a deviceId; refusing to end every session.',
				'INVALID_TERMINATE_FILTER',
				{ fix: 'Pass { userId } to end a user, or { userId, deviceId } to end one device.' },
			)
		}
		const code = filter.code ?? 'AUTH_REVOKED'
		let terminated = 0
		for (const session of [...this.sessions.values()]) {
			if (session.terminateIfMatches(filter, code)) terminated++
		}
		if (terminated > 0) {
			this.logger.log({
				timestamp: Date.now(),
				level: 'info',
				event: 'sessions.terminated',
				count: terminated,
				details: {
					code,
					...(filter.userId !== undefined ? { userId: filter.userId } : {}),
					...(filter.deviceId !== undefined ? { deviceId: filter.deviceId } : {}),
				},
			})
		}
		return terminated
	}

	/**
	 * Admin release of a device node id (RT-5). The next principal to handshake with
	 * this node id claims it, even when the node already has operation history.
	 *
	 * Use it to hand over operation history written before node claims existed (an
	 * upgrade from beta.12, where nobody may adopt such a node until it is released),
	 * or to reassign a lost device's node id. Live sessions on that node id are ended
	 * with a retriable `NODE_RELEASED` error so the handover starts clean.
	 *
	 * @param nodeId - The device node id to release
	 * @returns True when the node had a claim or history to release; false when it
	 *   was unknown or the store does not support node claims
	 *
	 * @example
	 * ```typescript
	 * await server.releaseNodeClaim('0190a1b2-...')
	 * ```
	 */
	async releaseNodeClaim(nodeId: string): Promise<boolean> {
		if (!this.store.releaseNodeClaim) return false
		const released = await this.store.releaseNodeClaim(nodeId)
		if (released) {
			for (const session of [...this.sessions.values()]) {
				if (session.getClientNodeId() === nodeId && session.getState() !== 'connected') {
					session.endForNodeRelease()
				}
			}
			this.logger.log({
				timestamp: Date.now(),
				level: 'info',
				event: 'node_claim.released',
				nodeId,
			})
		}
		return released
	}

	private ensureBackgroundTimersStarted(): void {
		if (this.relayRetransmitIntervalMs > 0 && !this.relayRetransmitTimer) {
			this.relayRetransmitTimer = setInterval(() => {
				this.retransmitPendingRelays(this.relayRetransmitIntervalMs)
			}, this.relayRetransmitIntervalMs)
			this.relayRetransmitTimer.unref?.()
		}

		if (this.deliveryPollIntervalMs > 0 && !this.deliveryPollTimer) {
			this.deliveryPollTimer = setInterval(() => {
				void this.pollDeliveryLog()
			}, this.deliveryPollIntervalMs)
			this.deliveryPollTimer.unref?.()
		}
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
		this.expireIdleHttpSessions()
	}

	/** Close HTTP long-poll sessions that sent no request within the idle timeout. */
	private expireIdleHttpSessions(now = Date.now()): void {
		if (this.httpSessionIdleTimeoutMs <= 0 || this.httpSessions.size === 0) return
		const cutoff = now - this.httpSessionIdleTimeoutMs
		for (const entry of [...this.httpSessions.values()]) {
			if (entry.lastSeenAtMs <= cutoff) {
				entry.transport.close(4008, 'http session idle')
			}
		}
	}

	/**
	 * Check whether the authoritative delivery log advanced without passing through
	 * this server instance, then wake delivery-watermark sessions to scan from their
	 * own acknowledged cursors. Session-level filtering remains the only fan-out path.
	 */
	async pollDeliveryLog(): Promise<void> {
		if (this.deliveryPollInFlight) return
		this.deliveryPollInFlight = true
		try {
			const maxDeliverySequence = await this.store.getMaxDeliverySequence()
			if (maxDeliverySequence <= this.lastObservedDeliverySequence) {
				for (const session of this.sessions.values()) {
					session.pushDeliveryStreamIfSupported(this.deliveryPollIntervalMs, {
						trackStall: true,
						serverFrontier: maxDeliverySequence,
					})
				}
				return
			}
			this.lastObservedDeliverySequence = maxDeliverySequence
			for (const session of this.sessions.values()) {
				session.pushDeliveryStreamIfSupported(0, {
					serverFrontier: maxDeliverySequence,
				})
			}
		} catch (error) {
			this.logger.log({
				timestamp: Date.now(),
				level: 'warn',
				event: 'delivery_poll.failed',
				details: { error: error instanceof Error ? error.message : String(error) },
			})
		} finally {
			this.deliveryPollInFlight = false
		}
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
			this.metrics.recordReceived(sessionId, event.batchSize, byteSize, {
				unique: event.uniqueOperations ?? event.batchSize,
				duplicates: event.duplicateOperations ?? 0,
				rejected: event.rejectedOperations ?? 0,
			})
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

		sessionEmitter.on('sync:schema-mismatch', (event) => {
			this.logger.log({
				timestamp: Date.now(),
				level: 'warn',
				event: 'session.schema_mismatch',
				sessionId,
				details: {
					clientSchemaVersion: event.clientSchemaVersion,
					serverSchemaVersion: event.serverSchemaVersion,
					supportedMin: event.supportedMin,
					supportedMax: event.supportedMax,
					reason: event.reason,
				},
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
				maxPayload: this.maxMessageBytes,
			})
		} else {
			// Dynamic import of ws — only needed in standalone mode
			const { WebSocketServer } = await import('ws')
			this.wsServer = new WebSocketServer({
				port: this.port,
				host: this.host,
				path: this.path,
				maxPayload: this.maxMessageBytes,
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
		if (this.deliveryPollTimer) {
			clearInterval(this.deliveryPollTimer)
			this.deliveryPollTimer = null
		}
		this.orphanedRelaysByNode.clear()
		this.revocationUnsubscribe?.()
		this.revocationUnsubscribe = null

		// Clean up awareness relay
		this.awarenessRelay.clear()
		this.yjsDocRelay.clear()
		this.blobChunkRelay.clear()

		// Close all active sessions (works in both standalone and attach mode)
		for (const session of this.sessions.values()) {
			session.close('server shutting down')
		}
		this.sessions.clear()
		this.httpSessions.clear()
		this.httpSessionIdBySession.clear()

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
	 * The POST that opens a session (the handshake, sent without `sessionId`) creates
	 * it and answers with a server-issued, high-entropy session id in the
	 * `x-kora-session` response header. Every later request must name that id.
	 *
	 * With an auth provider, EVERY request is authenticated from its `authorization`
	 * header and must resolve to the same principal (user, device and anonymity) as
	 * the request that opened the session and as the session's handshake, so knowing
	 * a session id alone grants nothing (RT-2). Sessions with no request for
	 * `httpSessionIdleTimeoutMs` are closed.
	 *
	 * Responses: 202 (POST accepted), 200/204/304 (GET), 400 (malformed), 401
	 * (credential missing or invalid), 403 (credential of another principal), 404
	 * (unknown or expired session), 405 (method), 410 (session closed).
	 */
	async handleHttpRequest(request: HttpSyncRequest): Promise<HttpSyncResponse> {
		if (request.method !== 'GET' && request.method !== 'POST') {
			return { status: 405, headers: { allow: 'GET, POST' } }
		}
		this.expireIdleHttpSessions()

		const authenticated = await this.authenticateHttpRequest(request.authorization)
		if (authenticated === 'unauthorized') {
			return { status: 401, headers: { 'www-authenticate': 'Bearer' } }
		}

		if (request.sessionId === undefined || request.sessionId.length === 0) {
			// Only the POST carrying the handshake may open a session.
			if (request.method !== 'POST' || request.body === undefined) {
				return { status: 400 }
			}
			const entry = this.openHttpSession(authenticated)
			entry.transport.receive(normalizeHttpBody(request.body, request.contentType))
			return {
				status: 202,
				headers: { [HTTP_SYNC_SESSION_HEADER]: entry.id },
			}
		}

		const entry = this.httpSessions.get(request.sessionId)
		if (!entry) {
			return { status: 404 }
		}
		if (!this.httpPrincipalMatches(entry, authenticated)) {
			return { status: 403 }
		}
		entry.lastSeenAtMs = Date.now()

		if (request.method === 'POST') {
			if (request.body === undefined) {
				return { status: 400 }
			}
			if (!entry.transport.isConnected()) {
				return { status: 410 }
			}
			entry.transport.receive(normalizeHttpBody(request.body, request.contentType))
			return { status: 202 }
		}

		const polled = entry.transport.poll(request.ifNoneMatch)
		return {
			status: polled.status,
			body: polled.body,
			headers: polled.headers,
		}
	}

	/**
	 * Authenticate one HTTP request. Returns the principal identity, null when the
	 * server has no real auth provider, or 'unauthorized'.
	 */
	private async authenticateHttpRequest(
		authorization: string | undefined,
	): Promise<HttpPrincipal | null | 'unauthorized'> {
		if (!this.auth || this.auth instanceof NoAuthProvider) return null
		const token = parseBearer(authorization)
		if (token === null) return 'unauthorized'
		let context: AuthContext | null
		try {
			context = await this.auth.authenticate(token)
		} catch {
			return 'unauthorized'
		}
		return context ? principalOf(context) : 'unauthorized'
	}

	/**
	 * True when a request's principal is the one that opened the session and, once
	 * the handshake authenticated, the session's own principal.
	 */
	private httpPrincipalMatches(entry: HttpSessionEntry, principal: HttpPrincipal | null): boolean {
		if (!samePrincipal(entry.principal, principal)) return false
		const session = this.sessions.get(entry.sessionId)
		const handshakePrincipal = session?.getPrincipal()
		if (handshakePrincipal && !samePrincipal(principalOf(handshakePrincipal), principal)) {
			// The handshake authenticated someone other than the HTTP credential: the
			// session cannot be trusted by either; end it.
			entry.transport.close(4003, 'http principal mismatch')
			return false
		}
		return true
	}

	/**
	 * Handle an incoming client connection (attach mode).
	 * Creates a new ClientSession for the transport.
	 *
	 * @param transport - The server transport for the new connection
	 * @returns The session ID
	 */
	handleConnection(transport: ServerTransport): string {
		this.ensureRevocationSubscribed()
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

		this.ensureBackgroundTimersStarted()

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
			this.metrics.recordReceived(sessionId, event.batchSize, byteSize, {
				unique: event.uniqueOperations ?? event.batchSize,
				duplicates: event.duplicateOperations ?? 0,
				rejected: event.rejectedOperations ?? 0,
			})
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

		sessionEmitter.on('sync:schema-mismatch', (event) => {
			this.logger.log({
				timestamp: Date.now(),
				level: 'warn',
				event: 'session.schema_mismatch',
				sessionId,
				details: {
					clientSchemaVersion: event.clientSchemaVersion,
					serverSchemaVersion: event.serverSchemaVersion,
					supportedMin: event.supportedMin,
					supportedMax: event.supportedMax,
					reason: event.reason,
				},
			})
		})

		sessionEmitter.on('sync:delivery-stalled', (event) => {
			this.logger.log({
				timestamp: Date.now(),
				level: 'warn',
				event: 'session.delivery_stalled',
				sessionId,
				details: {
					watermark: event.watermark,
					outstandingMaxDeliverySequence: event.outstandingMaxDeliverySequence,
					repeatCount: event.repeatCount,
					reason: event.reason,
				},
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
			operationTransforms: this.operationTransforms,
			onRelay: (sourceSessionId, operations) => {
				this.handleRelay(sourceSessionId, operations)
			},
			onAwarenessUpdate: (sourceSessionId, message) => {
				this.handleAwarenessRelay(sourceSessionId, message)
			},
			onYjsDocUpdate: (sourceSessionId, message, storedRecord) => {
				this.handleYjsDocRelay(sourceSessionId, message, storedRecord)
			},
			onBlobChunkRequest: (sourceSessionId, message) => {
				this.blobChunkRelay.handleRequest(sourceSessionId, message)
			},
			onBlobChunkResponse: (sourceSessionId, message) => {
				this.blobChunkRelay.handleResponse(sourceSessionId, message)
			},
			...(this.persistBlobChunk ? { persistBlobChunk: this.persistBlobChunk } : {}),
			...(this.blobLimits.maxChunkBytes !== undefined
				? { maxBlobChunkBytes: this.blobLimits.maxChunkBytes }
				: {}),
			...(this.blobLimits.maxBytesPerSession !== undefined
				? { maxBlobBytesPerSession: this.blobLimits.maxBytesPerSession }
				: {}),
			// Side channels are joined only after an accepted handshake, never at connect.
			onReady: (sid) => {
				this.yjsDocRelay.addClient(sid, transport)
				this.blobChunkRelay.addClient(sid, transport)
			},
			// Only forward when configured, so an unset server value leaves the
			// session on its own documented default rather than `undefined`.
			...(this.maxOperationBytes !== undefined
				? { maxOperationBytes: this.maxOperationBytes }
				: {}),
			...(this.maxOpsPerMinute !== undefined ? { maxOpsPerMinute: this.maxOpsPerMinute } : {}),
			...(this.maxOpsPerBatch !== undefined ? { maxOpsPerBatch: this.maxOpsPerBatch } : {}),
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
	 * @param options - Optional in-store authorization (used by scoped routes)
	 * @returns The apply result, including any server-generated side-effect ops
	 */
	async applyLocalOperation(
		op: Operation,
		options: ApplyServerOperationOptions = {},
	): Promise<ApplyServerOperationResult> {
		const result = await applyServerOperation(this.store, op, undefined, options)

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

		const httpSessionId = this.httpSessionIdBySession.get(sessionId)
		if (httpSessionId) {
			this.httpSessionIdBySession.delete(sessionId)
			this.httpSessions.delete(httpSessionId)
		}
	}

	private handleAwarenessRelay(sourceSessionId: string, message: AwarenessUpdateMessage): void {
		// Only sessions that completed an accepted handshake take part in presence. The
		// first update binds the session's awareness clientId (later updates must use
		// it) and its presence partition (its canonical download scope).
		const session = this.sessions.get(sourceSessionId)
		if (!session || !session.isStreaming()) return

		if (!this.awarenessRelay.hasClient(sourceSessionId)) {
			this.awarenessRelay.addClient(
				sourceSessionId,
				message.clientId,
				session.getTransport(),
				session.getScopePartitionKey(),
			)
		}
		this.awarenessRelay.handleUpdate(sourceSessionId, message)
	}

	private handleYjsDocRelay(
		sourceSessionId: string,
		message: YjsDocUpdateMessage,
		storedRecord: MaterializedRecord | null,
	): void {
		if (!this.sessions.has(sourceSessionId)) {
			return
		}
		// The session already authorized the sender's write. Deliver only to sessions
		// whose download scope contains the stored record.
		this.yjsDocRelay.handleUpdate(sourceSessionId, message, (targetSessionId) => {
			const target = this.sessions.get(targetSessionId)
			return target
				? target.canReceiveRecord(message.collection, message.recordId, storedRecord)
				: false
		})
	}

	/** Open a new HTTP long-poll session bound to `principal`, under a fresh random id. */
	private openHttpSession(principal: HttpPrincipal | null): HttpSessionEntry {
		const transport = new HttpServerTransport(this.serializer)
		const sessionId = this.handleConnection(transport)
		const entry: HttpSessionEntry = {
			id: generateHttpSessionId(),
			sessionId,
			transport,
			principal,
			lastSeenAtMs: Date.now(),
		}
		this.httpSessions.set(entry.id, entry)
		this.httpSessionIdBySession.set(sessionId, entry.id)
		return entry
	}
}

/** The identity an HTTP session is bound to (RT-2). */
interface HttpPrincipal {
	userId: string
	deviceId: string | null
	anonymous: boolean
}

interface HttpSessionEntry {
	/** Server-issued, high-entropy id the client presents on every request. */
	id: string
	/** The ClientSession behind it. */
	sessionId: string
	transport: HttpServerTransport
	/** Principal of the request that opened it; null without a real auth provider. */
	principal: HttpPrincipal | null
	lastSeenAtMs: number
}

function principalOf(context: AuthContext): HttpPrincipal {
	const deviceId = context.metadata?.deviceId
	return {
		userId: context.userId,
		deviceId: typeof deviceId === 'string' ? deviceId : null,
		anonymous: context.anonymous === true,
	}
}

/**
 * Same principal. Anonymous principals get a fresh userId per authentication, so two
 * anonymous principals match on anonymity alone; their session id is their only
 * credential.
 */
function samePrincipal(a: HttpPrincipal | null, b: HttpPrincipal | null): boolean {
	if (a === null || b === null) return a === b
	if (a.anonymous || b.anonymous) return a.anonymous && b.anonymous
	return a.userId === b.userId && a.deviceId === b.deviceId
}

/** The token of a `Bearer <token>` header; '' when absent (anonymous); null when malformed. */
function parseBearer(authorization: string | undefined): string | null {
	if (authorization === undefined || authorization.trim() === '') return ''
	const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization.trim())
	return match?.[1] ?? null
}

/** 256 random bits, base64url: an unguessable HTTP session id. */
function generateHttpSessionId(): string {
	const bytes = new Uint8Array(HTTP_SESSION_ID_BYTES)
	globalThis.crypto.getRandomValues(bytes)
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
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
