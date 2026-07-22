// @korajs/server — public API
// Every export here is a public API commitment. Be explicit.

// === Types ===
export type {
	AuthContext,
	AuthProvider,
	HttpSyncRequest,
	HttpSyncResponse,
	KoraSyncServerConfig,
	ServerStatus,
} from './types'

export type { ServerStore, MaterializedRecord, CollectionQueryOptions } from './store/server-store'

export type {
	ServerCloseHandler,
	ServerErrorHandler,
	ServerMessageHandler,
	ServerTransport,
} from './transport/server-transport'

export type { HttpPollResponse } from './transport/http-server-transport'

export type {
	WsWebSocket,
	WsServerTransportOptions,
} from './transport/ws-server-transport'

export type {
	AwarenessRelayCallback,
	ClientSessionOptions,
	RelayCallback,
	SessionState,
} from './session/client-session'

// === Diagnostics ===
export type {
	ClientMetrics,
	ServerMetricsCollector,
	ServerMetricsSnapshot,
} from './diagnostics/server-metrics-collector'

// === Logging ===
export type { LogEntry, LogLevel, Logger } from './logging/structured-logger'
export {
	createDefaultLogger,
	createJsonLogger,
	createPrettyLogger,
	createSilentLogger,
} from './logging/structured-logger'

export type {
	WsServerConstructor,
	WsServerLike,
} from './server/kora-sync-server'

export type {
	ProductionServerConfig,
	ProductionHttpRoute,
	ProductionHttpRouteRequest,
	ProductionHttpRouteResponse,
	ProductionServer,
} from './server/production-server'

export type {
	ProductionHttpRouteContext,
	RouteMutation,
	RouteScopeOptions,
	RouteApplyResult,
} from './server/route-context'

export type { TokenAuthProviderOptions } from './auth/token-auth'
export type { KoraAuthProviderOptions } from './auth/kora-auth-provider'
export type { MixedAuthProviderOptions } from './auth/mixed-auth-provider'

// === Classes ===
export { MemoryServerStore } from './store/memory-server-store'
export { PostgresServerStore } from './store/postgres-server-store'
export { SqliteServerStore } from './store/sqlite-server-store'
export { HttpServerTransport } from './transport/http-server-transport'
export { WsServerTransport } from './transport/ws-server-transport'
export { ClientSession } from './session/client-session'
export { KoraSyncServer } from './server/kora-sync-server'
export { NoAuthProvider } from './auth/no-auth'
export { TokenAuthProvider } from './auth/token-auth'
export { KoraAuthProvider } from './auth/kora-auth-provider'
export { MixedAuthProvider } from './auth/mixed-auth-provider'

// === Awareness ===
export { AwarenessRelay } from './awareness/awareness-relay'

// === Factory Functions ===
export { createKoraServer } from './server/create-server'
export { createProductionServer } from './server/production-server'
export { createPostgresServerStore } from './store/postgres-server-store'
export { createSqliteServerStore } from './store/sqlite-server-store'
