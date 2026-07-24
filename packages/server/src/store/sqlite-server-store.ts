import { createRequire } from 'node:module'
import type { AtomicOp, Operation, SchemaDefinition, VersionVector } from '@korajs/core'
import { generateUUIDv7, quoteIdent } from '@korajs/core'
import type { ApplyResult } from '@korajs/sync'
import type { SQL } from 'drizzle-orm'
import { and, asc, between, count, eq, gt, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { operations, syncState } from './drizzle-schema'
import {
	deserializeFieldValue,
	generateAllCollectionDDL,
	replayOperationsForRecord,
	serializeFieldValue,
	validateFieldName,
} from './materialization'
import type {
	CollectionQueryOptions,
	DeliveredOperation,
	MaterializedRecord,
	ServerStore,
} from './server-store'

// better-sqlite3 is a native CJS addon that cannot be loaded via ESM import().
// createRequire provides a CJS require() that works in both ESM and CJS contexts.
// tsup's shims option ensures import.meta.url is available in CJS builds.
const esmRequire = createRequire(import.meta.url)

/**
 * SQLite-backed server store using Drizzle ORM.
 * Persists operations and version vectors to a real database file,
 * surviving process restarts.
 *
 * When a schema is set via setSchema(), also maintains materialized
 * collection tables for efficient indexed queries (dual-write).
 */
export class SqliteServerStore implements ServerStore {
	private readonly nodeId: string
	private readonly db: BetterSQLite3Database
	private schema: SchemaDefinition | null = null
	private closed = false
	/**
	 * Next delivery sequence to assign. Single-writer (better-sqlite3 is synchronous),
	 * so a plain in-memory counter, seeded from MAX(delivery_seq) at startup, gives
	 * commit-order delivery sequence. Assigned inside the append transaction.
	 */
	private deliverySeqCounter = 0

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

	getSchema(): SchemaDefinition | null {
		return this.schema
	}

	async setSchema(schema: SchemaDefinition): Promise<void> {
		this.assertOpen()
		this.schema = schema

		// Generate and execute DDL for all collection tables
		const ddlStatements = generateAllCollectionDDL(schema, 'sqlite')
		for (const stmt of ddlStatements) {
			if (stmt.startsWith('--kora:safe-alter')) {
				const alterSql = stmt.replace('--kora:safe-alter\n', '')
				try {
					this.db.run(sql.raw(alterSql))
				} catch (e) {
					// Ignore "duplicate column" errors from safe ALTER TABLE.
					// Drizzle wraps SQLite errors, so check both outer message and cause.
					const msg = e instanceof Error ? e.message : ''
					const causeMsg = e instanceof Error && e.cause instanceof Error ? e.cause.message : ''
					if (!msg.includes('duplicate column') && !causeMsg.includes('duplicate column')) {
						throw e
					}
				}
			} else {
				this.db.run(sql.raw(stmt))
			}
		}

		// Backfill materialized tables from existing operations
		await this.backfillAllCollections()
	}

	async applyRemoteOperation(op: Operation): Promise<ApplyResult> {
		this.assertOpen()

		const now = Date.now()

		// Use a transaction for atomicity: insert op + update version vector + materialize
		const result = this.db.transaction((tx) => {
			// Content-addressed dedup: check before assigning a delivery sequence so a
			// duplicate never burns one (keeps the sequence gap-free on this store).
			const existing = tx.all<{ id: string }>(
				sql`SELECT id FROM operations WHERE id = ${op.id} LIMIT 1`,
			)
			if (existing.length > 0) {
				return 'duplicate' as const
			}

			// Assign the next delivery sequence in commit order (single-writer: no race).
			this.deliverySeqCounter += 1
			const row = this.serializeOperation(op, now, this.deliverySeqCounter)
			tx.insert(operations).values(row).run()

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

			// Dual-write: update materialized collection table if schema is set
			if (this.schema?.collections[op.collection]) {
				this.rebuildMaterializedRecord(tx, op.collection, op.recordId)
			}

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

	async getMaxDeliverySequence(): Promise<number> {
		this.assertOpen()
		const rows = this.db.all<{ m: number | null }>(
			sql`SELECT MAX(delivery_seq) AS m FROM operations`,
		)
		return rows[0]?.m ?? 0
	}

	async getOperationsAfterDelivery(
		afterDeliverySequence: number,
		limit: number,
	): Promise<DeliveredOperation[]> {
		this.assertOpen()
		const rows = this.db
			.select()
			.from(operations)
			.where(gt(operations.deliverySeq, afterDeliverySequence))
			.orderBy(asc(operations.deliverySeq))
			.limit(limit)
			.all()
		return rows.map((row) => ({
			operation: this.deserializeOperation(row),
			deliverySequence: row.deliverySeq ?? 0,
		}))
	}

	async materializeCollection(collection: string): Promise<MaterializedRecord[]> {
		this.assertOpen()

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
		const rows = this.db.all<Record<string, unknown>>(query)

		return rows.map((row) => this.deserializeRow(row, collectionDef))
	}

	async findRecord(collection: string, id: string): Promise<MaterializedRecord | null> {
		this.assertOpen()
		this.assertSchema()
		this.assertCollection(collection)

		const schema = this.schema as SchemaDefinition
		const collectionDef = schema.collections[collection] as NonNullable<
			SchemaDefinition['collections'][string]
		>
		const query = sql`SELECT * FROM ${sql.raw(quoteIdent(collection))} WHERE id = ${id} AND _deleted = 0`
		const rows = this.db.all<Record<string, unknown>>(query)

		if (rows.length === 0) return null
		return this.deserializeRow(rows[0] as Record<string, unknown>, collectionDef)
	}

	async countCollection(collection: string, where?: Record<string, unknown>): Promise<number> {
		this.assertOpen()
		this.assertSchema()
		this.assertCollection(collection)

		const schema = this.schema as SchemaDefinition
		if (where) {
			for (const key of Object.keys(where)) {
				validateFieldName(collection, key, schema)
			}
		}

		const whereClause = this.buildWhereClause(where ?? {}, false)
		const query = sql`SELECT COUNT(*) as cnt FROM ${sql.raw(quoteIdent(collection))} WHERE ${whereClause}`
		const rows = this.db.all<{ cnt: number }>(query)
		return rows[0]?.cnt ?? 0
	}

	async close(): Promise<void> {
		this.closed = true
	}

	async exportBackup(): Promise<Uint8Array> {
		this.assertOpen()

		const { buildServerBackup } = await import('./server-backup')
		// Export in delivery-sequence (commit) order so a restore reassigns delivery
		// sequences causally; an implicit scan order must not be relied on.
		const rows = this.db.select().from(operations).orderBy(asc(operations.deliverySeq)).all()
		const deserialized = rows.map((row) => this.deserializeOperation(row))
		const vv = this.getVersionVector()

		return buildServerBackup(this.nodeId, deserialized, vv)
	}

	async importBackup(
		data: Uint8Array,
		merge?: boolean,
	): Promise<{ operationsRestored: number; success: boolean }> {
		this.assertOpen()

		const { parseServerBackup } = await import('./server-backup')
		const { operations: ops, versionVector } = parseServerBackup(data)

		if (merge) {
			let restored = 0
			for (const op of ops) {
				const result = await this.applyRemoteOperation(op)
				if (result === 'applied') restored++
			}
			return { operationsRestored: restored, success: true }
		}

		// Replace mode: DROP and recreate
		this.db.transaction((tx) => {
			tx.run(sql.raw('DELETE FROM operations'))
			tx.run(sql.raw('DELETE FROM sync_state'))

			for (const [nid, seq] of versionVector) {
				tx.insert(syncState)
					.values({ nodeId: nid, maxSequenceNumber: seq, lastSeenAt: Date.now() })
					.run()
			}

			// Re-assign delivery sequence from scratch in backup order.
			let deliverySeq = 0
			for (const op of ops) {
				deliverySeq += 1
				const row = this.serializeOperation(op, Date.now(), deliverySeq)
				tx.insert(operations).values(row).run()
			}
			this.deliverySeqCounter = deliverySeq
		})

		return { operationsRestored: ops.length, success: true }
	}

	// ---------------------------------------------------------------------------
	// Materialization internals
	// ---------------------------------------------------------------------------

	/**
	 * Rebuild a single record in the materialized collection table by replaying
	 * all operations for that record. Called within the applyRemoteOperation
	 * transaction for atomic dual-write.
	 */
	private rebuildMaterializedRecord(
		txOrDb: BetterSQLite3Database,
		collection: string,
		recordId: string,
	): void {
		const collectionDef = this.schema?.collections[collection]
		if (!collectionDef) return

		// Fetch all ops for this specific record, in HLC total order (wallTime,
		// logical, nodeId) so atomic composition and LWW converge like the merge engine.
		const ops = txOrDb
			.select({
				type: operations.type,
				data: operations.data,
				atomicOps: operations.atomicOps,
				wallTime: operations.wallTime,
			})
			.from(operations)
			.where(and(eq(operations.collection, collection), eq(operations.recordId, recordId)))
			.orderBy(asc(operations.wallTime), asc(operations.logical), asc(operations.timestampNodeId))
			.all()

		// Replay to get current state
		const parsedOps = ops.map((op) => ({
			type: op.type,
			data: op.data !== null ? JSON.parse(op.data) : null,
			atomicOps:
				op.atomicOps != null ? (JSON.parse(op.atomicOps) as Record<string, AtomicOp>) : null,
		}))
		const recordData = replayOperationsForRecord(parsedOps)

		const fieldNames = Object.keys(collectionDef.fields)

		if (recordData) {
			// Compute timestamps from operations
			const createdAt = ops.length > 0 ? (ops[0] as (typeof ops)[0]).wallTime : Date.now()
			const updatedAt =
				ops.length > 0 ? (ops[ops.length - 1] as (typeof ops)[0]).wallTime : Date.now()

			this.upsertMaterializedRecord(
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
			// Record was deleted — soft-delete in materialized table
			txOrDb.run(
				sql`UPDATE ${sql.raw(quoteIdent(collection))} SET _deleted = 1, _updated_at = ${Date.now()} WHERE id = ${recordId}`,
			)
		}
	}

	/**
	 * UPSERT a record into the materialized collection table.
	 * Uses INSERT ... ON CONFLICT (id) DO UPDATE SET for atomic upsert.
	 */
	private upsertMaterializedRecord(
		txOrDb: BetterSQLite3Database,
		tableName: string,
		recordId: string,
		recordData: Record<string, unknown>,
		fieldNames: string[],
		collectionDef: { fields: Record<string, import('@korajs/core').FieldDescriptor> },
		createdAt: number,
		updatedAt: number,
	): void {
		const allColumns = ['id', ...fieldNames, '_created_at', '_updated_at', '_deleted']
		const values: unknown[] = [
			recordId,
			...fieldNames.map((f) => {
				const descriptor = collectionDef.fields[f]
				return descriptor ? serializeFieldValue(recordData[f] ?? null, descriptor) : null
			}),
			createdAt,
			updatedAt,
			0, // _deleted = false
		]

		const columnsSql = sql.raw(allColumns.map((c) => quoteIdent(c)).join(', '))
		const valuesSql = sql.join(
			values.map((v) => sql`${v}`),
			sql.raw(', '),
		)
		const updateSet = sql.raw(
			allColumns
				.slice(1)
				.map((c) => `${quoteIdent(c)} = excluded.${quoteIdent(c)}`)
				.join(', '),
		)

		txOrDb.run(
			sql`INSERT INTO ${sql.raw(quoteIdent(tableName))} (${columnsSql}) VALUES (${valuesSql}) ON CONFLICT (id) DO UPDATE SET ${updateSet}`,
		)
	}

	/**
	 * Backfill all materialized collection tables from the existing operation log.
	 * Called when setSchema() is invoked and operations already exist.
	 */
	private async backfillAllCollections(): Promise<void> {
		if (!this.schema) return

		for (const collectionName of Object.keys(this.schema.collections)) {
			this.backfillCollection(collectionName)
		}
	}

	/**
	 * Backfill a single collection's materialized table from operations.
	 */
	private backfillCollection(collectionName: string): void {
		const collectionDef = this.schema?.collections[collectionName]
		if (!collectionDef) return

		// Fetch all ops for this collection, in HLC total order (wallTime, logical, nodeId).
		const allOps = this.db
			.select({
				recordId: operations.recordId,
				type: operations.type,
				data: operations.data,
				atomicOps: operations.atomicOps,
				wallTime: operations.wallTime,
			})
			.from(operations)
			.where(eq(operations.collection, collectionName))
			.orderBy(asc(operations.wallTime), asc(operations.logical), asc(operations.timestampNodeId))
			.all()

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

		// Rebuild each record inside a single transaction for efficiency
		const fieldNames = Object.keys(collectionDef.fields)
		this.db.transaction((tx) => {
			for (const [recordId, recordOps] of grouped) {
				const parsedOps = recordOps.map((op) => ({
					type: op.type,
					data: op.data !== null ? JSON.parse(op.data) : null,
					atomicOps:
						op.atomicOps != null ? (JSON.parse(op.atomicOps) as Record<string, AtomicOp>) : null,
				}))
				const recordData = replayOperationsForRecord(parsedOps)

				if (recordData) {
					const createdAt = (recordOps[0] as (typeof recordOps)[0]).wallTime
					const updatedAt = (recordOps[recordOps.length - 1] as (typeof recordOps)[0]).wallTime
					this.upsertMaterializedRecord(
						tx,
						collectionName,
						recordId,
						recordData,
						fieldNames,
						collectionDef,
						createdAt,
						updatedAt,
					)
				} else {
					tx.run(
						sql`INSERT INTO ${sql.raw(quoteIdent(collectionName))} (id, _deleted, _created_at, _updated_at) VALUES (${recordId}, 1, ${Date.now()}, ${Date.now()}) ON CONFLICT (id) DO UPDATE SET _deleted = 1, _updated_at = ${Date.now()}`,
					)
				}
			}
		})
	}

	// ---------------------------------------------------------------------------
	// Query building
	// ---------------------------------------------------------------------------

	private buildSelectQuery(collection: string, options?: CollectionQueryOptions): SQL {
		const whereClause = this.buildWhereClause(
			options?.where ?? {},
			options?.includeDeleted ?? false,
		)

		const parts: SQL[] = [
			sql`SELECT * FROM ${sql.raw(quoteIdent(collection))} WHERE ${whereClause}`,
		]

		if (options?.orderBy) {
			const dir = options.orderDirection === 'desc' ? 'DESC' : 'ASC'
			parts.push(sql.raw(` ORDER BY ${quoteIdent(options.orderBy)} ${dir}`))
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
			conditions.push(sql`${sql.raw(quoteIdent(key))} = ${value}`)
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

		// Include metadata fields
		if ('_created_at' in row) record._created_at = row._created_at
		if ('_updated_at' in row) record._updated_at = row._updated_at

		return record
	}

	// ---------------------------------------------------------------------------
	// Fallback materialization (operation replay, no schema)
	// ---------------------------------------------------------------------------

	private materializeFromOpsLog(collection: string): MaterializedRecord[] {
		const rows = this.db
			.select()
			.from(operations)
			.where(eq(operations.collection, collection))
			.orderBy(asc(operations.wallTime), asc(operations.logical), asc(operations.sequenceNumber))
			.all()

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
	// Table setup
	// ---------------------------------------------------------------------------

	/**
	 * Create the operations and sync_state tables if they don't exist.
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
				atomic_ops TEXT,
				wall_time INTEGER NOT NULL,
				logical INTEGER NOT NULL,
				timestamp_node_id TEXT NOT NULL,
				sequence_number INTEGER NOT NULL,
				causal_deps TEXT NOT NULL DEFAULT '[]',
				schema_version INTEGER NOT NULL,
				received_at INTEGER NOT NULL
			)
		`)

		// Backward-compatible migration: add atomic_ops to operation logs created
		// before atomic-op persistence. Nullable, so existing rows read as "no atomic
		// ops" and keep materializing by last-write-wins exactly as before. SQLite has
		// no ADD COLUMN IF NOT EXISTS, so tolerate the duplicate-column error on re-run.
		try {
			this.db.run(sql`ALTER TABLE operations ADD COLUMN atomic_ops TEXT`)
		} catch (e) {
			const msg = e instanceof Error ? e.message : ''
			const causeMsg = e instanceof Error && e.cause instanceof Error ? e.cause.message : ''
			if (!msg.includes('duplicate column') && !causeMsg.includes('duplicate column')) {
				throw e
			}
		}

		// Backward-compatible migration: add the delivery_seq column for the gap-free
		// delivery watermark. SQLite has no ADD COLUMN IF NOT EXISTS, so tolerate the
		// duplicate-column error on re-run.
		try {
			this.db.run(sql`ALTER TABLE operations ADD COLUMN delivery_seq INTEGER`)
		} catch (e) {
			const msg = e instanceof Error ? e.message : ''
			const causeMsg = e instanceof Error && e.cause instanceof Error ? e.cause.message : ''
			if (!msg.includes('duplicate column') && !causeMsg.includes('duplicate column')) {
				throw e
			}
		}

		this.db.run(sql`
			CREATE INDEX IF NOT EXISTS idx_node_seq ON operations (node_id, sequence_number)
		`)

		this.db.run(sql`
			CREATE INDEX IF NOT EXISTS idx_delivery_seq ON operations (delivery_seq)
		`)

		this.db.run(sql`
			CREATE INDEX IF NOT EXISTS idx_collection ON operations (collection)
		`)

		this.db.run(sql`
			CREATE INDEX IF NOT EXISTS idx_received ON operations (received_at)
		`)

		// Index for efficient per-record operation lookups during materialization
		this.db.run(sql`
			CREATE INDEX IF NOT EXISTS idx_collection_record ON operations (collection, record_id)
		`)

		this.db.run(sql`
			CREATE TABLE IF NOT EXISTS sync_state (
				node_id TEXT PRIMARY KEY,
				max_sequence_number INTEGER NOT NULL,
				last_seen_at INTEGER NOT NULL
			)
		`)

		this.backfillDeliverySequence()
	}

	/**
	 * Assign delivery sequences to any operations written before the column existed,
	 * then seed the in-memory counter from the current max. Ordered by
	 * (received_at, sequence_number, id) so the backfill is deterministic and stable
	 * across restarts. A one-time migration: after it runs, all rows have a value.
	 */
	private backfillDeliverySequence(): void {
		this.db.transaction((tx) => {
			const maxRow = tx.all<{ m: number | null }>(
				sql`SELECT MAX(delivery_seq) AS m FROM operations`,
			)
			let next = maxRow[0]?.m ?? 0
			const nullRows = tx.all<{ id: string }>(
				sql`SELECT id FROM operations WHERE delivery_seq IS NULL ORDER BY received_at ASC, sequence_number ASC, id ASC`,
			)
			for (const row of nullRows) {
				next += 1
				tx.run(sql`UPDATE operations SET delivery_seq = ${next} WHERE id = ${row.id}`)
			}
			this.deliverySeqCounter = next
		})
	}

	// ---------------------------------------------------------------------------
	// Operation serialization
	// ---------------------------------------------------------------------------

	private serializeOperation(
		op: Operation,
		receivedAt: number,
		deliverySeq: number,
	): typeof operations.$inferInsert {
		return {
			id: op.id,
			nodeId: op.nodeId,
			type: op.type,
			collection: op.collection,
			recordId: op.recordId,
			data: op.data !== null ? JSON.stringify(op.data) : null,
			previousData: op.previousData !== null ? JSON.stringify(op.previousData) : null,
			atomicOps:
				op.atomicOps && Object.keys(op.atomicOps).length > 0 ? JSON.stringify(op.atomicOps) : null,
			wallTime: op.timestamp.wallTime,
			logical: op.timestamp.logical,
			timestampNodeId: op.timestamp.nodeId,
			sequenceNumber: op.sequenceNumber,
			causalDeps: JSON.stringify(op.causalDeps),
			schemaVersion: op.schemaVersion,
			receivedAt,
			deliverySeq,
		}
	}

	private deserializeOperation(row: typeof operations.$inferSelect): Operation {
		const atomicOps =
			row.atomicOps != null ? (JSON.parse(row.atomicOps) as Record<string, AtomicOp>) : undefined
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
			...(atomicOps ? { atomicOps } : {}),
		}
	}

	// ---------------------------------------------------------------------------
	// Assertions
	// ---------------------------------------------------------------------------

	private assertOpen(): void {
		if (this.closed) {
			throw new Error('SqliteServerStore is closed')
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
 * import { createSqliteServerStore } from '@korajs/server'
 *
 * const store = createSqliteServerStore({ filename: './kora-server.db' })
 *
 * // Optional: enable materialized collection tables for fast queries
 * await store.setSchema(mySchema)
 *
 * const server = createKoraServer({ store, port: 3001 })
 * ```
 */
export function createSqliteServerStore(options: {
	filename?: string
	nodeId?: string
}): SqliteServerStore {
	// better-sqlite3 is a native CJS addon — use esmRequire (from createRequire)
	// so this works in both ESM and CJS contexts.
	const Database = esmRequire('better-sqlite3')
	const { drizzle } = esmRequire('drizzle-orm/better-sqlite3')

	const filename = options.filename ?? ':memory:'
	const sqlite = new Database(filename)

	// Enable WAL mode for better concurrent read/write performance
	sqlite.pragma('journal_mode = WAL')

	const db = drizzle(sqlite)
	return new SqliteServerStore(db, options.nodeId)
}
