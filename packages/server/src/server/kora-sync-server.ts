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
import { type AwarenessAudience, AwarenessRelay } from '../awareness/awareness-relay'
import { ServerMetricsCollector, estimateByteSize } from '../diagnostics/server-metrics-collector'
import { EncryptionKeyService } from '../encryption/key-record-service'
import type { Logger } from '../logging/structured-logger'
import { createDefaultLogger } from '../logging/structured-logger'
import { BlobAccessIndex } from '../richtext/blob-access-index'
import { BlobChunkRelay } from '../richtext/blob-chunk-relay'
import { YjsDocRelay } from '../richtext/yjs-doc-relay'
import { type AwarenessCursorTarget, ClientSession } from '../session/client-session'
import {
	CombinedRateLimiter,
	DEFAULT_MAX_OPS_PER_MINUTE,
	DEFAULT_USER_BUDGET_MULTIPLIER,
	type IngestRateLimiter,
	SessionRateLimiter,
} from '../session/session-operation-limits'
import type { MaterializedRecord, ServerStore } from '../store/server-store'
import { HttpServerTransport } from '../transport/http-server-transport'
import type { ServerTransport } from '../transport/server-transport'
import {
	DEFAULT_WS_HEARTBEAT_INTERVAL_MS,
	DEFAULT_WS_MAX_BUFFERED_BYTES,
	WsServerTransport,
	type WsWebSocket,
} from '../transport/ws-server-transport'
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

/**
 * Default connection ceiling (SRV-6). Unlimited before beta.13; a bound keeps a flood
 * of idle or half-open sockets from exhausting memory and file descriptors. 0 means
 * unlimited.
 */
export const DEFAULT_MAX_CONNECTIONS = 10_000
/** Default interval of the application-level heartbeat message (LMS #12). */
export const DEFAULT_APP_HEARTBEAT_INTERVAL_MS = 25_000
/**
 * Upper bound on remembered per-node rate limiters. A flood of fresh node ids cannot
 * grow the map past it; the least recently used entries go first.
 */
const MAX_TRACKED_RATE_LIMITERS = 100_000
/** Window of the per-node ingest rate limiter. */
const RATE_LIMIT_WINDOW_MS = 60_000

/**
 * The limiter tracked under `key` in `map`, created on first use. Re-inserted on every
 * use so the map's insertion order is least-recently-used order, and bounded by
 * {@link MAX_TRACKED_RATE_LIMITERS}.
 */
function trackedLimiter(
	map: Map<string, { limiter: SessionRateLimiter; lastUsedAtMs: number }>,
	key: string,
	perMinute: number,
): SessionRateLimiter {
	const now = Date.now()
	const existing = map.get(key)
	if (existing) {
		existing.lastUsedAtMs = now
		map.delete(key)
		map.set(key, existing)
		return existing.limiter
	}
	const limiter = new SessionRateLimiter(perMinute, RATE_LIMIT_WINDOW_MS)
	map.set(key, { limiter, lastUsedAtMs: now })
	while (map.size > MAX_TRACKED_RATE_LIMITERS) {
		const oldest = map.keys().next().value
		if (oldest === undefined) break
		map.delete(oldest)
	}
	return limiter
}
const DEFAULT_BATCH_SIZE = 100
const DEFAULT_SCHEMA_VERSION = 1
const DEFAULT_HOST = '0.0.0.0'
const DEFAULT_PATH = '/'
const DEFAULT_RELAY_RETRANSMIT_INTERVAL_MS = 2000
const DEFAULT_DELIVERY_POLL_INTERVAL_MS = 2000
const DEFAULT_HTTP_SESSION_IDLE_TIMEOUT_MS = 2 * 60_000
/** Default interval between re-validations of live sessions' credentials (RT-18). */
export const DEFAULT_SESSION_REVALIDATION_INTERVAL_MS = 30_000
/** Bytes of randomness in a server-issued HTTP session id (256 bits). */
const HTTP_SESSION_ID_BYTES = 32
/** Default largest WebSocket message accepted (the ws library default is 100 MiB). */
export const DEFAULT_MAX_MESSAGE_BYTES = 32 * 1024 * 1024

/**
 * The `ws` permessage-deflate setting for a `perMessageDeflate` config value (LMS #11).
 * `true`/omitted: compress messages of 1 KiB or more with no compression context kept
 * between messages (bounded memory per connection); `false`: off; an object: as is.
 *
 * @internal Shared by the standalone server and `createProductionServer`.
 */
export function resolvePerMessageDeflate(
	option: boolean | Record<string, unknown> | undefined,
): false | Record<string, unknown> {
	if (option === false) return false
	if (option === undefined || option === true) {
		return {
			threshold: 1024,
			serverNoContextTakeover: true,
			clientNoContextTakeover: true,
			zlibDeflateOptions: { level: 6, memLevel: 8 },
			concurrencyLimit: 10,
		}
	}
	return option
}

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
	perMessageDeflate?: false | Record<string, unknown>
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
	/** The store's re-fold for the configured transforms (RT-84), awaited by start(). */
	private storeTransformsReady: Promise<void> | undefined
	private readonly port: number | undefined
	private readonly host: string
	private readonly path: string
	private readonly logger: Logger
	private readonly metrics: ServerMetricsCollector

	private readonly awarenessRelay = new AwarenessRelay()
	private readonly yjsDocRelay = new YjsDocRelay()
	private readonly blobChunkRelay: BlobChunkRelay
	/** Wrapped encryption key records (ENC-1, D4b), persisted in the server store. */
	private readonly encryptionKeys: EncryptionKeyService
	/** Which blob hashes each download scope may obtain (RT-1). */
	private readonly blobAccess: BlobAccessIndex
	private readonly persistBlobChunk:
		| ((hash: string, bytes: Uint8Array) => Promise<void> | void)
		| null
	private readonly maxOperationBytes: number | undefined
	private readonly maxOpsPerMinute: number | undefined
	/** Per-principal ingest budget per minute; 0 when disabled. */
	private readonly maxOpsPerMinutePerUser: number
	private readonly allowLegacyAnonymousClaims: boolean | undefined
	private readonly anonymousClaimTtlMs: number | undefined
	private readonly maxOpsPerBatch: number | undefined
	private readonly maxScopePredicateValues: number | undefined
	private readonly maxMessageBytes: number
	private readonly heartbeatIntervalMs: number
	private readonly appHeartbeatIntervalMs: number
	private readonly encryptionPolicy:
		| { required: boolean; allowPlaintextMigration?: boolean }
		| undefined
	private readonly handshakeTimeoutMs: number | undefined
	private readonly maxBufferedBytes: number
	private readonly deliveryHighWaterBytes: number | undefined
	private readonly perMessageDeflate: false | Record<string, unknown>
	/**
	 * Ingest rate limiters by device node id, shared by that node's sessions so a
	 * reconnect does not reset the budget (SRV-6). Entries idle past the window are
	 * dropped by the background tick; insertion order doubles as LRU order.
	 */
	private readonly rateLimiters = new Map<
		string,
		{ limiter: SessionRateLimiter; lastUsedAtMs: number }
	>()
	/**
	 * Ingest budgets by authenticated principal, shared by every node of that user, so
	 * minting node ids does not multiply the per-node budget. Expired like the node map.
	 */
	private readonly userRateLimiters = new Map<
		string,
		{ limiter: SessionRateLimiter; lastUsedAtMs: number }
	>()
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
	/**
	 * Re-validates every live session's credential against the auth provider, so a
	 * revocation persisted by ANOTHER server instance (whose in-process revocation
	 * listeners never reach this one) still ends the session here (RT-18).
	 */
	private readonly sessionRevalidationIntervalMs: number
	private sessionRevalidationTimer: ReturnType<typeof setInterval> | null = null
	private lastSessionRevalidationAtMs = 0
	private sessionRevalidationInFlight: Promise<number> | null = null
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
		this.operationTransforms = config.operationTransforms ?? [
			...(this.store.getOperationTransforms?.() ?? []),
		]
		// Transforms run at fold time (RT-84): the store folds every operation as the
		// server schema reads it, with exactly the transforms sessions judge with.
		if (config.operationTransforms !== undefined && this.store.setOperationTransforms) {
			const ready = this.store.setOperationTransforms(this.operationTransforms)
			this.storeTransformsReady = ready
			// Surfaced by start(); logged here for attach mode (handleConnection only).
			ready.catch((error: unknown) => {
				this.logger.log({
					timestamp: Date.now(),
					level: 'error',
					event: 'server.operation_transforms_failed',
					details: { message: error instanceof Error ? error.message : String(error) },
				})
			})
		}
		this.port = config.port
		this.host = config.host ?? DEFAULT_HOST
		this.path = config.path ?? DEFAULT_PATH
		this.logger = config.logger ?? createDefaultLogger()
		this.metrics = config.metricsCollector ?? new ServerMetricsCollector()
		this.metrics.setSchemaVersion(this.schemaVersion)
		this.blobLimits = config.blobLimits ?? {}
		this.blobAccess = new BlobAccessIndex(this.store, config.resolveBlobChunk ?? null)
		this.encryptionKeys = new EncryptionKeyService(this.store)
		this.blobChunkRelay = new BlobChunkRelay(
			config.resolveBlobChunk,
			{
				canReadFromStore: (requesterId, hash) => this.sessionMayReadStoredBlob(requesterId, hash),
				canForward: (requesterId, targetId, hash) =>
					this.mayForwardBlobRequest(requesterId, targetId, hash),
				observeVerifiedBytes: (hash, bytes) => this.blobAccess.observeVerifiedBytes(hash, bytes),
			},
			{
				...(this.blobLimits.maxPendingRequestsPerSession !== undefined
					? { maxPendingPerSession: this.blobLimits.maxPendingRequestsPerSession }
					: {}),
				...(this.blobLimits.pendingRequestTtlMs !== undefined
					? { pendingTtlMs: this.blobLimits.pendingRequestTtlMs }
					: {}),
			},
		)
		this.sessionRevalidationIntervalMs = validateIntervalOption(
			'sessionRevalidationIntervalMs',
			config.sessionRevalidationIntervalMs ?? DEFAULT_SESSION_REVALIDATION_INTERVAL_MS,
		)
		this.httpSessionIdleTimeoutMs = validateIntervalOption(
			'httpSessionIdleTimeoutMs',
			config.httpSessionIdleTimeoutMs ?? DEFAULT_HTTP_SESSION_IDLE_TIMEOUT_MS,
		)
		this.maxMessageBytes = config.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES
		this.heartbeatIntervalMs = validateIntervalOption(
			'heartbeatIntervalMs',
			config.heartbeatIntervalMs ?? DEFAULT_WS_HEARTBEAT_INTERVAL_MS,
		)
		this.appHeartbeatIntervalMs = validateIntervalOption(
			'appHeartbeatIntervalMs',
			config.appHeartbeatIntervalMs ?? DEFAULT_APP_HEARTBEAT_INTERVAL_MS,
		)
		this.encryptionPolicy = config.encryption ? { ...config.encryption } : undefined
		this.handshakeTimeoutMs =
			config.handshakeTimeoutMs === undefined
				? undefined
				: validateIntervalOption('handshakeTimeoutMs', config.handshakeTimeoutMs)
		this.maxBufferedBytes = config.maxBufferedBytes ?? DEFAULT_WS_MAX_BUFFERED_BYTES
		this.deliveryHighWaterBytes = config.deliveryHighWaterBytes
		this.perMessageDeflate = resolvePerMessageDeflate(config.perMessageDeflate)
		this.persistBlobChunk = config.persistBlobChunk ?? null
		this.maxOperationBytes = config.maxOperationBytes
		this.maxOpsPerMinute = config.maxOpsPerMinute
		if (
			config.maxOpsPerMinutePerUser !== undefined &&
			(!Number.isSafeInteger(config.maxOpsPerMinutePerUser) || config.maxOpsPerMinutePerUser < 0)
		) {
			throw new Error(
				`maxOpsPerMinutePerUser must be a non-negative integer (0 disables the per-user budget), got ${String(config.maxOpsPerMinutePerUser)}.`,
			)
		}
		this.maxOpsPerMinutePerUser =
			config.maxOpsPerMinutePerUser ??
			(config.maxOpsPerMinute ?? DEFAULT_MAX_OPS_PER_MINUTE) * DEFAULT_USER_BUDGET_MULTIPLIER
		this.allowLegacyAnonymousClaims = config.allowLegacyAnonymousClaims
		this.anonymousClaimTtlMs = config.anonymousClaimTtlMs
		if (
			config.maxOpsPerBatch !== undefined &&
			(!Number.isInteger(config.maxOpsPerBatch) || config.maxOpsPerBatch < 1)
		) {
			throw new SyncError('maxOpsPerBatch must be a positive integer', {
				maxOpsPerBatch: config.maxOpsPerBatch,
			})
		}
		this.maxOpsPerBatch = config.maxOpsPerBatch
		if (
			config.maxScopePredicateValues !== undefined &&
			(!Number.isInteger(config.maxScopePredicateValues) || config.maxScopePredicateValues < 1)
		) {
			throw new SyncError('maxScopePredicateValues must be a positive integer', {
				maxScopePredicateValues: config.maxScopePredicateValues,
			})
		}
		this.maxScopePredicateValues = config.maxScopePredicateValues
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

		if (
			this.sessionRevalidationIntervalMs > 0 &&
			!this.sessionRevalidationTimer &&
			this.auth !== null &&
			!(this.auth instanceof NoAuthProvider)
		) {
			this.sessionRevalidationTimer = setInterval(() => {
				void this.revalidateSessions()
			}, this.sessionRevalidationIntervalMs)
			this.sessionRevalidationTimer.unref?.()
		}
	}

	/**
	 * Re-validate the credential of every live session with the auth provider and end
	 * the sessions whose credential is no longer accepted (RT-18).
	 *
	 * Revocations are persisted by the auth stores (token, device and per-user
	 * cut-offs), but `onRevoke` listeners only run in the process that handled the
	 * revocation. Every instance therefore re-checks its own live sessions
	 * periodically (`sessionRevalidationIntervalMs`, default 30 seconds, also driven by
	 * the delivery poll tick) by authenticating the session's credential again. A
	 * session whose credential is refused, or now resolves to another principal, gets
	 * a retriable `AUTH_REVOKED` (or `AUTH_EXPIRED`) and is closed. A provider error
	 * (for example the auth database is unreachable) ends nothing: it is logged and the
	 * next pass retries, so an outage does not disconnect every client.
	 *
	 * @returns The number of sessions ended by this pass
	 *
	 * @example
	 * ```typescript
	 * // After revoking through another instance's admin API:
	 * await server.revalidateSessions()
	 * ```
	 */
	revalidateSessions(): Promise<number> {
		if (this.sessionRevalidationInFlight) return this.sessionRevalidationInFlight
		const run = (async (): Promise<number> => {
			this.lastSessionRevalidationAtMs = Date.now()
			let terminated = 0
			for (const session of [...this.sessions.values()]) {
				const outcome = await session.revalidateCredential()
				if (outcome === 'terminated') terminated++
				if (outcome === 'error') {
					this.logger.log({
						timestamp: Date.now(),
						level: 'warn',
						event: 'session.revalidation_failed',
						sessionId: session.getSessionId(),
					})
				}
			}
			if (terminated > 0) {
				this.logger.log({
					timestamp: Date.now(),
					level: 'info',
					event: 'sessions.terminated',
					count: terminated,
					details: { code: 'AUTH_REVOKED', reason: 'revalidation' },
				})
			}
			return terminated
		})()
		this.sessionRevalidationInFlight = run
		void run.finally(() => {
			if (this.sessionRevalidationInFlight === run) this.sessionRevalidationInFlight = null
		})
		return run
	}

	/**
	 * Re-resolve one user's grant on every live session of that user now, instead of
	 * waiting for the next revalidation pass (`sessionRevalidationIntervalMs`). Call it
	 * after a membership change the auth provider's grant depends on: an invitation
	 * accepted, a collaborator removed, a role changed.
	 *
	 * Each of the user's sessions re-authenticates its credential with the provider. A
	 * session whose resolved download or upload scope changed ends with a retriable
	 * `SCOPE_CHANGED`; its client reconnects at once and receives the new grant. A
	 * narrowed grant applies the client's `scopeExit` policy at that handshake
	 * (`'retract'` hides the rows that left the scope), and the device's unsynced writes
	 * outside the new upload scope are refused. A session still in its handshake
	 * re-checks as soon as it is established, so a grant read before the change never
	 * outlives this call. Sessions whose grant did not change are kept.
	 *
	 * Only this process's sessions are refreshed. Other instances apply the change at
	 * their next revalidation pass, or call this too (for example from a pub/sub
	 * message).
	 *
	 * @param userId - The user whose grant changed (the auth provider's `userId`)
	 * @returns The number of sessions this call ended
	 *
	 * @example
	 * ```typescript
	 * await removeCollaborator(documentId, bobId)
	 * await server.refreshScopes(bobId)
	 * ```
	 */
	async refreshScopes(userId: string): Promise<number> {
		if (typeof userId !== 'string' || userId.length === 0) {
			throw new KoraError(
				'refreshScopes needs the user id whose grant changed.',
				'INVALID_REFRESH_SCOPES_USER',
				{ fix: 'Pass the userId your auth provider returns for that user.' },
			)
		}
		let terminated = 0
		for (const session of [...this.sessions.values()]) {
			const outcome = await session.refreshScopes(userId)
			if (outcome === 'terminated') terminated++
			if (outcome === 'error') {
				this.logger.log({
					timestamp: Date.now(),
					level: 'warn',
					event: 'session.revalidation_failed',
					sessionId: session.getSessionId(),
					details: { reason: 'refreshScopes', userId },
				})
			}
		}
		this.logger.log({
			timestamp: Date.now(),
			level: 'info',
			event: 'sessions.scopes_refreshed',
			count: terminated,
			details: { userId },
		})
		return terminated
	}

	/** Run {@link revalidateSessions} from the delivery poll tick once the interval elapsed. */
	private maybeRevalidateSessions(now = Date.now()): void {
		if (this.sessionRevalidationIntervalMs <= 0) return
		if (this.auth === null || this.auth instanceof NoAuthProvider) return
		if (now - this.lastSessionRevalidationAtMs < this.sessionRevalidationIntervalMs) return
		void this.revalidateSessions()
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
		this.expireIdleRateLimiters()
	}

	/**
	 * The ingest rate limiter of a device node, created on first use and shared by
	 * every session of that node, so reconnecting does not buy a fresh budget (SRV-6).
	 */
	private rateLimiterFor(nodeId: string, principal: string | null): IngestRateLimiter {
		const node = trackedLimiter(
			this.rateLimiters,
			nodeId,
			this.maxOpsPerMinute ?? DEFAULT_MAX_OPS_PER_MINUTE,
		)
		if (principal === null || this.maxOpsPerMinutePerUser === 0) return node
		const user = trackedLimiter(this.userRateLimiters, principal, this.maxOpsPerMinutePerUser)
		return new CombinedRateLimiter(node, user)
	}

	/**
	 * Forget rate limiters of nodes with no live session whose window has long
	 * passed: their budget would be full again anyway.
	 */
	private expireIdleRateLimiters(now = Date.now()): void {
		if (this.rateLimiters.size === 0) return
		const live = new Set<string>()
		for (const session of this.sessions.values()) {
			const nodeId = session.getClientNodeId()
			if (nodeId !== null) live.add(nodeId)
		}
		const cutoff = now - 2 * RATE_LIMIT_WINDOW_MS
		for (const [nodeId, entry] of this.rateLimiters) {
			if (entry.lastUsedAtMs <= cutoff && !live.has(nodeId)) this.rateLimiters.delete(nodeId)
		}
		// A user budget is touched at every handshake of its nodes; one idle past two
		// windows would be full again anyway. A live session keeps its own reference.
		for (const [principal, entry] of this.userRateLimiters) {
			if (entry.lastUsedAtMs <= cutoff) this.userRateLimiters.delete(principal)
		}
	}

	/** Close HTTP long-poll sessions that sent no request within the idle timeout. */
	private expireIdleHttpSessions(now = Date.now()): void {
		if (this.httpSessionIdleTimeoutMs <= 0 || this.httpSessions.size === 0) return
		const cutoff = now - this.httpSessionIdleTimeoutMs
		for (const entry of [...this.httpSessions.values()]) {
			if (entry.lastSeenAtMs <= cutoff) {
				entry.transport.close(4008, 'http session idle')
				// A closed session left only for its final messages is dropped too.
				this.httpSessions.delete(entry.id)
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
		this.maybeRevalidateSessions()
		try {
			const maxDeliverySequence = await this.store.getMaxDeliverySequence()
			if (maxDeliverySequence > this.lastObservedDeliverySequence) {
				const previous = this.lastObservedDeliverySequence
				this.lastObservedDeliverySequence = maxDeliverySequence
				// Records may have changed through another instance: drop the blob access
				// sets of the collections written since the last poll (RT-17).
				await this.invalidateBlobAccessSince(previous, maxDeliverySequence)
			}
			// Each session sends what is above its send cursor (operations committed
			// through another instance), and re-sends an unacknowledged delivery only once
			// it made no progress for the poll interval, backed off while it stays stuck
			// (SRV-3, LMS #12: a stuck or ghost client is not re-sent its backlog forever).
			for (const session of this.sessions.values()) {
				session.pushDeliveryStreamIfSupported(this.deliveryPollIntervalMs, {
					trackStall: true,
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
	 * Invalidate cached blob access sets for the collections written between two
	 * delivery frontiers. Falls back to dropping every set when the gap is large.
	 */
	private async invalidateBlobAccessSince(from: number, to: number): Promise<void> {
		const MAX_SCANNED = 1000
		if (to - from > MAX_SCANNED) {
			this.blobAccess.invalidate()
			return
		}
		try {
			const delivered = await this.store.getOperationsAfterDelivery(from, MAX_SCANNED)
			this.blobAccess.invalidate(collectionsOf(delivered.map((d) => d.operation)))
		} catch {
			this.blobAccess.invalidate()
		}
	}

	/**
	 * The blob reference authority shared by every session and route (RT-11).
	 * @internal Used by the route context; not part of the public API.
	 */
	getBlobAccessIndex(): BlobAccessIndex {
		return this.blobAccess
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

		sessionEmitter.on('sync:unverified-legacy-operation', () => {
			this.metrics.recordUnverifiedLegacyOperation()
		})

		sessionEmitter.on('sync:forged-duplicate', () => {
			this.metrics.recordForgedDuplicate()
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
		await this.storeTransformsReady

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
				perMessageDeflate: this.perMessageDeflate,
			})
		} else {
			// Dynamic import of ws — only needed in standalone mode
			const { WebSocketServer } = await import('ws')
			this.wsServer = new WebSocketServer({
				port: this.port,
				host: this.host,
				path: this.path,
				maxPayload: this.maxMessageBytes,
				perMessageDeflate: this.perMessageDeflate,
			})
		}

		this.wsServer.on('connection', (ws: unknown) => {
			try {
				this.handleWebSocket(ws as WsWebSocket)
			} catch {
				// Refused (for example the connection limit): handleConnection already
				// told the client and closed the socket.
			}
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
		if (this.sessionRevalidationTimer) {
			clearInterval(this.sessionRevalidationTimer)
			this.sessionRevalidationTimer = null
		}
		this.orphanedRelaysByNode.clear()
		this.rateLimiters.clear()
		this.userRateLimiters.clear()
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
		if (!entry.transport.isConnected() && !entry.transport.hasPending()) {
			this.httpSessions.delete(entry.id)
		}
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
	 * Handle an accepted WebSocket (attach mode with `ws`): wraps it in a
	 * {@link WsServerTransport} configured like the standalone server's (serializer,
	 * ping/pong liveness probing, send-buffer ceiling) and starts a session.
	 *
	 * @param ws - A `ws` WebSocket from `WebSocketServer.handleUpgrade` or `connection`
	 * @returns The session ID
	 */
	handleWebSocket(ws: WsWebSocket): string {
		return this.handleConnection(
			new WsServerTransport(ws, {
				serializer: this.serializer,
				heartbeatIntervalMs: this.heartbeatIntervalMs,
				maxBufferedBytes: this.maxBufferedBytes,
			}),
		)
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

		sessionEmitter.on('sync:unverified-legacy-operation', () => {
			this.metrics.recordUnverifiedLegacyOperation()
		})

		sessionEmitter.on('sync:forged-duplicate', () => {
			this.metrics.recordForgedDuplicate()
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
			onAwarenessUpdate: (sourceSessionId, message, cursorTarget) => {
				this.handleAwarenessRelay(sourceSessionId, message, cursorTarget)
			},
			onYjsDocUpdate: (sourceSessionId, message, storedRecord) => {
				this.handleYjsDocRelay(sourceSessionId, message, storedRecord)
			},
			onBlobChunkRequest: (sourceSessionId, message) => {
				void this.blobChunkRelay.handleRequest(sourceSessionId, message)
			},
			onBlobChunkResponse: (sourceSessionId, message) => {
				void this.blobChunkRelay.handleResponse(sourceSessionId, message)
			},
			...(this.persistBlobChunk ? { persistBlobChunk: this.persistBlobChunk } : {}),
			...(this.blobLimits.maxChunkBytes !== undefined
				? { maxBlobChunkBytes: this.blobLimits.maxChunkBytes }
				: {}),
			...(this.blobLimits.maxBytesPerSession !== undefined
				? { maxBlobBytesPerSession: this.blobLimits.maxBytesPerSession }
				: {}),
			encryptionKeys: this.encryptionKeys,
			onEncryptionKeyWritten: (sourceSessionId, owner, keyring, record) => {
				// Every other live device of the same owner learns the new record at once
				// (rotation, passphrase change), before the operations sealed under it.
				for (const [sid, other] of this.sessions) {
					if (sid === sourceSessionId) continue
					if (other.getEncryptionKeyOwner() === owner) {
						other.pushEncryptionKeyRecord(keyring, record)
					}
				}
			},
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
			...(this.blobLimits.maxRequestsPerMinute !== undefined
				? { maxBlobRequestsPerMinute: this.blobLimits.maxRequestsPerMinute }
				: {}),
			...(this.maxOpsPerBatch !== undefined ? { maxOpsPerBatch: this.maxOpsPerBatch } : {}),
			...(this.maxScopePredicateValues !== undefined
				? { maxScopePredicateValues: this.maxScopePredicateValues }
				: {}),
			...(this.validateOperation
				? { validateOperation: this.validateOperation, koraContext: this.koraContext }
				: {}),
			blobAccess: this.blobAccess,
			...(this.allowLegacyAnonymousClaims !== undefined
				? { allowLegacyAnonymousClaims: this.allowLegacyAnonymousClaims }
				: {}),
			...(this.anonymousClaimTtlMs !== undefined
				? { anonymousClaimTtlMs: this.anonymousClaimTtlMs }
				: {}),
			isNodeLive: (nodeId, exceptSessionId) => this.isNodeLive(nodeId, exceptSessionId),
			rateLimiterFor: (nodeId, principal) => this.rateLimiterFor(nodeId, principal),
			appHeartbeatIntervalMs: this.appHeartbeatIntervalMs,
			authoritativeNodeIds: this.authoritativeNodeIds,
			...(this.encryptionPolicy ? { encryption: this.encryptionPolicy } : {}),
			...(this.handshakeTimeoutMs !== undefined
				? { handshakeTimeoutMs: this.handshakeTimeoutMs }
				: {}),
			...(this.deliveryHighWaterBytes !== undefined
				? { deliveryHighWaterBytes: this.deliveryHighWaterBytes }
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
			this.blobAccess.invalidate(collectionsOf(result.appliedOperations))
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
		this.blobAccess.invalidate(collectionsOf(operations))
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

	/**
	 * Node ids whose operations win `merge('server-authoritative')` fields in the fold
	 * (W7): the store's own node id, which authors every server-originated operation
	 * (side effects, constraint corrections, route writes), plus any extras the store
	 * was configured with (`authoritativeNodeIds` store option). This is the one source
	 * of truth: every session advertises exactly this list in the handshake, so clients
	 * fold with the same authority as the server's stores.
	 */
	get authoritativeNodeIds(): string[] {
		return this.store.getAuthoritativeNodeIds?.() ?? [this.store.getNodeId()]
	}

	// --- Private ---

	/**
	 * Blob access policy (RT-1): true when the session is streaming and a live record
	 * inside its download scope references the hash. Gates the central store.
	 */
	private async sessionReferencesBlob(sessionId: string, hash: string): Promise<boolean> {
		const session = this.sessions.get(sessionId)
		if (!session || !session.isStreaming()) return false
		return this.blobAccess.isReferenced(session.getDownlinkScopes(), hash)
	}

	/** True when a session other than `exceptSessionId` is connected as `nodeId`. */
	private isNodeLive(nodeId: string, exceptSessionId: string): boolean {
		for (const [sessionId, session] of this.sessions) {
			if (sessionId === exceptSessionId) continue
			if (session.getState() !== 'closed' && session.getClientNodeId() === nodeId) return true
		}
		return false
	}

	/**
	 * Central-store read policy (RT-1, RT-25): the session owns the hash (it pushed
	 * the bytes) or a live record inside its download scope references it.
	 */
	private async sessionMayReadStoredBlob(sessionId: string, hash: string): Promise<boolean> {
		const session = this.sessions.get(sessionId)
		if (!session || !session.isStreaming()) return false
		if (await this.blobAccess.isOwnedBy(hash, session.getBlobOwnerKey())) return true
		return this.blobAccess.isReferenced(session.getDownlinkScopes(), hash)
	}

	/**
	 * Blob access policy (RT-1): a request may be forwarded to a peer that shares the
	 * requester's exact download scope (the same tenant view, as for presence), which
	 * keeps manifests handed over out of band working; across scopes, only when both
	 * scopes reference the hash, so neither the hash nor the bytes cross a tenant.
	 */
	private async mayForwardBlobRequest(
		requesterId: string,
		targetId: string,
		hash: string,
	): Promise<boolean> {
		const requester = this.sessions.get(requesterId)
		const target = this.sessions.get(targetId)
		if (!requester?.isStreaming() || !target?.isStreaming()) return false
		// Same tenant view (anonymous devices are each their own partition, RT-11).
		if (requester.getBlobPartitionKey() === target.getBlobPartitionKey()) return true
		return (
			(await this.sessionReferencesBlob(requesterId, hash)) &&
			(await this.sessionReferencesBlob(targetId, hash))
		)
	}

	private handleRelay(sourceSessionId: string, operations: Operation[]): void {
		this.blobAccess.invalidate(collectionsOf(operations))
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
			// Keep a closed HTTP session until the client polls what was queued before the
			// close (the error that explains it); the idle sweep drops it otherwise.
			if (!this.httpSessions.get(httpSessionId)?.transport.hasPending()) {
				this.httpSessions.delete(httpSessionId)
			}
		}
	}

	private handleAwarenessRelay(
		sourceSessionId: string,
		message: AwarenessUpdateMessage,
		cursorTarget: AwarenessCursorTarget | undefined,
	): void {
		// Only sessions that completed an accepted handshake take part in presence. The
		// first update binds the session's awareness clientId (later updates must use
		// it) and its presence partition.
		const session = this.sessions.get(sourceSessionId)
		if (!session || !session.isStreaming()) return

		if (!this.awarenessRelay.hasClient(sourceSessionId)) {
			this.awarenessRelay.addClient(
				sourceSessionId,
				message.clientId,
				session.getTransport(),
				session.getPresencePartitionKey(),
			)
		}
		this.awarenessRelay.handleUpdate(
			sourceSessionId,
			message,
			this.awarenessAudience(session, cursorTarget),
		)
	}

	/**
	 * Who may see a presence state (F16). A state whose cursor names a record reaches
	 * exactly the sessions whose download scope contains that record, the rule of the
	 * Yjs doc channel, and only when the sender may read the record too: collaborators
	 * with different grants see each other on the documents they share, and nobody
	 * sees presence on a record outside their grant. A malformed cursor reaches
	 * nobody. A state without a cursor names no record: it reaches only sessions of
	 * the same presence partition (identical download scope; anonymous sessions are
	 * each their own partition).
	 */
	private awarenessAudience(
		source: ClientSession,
		cursorTarget: AwarenessCursorTarget | undefined,
	): AwarenessAudience {
		if (cursorTarget === undefined) {
			const partition = source.getPresencePartitionKey()
			return (targetSessionId) => {
				const target = this.sessions.get(targetSessionId)
				return target?.isStreaming() === true && target.getPresencePartitionKey() === partition
			}
		}
		if (cursorTarget.invalid === true) return () => false
		const { collection, recordId, stored } = cursorTarget
		if (!source.canReceiveRecord(collection, recordId, stored)) return () => false
		return (targetSessionId) =>
			this.sessions.get(targetSessionId)?.canReceiveRecord(collection, recordId, stored) ?? false
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
		const transport = new HttpServerTransport(this.serializer, {
			maxQueuedBytes: this.maxBufferedBytes,
		})
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

/** The distinct collections a set of operations writes. */
function collectionsOf(operations: Operation[]): Set<string> {
	return new Set(operations.map((op) => op.collection))
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
