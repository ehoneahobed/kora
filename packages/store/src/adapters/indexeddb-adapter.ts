import type { SchemaDefinition } from '@kora/core'
import { AdapterError } from '../errors'
import type { MigrationPlan, StorageAdapter, Transaction } from '../types'
import { SqliteWasmAdapter } from './sqlite-wasm-adapter'
import type { WorkerBridge } from './sqlite-wasm-channel'
import {
	loadDumpFromIndexedDB,
	loadFromIndexedDB,
	saveDumpToIndexedDB,
	saveToIndexedDB,
} from './sqlite-wasm-persistence'

interface DatabaseDump {
	tables: Array<{
		name: string
		columns: string[]
		rows: Array<Record<string, unknown>>
	}>
}

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

		const persisted = await loadFromIndexedDB(this.dbName)
		if (!persisted) return

		try {
			await this.inner.importDatabase(persisted)
		} catch {
			await this.restoreFromDumpFallback()
		}
	}

	async close(): Promise<void> {
		await this.persistSnapshot()
		await this.inner.close()
	}

	async execute(sql: string, params?: unknown[]): Promise<void> {
		await this.inner.execute(sql, params)
		await this.persistSnapshot()
	}

	async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
		return this.inner.query<T>(sql, params)
	}

	async transaction(fn: (tx: Transaction) => Promise<void>): Promise<void> {
		await this.inner.transaction(fn)
		await this.persistSnapshot()
	}

	async migrate(from: number, to: number, migration: MigrationPlan): Promise<void> {
		await this.inner.migrate(from, to, migration)
		await this.persistSnapshot()
	}

	private async persistSnapshot(): Promise<void> {
		try {
			const data = await this.inner.exportDatabase()
			await saveToIndexedDB(this.dbName, data)
			const dump = await this.exportDump()
			await saveDumpToIndexedDB(this.dbName, dump)
		} catch {
			// Non-fatal persistence failure. Next write/close retries persistence.
		}
	}

	private async restoreFromDumpFallback(): Promise<void> {
		const dump = await loadDumpFromIndexedDB<DatabaseDump>(this.dbName)
		if (!dump) return

		for (const table of dump.tables) {
			const name = ensureSafeIdentifier(table.name)
			await this.inner.execute(`DELETE FROM ${name}`)

			if (table.rows.length === 0) continue

			for (const row of table.rows) {
				const columns = table.columns.filter((column) => Object.prototype.hasOwnProperty.call(row, column))
				if (columns.length === 0) continue

				const placeholders = columns.map(() => '?').join(', ')
				const quotedColumns = columns.map((column) => ensureSafeIdentifier(column)).join(', ')
				const values = columns.map((column) => row[column])

				await this.inner.execute(
					`INSERT INTO ${name} (${quotedColumns}) VALUES (${placeholders})`,
					values,
				)
			}
		}
	}

	private async exportDump(): Promise<DatabaseDump> {
		const tableRows = await this.inner.query<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
		)

		const tables: DatabaseDump['tables'] = []
		for (const tableRow of tableRows) {
			const tableName = ensureSafeIdentifier(tableRow.name)
			const columns = await this.inner.query<{ name: string }>(`PRAGMA table_info(${tableName})`)
			const columnNames = columns.map((column) => column.name)
			const rows = await this.inner.query<Record<string, unknown>>(`SELECT * FROM ${tableName}`)

			tables.push({
				name: tableName,
				columns: columnNames,
				rows,
			})
		}

		return { tables }
	}
}

function ensureSafeIdentifier(identifier: string): string {
	if (!/^[a-zA-Z0-9_]+$/.test(identifier)) {
		throw new AdapterError(`Unsafe SQL identifier: ${identifier}`)
	}
	return identifier
}
