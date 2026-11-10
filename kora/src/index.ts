// kora — meta-package re-exporting core, store, merge, sync
// This is the primary entry point for `import { createApp, defineSchema, t } from 'korajs'`

// === createApp factory ===
export { createApp } from './create-app'
export { RESERVED_APP_PROPERTIES } from './reserved-app-properties'
export type { ReservedAppProperty } from './reserved-app-properties'
export { ServerRenderingAppError } from './ssr'

// === Auth binding that loads after the first paint ===
export { lazyAuthSync } from './lazy-auth-sync'

// === Form drafts (keep typed input across a reload into a new build; opt-in) ===
export { clearFormDrafts } from '@korajs/core/bindings'
export type { FormDraftOptions } from '@korajs/core/bindings'

// === Version gate (one build of the app writes the local database at a time) ===
export {
	BuildSupersededError,
	StorageFormatAheadError,
	TabCoordinationUnavailableError,
	WriteNotDurableError,
} from '@korajs/store'
export type { InstantUpdatesOptions, WriteDurabilityState, WriteOptions } from '@korajs/store'

// === App types ===
export type {
	AdapterType,
	AuthSyncBinding,
	BlobApi,
	BuildSupersededNotice,
	BlobOptions,
	KoraApp,
	KoraConfig,
	LocalDatabaseInfo,
	OfflineApi,
	OfflineAuthDeclaration,
	OfflineOptions,
	StorageApi,
	StorageEviction,
	StorageWritesApi,
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
	StampedFieldError,
	decodeAuditExport,
	readAuditExportManifest,
	verifyAuditExportChecksum,
} from '@korajs/store'

// === @korajs/core re-exports ===
export { migrate } from '@korajs/core'
export { defineSchema, t } from '@korajs/core/lite'
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
export { AppNotReadyError, KoraError } from '@korajs/core/lite'
export { OfflineKeepError, OFFLINE_PIN_LIMIT } from '@korajs/core'
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
	OfflineAuthStatus,
	OfflineDataStatus,
	OfflineFileFailureReason,
	OfflineFilesStatus,
	OfflineKeepFilesProgress,
	OfflineKeepHandle,
	OfflineKeepOptions,
	OfflineKeepQuery,
	OfflineKeepStatus,
	OfflinePinInfo,
	OfflineReason,
	OfflineShellStatus,
	OfflineStatus,
	OfflineStorageStatus,
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
	BlobTransferError,
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
	BlobChunkFailureReason,
	BlobTransferErrorCode,
	RemoteChunkProvider,
	RemoteChunkProviderOptions,
	OpfsBlobDirectory,
	ReceiveBlobResult,
	ReceiveBlobStores,
} from '@korajs/store'
export { createBlobRef, hashBlob, isBlobRef } from '@korajs/core'
export type { BlobRef, BlobRefMetadata } from '@korajs/core'
export { createSyncEngineChunkPort } from './blob/sync-chunk-port'

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

// In development the access compiler loads with this entry, so a schema defined with
// `defineSchema` from 'korajs' validates its access rules right there. Production builds drop
// this line (and the compiler with it) from the first-paint bundle; the runtime loads it
// after the first paint and a bad rule then rejects `app.ready` (see `attachAccess`).
import { registerAccessCompiler } from '@korajs/core'
import { registerConfigValidator } from './register-config-validator'
if (process.env.NODE_ENV !== 'production') {
	registerAccessCompiler()
	// `createApp` then throws an invalid option at the call; production reports it on `ready`.
	registerConfigValidator()
}
