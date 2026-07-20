import type { HLCTimestamp, KoraEventEmitter, Operation, SchemaDefinition } from '@korajs/core'

/**
 * Transaction interface for executing multiple operations atomically.
 */
export interface Transaction {
	execute(sql: string, params?: unknown[]): Promise<void>
	query<T>(sql: string, params?: unknown[]): Promise<T[]>
}

/**
 * Migration plan containing SQL statements and optional data transforms.
 */
export interface MigrationPlan {
	statements: string[]
	transforms?: Array<(row: Record<string, unknown>) => Record<string, unknown>>
}

/**
 * Storage adapter interface. All storage backends must implement this.
 * Operations are async to support both sync (better-sqlite3) and async (IndexedDB, WASM) backends.
 */
export interface StorageAdapter {
	/** Open or create the database */
	open(schema: SchemaDefinition): Promise<void>

	/** Close the database and release resources */
	close(): Promise<void>

	/** Execute a write query (INSERT, UPDATE, DELETE) within a transaction */
	execute(sql: string, params?: unknown[]): Promise<void>

	/** Execute a read query (SELECT) */
	query<T>(sql: string, params?: unknown[]): Promise<T[]>

	/** Execute multiple operations atomically */
	transaction(fn: (tx: Transaction) => Promise<void>): Promise<void>

	/** Apply a schema migration */
	migrate(from: number, to: number, migration: MigrationPlan): Promise<void>
}

/**
 * Buffered SQL + operation produced during a transaction (before commit).
 */
export interface TransactionBufferedEntry {
	operation: Operation
	commands: Array<{ sql: string; params: unknown[] }>
	collection: string
}

/**
 * Batch passed to {@link LocalMutationHandler.commitTransaction} on commit.
 */
export interface TransactionCommitBatch {
	entries: TransactionBufferedEntry[]
	transactionId: string
	mutationName?: string
}

export interface TransactionCommitResult {
	operations: Operation[]
	affectedCollections: Set<string>
}

export interface LocalMutationHandler {
	insert(collection: string, data: Record<string, unknown>): Promise<CollectionRecord>
	update(collection: string, id: string, data: Record<string, unknown>): Promise<CollectionRecord>
	delete(collection: string, id: string): Promise<void>
	/**
	 * Commit a buffered transaction through the unified apply pipeline.
	 * When omitted, the store uses the built-in SQL commit path.
	 */
	commitTransaction?(batch: TransactionCommitBatch): Promise<TransactionCommitResult>
}

export type StoreIsolation = 'shared' | 'per-tab'

export interface StoreConfig {
	schema: SchemaDefinition
	adapter: StorageAdapter
	/** Database name used for per-tab node id keys. Defaults to 'kora-db'. */
	dbName?: string
	/**
	 * `shared` (default): one node id per database in `_kora_meta`.
	 * `per-tab`: unique node id per browser tab via sessionStorage.
	 */
	isolation?: StoreIsolation
	/** Optional node ID. If omitted, one is generated or loaded from the database. */
	nodeId?: string
	/** Optional event emitter. When provided, local mutations emit 'operation:created' events. */
	emitter?: KoraEventEmitter
	/** Routes local mutations through a unified apply pipeline when provided. */
	localMutationHandler?: LocalMutationHandler
	/** Called when a reactive query subscription is registered (for sync query subsets). */
	onQuerySubscribed?: (descriptor: QueryDescriptor) => () => void
}

/**
 * Operators for where clause conditions.
 */
export interface WhereOperators {
	$eq?: unknown
	$ne?: unknown
	$gt?: number | string
	$gte?: number | string
	$lt?: number | string
	$lte?: number | string
	$in?: unknown[]
}

/**
 * Where clause: field name to value (shorthand for $eq) or WhereOperators.
 */
export type WhereClause = Record<string, unknown | WhereOperators>

/**
 * Order direction for sorting query results.
 */
export type OrderByDirection = 'asc' | 'desc'

/**
 * Order-by clause: field name and optional direction.
 */
export interface OrderByClause {
	field: string
	direction: OrderByDirection
}

/**
 * Internal representation of a query to be compiled to SQL.
 */
export interface QueryDescriptor {
	collection: string
	where: WhereClause
	orderBy: OrderByClause[]
	limit?: number
	offset?: number
	/** Relation names to include in results (for relational queries). */
	include?: string[]
	/** Resolved collection names for included relations (for subscription tracking). */
	includeCollections?: string[]
}

/**
 * Callback for reactive subscriptions. Receives the current result set.
 */
export type SubscriptionCallback<T> = (results: T[]) => void

/**
 * Serialized row in the operations log table.
 */
export interface OperationRow {
	id: string
	node_id: string
	type: string
	record_id: string
	data: string | null
	previous_data: string | null
	timestamp: string
	sequence_number: number
	causal_deps: string
	schema_version: number
}

/**
 * Record type returned from collection queries.
 * Includes the id and mapped metadata fields.
 */
export interface CollectionRecord {
	id: string
	createdAt: number
	updatedAt: number
	[key: string]: unknown
}

export type { ReplaySnapshot } from './replay/replay-to'

/**
 * Internal row shape returned from SQL queries on collection tables.
 */
export interface RawCollectionRow {
	id: string
	_created_at: number
	_updated_at: number
	_version?: string
	/** JSON map of per-field last-writer HLC versions: { field -> serialized HLC }. */
	_field_versions?: string
	_deleted: number
	[key: string]: unknown
}

/**
 * A registered subscription tracked by the SubscriptionManager.
 */
export interface Subscription<T = CollectionRecord> {
	id: string
	descriptor: QueryDescriptor
	callback: SubscriptionCallback<T>
	executeFn: () => Promise<T[]>
	lastResults: T[]
}

export type { ApplyResult } from '@korajs/core'

/**
 * Options for applying a remote operation to materialized storage.
 */
export interface ApplyRemoteOptions {
	/** When true, a winning remote update clears soft-delete on the row. */
	reactivateIfDeleted?: boolean
	/**
	 * When true, materialize the update unconditionally, bypassing the LWW
	 * version guard. Used only for authoritative three-way merge results: the
	 * merged value already incorporates the current local row, so it must be
	 * written even when its timestamp ties the current row version (which
	 * happens on the device that authored the newer of two concurrent edits —
	 * without this, that device's CRDT/merge result is silently dropped).
	 */
	forceMaterialize?: boolean
	/**
	 * Data to materialize into the row INSTEAD of `op.data`, without altering
	 * what is stored in the append-only operation log. Merge results must never
	 * be persisted under the original operation's content-addressed id (ops are
	 * immutable); the pipeline passes the merged values here so the log keeps
	 * the canonical operation while the row reflects the merge.
	 */
	materializeData?: Record<string, unknown>
	/**
	 * Version timestamp to stamp on the materialized row INSTEAD of
	 * `op.timestamp` (e.g. max(local, remote) for a merge result). The logged
	 * operation keeps its own timestamp.
	 */
	materializeTimestamp?: HLCTimestamp
	/**
	 * Optimistic-concurrency guard: the row version state the caller observed
	 * when it computed the data it is now applying. Inside the write
	 * transaction, if the row's current `_version` / `_field_versions` no longer
	 * match this snapshot, the apply throws `OptimisticLockError` (rolling back,
	 * writing nothing) so the caller can recompute against fresh state.
	 */
	guardRowState?: RowVersionState
}

/**
 * Raw version state of a materialized row, used for optimistic-concurrency
 * guarded applies. `null` means the row (or column value) was absent.
 */
export interface RowVersionState {
	version: string | null
	fieldVersions: string | null
}

/**
 * Snapshot of a materialized row, including soft-deleted records.
 */
export interface MaterializedRowSnapshot {
	/** Deserialized application record (excludes tombstone metadata). */
	record: CollectionRecord
	/** Whether the row is soft-deleted (_deleted = 1). */
	deleted: boolean
}

/**
 * Metadata row from _kora_meta table.
 */
export interface MetaRow {
	key: string
	value: string
}

/**
 * Version vector row from _kora_version_vector table.
 */
export interface VersionVectorRow {
	node_id: string
	sequence_number: number
}
