// @korajs/store — public API
// Every export here is a public API commitment. Be explicit.

// === Types ===
export type {
	ApplyResult,
	CollectionRecord,
	MigrationPlan,
	OrderByClause,
	OrderByDirection,
	QueryDescriptor,
	StoreConfig,
	StorageAdapter,
	SubscriptionCallback,
	Transaction,
	WhereClause,
	WhereOperators,
} from './types'

// === Errors ===
export {
	AdapterError,
	PersistenceError,
	QueryError,
	RecordNotFoundError,
	StoreNotOpenError,
	WorkerInitError,
	WorkerTimeoutError,
} from './errors'

// === Store ===
export { Store } from './store/store'
export type { CollectionAccessor } from './store/store'

// === Query ===
export { QueryBuilder } from './query/query-builder'

// === Subscription ===
export { SubscriptionManager } from './subscription/subscription-manager'
export type {
	SubscriptionManagerOptions,
	SubscriptionStats,
} from './subscription/subscription-manager'
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

// === Richtext Serialization ===
export {
	decodeRichtext,
	encodeRichtext,
	richtextToPlainText,
} from './serialization/richtext-serializer'

// === Query Utilities ===
export { pluralize, singularize } from './query/pluralize'

// === Backup/Restore ===
export {
	exportBackup,
	readBackupManifest,
	restoreBackup,
	verifyBackupChecksum,
} from './backup'
export type {
	BackupManifest,
	BackupOptions,
	BackupProgress,
	RestoreOptions,
	RestoreResult,
} from './backup'
