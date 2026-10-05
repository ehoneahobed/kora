import { generateFullDDL } from '@korajs/core'
import type { SchemaDefinition } from '@korajs/core'
import type Database from 'better-sqlite3'
import { AdapterError, SchemaVersionAheadError, StoreNotOpenError } from '../errors'
import {
	STORED_SCHEMA_VERSION_SQL,
	parseSchemaCeiling,
	storedSchemaVersion,
} from '../migrations/schema-ceiling'
import type { MigrationPlan, StorageAdapter, Transaction } from '../types'
import { Mutex } from './mutex'

/**
 * Storage adapter backed by better-sqlite3 for Node.js environments.
 * Used for testing and server-side usage.
 *
 * @example
 * ```typescript
 * import { BetterSqlite3Adapter } from '@korajs/store/better-sqlite3'
 *
 * const adapter = new BetterSqlite3Adapter(':memory:')
 * ```
 */
/** Prepared statements kept per adapter (distinct SQL texts, LRU). */
const STATEMENT_CACHE_SIZE = 256

export class BetterSqlite3Adapter implements StorageAdapter {
	private db: Database.Database | null = null
	private readonly statements = new Map<string, Database.Statement>()
	private statementsDb: Database.Database | null = null

	/**
	 * Serializes transactions. better-sqlite3 is synchronous, but our
	 * `transaction()` is async and yields the event loop at each `await` inside
	 * the callback. Without this mutex, a transaction started while another is
	 * mid-flight (e.g. a relayed remote operation applied during a local write)
	 * issues a nested `BEGIN`, which SQLite rejects, and the operation is lost.
	 */
	private readonly txMutex = new Mutex()

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
			const ceiling = parseSchemaCeiling(sql)
			if (ceiling !== null) {
				// A database a newer build migrated gets none of this build's DDL (RT-109).
				const stored = storedSchemaVersion(
					this.db.prepare(STORED_SCHEMA_VERSION_SQL).all() as Array<{ value: unknown }>,
				)
				if (stored > ceiling) {
					this.db.close()
					this.db = null
					throw new SchemaVersionAheadError(this.path, stored, ceiling)
				}
				continue
			}
			if (sql.startsWith('--kora:safe-alter')) {
				// Safe ALTER TABLE — ignore "duplicate column name" errors for existing columns
				try {
					this.db.exec(sql.replace('--kora:safe-alter\n', ''))
				} catch (e) {
					const msg = (e as Error).message || ''
					// Tolerate duplicate columns (already exists) and NOT NULL without defaults
					// (column may be added or renamed by a migration step instead)
					if (
						!msg.includes('duplicate column name') &&
						!msg.includes('Cannot add a NOT NULL column with default value NULL')
					) {
						throw e
					}
				}
			} else {
				this.db.exec(sql)
			}
		}
	}

	async close(): Promise<void> {
		if (this.db) {
			this.statements.clear()
			this.db.close()
			this.db = null
		}
	}

	/**
	 * Non-transactional write. Takes the same mutex as {@link transaction} so it
	 * never lands inside another caller's open transaction, where a rollback of
	 * that transaction would silently discard it (STORE-8). Code running inside a
	 * transaction callback must use the `tx` handle, never this method.
	 */
	async execute(sql: string, params?: unknown[]): Promise<void> {
		const db = this.getDb()
		const release = await this.txMutex.acquire()
		try {
			this.statement(db, sql).run(...(params ?? []))
		} catch (error) {
			throw new AdapterError(`Execute failed: ${(error as Error).message}`, {
				sql,
				params,
			})
		} finally {
			release()
		}
	}

	/**
	 * Non-transactional read. Waits for any open transaction to finish so a reader
	 * never observes another caller's uncommitted (possibly rolled-back) rows
	 * (STORE-8). Inside a transaction callback, read through the `tx` handle.
	 */
	async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
		const db = this.getDb()
		const release = await this.txMutex.acquire()
		try {
			return this.statement(db, sql).all(...(params ?? [])) as T[]
		} catch (error) {
			throw new AdapterError(`Query failed: ${(error as Error).message}`, {
				sql,
				params,
			})
		} finally {
			release()
		}
	}

	async transaction(fn: (tx: Transaction) => Promise<void>): Promise<void> {
		const db = this.getDb()

		// Serialize with any other in-flight transaction so BEGIN is never nested.
		const release = await this.txMutex.acquire()
		try {
			// better-sqlite3's transaction() is synchronous, but our interface is async.
			// We use BEGIN/COMMIT/ROLLBACK manually for the async callback.
			db.exec('BEGIN')
			try {
				const tx: Transaction = {
					execute: async (sql: string, params?: unknown[]): Promise<void> => {
						try {
							this.statement(db, sql).run(...(params ?? []))
						} catch (error) {
							throw new AdapterError(`Transaction execute failed: ${(error as Error).message}`, {
								sql,
								params,
							})
						}
					},
					query: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
						try {
							return this.statement(db, sql).all(...(params ?? [])) as T[]
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
		} finally {
			release()
		}
	}

	async migrate(from: number, to: number, migration: MigrationPlan): Promise<void> {
		const db = this.getDb()
		// Serialize against transactions so migration's BEGIN is never nested.
		const release = await this.txMutex.acquire()
		try {
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
		} finally {
			release()
		}
	}

	/**
	 * A prepared statement for `sql`, cached by its text (bounded, least recently
	 * used evicted). Preparing dominated the write path: every local or remote write
	 * runs the same handful of statements. SQLite re-prepares a cached statement
	 * itself when the schema changes.
	 */
	private statement(db: Database.Database, sql: string): Database.Statement {
		// A re-open replaces the connection: statements belong to the one they were
		// prepared on.
		if (this.statementsDb !== db) {
			this.statements.clear()
			this.statementsDb = db
		}
		const cached = this.statements.get(sql)
		if (cached) {
			this.statements.delete(sql)
			this.statements.set(sql, cached)
			return cached
		}
		const prepared = db.prepare(sql)
		this.statements.set(sql, prepared)
		if (this.statements.size > STATEMENT_CACHE_SIZE) {
			const oldest = this.statements.keys().next().value
			if (oldest !== undefined) this.statements.delete(oldest)
		}
		return prepared
	}

	private getDb(): Database.Database {
		if (!this.db) {
			throw new StoreNotOpenError()
		}
		return this.db
	}
}
