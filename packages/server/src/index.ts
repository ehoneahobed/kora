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

export type { ServerStore } from './store/server-store'

export type {
	ServerCloseHandler,
	ServerErrorHandler,
	ServerMessageHandler,
	ServerTransport,
} from './transport/server-transport'

export type {
	HttpPollResponse,
} from './transport/http-server-transport'

export type {
	WsWebSocket,
	WsServerTransportOptions,
} from './transport/ws-server-transport'

export type {
	ClientSessionOptions,
	RelayCallback,
	SessionState,
} from './session/client-session'

export type {
	WsServerConstructor,
	WsServerLike,
} from './server/kora-sync-server'

export type {
	ProductionServerConfig,
	ProductionServer,
} from './server/production-server'

export type { TokenAuthProviderOptions } from './auth/token-auth'

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

// === Factory Functions ===
export { createKoraServer } from './server/create-server'
export { createProductionServer } from './server/production-server'
export { createPostgresServerStore } from './store/postgres-server-store'
export { createSqliteServerStore } from './store/sqlite-server-store'
