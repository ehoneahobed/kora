// @korajs/store — public API
// Every export here is a public API commitment. Be explicit.

// === Types ===
export type {
	ApplyRemoteOptions,
	ApplyResult,
	LocalMutationHandler,
	MaterializedRowSnapshot,
	RowVersionState,
	CollectionRecord,
	ReplaySnapshot,
	MigrationPlan,
	OrderByClause,
	OrderByDirection,
	QueryDescriptor,
	StoreConfig,
	StoreIsolation,
	StorageFallbackReason,
	StorageOpenState,
	StorageAdapter,
	SubscriptionCallback,
	Transaction,
	WhereClause,
	WhereOperators,
} from './types'

// === Errors ===
export {
	AdapterError,
	BridgeTerminatedError,
	LeaderUnresponsiveError,
	NoLeaderError,
	NodeOwnedByAnotherUserError,
	OptimisticLockError,
	PersistenceError,
	QueryError,
	RecordNotFoundError,
	StampedFieldError,
	RequestAbortedError,
	SchemaVersionAheadError,
	StorageBackendMismatchError,
	StorageDurabilityError,
	StorageInUseError,
	StoreNotOpenError,
	UnsyncedDataError,
	WorkerInitError,
	WorkerTimeoutError,
} from './errors'

// === Operation log compaction ===
export type { CompactionResult, CompactionStrategy } from './compaction/types'
export { COMPACTION_BASELINE_META_KEY } from './compaction/types'
export {
	compactOperationLog,
	computeAckCompactionWatermark,
} from './compaction/compact-operation-log'

// === W7 record fold (client materialization) ===
export { mergeYjsUpdates } from './fold/record-folder'
export type { RematerializationMode } from './fold/rematerialize'

// === Clock rebase (timestamp rebase of unsynced operations) ===
export type { ClockRebaseResult } from './sync/rebase-unsynced-operations'
export type { NodeRotationResult } from './sync/rotate-node-id'
export type { ResequenceResult } from './sync/rehash-operation'
export type { UnappliedOperation } from './sync/sync-durability'
export type {
	AdoptionSchedule,
	LocalNodeRecord,
	ParkedAdoption,
	TerminalRejection,
} from './sync/local-sync-records'
export type { PrincipalBinding } from './store/store'

// === Sync state helpers ===
export {
	collectOperationsAheadOfServer,
	deserializeVersionVectorFromMeta,
	LAST_ACKED_SERVER_VECTOR_META_KEY,
	mergeVersionVectors,
	serializeVersionVectorToMeta,
} from './sync/sync-state'

// === Store ===
export { Store } from './store/store'
export type { CollectionAccessor } from './store/store'

// === Query ===
export { QueryBuilder } from './query/query-builder'
export { normalizeWhere, queryKey } from './query/query-key'
export { VIRTUAL_TIMESTAMP_FIELDS, VIRTUAL_TIMESTAMP_FIELD_NAMES } from './query/sql-builder'
export type { VirtualTimestampField } from './query/sql-builder'
export type { QueryErrorPhase, QuerySubscriptionError, SubscribeOptions } from './types'

// === Durable storage (navigator.storage.persist), never on the startup path ===
export { StoragePersistence } from './persistence/storage-persistence'
export type {
	PersistenceRequestReason,
	PersistenceStorageManager,
	StoragePersistenceOptions,
	StoragePersistenceState,
	StoragePersistenceStatus,
} from './persistence/storage-persistence'
export { QueryStore } from './reactivity/query-store'
export { assertQueryReady } from './reactivity/assert-query-ready'
export {
	getSharedQueryStoreCache,
	QueryStoreCache,
} from './reactivity/query-store-cache'

// === Subscription ===
export { SubscriptionManager } from './subscription/subscription-manager'
export type {
	RecordsChange,
	RecordsChangeListener,
	RegisterOptions,
	SubscriptionManagerOptions,
	SubscriptionStats,
} from './subscription/subscription-manager'
export type { ResultsEqual } from './subscription/result-equality'
export { SubscriptionBloomFilter } from './subscription/bloom-filter'

// === Collection ===
export { Collection } from './collection/collection'

// === State Machine Validation ===
export {
	InvalidStateTransitionError,
	validateStateTransition,
	validateUpdateStateMachine,
} from './state-machine/state-validator'

// === Transaction ===
export { TransactionContext } from './transaction/transaction-context'
export type {
	TransactionCollectionAccessor,
	TransactionContextConfig,
} from './transaction/transaction-context'

// === Sequences ===
export { SequenceManager } from './sequences/sequence-manager'

// === Richtext controller (framework bindings) ===
export { createRichTextController } from './richtext/create-richtext-controller'
export { asRichTextSyncEngine } from './richtext/as-rich-text-sync-engine'
export type {
	CreateRichTextControllerOptions,
	RichTextAwarenessUser,
	RichTextController,
	RichTextControllerSnapshot,
	RichTextCursorInfo,
	RichTextSyncEngine,
} from './richtext/types'

// === Richtext Serialization ===
export {
	decodeRichtext,
	encodeRichtext,
	richtextToPlainText,
	richtextStatesEqual,
} from './serialization/richtext-serializer'

// === Query Utilities ===
export { pluralize, singularize } from './query/pluralize'

// === Backup/Restore ===
export {
	BACKUP_VERSION,
	BackupFormatError,
	convertBackupV1,
	exportBackup,
	readBackupManifest,
	restoreBackup,
	verifyBackupChecksum,
} from './backup'
export type {
	ConvertBackupV1Options,
	BackupManifest,
	BackupOptions,
	BackupProgress,
	RestoreOptions,
	RestoreResult,
} from './backup'

// === Log integrity (W8 step 0) ===
export { LOG_QUARANTINE_TABLE } from './log-integrity/log-integrity'
export type {
	LogIntegrityReport,
	LogIntegrityRow,
	LogRowProblem,
	LogSequenceGap,
} from './log-integrity/log-integrity'

// === Audit export ===
export {
	decodeAuditExport,
	persistedAuditTraceFromEvent,
	readAuditExportManifest,
	verifyAuditExportChecksum,
} from './audit'
export type {
	AuditExportManifest,
	AuditExportOptions,
	AuditExportPayload,
	AuditExportProgress,
	AuditTraceQuery,
	PersistedAuditTrace,
} from './audit'

// === Content-addressed blob store ===
export {
	BlobIntegrityError,
	MemoryBlobStore,
	type ContentAddressedBlobStore,
} from './blob/content-addressed-blob-store'
export {
	OpfsBlobStore,
	createOpfsBlobDirectory,
	createOpfsBlobStore,
	type OpfsBlobDirectory,
} from './blob/opfs-blob-store'
export {
	DEFAULT_CHUNK_SIZE,
	chunkBlob,
	reassembleBlob,
	type BlobManifest,
	type BlobManifestMetadata,
} from './blob/blob-chunking'
export {
	prepareBlobForSend,
	receiveBlob,
	type ChunkProvider,
	type ReceiveBlobResult,
	type ReceiveBlobStores,
} from './blob/blob-transfer'
export {
	fetchBlobManifest,
	parseBlobManifest,
	putBlobForTransfer,
	resolveBlobManifest,
	serializeBlobManifest,
} from './blob/blob-manifest-transfer'
export {
	createMemoryServerBlobStore,
	toServerBlobCallbacks,
	type ServerBlobCallbacks,
} from './blob/server-blob-callbacks'
export {
	collectBlobGarbage,
	extractBlobRefs,
	type BlobGcOptions,
	type BlobGcResult,
} from './blob/blob-gc'
export {
	createChunkPortPair,
	createRemoteChunkProvider,
	serveBlobChunks,
	type ChunkMessage,
	type ChunkMessagePort,
	type ChunkRequestMessage,
	type ChunkResponseMessage,
	type RemoteChunkProvider,
	type RemoteChunkProviderOptions,
} from './blob/blob-chunk-transport'
