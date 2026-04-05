// kora — meta-package re-exporting core, store, merge, sync
// This is the primary entry point for `import { createApp, defineSchema, t } from 'korajs'`

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

// === @korajs/core re-exports ===
export { defineSchema, t } from '@korajs/core'
export { HybridLogicalClock } from '@korajs/core'
export { generateUUIDv7 } from '@korajs/core'
export { createOperation } from '@korajs/core'
export { KoraError } from '@korajs/core'
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
} from '@korajs/core'

// === @korajs/store re-exports ===
export { Store } from '@korajs/store'
export type {
	CollectionAccessor,
	CollectionRecord,
	StorageAdapter,
	StoreConfig,
} from '@korajs/store'

// === @korajs/merge re-exports ===
export { MergeEngine } from '@korajs/merge'
export type { MergeInput, MergeResult } from '@korajs/merge'

// === @korajs/sync re-exports ===
export { SyncEngine, WebSocketTransport } from '@korajs/sync'
export type {
	SyncConfig,
	SyncState,
	SyncStatus,
	SyncStatusInfo,
	SyncStore,
} from '@korajs/sync'
