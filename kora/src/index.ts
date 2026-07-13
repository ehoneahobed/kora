// kora — meta-package re-exporting core, store, merge, sync
// This is the primary entry point for `import { createApp, defineSchema, t } from 'korajs'`

// === createApp factory ===
export { createApp } from './create-app'

// === App types ===
export type {
	AdapterType,
	AuthSyncBinding,
	KoraApp,
	KoraConfig,
	StoreOptions,
	SyncControl,
	SyncOptions,
	SequenceAccessor,
	TransactionCollectionProxy,
	TransactionProxy,
	TypedCollectionAccessor,
	TypedKoraApp,
	TypedKoraConfig,
} from './types'

export type { ReplaySnapshot } from '@korajs/store'
export type {
	AuditExportManifest,
	AuditExportOptions,
	AuditExportPayload,
	PersistedAuditTrace,
} from '@korajs/store'
export {
	decodeAuditExport,
	readAuditExportManifest,
	verifyAuditExportChecksum,
} from '@korajs/store'

// === @korajs/core re-exports ===
export { defineSchema, migrate, t } from '@korajs/core'
export { HybridLogicalClock } from '@korajs/core'
export { generateUUIDv7 } from '@korajs/core'
export { createOperation } from '@korajs/core'
export { KoraError, AppNotReadyError } from '@korajs/core'
export { op } from '@korajs/core'
export type {
	AtomicOp,
	AtomicOpType,
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
	MigrationDefinition,
	MigrationStep,
	Operation,
	SchemaDefinition,
	SchemaInput,
	SequenceConfig,
	SyncRuleDefinition,
	TypedSchemaDefinition,
	VersionVector,
} from '@korajs/core'

// === @korajs/store re-exports ===
export { SequenceManager, Store } from '@korajs/store'
export { TransactionContext } from '@korajs/store'
export {
	exportBackup,
	readBackupManifest,
	restoreBackup,
	verifyBackupChecksum,
} from '@korajs/store'
export type {
	BackupManifest,
	BackupOptions,
	BackupProgress,
	CollectionAccessor,
	CollectionRecord,
	RestoreOptions,
	RestoreResult,
	StorageAdapter,
	StoreConfig,
	TransactionCollectionAccessor,
	TransactionContextConfig,
} from '@korajs/store'

// === @korajs/merge re-exports ===
export { MergeEngine } from '@korajs/merge'
export type { MergeInput, MergeResult } from '@korajs/merge'

// === @korajs/sync re-exports ===
export { SyncEngine, WebSocketTransport } from '@korajs/sync'
export type {
	SyncConfig,
	SyncDiagnostics,
	SyncEncryptionConfig,
	SyncState,
	SyncStatus,
	SyncStatusInfo,
	SyncStore,
} from '@korajs/sync'
