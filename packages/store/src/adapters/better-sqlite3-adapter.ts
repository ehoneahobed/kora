import { generateFullDDL } from '@kora/core'
import type { SchemaDefinition } from '@kora/core'
import type Database from 'better-sqlite3'
import { AdapterError, StoreNotOpenError } from '../errors'
import type { MigrationPlan, StorageAdapter, Transaction } from '../types'

/**
 * Storage adapter backed by better-sqlite3 for Node.js environments.
 * Used for testing and server-side usage.
 *
 * @example
 * ```typescript
 * import { BetterSqlite3Adapter } from '@kora/store/better-sqlite3'
 *
 * const adapter = new BetterSqlite3Adapter(':memory:')
 * ```
 */
export class BetterSqlite3Adapter implements StorageAdapter {
	private db: Database.Database | null = null

	/**
	 * @param path - Database file path, or ':memory:' for in-memory database
	 */
	constructor(private readonly path: string = ':memory:') {}

	async open(schema: SchemaDefinition): Promise<void> {
		// Dynamic import so better-sqlite3 is only loaded when this adapter is used
		const BetterSqlite3 = (await import('better-sqlite3')).default
		this.db = new BetterSqlite3(this.path)

		// WAL mode for better concurrent read/write performance
		this.db.pragma('journal_mode = WAL')
		// Enable foreign keys
		this.db.pragma('foreign_keys = ON')

		const statements = generateFullDDL(schema)
		for (const sql of statements) {
			this.db.exec(sql)
		}
	}

	async close(): Promise<void> {
		if (this.db) {
			this.db.close()
			this.db = null
		}
	}

	async execute(sql: string, params?: unknown[]): Promise<void> {
		const db = this.getDb()
		try {
			db.prepare(sql).run(...(params ?? []))
		} catch (error) {
			throw new AdapterError(`Execute failed: ${(error as Error).message}`, {
				sql,
				params,
			})
		}
	}

	async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
		const db = this.getDb()
		try {
			return db.prepare(sql).all(...(params ?? [])) as T[]
		} catch (error) {
			throw new AdapterError(`Query failed: ${(error as Error).message}`, {
				sql,
				params,
			})
		}
	}

	async transaction(fn: (tx: Transaction) => Promise<void>): Promise<void> {
		const db = this.getDb()

		// better-sqlite3's transaction() is synchronous, but our interface is async.
		// We use BEGIN/COMMIT/ROLLBACK manually for the async callback.
		db.exec('BEGIN')
		try {
			const tx: Transaction = {
				execute: async (sql: string, params?: unknown[]): Promise<void> => {
					try {
						db.prepare(sql).run(...(params ?? []))
					} catch (error) {
						throw new AdapterError(`Transaction execute failed: ${(error as Error).message}`, {
							sql,
							params,
						})
					}
				},
				query: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
					try {
						return db.prepare(sql).all(...(params ?? [])) as T[]
					} catch (error) {
						throw new AdapterError(`Transaction query failed: ${(error as Error).message}`, {
							sql,
							params,
						})
					}
				},
			}
			await fn(tx)
			db.exec('COMMIT')
		} catch (error) {
			db.exec('ROLLBACK')
			throw error
		}
	}

	async migrate(from: number, to: number, migration: MigrationPlan): Promise<void> {
		const db = this.getDb()
		db.exec('BEGIN')
		try {
			for (const sql of migration.statements) {
				db.exec(sql)
			}
			db.exec('COMMIT')
		} catch (error) {
			db.exec('ROLLBACK')
			throw new AdapterError(
				`Migration from v${from} to v${to} failed: ${(error as Error).message}`,
				{
					from,
					to,
				},
			)
		}
	}

	private getDb(): Database.Database {
		if (!this.db) {
			throw new StoreNotOpenError()
		}
		return this.db
	}
}
