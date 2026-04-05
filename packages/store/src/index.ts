// @kora/store — public API
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

// === Collection ===
export { Collection } from './collection/collection'

// === Richtext Serialization ===
export { decodeRichtext, encodeRichtext, richtextToPlainText } from './serialization/richtext-serializer'

// === Query Utilities ===
export { pluralize, singularize } from './query/pluralize'
