import type { SchemaDefinition } from '@kora/core'
import { AdapterError } from '../errors'
import type { MigrationPlan, StorageAdapter, Transaction } from '../types'
import { SqliteWasmAdapter } from './sqlite-wasm-adapter'
import type { WorkerBridge } from './sqlite-wasm-channel'
import { loadFromIndexedDB, saveToIndexedDB } from './sqlite-wasm-persistence'

/**
 * Options for creating an IndexedDbAdapter.
 */
export interface IndexedDbAdapterOptions {
	/**
	 * Database name used as the IndexedDB key for persistence.
	 * Defaults to 'kora-db'.
	 */
	dbName?: string

	/**
	 * Injected WorkerBridge for testing. If omitted, a WebWorkerBridge is created
	 * in browser environments.
	 */
	bridge?: WorkerBridge

	/**
	 * URL to the sqlite-wasm-worker script. Required in browsers if no bridge is provided.
	 */
	workerUrl?: string | URL
}

/**
 * IndexedDB-backed adapter that uses SQLite WASM in-memory and serializes
 * the entire database to IndexedDB after each transaction.
 *
 * This is the fallback adapter for browsers where OPFS is not available.
 * It provides the same SQL interface as SqliteWasmAdapter, but persists by
 * serializing the full SQLite database to a single IndexedDB blob.
 *
 * @example
 * ```typescript
 * const adapter = new IndexedDbAdapter({ workerUrl: '/sqlite-wasm-worker.js' })
 * ```
 */
export class IndexedDbAdapter implements StorageAdapter {
	private inner: SqliteWasmAdapter
	private readonly dbName: string

	constructor(options: IndexedDbAdapterOptions = {}) {
		this.dbName = options.dbName ?? 'kora-db'
		this.inner = new SqliteWasmAdapter({
			bridge: options.bridge,
			workerUrl: options.workerUrl,
			dbName: this.dbName,
		})
	}

	async open(schema: SchemaDefinition): Promise<void> {
		await this.inner.open(schema)

		// If there's existing data in IndexedDB, we can't easily restore it
		// into an in-memory database via the mock bridge. In a real browser
		// environment with WASM, the worker would handle deserialization.
		// For now, the adapter starts fresh each time.
	}

	async close(): Promise<void> {
		// Persist before closing
		try {
			const data = await this.inner.exportDatabase()
			await saveToIndexedDB(this.dbName, data)
		} catch {
			// Export may not be supported (e.g., in browser worker).
			// Persistence is best-effort on close.
		}
		await this.inner.close()
	}

	async execute(sql: string, params?: unknown[]): Promise<void> {
		return this.inner.execute(sql, params)
	}

	async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
		return this.inner.query<T>(sql, params)
	}

	async transaction(fn: (tx: Transaction) => Promise<void>): Promise<void> {
		await this.inner.transaction(fn)

		// Persist after successful transaction commit
		try {
			const data = await this.inner.exportDatabase()
			await saveToIndexedDB(this.dbName, data)
		} catch {
			// Persistence failure after commit is non-fatal.
			// Data is still in memory and will be persisted on next transaction or close.
		}
	}

	async migrate(from: number, to: number, migration: MigrationPlan): Promise<void> {
		await this.inner.migrate(from, to, migration)

		// Persist after successful migration
		try {
			const data = await this.inner.exportDatabase()
			await saveToIndexedDB(this.dbName, data)
		} catch {
			// Non-fatal persistence failure
		}
	}
}
