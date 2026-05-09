// @korajs/sync — public API
// Every export here is a public API commitment. Be explicit.

// === Types ===
export type {
	QueueStorage,
	SyncConfig,
	SyncEncryptionConfig,
	SyncScopeContext,
	SyncScopeMap,
	SyncState,
	SyncStatus,
	SyncStatusInfo,
} from './types'

export { InvalidScopeError, ScopeViolationError, SYNC_STATES, SYNC_STATUSES } from './types'

// === Scope Filtering ===
export { filterOperationsByScope, operationMatchesScope } from './scopes/scope-filter'

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
	WireFormat,
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
	NegotiatedMessageSerializer,
	ProtobufMessageSerializer,
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

export type { HttpLongPollingTransportOptions } from './transport/http-long-polling-transport'

export { WebSocketTransport } from './transport/websocket-transport'
export { HttpLongPollingTransport } from './transport/http-long-polling-transport'

export type { ChaosConfig } from './transport/chaos-transport'

export { ChaosTransport } from './transport/chaos-transport'

// === Engine ===
export type { SyncDiagnostics, SyncEngineOptions } from './engine/sync-engine'

export { SyncEngine } from './engine/sync-engine'

export type { OutboundBatch } from './engine/outbound-queue'

export { OutboundQueue } from './engine/outbound-queue'

export type { ConnectionMonitorConfig } from './engine/connection-monitor'

export { ConnectionMonitor } from './engine/connection-monitor'

export type { ReconnectionConfig } from './engine/reconnection-manager'

export { ReconnectionManager } from './engine/reconnection-manager'

// === Awareness ===
export type {
	AwarenessChange,
	AwarenessCursor,
	AwarenessMessage,
	AwarenessState,
	AwarenessUser,
	CursorInfo,
} from './awareness/types'

export { AwarenessManager } from './awareness/awareness-manager'

// === Awareness Protocol Messages ===
export type {
	AwarenessStateWire,
	AwarenessUpdateMessage,
} from './protocol/messages'

export { isAwarenessUpdateMessage } from './protocol/messages'

// === Encryption ===
export type {
	EncryptedPayload,
	SyncEncryptionAlgorithm,
	VersionedKey,
} from './encryption/types'

export { SyncEncryptor, EncryptionError, DecryptionError, isEncryptedPayload } from './encryption/sync-encryptor'

export { KeyDerivationError, deriveKey, deriveVersionedKey, generateSalt } from './encryption/key-derivation'
