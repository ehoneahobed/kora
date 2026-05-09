import type {
	InferInsertInput,
	InferRecord,
	InferUpdateInput,
	KoraEventEmitter,
	Operation,
	SchemaDefinition,
	SchemaInput,
	SequenceConfig,
} from '@korajs/core'
import type { FieldBuilder } from '@korajs/core'
import type {
	BackupOptions,
	BackupProgress,
	CollectionAccessor,
	CollectionRecord,
	QueryBuilder,
	RestoreOptions,
	RestoreResult,
	TransactionContext,
} from '@korajs/store'
import type { SyncEngine, SyncStatusInfo } from '@korajs/sync'

/**
 * Adapter type for local storage.
 * - 'sqlite-wasm': SQLite WASM with OPFS (browser, primary)
 * - 'indexeddb': IndexedDB fallback (browser, when OPFS unavailable)
 * - 'better-sqlite3': Native SQLite (Node.js, server-side, Electron)
 * - 'tauri-sqlite': Native SQLite via Tauri plugin (Tauri desktop/mobile apps)
 */
export type AdapterType = 'sqlite-wasm' | 'indexeddb' | 'better-sqlite3' | 'tauri-sqlite'

/**
 * Store configuration within createApp.
 */
export interface StoreOptions {
	/** Explicit adapter type. Auto-detected if omitted. */
	adapter?: AdapterType
	/** Database name. Defaults to 'kora-db'. */
	name?: string
	/** URL to the SQLite WASM worker script. Required for browser adapters (sqlite-wasm, indexeddb). */
	workerUrl?: string | URL
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
	/**
	 * Flat scope values. Combined with schema scope declarations to build
	 * per-collection scope filters sent to the server during handshake.
	 *
	 * @example
	 * ```typescript
	 * createApp({
	 *   schema,
	 *   sync: {
	 *     url: 'wss://server/kora',
	 *     scope: { orgId: 'org-123', storeId: 'store-456' },
	 *   },
	 * })
	 * ```
	 */
	scope?: Record<string, unknown>
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
	/** Force an immediate reconnection attempt. No-op if already connected. */
	retryNow(): Promise<void>
	/** Export a diagnostics snapshot for debugging and support tickets. */
	exportDiagnostics(): import('@korajs/sync').SyncDiagnostics
}

/**
 * A transaction collection accessor providing insert, update, delete, and findById.
 */
export interface TransactionCollectionProxy {
	insert(data: Record<string, unknown>): Promise<CollectionRecord>
	update(id: string, data: Record<string, unknown>): Promise<CollectionRecord>
	delete(id: string): Promise<void>
	findById(id: string): Promise<CollectionRecord | null>
}

/**
 * Transaction proxy passed to the transaction callback.
 * Provides collection accessors as direct properties (e.g., tx.todos.insert(...)).
 */
export interface TransactionProxy {
	/** Dynamic collection accessors for transaction operations. */
	[collection: string]: TransactionCollectionProxy
}

/**
 * Accessor for offline-safe sequences.
 * Generates monotonically increasing, collision-free identifiers
 * that work across offline devices.
 */
export interface SequenceAccessor {
	/**
	 * Get the next value in a sequence, atomically incrementing the counter.
	 *
	 * @param name - The sequence name (e.g., 'receipt', 'invoice')
	 * @param config - Optional configuration for scope, format, and starting value
	 * @returns The formatted sequence value
	 *
	 * @example
	 * ```typescript
	 * const receiptNo = await app.sequences.next('receipt', {
	 *   scope: storeId,
	 *   format: 'S-{date}-{node4}-{seq}',
	 * })
	 * // → "S-20260508-a1b2-0042"
	 * ```
	 */
	next(name: string, config?: SequenceConfig): Promise<string>

	/**
	 * Get the current counter value without incrementing.
	 *
	 * @param name - The sequence name
	 * @param config - Optional scope
	 * @returns The current counter value, or 0 if never used
	 */
	current(name: string, config?: { scope?: string }): Promise<number>

	/**
	 * Reset a sequence counter.
	 *
	 * @param name - The sequence name
	 * @param config - Optional scope and target value
	 */
	reset(name: string, config?: { scope?: string; to?: number }): Promise<void>
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
	/** Offline-safe sequence generation. */
	sequences: SequenceAccessor
	/** Get the underlying Store instance (for advanced use / React integration). */
	getStore(): import('@korajs/store').Store
	/** Get the underlying SyncEngine instance. Null if sync not configured. */
	getSyncEngine(): SyncEngine | null
	/** Gracefully close the app: stop sync, close store. */
	close(): Promise<void>
	/**
	 * Execute multiple mutations atomically within a transaction.
	 * All operations are committed together or rolled back on error.
	 * Subscription notifications are batched after commit.
	 *
	 * @example
	 * ```typescript
	 * await app.transaction(async (tx) => {
	 *   await tx.sales.update(saleId, { status: 'completed' })
	 *   await tx.payments.insert({ saleId, method: 'cash', amount: total })
	 * })
	 * ```
	 */
	transaction(fn: (tx: TransactionProxy) => Promise<void>): Promise<Operation[]>
	/**
	 * Execute a named mutation — a transaction with a human-readable name.
	 * The mutation name is attached to all operations and visible in DevTools.
	 *
	 * @example
	 * ```typescript
	 * await app.mutation('complete-sale', async (tx) => {
	 *   await tx.sales.update(saleId, { status: 'completed' })
	 *   await tx.payments.insert({ saleId, method: 'cash', amount: total })
	 * })
	 * ```
	 */
	mutation(name: string, fn: (tx: TransactionProxy) => Promise<void>): Promise<Operation[]>
	/**
	 * Export all data as a portable backup binary.
	 * Delegates to the underlying store's exportBackup.
	 *
	 * @param options - Backup options (includeRecords, collections, onProgress)
	 * @returns Backup as a Uint8Array
	 */
	exportBackup(options?: BackupOptions): Promise<Uint8Array>
	/**
	 * Restore data from a backup binary.
	 * Delegates to the underlying store's importBackup.
	 *
	 * @param data - The backup data
	 * @param options - Restore options (merge, collections, onProgress)
	 * @returns Result of the restore operation
	 */
	importBackup(data: Uint8Array, options?: RestoreOptions): Promise<RestoreResult>
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
	/** Offline-safe sequence generation. */
	sequences: SequenceAccessor
	/** Get the underlying Store instance (for advanced use / React integration). */
	getStore(): import('@korajs/store').Store
	/** Get the underlying SyncEngine instance. Null if sync not configured. */
	getSyncEngine(): SyncEngine | null
	/** Gracefully close the app: stop sync, close store. */
	close(): Promise<void>
	/** Execute multiple mutations atomically within a transaction. */
	transaction(fn: (tx: TransactionProxy) => Promise<void>): Promise<Operation[]>
	/** Execute a named mutation — a transaction with a DevTools-visible name. */
	mutation(name: string, fn: (tx: TransactionProxy) => Promise<void>): Promise<Operation[]>
	/** Export all data as a portable backup binary. */
	exportBackup(options?: BackupOptions): Promise<Uint8Array>
	/** Restore data from a backup binary. */
	importBackup(data: Uint8Array, options?: RestoreOptions): Promise<RestoreResult>
} & {
	readonly [C in keyof S['collections'] & string]: S['collections'][C] extends {
		// biome-ignore lint/suspicious/noExplicitAny: Required for TypeScript conditional type inference
		fields: infer F extends Record<string, FieldBuilder<any, any, any>>
	}
		? TypedCollectionAccessor<InferRecord<F>, InferInsertInput<F>, InferUpdateInput<F>>
		: CollectionAccessor
}
