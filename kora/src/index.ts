// kora — meta-package re-exporting core, store, merge, sync
// This is the primary entry point for `import { createApp, defineSchema, t } from 'korajs'`

// === createApp factory ===
export { createApp } from './create-app'
export { RESERVED_APP_PROPERTIES } from './reserved-app-properties'
export type { ReservedAppProperty } from './reserved-app-properties'
export { ServerRenderingAppError } from './ssr'

// === App types ===
export type {
	AdapterType,
	AuthSyncBinding,
	BlobApi,
	BlobOptions,
	KoraApp,
	ExperimentalOptions,
	KoraConfig,
	LocalDatabaseInfo,
	StorageApi,
	StoreOptions,
	StoreInfo,
	EncryptionControl,
	SyncControl,
	SyncOptions,
	SequenceAccessor,
	TransactionCollectionProxy,
	TransactionProxy,
	TypedKoraApp,
	TypedKoraConfig,
} from './types'

// === Schema-typed API (collections, queries, transactions) ===
export type {
	CollectionInsertOf,
	CollectionRecordOf,
	CollectionUpdateOf,
	IncludeMap,
	Pluralize,
	RecordOf,
	Singularize,
	TypedCollectionAccessor,
	TypedCollectionOf,
	TypedCollections,
	TypedQueryBuilder,
	TypedTransactionCollection,
	TypedTransactionProxy,
	TypedWhere,
	WhereOperatorsFor,
} from './typed-api'

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
// Access rules for `access` blocks in the schema.
export {
	and,
	anyone,
	custom,
	member,
	memberOfKey,
	or,
	owner,
	serverOnly,
	where,
} from '@korajs/core'
export type {
	AccessConfigInput,
	AccessRule,
	AndRule,
	AnyoneRule,
	CustomRule,
	MemberOfKeyRule,
	MemberRule,
	OrRule,
	OwnerRule,
	ServerOnlyRule,
	WhereRule,
	CollectionAccessInput,
	FieldAccessInput,
	MembershipView,
} from '@korajs/core'
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
	FieldMap,
	HLCTimestamp,
	InferFieldInput,
	InferFieldType,
	InferInsert,
	InferInsertInput,
	InferRecord,
	InferUpdate,
	InferUpdateInput,
	RichtextInput,
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
	BACKUP_VERSION,
	BackupFormatError,
	convertBackupV1,
	exportBackup,
	readBackupManifest,
	restoreBackup,
	verifyBackupChecksum,
} from '@korajs/store'
export type {
	BackupManifest,
	BackupOptions,
	BackupProgress,
	ConvertBackupV1Options,
	CollectionAccessor,
	CollectionRecord,
	RestoreOptions,
	RestoreResult,
	StorageAdapter,
	StoreConfig,
	TransactionCollectionAccessor,
	TransactionContextConfig,
} from '@korajs/store'

// === Blob transfer (out-of-band, content-addressed) ===
export {
	MemoryBlobStore,
	OpfsBlobStore,
	createOpfsBlobDirectory,
	createOpfsBlobStore,
	BlobIntegrityError,
	chunkBlob,
	reassembleBlob,
	prepareBlobForSend,
	receiveBlob,
	createRemoteChunkProvider,
	serveBlobChunks,
	collectBlobGarbage,
	extractBlobRefs,
	DEFAULT_CHUNK_SIZE,
} from '@korajs/store'
export type {
	ContentAddressedBlobStore,
	BlobGcOptions,
	BlobGcResult,
	BlobManifest,
	ChunkProvider,
	ChunkMessage,
	ChunkMessagePort,
	OpfsBlobDirectory,
	ReceiveBlobResult,
	ReceiveBlobStores,
} from '@korajs/store'
export { createBlobRef, hashBlob, isBlobRef } from '@korajs/core'
export type { BlobRef, BlobRefMetadata } from '@korajs/core'
export { createSyncEngineChunkPort } from './blob/sync-chunk-port'

// === @korajs/merge re-exports ===
export { MergeEngine } from '@korajs/merge'
export type { MergeInput, MergeResult } from '@korajs/merge'

// === @korajs/sync re-exports ===
export { EncryptionKeyError, SyncEngine, WebSocketTransport } from '@korajs/sync'
export type {
	EncryptionLockState,
	EncryptionStatus,
	EncryptionStatusCode,
	SyncConfig,
	SyncDiagnostics,
	SyncEncryptionConfig,
	SyncState,
	SyncStatus,
	SyncStatusInfo,
	SyncStore,
} from '@korajs/sync'
