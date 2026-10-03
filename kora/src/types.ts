import type {
	BlobRef,
	BlobRefMetadata,
	InferInsertInput,
	InferRecord,
	InferUpdateInput,
	KoraEvent,
	KoraEventEmitter,
	Operation,
	SchemaDefinition,
	SchemaInput,
	SequenceConfig,
} from '@korajs/core'
import type { AuthSyncBinding } from '@korajs/core/bindings'
import type {
	AuditExportOptions,
	BackupOptions,
	BackupProgress,
	BlobGcOptions,
	BlobGcResult,
	BlobManifest,
	CollectionAccessor,
	CollectionRecord,
	ContentAddressedBlobStore,
	QueryBuilder,
	ReceiveBlobResult,
	ReplaySnapshot,
	RestoreOptions,
	RestoreResult,
	TransactionContext,
} from '@korajs/store'
import type { SyncEngine, SyncStatusInfo } from '@korajs/sync'
import type { ReservedAppProperty } from './reserved-app-properties'
import type { TypedCollections, TypedTransactionProxy } from './typed-api'

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
	/**
	 * Namespace the physical local database by authenticated user id when
	 * `sync.authClient` exposes one. Use this for shared browser profiles and lab
	 * machines so one user's rows, queues, watermarks, and blob refs never appear in
	 * another user's local store.
	 */
	namespaceByAuthUser?: boolean
	/**
	 * `shared` (default): one sync node id per database.
	 * `per-tab`: unique node id per browser tab (sessionStorage).
	 */
	isolation?: import('@korajs/store').StoreIsolation
	/** URL to the SQLite WASM worker script. Required for browser adapters (sqlite-wasm, indexeddb). */
	workerUrl?: string | URL
	/**
	 * @deprecated SharedWorker-hosted SQLite cannot use OPFS SyncAccessHandle and
	 * is never durable. This option is ignored; Kora uses the dedicated-worker
	 * leader/follower path for durable multi-tab storage.
	 */
	sharedWorkerUrl?: string | URL
	/** Max wait for a worker RPC (e.g. `open`). Defaults to 30000ms. */
	workerResponseTimeoutMs?: number
	/**
	 * Largest serialized operation a write may produce, in bytes. Set it to the sync
	 * server's `maxOperationBytes`; a larger write is refused locally with
	 * `OperationTooLargeError` (nothing is written). Defaults to 256 KiB, the server's
	 * default.
	 */
	maxOperationBytes?: number
	/**
	 * Accept writes when no durable browser storage can be obtained (the store runs
	 * in memory and loses local writes on reload). Defaults to false: Kora emits the
	 * blocking `store:durability-lost` event and refuses writes with
	 * `StorageDurabilityError` instead.
	 */
	allowNonDurable?: boolean
	/**
	 * When Kora asks the browser for persistent storage (NEW-STORE-4).
	 * `'auto'` (default): in the background, never awaited, after sign-in, the
	 * first local write, or when running as an installed app. `'manual'`: only when
	 * the app calls `app.storage.persistence.request()`. Either way `app.ready`
	 * never waits on it and the boot check (`persisted()`) never prompts.
	 */
	persistence?: 'auto' | 'manual'
}

export interface StoreInfo {
	baseName: string
	databaseName: string
	authUserId: string | null
	persistence: AdapterType
	durable: boolean
	isolationState: 'ready' | 'switching' | 'closed' | 'failed'
}

/** One local database Kora recorded on this origin (see `app.storage`). */
export type LocalDatabaseInfo = import('@korajs/store/sqlite-wasm').LocalDatabaseRecord

/**
 * Explicit management of this origin's local (browser) databases, for example
 * the per-user databases of `store.namespaceByAuthUser` on a shared device.
 * Kora never evicts a database automatically.
 */
export interface StorageApi {
	/** Databases Kora created or opened on this origin. Empty outside browsers. */
	listDatabases(): Promise<LocalDatabaseInfo[]>
	/**
	 * Permanently delete a local database. Refuses with `StorageInUseError` while
	 * any tab has it open (close the app first) and with `UnsyncedDataError` while
	 * it holds operations the server never acknowledged, unless `force` is set.
	 *
	 * @returns true when a database was deleted, false when none existed
	 */
	deleteDatabase(name: string, options?: { force?: boolean }): Promise<boolean>
	/**
	 * Durable storage (`navigator.storage.persist()`), kept off the startup path
	 * (NEW-STORE-4). `app.ready` never waits on it. Kora checks `persisted()` at
	 * boot (never prompts) and, unless `store.persistence` is `'manual'`, requests
	 * persistence in the background after sign-in, the first local write, or when
	 * running as an installed app. Every result is also a `storage:persistence` event.
	 */
	persistence: StoragePersistenceApi
}

/** `app.storage.persistence`: durable-storage status and an explicit request. */
export interface StoragePersistenceApi {
	/** Last known state. Synchronous; never prompts. */
	status(): import('@korajs/store').StoragePersistenceStatus
	/**
	 * Ask the browser for persistent storage. Firefox shows a permission prompt and
	 * the promise settles when the user answers, so call it from a user gesture and
	 * do not block rendering on it. Never throws.
	 */
	request(): Promise<import('@korajs/store').StoragePersistenceStatus>
}

/**
 * Pre-built auth binding from `createKoraAuthSync()` in `@korajs/auth`.
 * Canonical definition lives in `@korajs/core/bindings`.
 */
export type { AuthSyncBinding }

/**
 * Sync configuration within createApp.
 */
export interface SyncOptions {
	/** WebSocket or HTTP URL for the sync server */
	url: string
	/** Transport type. Defaults to 'websocket'. */
	transport?: 'websocket' | 'http'
	/**
	 * Auth provider function. Called before each connection attempt, with
	 * `{ forceRefresh: true }` after the server ended a session because its
	 * credential expired or was revoked (return a freshly refreshed token then).
	 */
	auth?: (options?: { forceRefresh?: boolean }) => Promise<{ token: string }>
	/**
	 * Pre-built auth binding from `createKoraAuthSync({ authClient, schema })`.
	 * When set, overrides `auth`, auto-builds `scopeMap`, and binds store node id to `dev`.
	 */
	authClient?: AuthSyncBinding
	/**
	 * What happens to writes made on a database that never synced, before the app knew
	 * who was signed in (they cannot be attributed to a user, RT-50):
	 *
	 * - `'hold'` (default): they are held, reported in `status.heldNodes` with reason
	 *   `unassigned`, until the app calls `app.sync.assignHeld` or `app.sync.discardHeld`.
	 * - `'assign-to-first-user'`: they are assigned to the first user the sync server
	 *   accepts a session for on this device, and upload as that user. Use it for
	 *   single-user apps, where those writes can only be that user's.
	 */
	unassignedWrites?: 'hold' | 'assign-to-first-user'
	/** Controls whether reactive queries affect the replicated view. Defaults to `reactive`. */
	querySubsets?: { mode?: 'reactive' | 'static' | 'disabled' }
	/** Remove records from the local active view when server authorization retracts them. */
	scopeExit?: 'retain' | 'retract'
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
	/** Connect to the sync server automatically after `app.ready`. Defaults to false. */
	autoConnect?: boolean
	/** Wait for server ACK on each handshake delta batch before streaming. Defaults to false. */
	strictHandshake?: boolean
	/**
	 * Schema transforms for operations of other schema versions. They run at fold time
	 * (RT-84): operations are stored as written and the local store folds their
	 * transformed view. Must be pure and deterministic, and match the server's.
	 */
	operationTransforms?: import('@korajs/core').OperationTransform[]
	/** Enable auto-reconnection on unexpected disconnect. Defaults to true. */
	autoReconnect?: boolean
	/** Initial reconnection delay in ms. Defaults to 1000. */
	reconnectInterval?: number
	/** Maximum reconnection delay in ms. Defaults to 30000. */
	maxReconnectInterval?: number
	/**
	 * End-to-end encryption for operation payloads on the sync wire.
	 * When enabled, `data` and `previousData` are encrypted before send.
	 */
	encryption?: import('@korajs/sync').SyncEncryptionConfig
}

/**
 * Optional configuration for the blob subsystem (the bytes behind `blob` fields).
 */
export interface BlobOptions {
	/**
	 * Content-addressed store for blob bytes. Defaults to OPFS in the browser
	 * (durable across reloads) and in-memory elsewhere. Provide your own to use a
	 * different backend (for example a filesystem store on the server).
	 */
	store?: ContentAddressedBlobStore
	/** Chunk size, in bytes, used when preparing a blob for transfer. */
	chunkSize?: number
}

/**
 * The blob subsystem exposed on the KoraApp. Blob fields store a small
 * content-addressed reference in the record; the bytes are held here and move
 * between devices out of band over the sync connection.
 */
export interface BlobApi {
	/**
	 * Store bytes locally and prepare them for transfer to other devices. Returns
	 * the reference to place in a record's `blob` field, plus the manifest another
	 * device needs to pull the bytes. Identical content is stored once (dedup).
	 */
	put(
		bytes: Uint8Array,
		metadata?: BlobRefMetadata,
	): Promise<{ ref: BlobRef; manifest: BlobManifest }>
	/** Read blob bytes held locally by content hash, or null if absent. */
	get(hash: string): Promise<Uint8Array | null>
	/** Whether the bytes for a hash are held locally. */
	has(hash: string): Promise<boolean>
	/** Remove locally held bytes for a hash. Returns whether anything was removed. */
	delete(hash: string): Promise<boolean>
	/**
	 * Pull a blob's bytes from peers (or the server) over the live sync connection,
	 * fetching only the chunks this device is missing and verifying integrity.
	 *
	 * Accepts a {@link BlobRef} — the reference stored in a record, which carries a
	 * `manifestHash` so the manifest is resolved automatically — or an explicit
	 * {@link BlobManifest}. Requires an active sync connection.
	 */
	pull(source: BlobRef | BlobManifest): Promise<ReceiveBlobResult>
	/**
	 * Reclaim local storage by deleting blob bytes no live record references any
	 * more (mark-and-sweep). Safe under deduplication: a chunk shared by a record
	 * that still exists is kept. Pass `{ dryRun: true }` to preview what would be
	 * collected without deleting.
	 */
	gc(options?: BlobGcOptions): Promise<BlobGcResult>
	/** The underlying content-addressed store, for advanced use. */
	readonly store: ContentAddressedBlobStore
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
	/** Optional blob subsystem configuration. */
	blob?: BlobOptions
	/** Enable DevTools instrumentation. Defaults to false. */
	devtools?: boolean
	/** Called for each sync-related framework event. */
	onSyncEvent?: (event: Extract<KoraEvent, { type: `sync:${string}` }>) => void
	/**
	 * Server-rendering behaviour (DX-6). By default an app created where there is no
	 * `window` (a Next.js / Remix server render) stays inert: it opens no database and
	 * starts no sync, `app.ready` rejects with `ServerRenderingAppError`, and
	 * `<KoraProvider app={app}>` renders its fallback. Pass `false` in a Node.js program
	 * that wants a real database (or set `store.adapter: 'better-sqlite3'`, which implies
	 * it); `true` keeps the app inert without a `window` even with that adapter.
	 */
	ssr?: boolean
	/** Switches for behaviour that is being phased in or out. */
	experimental?: ExperimentalOptions
}

/** {@link KoraConfig.experimental}. */
export interface ExperimentalOptions {
	/**
	 * Use the beta.12 pairwise merge pipeline instead of the W7 per-field fold.
	 * Available for ONE beta (beta.13) to compare behaviour; removed afterwards.
	 * Switching it on an existing database re-materializes every row on open.
	 * Defaults to false.
	 */
	legacyMerge?: boolean
}

/** Sync event types delivered to {@link KoraConfig.onSyncEvent}. */
export type KoraSyncEvent = Extract<KoraEvent, { type: `sync:${string}` }>

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
	/** Optional blob subsystem configuration. */
	blob?: BlobOptions
	/** Enable DevTools instrumentation. Defaults to false. */
	devtools?: boolean
	/** Called for each sync-related framework event. */
	onSyncEvent?: (event: KoraSyncEvent) => void
	/**
	 * Server-rendering behaviour (DX-6). By default an app created where there is no
	 * `window` (a Next.js / Remix server render) stays inert: it opens no database and
	 * starts no sync, `app.ready` rejects with `ServerRenderingAppError`, and
	 * `<KoraProvider app={app}>` renders its fallback. Pass `false` in a Node.js program
	 * that wants a real database (or set `store.adapter: 'better-sqlite3'`, which implies
	 * it); `true` keeps the app inert without a `window` even with that adapter.
	 */
	ssr?: boolean
	/** Switches for behaviour that is being phased in or out. */
	experimental?: ExperimentalOptions
}

/**
 * End-to-end encryption keyring controls (`app.encryption`, ENC-1). Null when
 * `sync.encryption` is not enabled.
 *
 * While the keyring is locked sync is paused; local reads and writes continue (this
 * layer encrypts the sync wire, not the local database).
 */
export interface EncryptionControl {
	/** Current lock state, key version and reason. */
	getStatus(): import('@korajs/sync').EncryptionStatus
	/** Subscribe to status changes. Returns an unsubscribe function. */
	onStatusChange(listener: (status: import('@korajs/sync').EncryptionStatus) => void): () => void
	/**
	 * Unlock with the user's passphrase. Opens the cached or server key record (on the
	 * user's first device, creates it) and resumes sync. When no record is known yet and
	 * sync is not connected, resolves with `code: 'AWAITING_SERVER'` and finishes at the
	 * next handshake (watch `onStatusChange`). Rejects with `WRONG_PASSPHRASE`, or
	 * `UNLOCK_THROTTLED` after repeated failures (a device-side backoff).
	 */
	unlock(passphrase: string): Promise<import('@korajs/sync').EncryptionStatus>
	/** Forget the keys on this device (and its key cache) and pause sync until unlock. */
	lock(): Promise<import('@korajs/sync').EncryptionStatus>
	/** Create a new key version for new operations; old versions stay readable. Online only. */
	rotateKey(): Promise<import('@korajs/sync').EncryptionStatus>
	/** Re-wrap every key version under a new passphrase (no data re-encrypted). Online only. */
	changePassphrase(
		newPassphrase: string,
		options?: { currentPassphrase?: string },
	): Promise<import('@korajs/sync').EncryptionStatus>
	/**
	 * Create (or replace) the recovery key and return it ONCE. Store it offline: it is
	 * the only way back after a lost passphrase. Online only.
	 */
	enableRecovery(): Promise<string>
	/** Recover after a lost passphrase with the recovery key, setting a new passphrase. */
	recover(
		recoveryKey: string,
		newPassphrase: string,
	): Promise<import('@korajs/sync').EncryptionStatus>
}

/**
 * Controls for the sync subsystem exposed on the KoraApp.
 */
export interface SyncControl {
	/** Connect to the sync server and start syncing. */
	connect(): Promise<void>
	/** Disconnect from the sync server. */
	disconnect(): Promise<void>
	/** Disconnect and reconnect as one serialized sync lifecycle operation. */
	reconnect(): Promise<void>
	/** Atomically replace the static query-subset manifest. */
	setQuerySubsets(subsets: import('@korajs/sync').SyncQuerySubset[]): Promise<void>
	/** Wait for upload acknowledgement and/or active-view download completion. */
	waitForSettled(
		options?: import('@korajs/sync').SyncSettlementOptions,
	): Promise<import('@korajs/sync').SyncSettlementResult>
	/** Current sync status snapshot (updates on sync events). */
	readonly status: SyncStatusInfo
	/** Get the current developer-facing sync status. */
	getStatus(): SyncStatusInfo
	/** Subscribe to status changes (event-driven, no polling). */
	subscribeStatus(listener: (status: SyncStatusInfo) => void): () => void
	/** Force an immediate reconnection attempt. No-op if already connected. */
	retryNow(): Promise<void>
	/** Clear schema-mismatch block after upgrading schema; then call `connect()`. */
	clearSchemaBlock(): void
	/** Export a diagnostics snapshot for debugging and support tickets. */
	exportDiagnostics(): import('@korajs/sync').SyncDiagnostics
	/**
	 * Operations the server rejected that have not been reconciled yet. Pair with
	 * the `sync:operation-rejected` event to surface failed submissions and decide
	 * whether to roll back the optimistic local write or resubmit a corrected op.
	 * Empty when sync is not configured.
	 */
	getRejectedOperations(): Promise<import('@korajs/sync').RejectedOperation[]>
	/** Forget rejected operations by id once the app has reconciled them. */
	clearRejectedOperations(operationIds: string[]): Promise<void>
	/**
	 * Local nodes whose unsynced writes are held (RT-38, RT-50), with why: `other-user`
	 * (they upload when their user signs in on this device) or `unassigned` (written
	 * before the app knew who was signed in, on a database that never synced: nobody can
	 * tell whose they are). Empty when sync is not configured.
	 */
	getHeldOperations(): Promise<import('@korajs/sync').HeldNodeInfo[]>
	/**
	 * Assign a node's `unassigned` held writes to the signed-in user: they upload on
	 * that user's sessions from now on (a reconnect starts at once when connected). Only
	 * the app knows whose they are (for example a single-user device, or after asking).
	 *
	 * @throws {SyncError} `HELD_ASSIGN_NO_USER` when nobody is signed in;
	 *   `HELD_NODE_NOT_ASSIGNABLE` when the node holds no unassigned writes
	 */
	assignHeld(nodeId: string, to: 'current-user'): Promise<void>
	/**
	 * Never upload a node's `unassigned` held writes. They are not rolled back: they stay
	 * in this device's local database only.
	 *
	 * @returns How many writes were discarded from sync
	 * @throws {SyncError} `HELD_NODE_NOT_DISCARDABLE` when the node holds no unassigned writes
	 */
	discardHeld(nodeId: string): Promise<number>
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
	/** Collision-free event subscription shorthand. */
	on: KoraEventEmitter['on']
	/**
	 * Collision-free collection namespace. Every schema collection is exposed here,
	 * including collections whose names overlap framework APIs such as `events`.
	 */
	collections: Readonly<Record<string, CollectionAccessor>>
	/** Sync control (connect/disconnect/status). Null if sync not configured. */
	sync: SyncControl | null
	/** End-to-end encryption keyring (unlock, lock, rotation). Null unless enabled. */
	encryption: EncryptionControl | null
	/** Offline-safe sequence generation. */
	sequences: SequenceAccessor
	/** Blob subsystem: store, read, and pull the bytes behind `blob` fields. */
	blobs: BlobApi
	/** List and explicitly delete this origin's local databases. */
	storage: StorageApi
	/** Get the underlying Store instance (for advanced use / React integration). */
	getStore(): import('@korajs/store').Store
	/** Get the underlying SyncEngine instance. Null if sync not configured. */
	getSyncEngine(): SyncEngine | null
	/** Per-app reference-counted cache for framework query subscriptions. */
	getQueryStoreCache(): import('@korajs/store').QueryStoreCache
	/** Safe local-store identity and durability metadata (never exposes records). */
	storeInfo(): StoreInfo
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
	/**
	 * Rebuild an in-memory snapshot at a causal cut in the operation log.
	 * Does not mutate live data — for DevTools time-travel and audit inspection.
	 *
	 * @param operationId - Content-addressed operation id to replay through (inclusive)
	 */
	replayTo(operationId: string): Promise<ReplaySnapshot>
	/**
	 * Export the operation log and persisted merge traces as a portable audit bundle.
	 * Merge traces are recorded automatically when conflicts are resolved.
	 */
	exportAudit(options?: AuditExportOptions): Promise<Uint8Array>
	/** Dynamic collection accessors (e.g., app.todos). Typed via Object.defineProperty. */
	[collection: string]: unknown
}

/**
 * A typed Kora application object with collection accessors inferred from the schema.
 * Each collection becomes a property with fully typed insert/update/query methods.
 */
type KoraFrameworkProperty = ReservedAppProperty

export type TypedKoraApp<S extends SchemaInput> = {
	/** Resolves when the store is open and collections are ready. */
	ready: Promise<void>
	/** Event emitter for DevTools integration and custom listeners. */
	events: KoraEventEmitter
	/** Collision-free event subscription shorthand. */
	on: KoraEventEmitter['on']
	/** All schema collections, including names reserved by the framework. */
	collections: TypedCollections<S>
	/** Sync control (connect/disconnect/status). Null if sync not configured. */
	sync: SyncControl | null
	/** End-to-end encryption keyring (unlock, lock, rotation). Null unless enabled. */
	encryption: EncryptionControl | null
	/** Offline-safe sequence generation. */
	sequences: SequenceAccessor
	/** Blob subsystem: store, read, and pull the bytes behind `blob` fields. */
	blobs: BlobApi
	/** List and explicitly delete this origin's local databases. */
	storage: StorageApi
	/** Get the underlying Store instance (for advanced use / React integration). */
	getStore(): import('@korajs/store').Store
	/** Get the underlying SyncEngine instance. Null if sync not configured. */
	getSyncEngine(): SyncEngine | null
	/** Per-app reference-counted cache for framework query subscriptions. */
	getQueryStoreCache(): import('@korajs/store').QueryStoreCache
	/** Safe local-store identity and durability metadata. */
	storeInfo(): StoreInfo
	/** Gracefully close the app: stop sync, close store. */
	close(): Promise<void>
	/**
	 * Execute multiple mutations atomically within a transaction. The callback's `tx` has
	 * one typed accessor per schema collection.
	 */
	transaction(fn: (tx: TypedTransactionProxy<S>) => Promise<void>): Promise<Operation[]>
	/** Execute a named mutation — a transaction with a DevTools-visible name. */
	mutation(name: string, fn: (tx: TypedTransactionProxy<S>) => Promise<void>): Promise<Operation[]>
	/** Export all data as a portable backup binary. */
	exportBackup(options?: BackupOptions): Promise<Uint8Array>
	/** Restore data from a backup binary. */
	importBackup(data: Uint8Array, options?: RestoreOptions): Promise<RestoreResult>
	/** Rebuild an in-memory snapshot at a causal cut in the operation log. */
	replayTo(operationId: string): Promise<ReplaySnapshot>
	/** Export the operation log and persisted merge traces as a portable audit bundle. */
	exportAudit(options?: AuditExportOptions): Promise<Uint8Array>
} & Pick<TypedCollections<S>, Exclude<keyof TypedCollections<S>, KoraFrameworkProperty>>
