// @kora/sync — public API
// Every export here is a public API commitment. Be explicit.

// === Types ===
export type {
	QueueStorage,
	SyncConfig,
	SyncScopeContext,
	SyncState,
	SyncStatus,
	SyncStatusInfo,
} from './types'

export { SYNC_STATES, SYNC_STATUSES } from './types'

// === SyncStore Interface ===
export type { ApplyResult, SyncStore } from './engine/sync-store'

// === Protocol Messages ===
export type {
	AcknowledgmentMessage,
	ErrorMessage,
	HandshakeMessage,
	HandshakeResponseMessage,
	OperationBatchMessage,
	SerializedOperation,
	SyncMessage,
} from './protocol/messages'

export {
	isAcknowledgmentMessage,
	isErrorMessage,
	isHandshakeMessage,
	isHandshakeResponseMessage,
	isOperationBatchMessage,
	isSyncMessage,
} from './protocol/messages'

// === Serialization ===
export type { MessageSerializer } from './protocol/serializer'

export {
	JsonMessageSerializer,
	versionVectorToWire,
	wireToVersionVector,
} from './protocol/serializer'

// === Transport ===
export type {
	SyncTransport,
	TransportCloseHandler,
	TransportErrorHandler,
	TransportMessageHandler,
	TransportOptions,
} from './transport/transport'

export type {
	WebSocketConstructor,
	WebSocketLike,
	WebSocketTransportOptions,
} from './transport/websocket-transport'

export { WebSocketTransport } from './transport/websocket-transport'

export type { ChaosConfig } from './transport/chaos-transport'

export { ChaosTransport } from './transport/chaos-transport'

// === Engine ===
export type { SyncEngineOptions } from './engine/sync-engine'

export { SyncEngine } from './engine/sync-engine'

export type { OutboundBatch } from './engine/outbound-queue'

export { OutboundQueue } from './engine/outbound-queue'

export type { ConnectionMonitorConfig } from './engine/connection-monitor'

export { ConnectionMonitor } from './engine/connection-monitor'

export type { ReconnectionConfig } from './engine/reconnection-manager'

export { ReconnectionManager } from './engine/reconnection-manager'
