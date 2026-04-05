// kora — meta-package re-exporting core, store, merge, sync
// This is the primary entry point for `import { createApp, defineSchema, t } from 'kora'`

// === createApp factory ===
export { createApp } from './create-app'

// === App types ===
export type {
	AdapterType,
	KoraApp,
	KoraConfig,
	StoreOptions,
	SyncControl,
	SyncOptions,
	TypedCollectionAccessor,
	TypedKoraApp,
	TypedKoraConfig,
} from './types'

// === @kora/core re-exports ===
export { defineSchema, t } from '@kora/core'
export { HybridLogicalClock } from '@kora/core'
export { generateUUIDv7 } from '@kora/core'
export { createOperation } from '@kora/core'
export { KoraError } from '@kora/core'
export type {
	CollectionDefinition,
	ConnectionQuality,
	Constraint,
	FieldDescriptor,
	FieldKindToType,
	HLCTimestamp,
	InferFieldType,
	InferInsertInput,
	InferRecord,
	InferUpdateInput,
	KoraEvent,
	KoraEventEmitter,
	KoraEventListener,
	KoraEventType,
	MergeStrategy,
	MergeTrace,
	Operation,
	SchemaDefinition,
	SchemaInput,
	TypedSchemaDefinition,
	VersionVector,
} from '@kora/core'

// === @kora/store re-exports ===
export { Store } from '@kora/store'
export type {
	CollectionAccessor,
	CollectionRecord,
	StorageAdapter,
	StoreConfig,
} from '@kora/store'

// === @kora/merge re-exports ===
export { MergeEngine } from '@kora/merge'
export type { MergeInput, MergeResult } from '@kora/merge'

// === @kora/sync re-exports ===
export { SyncEngine, WebSocketTransport } from '@kora/sync'
export type {
	SyncConfig,
	SyncState,
	SyncStatus,
	SyncStatusInfo,
	SyncStore,
} from '@kora/sync'
