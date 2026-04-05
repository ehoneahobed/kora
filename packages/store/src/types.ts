import type { KoraEventEmitter, Operation, SchemaDefinition } from '@kora/core'

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
 * Configuration for creating a Store instance.
 */
export interface StoreConfig {
	schema: SchemaDefinition
	adapter: StorageAdapter
	/** Optional node ID. If omitted, one is generated or loaded from the database. */
	nodeId?: string
	/** Optional event emitter. When provided, local mutations emit 'operation:created' events. */
	emitter?: KoraEventEmitter
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

/**
 * Internal row shape returned from SQL queries on collection tables.
 */
export interface RawCollectionRow {
	id: string
	_created_at: number
	_updated_at: number
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

/**
 * Result of a remote operation application.
 */
export type ApplyResult = 'applied' | 'duplicate' | 'skipped'

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
