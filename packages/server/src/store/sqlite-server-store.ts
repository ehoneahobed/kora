import type { Operation, VersionVector } from '@kora/core'
import { generateUUIDv7 } from '@kora/core'
import type { ApplyResult } from '@kora/sync'
import { and, asc, between, count, eq, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { operations, syncState } from './drizzle-schema'
import type { ServerStore } from './server-store'

/**
 * SQLite-backed server store using Drizzle ORM.
 * Persists operations and version vectors to a real database file,
 * surviving process restarts.
 */
export class SqliteServerStore implements ServerStore {
	private readonly nodeId: string
	private readonly db: BetterSQLite3Database
	private closed = false

	constructor(db: BetterSQLite3Database, nodeId?: string) {
		this.db = db
		this.nodeId = nodeId ?? generateUUIDv7()
		this.ensureTables()
	}

	getVersionVector(): VersionVector {
		this.assertOpen()
		const rows = this.db.select().from(syncState).all()
		const vv: VersionVector = new Map()
		for (const row of rows) {
			vv.set(row.nodeId, row.maxSequenceNumber)
		}
		return vv
	}

	getNodeId(): string {
		return this.nodeId
	}

	async applyRemoteOperation(op: Operation): Promise<ApplyResult> {
		this.assertOpen()

		const now = Date.now()
		const row = this.serializeOperation(op, now)

		// Use a transaction for atomicity: insert op + update version vector
		const result = this.db.transaction((tx) => {
			// Content-addressed dedup via onConflictDoNothing
			const insertResult = tx
				.insert(operations)
				.values(row)
				.onConflictDoNothing({ target: operations.id })
				.run()

			if (insertResult.changes === 0) {
				return 'duplicate' as const
			}

			// Advance version vector: upsert with MAX to ensure monotonic progress
			tx.insert(syncState)
				.values({
					nodeId: op.nodeId,
					maxSequenceNumber: op.sequenceNumber,
					lastSeenAt: now,
				})
				.onConflictDoUpdate({
					target: syncState.nodeId,
					set: {
						maxSequenceNumber: sql`MAX(${syncState.maxSequenceNumber}, ${op.sequenceNumber})`,
						lastSeenAt: sql`${now}`,
					},
				})
				.run()

			return 'applied' as const
		})

		return result
	}

	async getOperationRange(nodeId: string, fromSeq: number, toSeq: number): Promise<Operation[]> {
		this.assertOpen()

		const rows = this.db
			.select()
			.from(operations)
			.where(and(eq(operations.nodeId, nodeId), between(operations.sequenceNumber, fromSeq, toSeq)))
			.orderBy(asc(operations.sequenceNumber))
			.all()

		return rows.map((row) => this.deserializeOperation(row))
	}

	async getOperationCount(): Promise<number> {
		this.assertOpen()

		const result = this.db.select({ value: count() }).from(operations).all()
		return result[0]?.value ?? 0
	}

	async close(): Promise<void> {
		this.closed = true
	}

	/**
	 * Create the operations and sync_state tables if they don't exist.
	 * Uses raw SQL via Drizzle's sql template — standard practice for DDL without drizzle-kit.
	 */
	private ensureTables(): void {
		this.db.run(sql`
			CREATE TABLE IF NOT EXISTS operations (
				id TEXT PRIMARY KEY,
				node_id TEXT NOT NULL,
				type TEXT NOT NULL,
				collection TEXT NOT NULL,
				record_id TEXT NOT NULL,
				data TEXT,
				previous_data TEXT,
				wall_time INTEGER NOT NULL,
				logical INTEGER NOT NULL,
				timestamp_node_id TEXT NOT NULL,
				sequence_number INTEGER NOT NULL,
				causal_deps TEXT NOT NULL DEFAULT '[]',
				schema_version INTEGER NOT NULL,
				received_at INTEGER NOT NULL
			)
		`)

		this.db.run(sql`
			CREATE INDEX IF NOT EXISTS idx_node_seq ON operations (node_id, sequence_number)
		`)

		this.db.run(sql`
			CREATE INDEX IF NOT EXISTS idx_collection ON operations (collection)
		`)

		this.db.run(sql`
			CREATE INDEX IF NOT EXISTS idx_received ON operations (received_at)
		`)

		this.db.run(sql`
			CREATE TABLE IF NOT EXISTS sync_state (
				node_id TEXT PRIMARY KEY,
				max_sequence_number INTEGER NOT NULL,
				last_seen_at INTEGER NOT NULL
			)
		`)
	}

	private serializeOperation(
		op: Operation,
		receivedAt: number,
	): typeof operations.$inferInsert {
		return {
			id: op.id,
			nodeId: op.nodeId,
			type: op.type,
			collection: op.collection,
			recordId: op.recordId,
			data: op.data !== null ? JSON.stringify(op.data) : null,
			previousData: op.previousData !== null ? JSON.stringify(op.previousData) : null,
			wallTime: op.timestamp.wallTime,
			logical: op.timestamp.logical,
			timestampNodeId: op.timestamp.nodeId,
			sequenceNumber: op.sequenceNumber,
			causalDeps: JSON.stringify(op.causalDeps),
			schemaVersion: op.schemaVersion,
			receivedAt,
		}
	}

	private deserializeOperation(row: typeof operations.$inferSelect): Operation {
		return {
			id: row.id,
			nodeId: row.nodeId,
			type: row.type as Operation['type'],
			collection: row.collection,
			recordId: row.recordId,
			data: row.data !== null ? JSON.parse(row.data) : null,
			previousData: row.previousData !== null ? JSON.parse(row.previousData) : null,
			timestamp: {
				wallTime: row.wallTime,
				logical: row.logical,
				nodeId: row.timestampNodeId,
			},
			sequenceNumber: row.sequenceNumber,
			causalDeps: JSON.parse(row.causalDeps),
			schemaVersion: row.schemaVersion,
		}
	}

	private assertOpen(): void {
		if (this.closed) {
			throw new Error('SqliteServerStore is closed')
		}
	}
}

/**
 * Creates a SqliteServerStore with a file-backed or in-memory database.
 * Handles database creation, Drizzle wrapping, and table setup.
 *
 * @param options - Configuration options
 * @param options.filename - Path to SQLite database file. Defaults to ':memory:' for testing.
 * @param options.nodeId - Server node ID. Auto-generated if not provided.
 * @returns A ready-to-use SqliteServerStore
 *
 * @example
 * ```typescript
 * import { createSqliteServerStore } from '@kora/server'
 *
 * const store = createSqliteServerStore({ filename: './kora-server.db' })
 * const server = createKoraServer({ store, port: 3001 })
 * ```
 */
export function createSqliteServerStore(options: {
	filename?: string
	nodeId?: string
}): SqliteServerStore {
	// Dynamic imports avoided — better-sqlite3 is synchronous and Node-only.
	// Consumer is responsible for having better-sqlite3 installed.
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const Database = require('better-sqlite3')
	const { drizzle } = require('drizzle-orm/better-sqlite3')

	const filename = options.filename ?? ':memory:'
	const sqlite = new Database(filename)

	// Enable WAL mode for better concurrent read/write performance
	sqlite.pragma('journal_mode = WAL')

	const db = drizzle(sqlite)
	return new SqliteServerStore(db, options.nodeId)
}
