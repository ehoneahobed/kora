import type { KoraEventEmitter } from '@korajs/core'
import type { MessageSerializer } from '@korajs/sync'
import type { Logger } from './logging/structured-logger'
import type { ServerMetricsCollector } from './diagnostics/server-metrics-collector'
import type { ServerStore } from './store/server-store'

/**
 * Authenticated client context. Returned by an AuthProvider after validation.
 */
export interface AuthContext {
	/** Unique user identifier */
	userId: string
	/** Per-collection sync scopes (optional) */
	scopes?: Record<string, Record<string, unknown>>
	/** Arbitrary metadata about the authenticated user */
	metadata?: Record<string, unknown>
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
	/** Maximum concurrent client connections. 0 = unlimited. Defaults to 0. */
	maxConnections?: number
	/** Maximum operations per sync batch. Defaults to 100. */
	batchSize?: number
	/** Schema version the server expects. Defaults to 1. */
	schemaVersion?: number
	/** WebSocket path (standalone mode). Defaults to '/'. */
	path?: string
	/** Structured logger. Defaults to pretty-print in dev, JSON lines in production. */
	logger?: Logger
	/** Server metrics collector. Created automatically if omitted. */
	metricsCollector?: ServerMetricsCollector
	/** Enable built-in dashboard and metrics endpoints. Defaults to true. */
	enableDashboard?: boolean
}

/**
 * Request envelope for the server-side HTTP sync endpoint.
 */
export interface HttpSyncRequest {
	/** Stable client identifier for binding HTTP requests to a server session */
	clientId: string
	/** HTTP method */
	method: 'GET' | 'POST'
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
	status: 200 | 202 | 204 | 304 | 400 | 405 | 410
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
