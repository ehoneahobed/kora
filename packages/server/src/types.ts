import type { KoraEventEmitter, OperationTransform } from '@korajs/core'
import type { MessageSerializer } from '@korajs/sync'
import type { OperationValidator } from './apply/operation-validator'
import type { ServerMetricsCollector } from './diagnostics/server-metrics-collector'
import type { Logger } from './logging/structured-logger'
import type { ServerStore } from './store/server-store'

/**
 * Authenticated client context. Returned by an AuthProvider after validation.
 */
export interface AuthContext {
	/** Unique user identifier */
	userId: string
	/** Per-collection sync scopes (optional) */
	scopes?: Record<string, Record<string, unknown>>
	/** Server-authoritative records this session may receive. Overrides `scopes`. */
	downlinkScopes?: Record<string, Record<string, unknown>>
	/** Server-authoritative records this session may upload. Overrides `scopes`. */
	uplinkScopes?: Record<string, Record<string, unknown>>
	/** Arbitrary metadata about the authenticated user */
	metadata?: Record<string, unknown>
	/**
	 * True for an unauthenticated (anonymous) principal, such as the fallback of
	 * `MixedAuthProvider`. Its `userId` is not stable across connections, so node-id
	 * claims are keyed by the shared anonymous owner instead: an anonymous device can
	 * reconnect with its node id, but can never take a signed-in user's node id.
	 */
	anonymous?: boolean
	/**
	 * When the credential that authenticated this session expires (ms since
	 * epoch). A session must not outlive its credential: the sync server can
	 * close it with a retriable AUTH_EXPIRED so the client refreshes (AUTH-11).
	 */
	expiresAt?: number
}

/**
 * Interface for authenticating incoming client connections.
 * Implementations validate tokens and return an AuthContext on success.
 */
export interface AuthProvider {
	/**
	 * Validate an authentication token.
	 * @param token - The token to validate
	 * @returns AuthContext if valid, null if rejected
	 */
	authenticate(token: string): Promise<AuthContext | null>
	/**
	 * Optional revocation feed. When present, `KoraSyncServer` subscribes on
	 * construction and calls {@link KoraSyncServer.terminateSessions} for every
	 * event, so a revoked device or user loses its live sync sessions immediately
	 * (AUTH-11). The built-in `createKoraAuthServer().auth` provides it.
	 *
	 * @returns An unsubscribe function
	 */
	onRevoke?(listener: (event: SessionRevocation) => void | Promise<void>): () => void
}

/**
 * Which live sync sessions a credential revocation ends. `userId` alone ends
 * every session of that user; with `deviceId` only that device's sessions
 * (matched against `AuthContext.metadata.deviceId`).
 */
export interface SessionRevocation {
	userId?: string
	deviceId?: string
}

/** Options for {@link KoraSyncServer.terminateSessions}. */
export interface TerminateSessionsFilter extends SessionRevocation {
	/**
	 * Error code sent to the client before the session closes. Both are retriable:
	 * the client refreshes its credentials and re-handshakes, and the server then
	 * decides again. Defaults to `'AUTH_REVOKED'`.
	 */
	code?: 'AUTH_REVOKED' | 'AUTH_EXPIRED'
}

/**
 * Configuration for creating a KoraSyncServer.
 */
export interface KoraSyncServerConfig {
	/** Server-side operation store */
	store: ServerStore
	/** WebSocket server port (standalone mode) */
	port?: number
	/** Host to bind to (standalone mode). Defaults to '0.0.0.0'. */
	host?: string
	/** Authentication provider. If omitted, all connections are accepted. */
	auth?: AuthProvider
	/** Message serializer. Defaults to JsonMessageSerializer. */
	serializer?: MessageSerializer
	/** Event emitter for DevTools integration */
	emitter?: KoraEventEmitter
	/**
	 * Maximum concurrent client connections (sessions, including ones still
	 * handshaking). A connection over the limit gets a retriable `MAX_CONNECTIONS` error
	 * and is closed. 0 = unlimited. Defaults to 10,000.
	 */
	maxConnections?: number
	/**
	 * Interval between WebSocket pings, in ms (SRV-6, LMS #12). A connection that
	 * leaves two pings in a row unanswered is terminated, which ends its session.
	 * Applies to the standalone server and `createProductionServer`. Defaults to 25
	 * seconds; 0 disables probing.
	 */
	heartbeatIntervalMs?: number
	/**
	 * Interval of the application-level `heartbeat` message sent to clients that
	 * advertise support for it (browsers cannot see WebSocket pings), in ms. A client
	 * that hears nothing for about 2.5 intervals reconnects. Defaults to 25 seconds; 0
	 * disables it.
	 */
	appHeartbeatIntervalMs?: number
	/**
	 * Time a new connection has to send its handshake, in ms. Defaults to 10 seconds;
	 * 0 disables the deadline.
	 */
	handshakeTimeoutMs?: number
	/**
	 * Bytes that may wait unsent for one client (WebSocket send buffer, or the queue of
	 * an HTTP long-poll client that stopped polling) before it is disconnected as a slow
	 * consumer. Defaults to 32 MiB; 0 disables the ceiling. The delivery stream pauses
	 * well before this (`deliveryHighWaterBytes`).
	 */
	maxBufferedBytes?: number
	/**
	 * Queued outbound bytes above which a client's delivery stream pauses until the
	 * client drains them (backpressure). Defaults to 1 MiB.
	 */
	deliveryHighWaterBytes?: number
	/**
	 * WebSocket permessage-deflate compression. `true` (the default) compresses messages
	 * of 1 KiB or more without keeping a compression context between messages, which
	 * cuts sync payloads several-fold on 2G/3G links at a bounded memory cost per
	 * connection. `false` disables it; an object is passed to `ws` as is.
	 */
	perMessageDeflate?: boolean | Record<string, unknown>
	/** Maximum operations per sync batch. Defaults to 100. */
	batchSize?: number
	/**
	 * How often to retransmit unacknowledged non-watermark relay batches, in
	 * milliseconds. Defaults to 2000. Set to 0 to disable periodic retransmit.
	 */
	relayRetransmitIntervalMs?: number
	/**
	 * How often the server checks the authoritative delivery log for writes that did
	 * not pass through this KoraSyncServer instance, in milliseconds. Defaults to
	 * 2000. Set to 0 to disable polling.
	 */
	deliveryPollIntervalMs?: number
	/**
	 * Schema version the server expects. Defaults to `store.getSchema()?.version`
	 * when the store has been configured with a schema, otherwise `1`.
	 */
	schemaVersion?: number
	/**
	 * Inclusive range of client schema versions accepted at handshake.
	 * Defaults to `{ min: schemaVersion, max: schemaVersion }`.
	 */
	supportedSchemaVersions?: { min: number; max: number }
	/**
	 * Transform accepted legacy client operations into the server schema version
	 * before validation and materialization. Required when
	 * `supportedSchemaVersions.min` is lower than `schemaVersion` and operation
	 * shapes changed across versions.
	 */
	operationTransforms?: OperationTransform[]
	/** WebSocket path (standalone mode). Defaults to '/'. */
	path?: string
	/** Structured logger. Defaults to pretty-print in dev, JSON lines in production. */
	logger?: Logger
	/** Server metrics collector. Created automatically if omitted. */
	metricsCollector?: ServerMetricsCollector
	/** Enable built-in dashboard and metrics endpoints. Defaults to true. */
	enableDashboard?: boolean
	/**
	 * Resolve a blob chunk by content hash from server-side storage. Optional.
	 * When provided, the server answers blob chunk requests directly from its own
	 * store; when absent, the server relays chunk requests among connected peers
	 * without storing any blob bytes itself.
	 */
	resolveBlobChunk?: (hash: string) => Promise<Uint8Array | null>
	/**
	 * Persist a client-uploaded blob chunk (or manifest) centrally, keyed by its
	 * content hash. Optional. When provided, the server advertises central blob
	 * storage at handshake, clients upload the bytes behind their `blob` fields,
	 * and those bytes remain available to other devices after the authoring device
	 * goes offline. Pair with `resolveBlobChunk` (both backed by the same store)
	 * so uploaded blobs can then be served. `toServerBlobCallbacks` in
	 * `@korajs/store` derives both from a `ContentAddressedBlobStore`.
	 */
	persistBlobChunk?: (hash: string, bytes: Uint8Array) => Promise<void> | void
	/**
	 * Limits on the blob side channel. `maxChunkBytes` (default 1 MiB) caps one
	 * pushed chunk or manifest, `maxBytesPerSession` (default 256 MiB) caps the total
	 * a session may push for central persistence, `maxPendingRequestsPerSession`
	 * (default 256) and `pendingRequestTtlMs` (default 60s) bound the chunk requests
	 * the relay remembers per session.
	 */
	blobLimits?: {
		maxChunkBytes?: number
		maxBytesPerSession?: number
		maxPendingRequestsPerSession?: number
		pendingRequestTtlMs?: number
		/**
		 * Blob chunk requests one session may make per minute, a budget separate from
		 * `maxOpsPerMinute` (one request per chunk, so a large blob makes many). Over
		 * it, a request is answered with a retriable `throttled` response the client
		 * backs off on (RT-24). Defaults to 6000.
		 */
		maxRequestsPerMinute?: number
	}
	/**
	 * Largest WebSocket message the standalone server (and `createProductionServer`)
	 * accepts, in bytes. Larger frames are refused by the socket layer before they are
	 * buffered. Defaults to 32 MiB (the `ws` library default is 100 MiB).
	 */
	maxMessageBytes?: number
	/**
	 * Maximum serialized byte size of a single client operation accepted at sync
	 * ingest. Operations larger than this are rejected before materialization.
	 * Defaults to 256 KiB. Set once here to enforce one payload cap across every
	 * connected client instead of configuring each session.
	 */
	maxOperationBytes?: number
	/**
	 * Maximum operations accepted per device node per minute (fixed window). The budget
	 * belongs to the node id (bound to its principal when auth is configured), not to
	 * the connection, so reconnecting does not reset it (SRV-6). Operations beyond the
	 * limit get a retriable `RATE_LIMIT` until the window resets. Defaults to 600.
	 */
	maxOpsPerMinute?: number
	/**
	 * Largest operation batch accepted from a client in one message. A larger batch is
	 * refused whole with `BATCH_TOO_LARGE` before the server decodes it or reads the
	 * store, so one message cannot buy unbounded work. Defaults to 1000 (the client
	 * sends batches of 100 by default).
	 */
	maxOpsPerBatch?: number
	/**
	 * Accept anonymous devices whose node claim predates confirmed claims (RT-21):
	 * nodes held by the pre-release shared anonymous owner, and provisional claims
	 * that expired without the device ever confirming its node token (clients without
	 * token support). Accepted with a deprecation warning and re-issued a token.
	 * Defaults to `true` for 1.0.0-beta.13; the default flips to `false` in the next
	 * release, after which such devices rotate to a fresh node id instead.
	 */
	allowLegacyAnonymousClaims?: boolean
	/**
	 * How long an anonymous device's provisional node claim may stay unconfirmed and
	 * still be re-issued to a device that presents no token (a handshake response lost
	 * in transit), in milliseconds (RT-21). Defaults to 24 hours.
	 */
	anonymousClaimTtlMs?: number
	/**
	 * How often every live session's credential is re-validated with the auth
	 * provider, in milliseconds (RT-18). A revocation persisted by another server
	 * instance ends the session here within this interval. Defaults to 30 seconds; 0
	 * disables it (sessions then end only through this process's `onRevoke` feed,
	 * `terminateSessions`, or credential expiry).
	 */
	sessionRevalidationIntervalMs?: number
	/**
	 * How long an HTTP long-poll session may go without any request before the server
	 * closes it, in milliseconds. Defaults to 2 minutes; 0 disables expiry.
	 */
	httpSessionIdleTimeoutMs?: number
	/**
	 * Adjudicate untrusted client operations before they become authoritative.
	 *
	 * Runs at sync ingestion for every incoming client operation, after HLC
	 * ordering and the built-in guards, and before materialization. Return
	 * `accept` to let it through, `reject` to refuse it (a structured rejection
	 * travels back to the submitter and the op never enters the authoritative
	 * log), or `ignore` when the server has handled it out of band. This is what
	 * lets Kora serve public / multi-tenant apps where the client is not trusted.
	 * Omit it and every operation is accepted, as before.
	 */
	validateOperation?: OperationValidator
}

/**
 * Request envelope for the server-side HTTP sync endpoint.
 *
 * Map it from your HTTP framework: `sessionId` from the `x-kora-session` header and
 * `authorization` from the `Authorization` header, on every request.
 */
export interface HttpSyncRequest {
	/** HTTP method */
	method: 'GET' | 'POST'
	/**
	 * The server-issued session id (`x-kora-session` request header). Absent only on
	 * the POST that opens a session (the handshake); the response to that POST
	 * carries the new id in its `x-kora-session` header. Never chosen by the client.
	 */
	sessionId?: string
	/**
	 * The raw `Authorization` header (`Bearer <token>`). With an auth provider
	 * configured, EVERY request is authenticated and must resolve to the same
	 * principal and device as the session it names (RT-2).
	 */
	authorization?: string
	/** Optional raw request payload for POST */
	body?: string | Uint8Array
	/** Value of the Content-Type header for POST payloads */
	contentType?: string
	/** Value of the If-None-Match header for GET polling */
	ifNoneMatch?: string
}

/**
 * Response envelope for the server-side HTTP sync endpoint.
 */
export interface HttpSyncResponse {
	/** HTTP status code */
	status: 200 | 202 | 204 | 304 | 400 | 401 | 403 | 404 | 405 | 410
	/** Optional raw response payload */
	body?: string | Uint8Array
	/** Optional response headers */
	headers?: Record<string, string>
}

/**
 * Session state machine states.
 * - connected: initial state after transport connects
 * - authenticated: auth check passed (or skipped)
 * - syncing: exchanging delta operations during handshake
 * - streaming: steady state, real-time operation relay
 * - closed: session terminated
 */
export type SessionState = 'connected' | 'authenticated' | 'syncing' | 'streaming' | 'closed'

/**
 * Runtime status of a KoraSyncServer.
 */
export interface ServerStatus {
	/** Whether the server is running */
	running: boolean
	/** Number of currently connected clients */
	connectedClients: number
	/** Port the server is listening on (null if attach mode) */
	port: number | null
	/** Total operations stored */
	totalOperations: number
	/** Server uptime in milliseconds */
	uptime: number
	/** Server package version */
	version: string
	/** Schema version the server expects */
	schemaVersion: number
	/** Array of connected node IDs */
	connectedNodeIds: string[]
	/** Peak connections since server start */
	peakConnections: number
	/** Total connections handled since server start */
	connectionsTotal: number
	/** Operations received since server start */
	operationsReceived: number
	/** Operations sent since server start */
	operationsSent: number
	/** Error count since server start */
	errorCount: number
}
