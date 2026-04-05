import { generateFullDDL } from '@kora/core'
import type { SchemaDefinition } from '@kora/core'
import { AdapterError, StoreNotOpenError } from '../errors'
import type { MigrationPlan, StorageAdapter, Transaction } from '../types'
import { Mutex } from './sqlite-wasm-channel'
import type { WorkerBridge, WorkerRequest, WorkerResponse } from './sqlite-wasm-channel'

/**
 * Options for creating a SqliteWasmAdapter.
 */
export interface SqliteWasmAdapterOptions {
	/**
	 * Injected WorkerBridge for testing. If omitted, a WebWorkerBridge is created
	 * in browser environments.
	 */
	bridge?: WorkerBridge

	/**
	 * Database name for persistence. Used as the OPFS file name or IDB key.
	 */
	dbName?: string

	/**
	 * URL to the sqlite-wasm-worker script. Required in browsers if no bridge is provided.
	 */
	workerUrl?: string | URL
}

/**
 * SQLite WASM adapter that communicates with a SQLite instance through a WorkerBridge.
 *
 * In browsers, the bridge is backed by a Web Worker running SQLite WASM with OPFS persistence.
 * In Node.js tests, the bridge is backed by MockWorkerBridge wrapping better-sqlite3.
 *
 * @example
 * ```typescript
 * // Browser usage
 * const adapter = new SqliteWasmAdapter({ workerUrl: '/sqlite-wasm-worker.js' })
 *
 * // Test usage with MockWorkerBridge
 * import { MockWorkerBridge } from './sqlite-wasm-mock-bridge'
 * const adapter = new SqliteWasmAdapter({ bridge: new MockWorkerBridge() })
 * ```
 */
export class SqliteWasmAdapter implements StorageAdapter {
	private bridge: WorkerBridge | null = null
	private opened = false
	private readonly mutex = new Mutex()
	private readonly injectedBridge: WorkerBridge | undefined
	private readonly workerUrl: string | URL | undefined
	private readonly dbName: string

	constructor(options: SqliteWasmAdapterOptions = {}) {
		this.injectedBridge = options.bridge
		this.workerUrl = options.workerUrl
		this.dbName = options.dbName ?? 'kora-db'
	}

	async open(schema: SchemaDefinition): Promise<void> {
		if (this.opened) return

		if (this.injectedBridge) {
			this.bridge = this.injectedBridge
		} else if (this.workerUrl) {
			// Dynamic import to avoid loading WebWorkerBridge in Node.js
			const { WebWorkerBridge } = await import('./sqlite-wasm-channel')
			this.bridge = new WebWorkerBridge(this.workerUrl)
		} else {
			throw new AdapterError(
				'SqliteWasmAdapter requires either a bridge (for testing) or a workerUrl (for browsers). ' +
					'Pass { bridge: new MockWorkerBridge() } for tests, or { workerUrl: "/worker.js" } for browsers.',
			)
		}

		const ddlStatements = generateFullDDL(schema)
		const response = await this.sendRequest({ id: 0, type: 'open', ddlStatements })
		if (response.type === 'error') {
			throw new AdapterError(`Failed to open database: ${response.message}`, {
				code: response.code,
				dbName: this.dbName,
			})
		}
		this.opened = true
	}

	async close(): Promise<void> {
		if (!this.bridge) return

		try {
			await this.sendRequest({ id: 0, type: 'close' })
		} finally {
			this.bridge.terminate()
			this.bridge = null
			this.opened = false
		}
	}

	async execute(sql: string, params?: unknown[]): Promise<void> {
		this.guardOpen()
		const response = await this.sendRequest({ id: 0, type: 'execute', sql, params })
		if (response.type === 'error') {
			throw new AdapterError(`Execute failed: ${response.message}`, { sql, params })
		}
	}

	async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
		this.guardOpen()
		const response = await this.sendRequest({ id: 0, type: 'query', sql, params })
		if (response.type === 'error') {
			throw new AdapterError(`Query failed: ${response.message}`, { sql, params })
		}
		return (response.data as T[]) ?? []
	}

	async transaction(fn: (tx: Transaction) => Promise<void>): Promise<void> {
		this.guardOpen()

		const release = await this.mutex.acquire()
		try {
			await this.sendChecked({ id: 0, type: 'begin' }, 'BEGIN transaction')

			const tx: Transaction = {
				execute: async (sql: string, params?: unknown[]): Promise<void> => {
					const response = await this.sendRequest({ id: 0, type: 'execute', sql, params })
					if (response.type === 'error') {
						throw new AdapterError(`Transaction execute failed: ${response.message}`, {
							sql,
							params,
						})
					}
				},
				query: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
					const response = await this.sendRequest({ id: 0, type: 'query', sql, params })
					if (response.type === 'error') {
						throw new AdapterError(`Transaction query failed: ${response.message}`, { sql, params })
					}
					return (response.data as T[]) ?? []
				},
			}

			await fn(tx)
			await this.sendChecked({ id: 0, type: 'commit' }, 'COMMIT transaction')
		} catch (error) {
			// Attempt rollback, but don't mask the original error
			try {
				await this.sendRequest({ id: 0, type: 'rollback' })
			} catch {
				// Rollback failure is secondary to the original error
			}
			throw error
		} finally {
			release()
		}
	}

	async migrate(from: number, to: number, migration: MigrationPlan): Promise<void> {
		this.guardOpen()

		const release = await this.mutex.acquire()
		try {
			await this.sendChecked({ id: 0, type: 'begin' }, 'BEGIN migration')

			for (const sql of migration.statements) {
				const response = await this.sendRequest({ id: 0, type: 'execute', sql })
				if (response.type === 'error') {
					throw new AdapterError(`Migration from v${from} to v${to} failed: ${response.message}`, {
						from,
						to,
					})
				}
			}

			await this.sendChecked({ id: 0, type: 'commit' }, 'COMMIT migration')
		} catch (error) {
			try {
				await this.sendRequest({ id: 0, type: 'rollback' })
			} catch {
				// Rollback failure is secondary
			}
			if (error instanceof AdapterError) throw error
			throw new AdapterError(
				`Migration from v${from} to v${to} failed: ${(error as Error).message}`,
				{ from, to },
			)
		} finally {
			release()
		}
	}

	/**
	 * Export the database as a Uint8Array (for IndexedDB persistence).
	 * Only available when the database is open.
	 */
	async exportDatabase(): Promise<Uint8Array> {
		this.guardOpen()
		const response = await this.sendRequest({ id: 0, type: 'export' })
		if (response.type === 'error') {
			throw new AdapterError(`Export failed: ${response.message}`)
		}
		return response.data as Uint8Array
	}

	/**
	 * Import a serialized database snapshot.
	 */
	async importDatabase(data: Uint8Array): Promise<void> {
		this.guardOpen()
		const response = await this.sendRequest({ id: 0, type: 'import', data })
		if (response.type === 'error') {
			throw new AdapterError(`Import failed: ${response.message}`)
		}
	}

	private guardOpen(): void {
		if (!this.opened || !this.bridge) {
			throw new StoreNotOpenError()
		}
	}

	private async sendRequest(request: WorkerRequest): Promise<WorkerResponse> {
		// guardOpen() is always called before sendRequest, so bridge is guaranteed non-null
		const bridge = this.bridge
		if (!bridge) {
			throw new StoreNotOpenError()
		}
		return bridge.send(request)
	}

	private async sendChecked(request: WorkerRequest, description: string): Promise<void> {
		const response = await this.sendRequest(request)
		if (response.type === 'error') {
			throw new AdapterError(`${description} failed: ${response.message}`)
		}
	}
}
