import type {
	InferInsertInput,
	InferRecord,
	InferUpdateInput,
	KoraEventEmitter,
	SchemaDefinition,
	SchemaInput,
} from '@kora/core'
import type { FieldBuilder } from '@kora/core'
import type { CollectionAccessor, CollectionRecord, QueryBuilder } from '@kora/store'
import type { SyncEngine, SyncStatusInfo } from '@kora/sync'

/**
 * Adapter type for local storage.
 * - 'sqlite-wasm': SQLite WASM with OPFS (browser, primary)
 * - 'indexeddb': IndexedDB fallback (browser, when OPFS unavailable)
 * - 'better-sqlite3': Native SQLite (Node.js, server-side, Electron)
 */
export type AdapterType = 'sqlite-wasm' | 'indexeddb' | 'better-sqlite3'

/**
 * Store configuration within createApp.
 */
export interface StoreOptions {
	/** Explicit adapter type. Auto-detected if omitted. */
	adapter?: AdapterType
	/** Database name. Defaults to 'kora-db'. */
	name?: string
}

/**
 * Sync configuration within createApp.
 */
export interface SyncOptions {
	/** WebSocket or HTTP URL for the sync server */
	url: string
	/** Transport type. Defaults to 'websocket'. */
	transport?: 'websocket' | 'http'
	/** Auth provider function. Called before each connection attempt. */
	auth?: () => Promise<{ token: string }>
	/** Sync scopes per collection. */
	scopes?: Record<string, (ctx: Record<string, unknown>) => Record<string, unknown>>
	/** Number of operations per batch. Defaults to 100. */
	batchSize?: number
	/** Schema version of this client. */
	schemaVersion?: number
	/** Enable auto-reconnection on unexpected disconnect. Defaults to true. */
	autoReconnect?: boolean
	/** Initial reconnection delay in ms. Defaults to 1000. */
	reconnectInterval?: number
	/** Maximum reconnection delay in ms. Defaults to 30000. */
	maxReconnectInterval?: number
}

/**
 * Full configuration passed to createApp().
 */
export interface KoraConfig {
	/** The application schema. Required. */
	schema: SchemaDefinition
	/** Optional store configuration. */
	store?: StoreOptions
	/** Optional sync configuration. Enables sync when provided. */
	sync?: SyncOptions
	/** Enable DevTools instrumentation. Defaults to false. */
	devtools?: boolean
}

/**
 * Typed configuration passed to createApp() when using a TypedSchemaDefinition.
 */
export interface TypedKoraConfig<S extends SchemaInput> {
	/** The application schema with preserved type information. Required. */
	schema: SchemaDefinition & { readonly __input: S }
	/** Optional store configuration. */
	store?: StoreOptions
	/** Optional sync configuration. Enables sync when provided. */
	sync?: SyncOptions
	/** Enable DevTools instrumentation. Defaults to false. */
	devtools?: boolean
}

/**
 * Controls for the sync subsystem exposed on the KoraApp.
 */
export interface SyncControl {
	/** Connect to the sync server and start syncing. */
	connect(): Promise<void>
	/** Disconnect from the sync server. */
	disconnect(): Promise<void>
	/** Get the current developer-facing sync status. */
	getStatus(): SyncStatusInfo
}

/**
 * The main application object returned by createApp().
 * Collection accessors are defined as dynamic properties via Object.defineProperty.
 */
export interface KoraApp {
	/** Resolves when the store is open and collections are ready. */
	ready: Promise<void>
	/** Event emitter for DevTools integration and custom listeners. */
	events: KoraEventEmitter
	/** Sync control (connect/disconnect/status). Null if sync not configured. */
	sync: SyncControl | null
	/** Get the underlying Store instance (for advanced use / React integration). */
	getStore(): import('@kora/store').Store
	/** Get the underlying SyncEngine instance. Null if sync not configured. */
	getSyncEngine(): SyncEngine | null
	/** Gracefully close the app: stop sync, close store. */
	close(): Promise<void>
	/** Dynamic collection accessors (e.g., app.todos). Typed via Object.defineProperty. */
	[collection: string]: unknown
}

/**
 * A typed collection accessor with full type inference.
 * Methods are parameterized by the inferred record, insert, and update types.
 */
export interface TypedCollectionAccessor<TRecord, TInsert, TUpdate> {
	/** Insert a new record. Returns the full record with generated id and metadata. */
	insert(data: TInsert): Promise<TRecord>
	/** Find a record by its ID. */
	findById(id: string): Promise<TRecord | null>
	/** Update a record by ID with partial data. Returns the updated record. */
	update(id: string, data: TUpdate): Promise<TRecord>
	/** Soft-delete a record by ID. */
	delete(id: string): Promise<void>
	/** Start building a query with WHERE conditions. */
	where(conditions: Record<string, unknown>): QueryBuilder<TRecord>
}

/**
 * A typed Kora application object with collection accessors inferred from the schema.
 * Each collection becomes a property with fully typed insert/update/query methods.
 */
export type TypedKoraApp<S extends SchemaInput> = {
	/** Resolves when the store is open and collections are ready. */
	ready: Promise<void>
	/** Event emitter for DevTools integration and custom listeners. */
	events: KoraEventEmitter
	/** Sync control (connect/disconnect/status). Null if sync not configured. */
	sync: SyncControl | null
	/** Get the underlying Store instance (for advanced use / React integration). */
	getStore(): import('@kora/store').Store
	/** Get the underlying SyncEngine instance. Null if sync not configured. */
	getSyncEngine(): SyncEngine | null
	/** Gracefully close the app: stop sync, close store. */
	close(): Promise<void>
} & {
	readonly [C in keyof S['collections'] & string]: S['collections'][C] extends {
		fields: infer F extends Record<string, FieldBuilder<any, any, any>>
	}
		? TypedCollectionAccessor<InferRecord<F>, InferInsertInput<F>, InferUpdateInput<F>>
		: CollectionAccessor
}
