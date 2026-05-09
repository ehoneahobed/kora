import type { Operation, SchemaDefinition, VersionVector } from '@korajs/core'
import { generateUUIDv7 } from '@korajs/core'
import type { ApplyResult } from '@korajs/sync'
import type { SQL } from 'drizzle-orm'
import { and, asc, between, count, eq, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { pgOperations, pgSyncState } from './drizzle-pg-schema'
import {
	deserializeFieldValue,
	generateAllCollectionDDL,
	replayOperationsForRecord,
	serializeFieldValue,
	validateFieldName,
} from './materialization'
import type { CollectionQueryOptions, MaterializedRecord, ServerStore } from './server-store'

/**
 * PostgreSQL-backed server store using Drizzle ORM.
 * All reads and writes go through Drizzle's typed query builder.
 *
 * When a schema is set via setSchema(), also maintains materialized
 * collection tables for efficient indexed queries (dual-write).
 */
export class PostgresServerStore implements ServerStore {
	private readonly nodeId: string
	private readonly db: PostgresJsDatabase
	private readonly versionVector: VersionVector = new Map()
	private readonly ready: Promise<void>
	private schema: SchemaDefinition | null = null
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

	async setSchema(schema: SchemaDefinition): Promise<void> {
		this.assertOpen()
		await this.ready
		this.schema = schema

		// Generate and execute DDL for all collection tables
		const ddlStatements = generateAllCollectionDDL(schema, 'postgres')
		for (const stmt of ddlStatements) {
			if (stmt.startsWith('--kora:safe-alter')) {
				const alterSql = stmt.replace('--kora:safe-alter\n', '')
				try {
					await this.db.execute(sql.raw(alterSql))
				} catch (e) {
					// Ignore "already exists" errors from safe ALTER TABLE.
					// Drizzle wraps the actual DB error in e.cause, so check both.
					const msg = e instanceof Error ? e.message : ''
					const causeMsg = e instanceof Error && e.cause instanceof Error ? e.cause.message : ''
					if (
						!msg.includes('already exists') &&
						!msg.includes('duplicate column') &&
						!causeMsg.includes('already exists') &&
						!causeMsg.includes('duplicate column')
					) {
						throw e
					}
				}
			} else {
				await this.db.execute(sql.raw(stmt))
			}
		}

		// Backfill materialized tables from existing operations
		await this.backfillAllCollections()
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
			await tx.insert(pgOperations).values(row).onConflictDoNothing({ target: pgOperations.id })

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

			// Dual-write: update materialized collection table if schema is set
			if (this.schema?.collections[op.collection]) {
				await this.rebuildMaterializedRecord(tx, op.collection, op.recordId)
			}
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
				and(eq(pgOperations.nodeId, nodeId), between(pgOperations.sequenceNumber, fromSeq, toSeq)),
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

	async materializeCollection(collection: string): Promise<MaterializedRecord[]> {
		this.assertOpen()
		await this.ready

		// Fast path: if schema is set, read directly from the materialized table
		if (this.schema?.collections[collection]) {
			return this.queryCollection(collection)
		}

		// Fallback: replay operations (legacy path when schema is not set)
		return this.materializeFromOpsLog(collection)
	}

	async queryCollection(
		collection: string,
		options?: CollectionQueryOptions,
	): Promise<MaterializedRecord[]> {
		this.assertOpen()
		await this.ready
		this.assertSchema()
		this.assertCollection(collection)

		const schema = this.schema as SchemaDefinition
		const collectionDef = schema.collections[collection] as NonNullable<
			SchemaDefinition['collections'][string]
		>

		// Validate field names in options
		if (options?.where) {
			for (const key of Object.keys(options.where)) {
				validateFieldName(collection, key, schema)
			}
		}
		if (options?.orderBy) {
			validateFieldName(collection, options.orderBy, schema)
		}

		const query = this.buildSelectQuery(collection, options)
		const rows = (await this.db.execute(query)) as unknown as Record<string, unknown>[]

		return rows.map((row) => this.deserializeRow(row, collectionDef))
	}

	async findRecord(collection: string, id: string): Promise<MaterializedRecord | null> {
		this.assertOpen()
		await this.ready
		this.assertSchema()
		this.assertCollection(collection)

		const schema = this.schema as SchemaDefinition
		const collectionDef = schema.collections[collection] as NonNullable<
			SchemaDefinition['collections'][string]
		>
		const query = sql`SELECT * FROM ${sql.raw(collection)} WHERE id = ${id} AND _deleted = 0`
		const rows = (await this.db.execute(query)) as unknown as Record<string, unknown>[]

		if (rows.length === 0) return null
		return this.deserializeRow(rows[0] as Record<string, unknown>, collectionDef)
	}

	async countCollection(collection: string, where?: Record<string, unknown>): Promise<number> {
		this.assertOpen()
		await this.ready
		this.assertSchema()
		this.assertCollection(collection)

		const schema = this.schema as SchemaDefinition
		if (where) {
			for (const key of Object.keys(where)) {
				validateFieldName(collection, key, schema)
			}
		}

		const whereClause = this.buildWhereClause(where ?? {}, false)
		const query = sql`SELECT COUNT(*) as cnt FROM ${sql.raw(collection)} WHERE ${whereClause}`
		const rows = (await this.db.execute(query)) as unknown as Array<{ cnt: number | string }>
		const cnt = rows[0]?.cnt
		return typeof cnt === 'string' ? Number.parseInt(cnt, 10) : (cnt ?? 0)
	}

	async close(): Promise<void> {
		this.closed = true
	}

	// ---------------------------------------------------------------------------
	// Materialization internals
	// ---------------------------------------------------------------------------

	/**
	 * Rebuild a single record in the materialized collection table by replaying
	 * all operations for that record.
	 */
	private async rebuildMaterializedRecord(
		txOrDb: PostgresJsDatabase,
		collection: string,
		recordId: string,
	): Promise<void> {
		const collectionDef = this.schema?.collections[collection]
		if (!collectionDef) return

		// Fetch all ops for this specific record, ordered by HLC
		const ops = await txOrDb
			.select({
				type: pgOperations.type,
				data: pgOperations.data,
				wallTime: pgOperations.wallTime,
			})
			.from(pgOperations)
			.where(and(eq(pgOperations.collection, collection), eq(pgOperations.recordId, recordId)))
			.orderBy(
				asc(pgOperations.wallTime),
				asc(pgOperations.logical),
				asc(pgOperations.sequenceNumber),
			)

		// Replay to get current state
		const parsedOps = ops.map((op) => ({
			type: op.type,
			data: op.data !== null ? JSON.parse(op.data) : null,
		}))
		const recordData = replayOperationsForRecord(parsedOps)

		const fieldNames = Object.keys(collectionDef.fields)

		if (recordData) {
			const createdAt = ops.length > 0 ? (ops[0] as (typeof ops)[0]).wallTime : Date.now()
			const updatedAt =
				ops.length > 0 ? (ops[ops.length - 1] as (typeof ops)[0]).wallTime : Date.now()

			await this.upsertMaterializedRecord(
				txOrDb,
				collection,
				recordId,
				recordData,
				fieldNames,
				collectionDef,
				createdAt,
				updatedAt,
			)
		} else {
			await txOrDb.execute(
				sql`UPDATE ${sql.raw(collection)} SET _deleted = 1, _updated_at = ${Date.now()} WHERE id = ${recordId}`,
			)
		}
	}

	/**
	 * UPSERT a record into the materialized collection table.
	 */
	private async upsertMaterializedRecord(
		txOrDb: PostgresJsDatabase,
		tableName: string,
		recordId: string,
		recordData: Record<string, unknown>,
		fieldNames: string[],
		collectionDef: { fields: Record<string, import('@korajs/core').FieldDescriptor> },
		createdAt: number,
		updatedAt: number,
	): Promise<void> {
		const allColumns = ['id', ...fieldNames, '_created_at', '_updated_at', '_deleted']
		const values: unknown[] = [
			recordId,
			...fieldNames.map((f) => {
				const descriptor = collectionDef.fields[f]
				return descriptor ? serializeFieldValue(recordData[f] ?? null, descriptor) : null
			}),
			createdAt,
			updatedAt,
			0,
		]

		const columnsSql = sql.raw(allColumns.join(', '))
		const valuesSql = sql.join(
			values.map((v) => sql`${v}`),
			sql.raw(', '),
		)
		const updateSet = sql.raw(
			allColumns
				.slice(1)
				.map((c) => `${c} = excluded.${c}`)
				.join(', '),
		)

		await txOrDb.execute(
			sql`INSERT INTO ${sql.raw(tableName)} (${columnsSql}) VALUES (${valuesSql}) ON CONFLICT (id) DO UPDATE SET ${updateSet}`,
		)
	}

	/**
	 * Backfill all materialized collection tables from the existing operation log.
	 */
	private async backfillAllCollections(): Promise<void> {
		if (!this.schema) return

		for (const collectionName of Object.keys(this.schema.collections)) {
			await this.backfillCollection(collectionName)
		}
	}

	/**
	 * Backfill a single collection's materialized table from operations.
	 */
	private async backfillCollection(collectionName: string): Promise<void> {
		const collectionDef = this.schema?.collections[collectionName]
		if (!collectionDef) return

		const allOps = await this.db
			.select({
				recordId: pgOperations.recordId,
				type: pgOperations.type,
				data: pgOperations.data,
				wallTime: pgOperations.wallTime,
			})
			.from(pgOperations)
			.where(eq(pgOperations.collection, collectionName))
			.orderBy(
				asc(pgOperations.wallTime),
				asc(pgOperations.logical),
				asc(pgOperations.sequenceNumber),
			)

		if (allOps.length === 0) return

		// Group by recordId
		const grouped = new Map<string, typeof allOps>()
		for (const op of allOps) {
			let group = grouped.get(op.recordId)
			if (!group) {
				group = []
				grouped.set(op.recordId, group)
			}
			group.push(op)
		}

		const fieldNames = Object.keys(collectionDef.fields)

		// Rebuild each record
		for (const [recordId, recordOps] of grouped) {
			const parsedOps = recordOps.map((op) => ({
				type: op.type,
				data: op.data !== null ? JSON.parse(op.data) : null,
			}))
			const recordData = replayOperationsForRecord(parsedOps)

			if (recordData) {
				const createdAt = (recordOps[0] as (typeof recordOps)[0]).wallTime
				const updatedAt = (recordOps[recordOps.length - 1] as (typeof recordOps)[0]).wallTime
				await this.upsertMaterializedRecord(
					this.db,
					collectionName,
					recordId,
					recordData,
					fieldNames,
					collectionDef,
					createdAt,
					updatedAt,
				)
			} else {
				await this.db.execute(
					sql`INSERT INTO ${sql.raw(collectionName)} (id, _deleted, _created_at, _updated_at) VALUES (${recordId}, 1, ${Date.now()}, ${Date.now()}) ON CONFLICT (id) DO UPDATE SET _deleted = 1, _updated_at = ${Date.now()}`,
				)
			}
		}
	}

	// ---------------------------------------------------------------------------
	// Query building
	// ---------------------------------------------------------------------------

	private buildSelectQuery(collection: string, options?: CollectionQueryOptions): SQL {
		const whereClause = this.buildWhereClause(
			options?.where ?? {},
			options?.includeDeleted ?? false,
		)

		const parts: SQL[] = [sql`SELECT * FROM ${sql.raw(collection)} WHERE ${whereClause}`]

		if (options?.orderBy) {
			const dir = options.orderDirection === 'desc' ? 'DESC' : 'ASC'
			parts.push(sql.raw(` ORDER BY ${options.orderBy} ${dir}`))
		}

		if (options?.limit !== undefined) {
			parts.push(sql` LIMIT ${options.limit}`)
		}

		if (options?.offset !== undefined) {
			parts.push(sql` OFFSET ${options.offset}`)
		}

		return sql.join(parts, sql.raw(''))
	}

	private buildWhereClause(where: Record<string, unknown>, includeDeleted: boolean): SQL {
		const conditions: SQL[] = []

		if (!includeDeleted) {
			conditions.push(sql.raw('_deleted = 0'))
		}

		for (const [key, value] of Object.entries(where)) {
			conditions.push(sql`${sql.raw(key)} = ${value}`)
		}

		if (conditions.length === 0) {
			return sql.raw('1 = 1')
		}

		return sql.join(conditions, sql.raw(' AND '))
	}

	// ---------------------------------------------------------------------------
	// Row deserialization
	// ---------------------------------------------------------------------------

	private deserializeRow(
		row: Record<string, unknown>,
		collectionDef: { fields: Record<string, import('@korajs/core').FieldDescriptor> },
	): MaterializedRecord {
		const record: MaterializedRecord = { id: row.id as string }

		for (const [fieldName, descriptor] of Object.entries(collectionDef.fields)) {
			if (fieldName in row) {
				record[fieldName] = deserializeFieldValue(row[fieldName], descriptor)
			}
		}

		if ('_created_at' in row) record._created_at = row._created_at
		if ('_updated_at' in row) record._updated_at = row._updated_at

		return record
	}

	// ---------------------------------------------------------------------------
	// Fallback materialization (operation replay, no schema)
	// ---------------------------------------------------------------------------

	private async materializeFromOpsLog(collection: string): Promise<MaterializedRecord[]> {
		const rows = await this.db
			.select()
			.from(pgOperations)
			.where(eq(pgOperations.collection, collection))
			.orderBy(
				asc(pgOperations.wallTime),
				asc(pgOperations.logical),
				asc(pgOperations.sequenceNumber),
			)

		const records = new Map<string, Record<string, unknown>>()
		const deleted = new Set<string>()

		for (const row of rows) {
			const recordId = row.recordId
			const data = row.data !== null ? JSON.parse(row.data) : null

			switch (row.type) {
				case 'insert':
					if (data) {
						records.set(recordId, { id: recordId, ...data })
						deleted.delete(recordId)
					}
					break
				case 'update':
					if (data) {
						const existing = records.get(recordId) ?? { id: recordId }
						records.set(recordId, { ...existing, ...data })
						deleted.delete(recordId)
					}
					break
				case 'delete':
					deleted.add(recordId)
					break
			}
		}

		for (const id of deleted) {
			records.delete(id)
		}

		return Array.from(records.values()) as MaterializedRecord[]
	}

	// ---------------------------------------------------------------------------
	// Initialization
	// ---------------------------------------------------------------------------

	private async initialize(): Promise<void> {
		await this.ensureTables()

		// Hydrate in-memory version vector cache
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
				wall_time BIGINT NOT NULL,
				logical INTEGER NOT NULL,
				timestamp_node_id TEXT NOT NULL,
				sequence_number INTEGER NOT NULL,
				causal_deps TEXT NOT NULL DEFAULT '[]',
				schema_version INTEGER NOT NULL,
				received_at BIGINT NOT NULL
			)
		`)

		await this.db.execute(
			sql`CREATE INDEX IF NOT EXISTS idx_node_seq ON operations (node_id, sequence_number)`,
		)
		await this.db.execute(sql`CREATE INDEX IF NOT EXISTS idx_collection ON operations (collection)`)
		await this.db.execute(sql`CREATE INDEX IF NOT EXISTS idx_received ON operations (received_at)`)
		// Index for efficient per-record operation lookups during materialization
		await this.db.execute(
			sql`CREATE INDEX IF NOT EXISTS idx_collection_record ON operations (collection, record_id)`,
		)

		await this.db.execute(sql`
			CREATE TABLE IF NOT EXISTS sync_state (
				node_id TEXT PRIMARY KEY,
				max_sequence_number INTEGER NOT NULL,
				last_seen_at BIGINT NOT NULL
			)
		`)
	}

	// ---------------------------------------------------------------------------
	// Operation serialization
	// ---------------------------------------------------------------------------

	private serializeOperation(op: Operation, receivedAt: number): typeof pgOperations.$inferInsert {
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

	// ---------------------------------------------------------------------------
	// Assertions
	// ---------------------------------------------------------------------------

	private assertOpen(): void {
		if (this.closed) {
			throw new Error('PostgresServerStore is closed')
		}
	}

	private assertSchema(): void {
		if (!this.schema) {
			throw new Error(
				'Schema not set. Call setSchema() before using queryCollection/findRecord/countCollection.',
			)
		}
	}

	private assertCollection(collection: string): void {
		const schema = this.schema as SchemaDefinition
		if (!schema.collections[collection]) {
			throw new Error(
				`Unknown collection "${collection}". Available: ${Object.keys(schema.collections).join(', ')}`,
			)
		}
	}
}

/**
 * Creates a PostgresServerStore from a PostgreSQL connection string.
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
