import { generateFullDDL } from '@korajs/core'
import type { SchemaDefinition } from '@korajs/core'

/**
 * Transaction interface for executing multiple operations atomically.
 * Mirrors @korajs/store's Transaction type to avoid a runtime dependency.
 */
export interface Transaction {
	execute(sql: string, params?: unknown[]): Promise<void>
	query<T>(sql: string, params?: unknown[]): Promise<T[]>
}

/**
 * Migration plan containing SQL statements and optional data transforms.
 * Mirrors @korajs/store's MigrationPlan type.
 */
export interface MigrationPlan {
	statements: string[]
	transforms?: Array<(row: Record<string, unknown>) => Record<string, unknown>>
}

/**
 * Storage adapter interface. Mirrors @korajs/store's StorageAdapter.
 * Redeclared here to avoid a runtime dependency on @korajs/store.
 */
export interface StorageAdapter {
	open(schema: SchemaDefinition): Promise<void>
	close(): Promise<void>
	execute(sql: string, params?: unknown[]): Promise<void>
	query<T>(sql: string, params?: unknown[]): Promise<T[]>
	transaction(fn: (tx: Transaction) => Promise<void>): Promise<void>
	migrate(from: number, to: number, migration: MigrationPlan): Promise<void>
}

/**
 * Function signature for Tauri's invoke IPC call.
 * Matches `invoke` from `@tauri-apps/api/core`.
 */
export type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>

/**
 * Configuration options for the Tauri SQLite adapter.
 */
export interface TauriSqliteOptions {
	/**
	 * Database file path relative to the app's data directory.
	 * Defaults to 'kora.db'.
	 */
	path?: string

	/**
	 * Custom invoke function. Defaults to Tauri's `invoke` from `@tauri-apps/api/core`.
	 * Useful for testing — inject a mock invoke to test without a Tauri runtime.
	 */
	invoke?: InvokeFn
}

/**
 * Thrown when a storage adapter operation fails in the Tauri plugin.
 */
export class TauriAdapterError extends Error {
	public readonly code: string
	public readonly context?: Record<string, unknown>

	constructor(message: string, context?: Record<string, unknown>) {
		super(message)
		this.name = 'TauriAdapterError'
		this.code = 'TAURI_ADAPTER_ERROR'
		this.context = context
	}
}

/**
 * Thrown when an operation is attempted on an adapter that has not been opened.
 */
export class TauriStoreNotOpenError extends Error {
	public readonly code: string

	constructor() {
		super('Store is not open. Call adapter.open() before performing operations.')
		this.name = 'TauriStoreNotOpenError'
		this.code = 'STORE_NOT_OPEN'
	}
}

// Mutex for serializing transactions over async IPC
class AsyncMutex {
	private queue: Array<() => void> = []
	private locked = false

	async acquire(): Promise<() => void> {
		if (!this.locked) {
			this.locked = true
			return () => this.release()
		}
		return new Promise<() => void>((resolve) => {
			this.queue.push(() => {
				resolve(() => this.release())
			})
		})
	}

	private release(): void {
		const next = this.queue.shift()
		if (next) {
			next()
		} else {
			this.locked = false
		}
	}
}

/**
 * Resolves the default Tauri invoke function by dynamically importing `@tauri-apps/api/core`.
 * Returns null if not in a Tauri environment.
 */
async function resolveDefaultInvoke(): Promise<InvokeFn> {
	try {
		const { invoke } = await import('@tauri-apps/api/core')
		return invoke as InvokeFn
	} catch {
		throw new TauriAdapterError(
			'Failed to import @tauri-apps/api/core. Ensure @tauri-apps/api is installed and you are running inside a Tauri application.',
		)
	}
}

const PLUGIN_PREFIX = 'plugin:kora-sqlite|'

/**
 * Storage adapter backed by native SQLite via a Tauri plugin.
 *
 * Uses Tauri IPC to communicate with the `tauri-plugin-kora` Rust plugin,
 * which provides native SQLite access with WAL mode, foreign keys, and
 * proper connection management — zero WASM overhead.
 *
 * @example
 * ```typescript
 * import { TauriSqliteAdapter } from '@korajs/tauri'
 *
 * const adapter = new TauriSqliteAdapter({ path: 'my-app.db' })
 * ```
 *
 * @example
 * ```typescript
 * // With createApp (auto-detected in Tauri environments)
 * import { createApp, defineSchema, t } from 'korajs'
 *
 * const app = createApp({
 *   schema: defineSchema({
 *     version: 1,
 *     collections: {
 *       todos: { fields: { title: t.string(), completed: t.boolean().default(false) } }
 *     }
 *   })
 * })
 * ```
 */
export class TauriSqliteAdapter implements StorageAdapter {
	private opened = false
	private invoker: InvokeFn | null
	private readonly dbPath: string
	private readonly txMutex = new AsyncMutex()
	private inTransaction = false

	constructor(options?: TauriSqliteOptions) {
		this.dbPath = options?.path ?? 'kora.db'
		this.invoker = options?.invoke ?? null
	}

	private async getInvoke(): Promise<InvokeFn> {
		if (!this.invoker) {
			this.invoker = await resolveDefaultInvoke()
		}
		return this.invoker
	}

	private async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
		const invokeFn = await this.getInvoke()
		return invokeFn<T>(`${PLUGIN_PREFIX}${cmd}`, args)
	}

	/**
	 * Open or create the database. Generates DDL from the schema and sends it
	 * to the Rust plugin for execution. The plugin configures WAL mode,
	 * foreign keys, and other pragmas before running the DDL.
	 */
	async open(schema: SchemaDefinition): Promise<void> {
		const statements = generateFullDDL(schema)
		await this.invoke('open', { path: this.dbPath, statements })
		this.opened = true
	}

	/**
	 * Close the database and release resources.
	 */
	async close(): Promise<void> {
		if (this.opened) {
			await this.invoke('close', { path: this.dbPath })
			this.opened = false
		}
	}

	/**
	 * Execute a write query (INSERT, UPDATE, DELETE).
	 */
	async execute(sql: string, params?: unknown[]): Promise<void> {
		this.ensureOpen()
		try {
			await this.invoke('execute', {
				path: this.dbPath,
				sql,
				params: params ?? [],
			})
		} catch (error) {
			throw new TauriAdapterError(`Execute failed: ${(error as Error).message}`, {
				sql,
				params,
			})
		}
	}

	/**
	 * Execute a read query (SELECT).
	 */
	async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
		this.ensureOpen()
		try {
			return await this.invoke<T[]>('query', {
				path: this.dbPath,
				sql,
				params: params ?? [],
			})
		} catch (error) {
			throw new TauriAdapterError(`Query failed: ${(error as Error).message}`, {
				sql,
				params,
			})
		}
	}

	/**
	 * Execute multiple operations atomically within a transaction.
	 *
	 * Uses a mutex to prevent interleaving of concurrent transactions.
	 * The transaction is committed on success or rolled back on error.
	 */
	async transaction(fn: (tx: Transaction) => Promise<void>): Promise<void> {
		this.ensureOpen()
		const release = await this.txMutex.acquire()
		try {
			this.inTransaction = true
			await this.invoke('execute', { path: this.dbPath, sql: 'BEGIN', params: [] })
			try {
				const tx: Transaction = {
					execute: async (sql: string, params?: unknown[]): Promise<void> => {
						try {
							await this.invoke('execute', {
								path: this.dbPath,
								sql,
								params: params ?? [],
							})
						} catch (error) {
							throw new TauriAdapterError(
								`Transaction execute failed: ${(error as Error).message}`,
								{ sql, params },
							)
						}
					},
					query: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
						try {
							return await this.invoke<T[]>('query', {
								path: this.dbPath,
								sql,
								params: params ?? [],
							})
						} catch (error) {
							throw new TauriAdapterError(`Transaction query failed: ${(error as Error).message}`, {
								sql,
								params,
							})
						}
					},
				}
				await fn(tx)
				await this.invoke('execute', { path: this.dbPath, sql: 'COMMIT', params: [] })
			} catch (error) {
				try {
					await this.invoke('execute', { path: this.dbPath, sql: 'ROLLBACK', params: [] })
				} catch {
					// Rollback failed — connection may be in a bad state, but we still throw the original error
				}
				throw error
			}
		} finally {
			this.inTransaction = false
			release()
		}
	}

	/**
	 * Apply a schema migration within a transaction.
	 */
	async migrate(from: number, to: number, migration: MigrationPlan): Promise<void> {
		this.ensureOpen()
		try {
			await this.invoke('migrate', {
				path: this.dbPath,
				statements: migration.statements,
			})
		} catch (error) {
			throw new TauriAdapterError(
				`Migration from v${from} to v${to} failed: ${(error as Error).message}`,
				{ from, to },
			)
		}
	}

	private ensureOpen(): void {
		if (!this.opened) {
			throw new TauriStoreNotOpenError()
		}
	}
}
