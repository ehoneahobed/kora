import type { Operation, VersionVector } from '@korajs/core'
import { generateUUIDv7 } from '@korajs/core'
import type { ApplyResult } from '@korajs/sync'
import { and, asc, between, count, eq, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { pgOperations, pgSyncState } from './drizzle-pg-schema'
import type { ServerStore } from './server-store'

/**
 * PostgreSQL-backed server store using Drizzle ORM.
 * All reads and writes go through Drizzle's typed query builder.
 * DDL stays as raw SQL via Drizzle's sql template (standard practice without drizzle-kit).
 */
export class PostgresServerStore implements ServerStore {
	private readonly nodeId: string
	private readonly db: PostgresJsDatabase
	private readonly versionVector: VersionVector = new Map()
	private readonly ready: Promise<void>
	private closed = false

	constructor(db: PostgresJsDatabase, nodeId?: string) {
		this.db = db
		this.nodeId = nodeId ?? generateUUIDv7()
		this.ready = this.initialize()
	}

	getVersionVector(): VersionVector {
		this.assertOpen()
		return new Map(this.versionVector)
	}

	getNodeId(): string {
		return this.nodeId
	}

	async applyRemoteOperation(op: Operation): Promise<ApplyResult> {
		this.assertOpen()
		await this.ready

		// Content-addressed dedup check
		const existing = await this.db
			.select({ id: pgOperations.id })
			.from(pgOperations)
			.where(eq(pgOperations.id, op.id))
			.limit(1)

		if (existing.length > 0) {
			return 'duplicate'
		}

		const now = Date.now()
		const row = this.serializeOperation(op, now)

		await this.db.transaction(async (tx) => {
			// Insert operation with dedup
			await tx
				.insert(pgOperations)
				.values(row)
				.onConflictDoNothing({ target: pgOperations.id })

			// Upsert version vector: advance max sequence number with GREATEST
			await tx
				.insert(pgSyncState)
				.values({
					nodeId: op.nodeId,
					maxSequenceNumber: op.sequenceNumber,
					lastSeenAt: now,
				})
				.onConflictDoUpdate({
					target: pgSyncState.nodeId,
					set: {
						maxSequenceNumber: sql`GREATEST(${pgSyncState.maxSequenceNumber}, ${op.sequenceNumber})`,
						lastSeenAt: sql`${now}`,
					},
				})
		})

		// Update in-memory version vector cache
		const currentMax = this.versionVector.get(op.nodeId) ?? 0
		if (op.sequenceNumber > currentMax) {
			this.versionVector.set(op.nodeId, op.sequenceNumber)
		}

		return 'applied'
	}

	async getOperationRange(nodeId: string, fromSeq: number, toSeq: number): Promise<Operation[]> {
		this.assertOpen()
		await this.ready

		const rows = await this.db
			.select()
			.from(pgOperations)
			.where(
				and(
					eq(pgOperations.nodeId, nodeId),
					between(pgOperations.sequenceNumber, fromSeq, toSeq),
				),
			)
			.orderBy(asc(pgOperations.sequenceNumber))

		return rows.map((row) => this.deserializeOperation(row))
	}

	async getOperationCount(): Promise<number> {
		this.assertOpen()
		await this.ready

		const result = await this.db.select({ value: count() }).from(pgOperations)
		return result[0]?.value ?? 0
	}

	async close(): Promise<void> {
		this.closed = true
	}

	private async initialize(): Promise<void> {
		await this.ensureTables()

		// Hydrate in-memory version vector cache via Drizzle query
		const rows = await this.db
			.select({
				nodeId: pgSyncState.nodeId,
				maxSequenceNumber: pgSyncState.maxSequenceNumber,
			})
			.from(pgSyncState)

		for (const row of rows) {
			this.versionVector.set(row.nodeId, row.maxSequenceNumber)
		}
	}

	/**
	 * Create tables if they don't exist.
	 * Uses raw SQL via Drizzle's sql template — standard DDL practice without drizzle-kit.
	 */
	private async ensureTables(): Promise<void> {
		await this.db.execute(sql`
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

		await this.db.execute(
			sql`CREATE INDEX IF NOT EXISTS idx_node_seq ON operations (node_id, sequence_number)`,
		)
		await this.db.execute(
			sql`CREATE INDEX IF NOT EXISTS idx_collection ON operations (collection)`,
		)
		await this.db.execute(
			sql`CREATE INDEX IF NOT EXISTS idx_received ON operations (received_at)`,
		)

		await this.db.execute(sql`
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
	): typeof pgOperations.$inferInsert {
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

	private deserializeOperation(row: typeof pgOperations.$inferSelect): Operation {
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
			throw new Error('PostgresServerStore is closed')
		}
	}
}

/**
 * Creates a PostgresServerStore from a PostgreSQL connection string.
 *
 * Uses runtime dynamic imports so projects that do not use PostgreSQL
 * do not need to install `postgres`. Wraps the postgres client with
 * Drizzle ORM for typed query building.
 */
export async function createPostgresServerStore(options: {
	connectionString: string
	nodeId?: string
}): Promise<PostgresServerStore> {
	const { postgresClient, drizzleFn } = await loadPostgresDeps()
	const client = postgresClient(options.connectionString)
	const db = drizzleFn(client)

	return new PostgresServerStore(db, options.nodeId)
}

async function loadPostgresDeps(): Promise<{
	postgresClient: (connectionString: string) => unknown
	drizzleFn: (client: unknown) => PostgresJsDatabase
}> {
	try {
		const dynamicImport = new Function('specifier', 'return import(specifier)') as (
			specifier: string,
		) => Promise<unknown>

		const postgresMod = (await dynamicImport('postgres')) as { default: (cs: string) => unknown }
		const drizzleMod = (await dynamicImport('drizzle-orm/postgres-js')) as {
			drizzle: (client: unknown) => PostgresJsDatabase
		}

		return {
			postgresClient: postgresMod.default,
			drizzleFn: drizzleMod.drizzle,
		}
	} catch {
		throw new Error(
			'PostgreSQL backend requires the "postgres" package. Install it in your project dependencies.',
		)
	}
}
