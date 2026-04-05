import type { KoraEventEmitter, SchemaDefinition } from '@kora/core'
import type { CollectionAccessor, StorageAdapter } from '@kora/store'
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
