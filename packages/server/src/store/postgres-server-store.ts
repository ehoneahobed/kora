import type {
	AtomicOp,
	HLCTimestamp,
	Operation,
	SchemaDefinition,
	TimeSource,
	VersionVector,
} from '@korajs/core'
import { HybridLogicalClock, generateUUIDv7, quoteIdent } from '@korajs/core'
import type { ApplyResult } from '@korajs/sync'
import type { SQL } from 'drizzle-orm'
import { and, asc, between, count, desc, eq, gt, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { pgOperations, pgSyncState } from './drizzle-pg-schema'
import {
	deserializeFieldValue,
	generateAllCollectionDDL,
	replayOperationsForRecord,
	serializeFieldValue,
	validateFieldName,
} from './materialization'
import type {
	CollectionQueryOptions,
	ConditionalApplyInput,
	ConditionalApplyResult,
	DeliveredOperation,
	MaterializedRecord,
	ServerStore,
} from './server-store'

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
	/**
	 * Monotonic counter for this node's server-originated sequence numbers. Lazily
	 * seeded from the persisted version vector on first use, then advanced in memory
	 * (a synchronous `++`, atomic on the single JS thread) so concurrent conditional
	 * applies never receive the same number. Null means "not yet seeded"; reset to
	 * null after a backup import so it re-seeds from the restored version vector.
	 */
	private sequenceCounter: number | null = null
	/**
	 * Time source for HLC timestamps on server-originated operations. Injectable so a
	 * test can freeze wall-clock time and prove the conditional-apply ordering holds
	 * under same-millisecond commits (the case the advisory lock and clock advance
	 * exist to make correct). Defaults to the system clock in production.
	 */
	private readonly timeSource: TimeSource

	constructor(db: PostgresJsDatabase, nodeId?: string, timeSource?: TimeSource) {
		this.db = db
		this.nodeId = nodeId ?? generateUUIDv7()
		this.timeSource = timeSource ?? { now: () => Date.now() }
		this.ready = this.initialize()
	}

	getVersionVector(): VersionVector {
		this.assertOpen()
		return new Map(this.versionVector)
	}

	/**
	 * Atomically reserve this node's next server-operation sequence number. The
	 * synchronous increment cannot interleave on the single JS thread, so two
	 * concurrent conditional applies are always handed distinct numbers.
	 */
	reserveSequenceNumber(): number {
		if (this.sequenceCounter === null) {
			this.sequenceCounter = this.versionVector.get(this.nodeId) ?? 0
		}
		this.sequenceCounter += 1
		return this.sequenceCounter
	}

	getNodeId(): string {
		return this.nodeId
	}

	getSchema(): SchemaDefinition | null {
		return this.schema
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

		await this.db.transaction(async (tx) => {
			// Assign the delivery sequence in commit order (see nextDeliverySeq). A rare
			// concurrent duplicate insert below no-ops and simply leaves a harmless gap.
			const deliverySeq = await this.nextDeliverySeq(tx)
			const row = this.serializeOperation(op, now, deliverySeq)

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

	/**
	 * Conditionally apply operations atomically, serialized across server instances
	 * on the target record via a transaction-scoped advisory lock. The lock makes
	 * the read-decide-write cycle atomic against concurrent instances, so a cap
	 * check like `responseCount < max` cannot be passed by two admissions at once.
	 */
	async applyConditional(input: ConditionalApplyInput): Promise<ConditionalApplyResult> {
		this.assertOpen()
		await this.ready
		this.assertSchema()
		this.assertCollection(input.target.collection)

		const schema = this.schema as SchemaDefinition
		const collectionDef = schema.collections[input.target.collection] as NonNullable<
			SchemaDefinition['collections'][string]
		>
		const lockKey = `kora:${input.target.collection}:${input.target.id}`

		const result = await this.db.transaction(async (tx) => {
			// Serialize this target across every server instance sharing the database.
			// hashtextextended maps the key to the bigint pg_advisory_xact_lock expects;
			// the lock releases automatically when the transaction ends.
			await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`)

			// Idempotency: if the key record already exists (from an earlier attempt),
			// this set is already committed. Checked under the lock so a retry racing a
			// first attempt on another instance still resolves to at-most-once.
			if (input.idempotencyKey) {
				const existing = (await tx.execute(
					sql`SELECT 1 FROM ${sql.raw(quoteIdent(input.idempotencyKey.collection))} WHERE id = ${input.idempotencyKey.id} AND _deleted = 0 LIMIT 1`,
				)) as unknown as unknown[]
				if (existing.length > 0) {
					return { admitted: true, idempotent: true, applied: [] as Operation[] }
				}
			}

			const rows = (await tx.execute(
				sql`SELECT * FROM ${sql.raw(quoteIdent(input.target.collection))} WHERE id = ${input.target.id} AND _deleted = 0`,
			)) as unknown as Record<string, unknown>[]
			const current =
				rows.length > 0
					? this.deserializeRow(rows[0] as Record<string, unknown>, collectionDef)
					: null

			if (!input.admit(current)) {
				return { admitted: false, idempotent: false, applied: [] as Operation[] }
			}

			// Seed a clock past the target record's latest committed operation so the
			// operations built next sort strictly after every prior write to it. Under
			// the advisory lock this makes last-write-wins materialization agree with the
			// serialized commit order, so a same-millisecond commit on another instance
			// cannot cause the counter to be undercounted (which would admit past a cap).
			const clock = new HybridLogicalClock(this.nodeId, this.timeSource)
			const latest = await this.latestOperationTimestamp(
				tx,
				input.target.collection,
				input.target.id,
			)
			if (latest) {
				clock.advanceTo(latest)
			}

			const ops = await input.buildOperations(current, { clock })
			const now = Date.now()
			for (const op of ops) {
				const deliverySeq = await this.nextDeliverySeq(tx)
				const row = this.serializeOperation(op, now, deliverySeq)
				await tx.insert(pgOperations).values(row).onConflictDoNothing({ target: pgOperations.id })
				await tx
					.insert(pgSyncState)
					.values({ nodeId: op.nodeId, maxSequenceNumber: op.sequenceNumber, lastSeenAt: now })
					.onConflictDoUpdate({
						target: pgSyncState.nodeId,
						set: {
							maxSequenceNumber: sql`GREATEST(${pgSyncState.maxSequenceNumber}, ${op.sequenceNumber})`,
							lastSeenAt: sql`${now}`,
						},
					})
				if (this.schema?.collections[op.collection]) {
					await this.rebuildMaterializedRecord(tx, op.collection, op.recordId)
				}
			}
			return { admitted: true, idempotent: false, applied: ops }
		})

		// Advance the in-memory version vector cache after commit.
		for (const op of result.applied) {
			const currentMax = this.versionVector.get(op.nodeId) ?? 0
			if (op.sequenceNumber > currentMax) {
				this.versionVector.set(op.nodeId, op.sequenceNumber)
			}
		}
		return result
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

	async getMaxDeliverySequence(): Promise<number> {
		this.assertOpen()
		await this.ready
		const rows = (await this.db.execute(
			sql`SELECT COALESCE(MAX(delivery_seq), 0) AS m FROM operations`,
		)) as unknown as { m: number | string | bigint }[]
		return Number(rows[0]?.m ?? 0)
	}

	async getOperationsAfterDelivery(
		afterDeliverySequence: number,
		limit: number,
	): Promise<DeliveredOperation[]> {
		this.assertOpen()
		await this.ready
		const rows = await this.db
			.select()
			.from(pgOperations)
			.where(gt(pgOperations.deliverySeq, afterDeliverySequence))
			.orderBy(asc(pgOperations.deliverySeq))
			.limit(limit)
		return rows.map((row) => ({
			operation: this.deserializeOperation(row),
			deliverySequence: row.deliverySeq ?? 0,
		}))
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
		const query = sql`SELECT * FROM ${sql.raw(quoteIdent(collection))} WHERE id = ${id} AND _deleted = 0`
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
		const query = sql`SELECT COUNT(*) as cnt FROM ${sql.raw(quoteIdent(collection))} WHERE ${whereClause}`
		const rows = (await this.db.execute(query)) as unknown as Array<{ cnt: number | string }>
		const cnt = rows[0]?.cnt
		return typeof cnt === 'string' ? Number.parseInt(cnt, 10) : (cnt ?? 0)
	}

	async close(): Promise<void> {
		this.closed = true
	}

	async exportBackup(): Promise<Uint8Array> {
		this.assertOpen()
		await this.ready

		const { buildServerBackup } = await import('./server-backup')

		// Export in delivery-sequence order (commit order), NOT sequenceNumber order.
		// sequenceNumber is per-node and interleaves nodes arbitrarily, which can place a
		// dependent operation before its dependency; restoring in that order would then
		// reassign delivery sequences non-causally, so a resumed client would receive the
		// dependent first, defer it, advance its watermark past it, and lose it. Delivery
		// order is commit order and therefore respects causality.
		const rows = await this.db.select().from(pgOperations).orderBy(asc(pgOperations.deliverySeq))
		const operations = rows.map((row) => this.deserializeOperation(row))

		return buildServerBackup(this.nodeId, operations, this.versionVector)
	}

	async importBackup(
		data: Uint8Array,
		merge?: boolean,
	): Promise<{ operationsRestored: number; success: boolean }> {
		this.assertOpen()
		await this.ready

		const { parseServerBackup } = await import('./server-backup')
		const { operations, versionVector } = parseServerBackup(data)

		if (merge) {
			let restored = 0
			for (const op of operations) {
				const result = await this.applyRemoteOperation(op)
				if (result === 'applied') restored++
			}
			// Re-seed the sequence counter from the (possibly advanced) version vector,
			// in case the merge restored operations on this node with higher numbers.
			this.sequenceCounter = null
			return { operationsRestored: restored, success: true }
		}

		const now = Date.now()
		await this.db.transaction(async (tx) => {
			await tx.delete(pgOperations)
			await tx.delete(pgSyncState)

			for (const [nid, seq] of versionVector) {
				await tx
					.insert(pgSyncState)
					.values({ nodeId: nid, maxSequenceNumber: seq, lastSeenAt: now })
					.onConflictDoNothing({ target: pgSyncState.nodeId })
			}

			// Re-assign delivery sequence from scratch in backup order, then realign the
			// counter so future appends continue above the restored maximum.
			let deliverySeq = 0
			for (const op of operations) {
				deliverySeq += 1
				const row = this.serializeOperation(op, now, deliverySeq)
				await tx.insert(pgOperations).values(row).onConflictDoNothing({ target: pgOperations.id })
			}
			await tx.execute(
				sql`INSERT INTO delivery_counter (id, value) VALUES (1, ${deliverySeq})
					ON CONFLICT (id) DO UPDATE SET value = ${deliverySeq}`,
			)
		})

		// Rebuild in-memory version vector
		this.versionVector.clear()
		for (const [nid, seq] of versionVector) {
			this.versionVector.set(nid, seq)
		}
		// Re-seed the sequence counter from the restored version vector.
		this.sequenceCounter = null

		return { operationsRestored: operations.length, success: true }
	}

	// ---------------------------------------------------------------------------
	// Materialization internals
	// ---------------------------------------------------------------------------

	/**
	 * The HLC timestamp of the most recent operation on a record, by total order
	 * (wallTime, logical, nodeId), or null when the record has no operations. Used
	 * by {@link applyConditional} to advance its clock past the record's latest
	 * write so newly built operations sort strictly after it.
	 */
	private async latestOperationTimestamp(
		txOrDb: PostgresJsDatabase,
		collection: string,
		recordId: string,
	): Promise<HLCTimestamp | null> {
		const rows = await txOrDb
			.select({
				wallTime: pgOperations.wallTime,
				logical: pgOperations.logical,
				timestampNodeId: pgOperations.timestampNodeId,
			})
			.from(pgOperations)
			.where(and(eq(pgOperations.collection, collection), eq(pgOperations.recordId, recordId)))
			.orderBy(
				desc(pgOperations.wallTime),
				desc(pgOperations.logical),
				desc(pgOperations.timestampNodeId),
			)
			.limit(1)

		const row = rows[0]
		if (!row) {
			return null
		}
		return { wallTime: row.wallTime, logical: row.logical, nodeId: row.timestampNodeId }
	}

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
				atomicOps: pgOperations.atomicOps,
				wallTime: pgOperations.wallTime,
			})
			.from(pgOperations)
			.where(and(eq(pgOperations.collection, collection), eq(pgOperations.recordId, recordId)))
			// HLC total order (wallTime, logical, nodeId) so atomic composition and LWW
			// see operations in exactly the order the merge engine converges them.
			.orderBy(
				asc(pgOperations.wallTime),
				asc(pgOperations.logical),
				asc(pgOperations.timestampNodeId),
			)

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
				sql`UPDATE ${sql.raw(quoteIdent(collection))} SET _deleted = 1, _updated_at = ${Date.now()} WHERE id = ${recordId}`,
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

		await txOrDb.execute(
			sql`INSERT INTO ${sql.raw(quoteIdent(tableName))} (${columnsSql}) VALUES (${valuesSql}) ON CONFLICT (id) DO UPDATE SET ${updateSet}`,
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
				atomicOps: pgOperations.atomicOps,
				wallTime: pgOperations.wallTime,
			})
			.from(pgOperations)
			.where(eq(pgOperations.collection, collectionName))
			// HLC total order (wallTime, logical, nodeId) for correct atomic composition.
			.orderBy(
				asc(pgOperations.wallTime),
				asc(pgOperations.logical),
				asc(pgOperations.timestampNodeId),
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
				atomicOps:
					op.atomicOps != null ? (JSON.parse(op.atomicOps) as Record<string, AtomicOp>) : null,
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
					sql`INSERT INTO ${sql.raw(quoteIdent(collectionName))} (id, _deleted, _created_at, _updated_at) VALUES (${recordId}, 1, ${Date.now()}, ${Date.now()}) ON CONFLICT (id) DO UPDATE SET _deleted = 1, _updated_at = ${Date.now()}`,
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
		// Serialize all schema setup across instances with an advisory transaction lock.
		// `CREATE TABLE IF NOT EXISTS` is not atomic in Postgres: two servers cold-starting
		// against the same empty database race and one fails with a duplicate-type error.
		// Running every setup statement in one advisory-locked transaction makes concurrent
		// startup safe and also serializes the delivery-sequence backfill.
		await this.db.transaction(async (tx) => {
			await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('kora:ensure-tables', 0))`)

			await tx.execute(sql`
				CREATE TABLE IF NOT EXISTS operations (
					id TEXT PRIMARY KEY,
					node_id TEXT NOT NULL,
					type TEXT NOT NULL,
					collection TEXT NOT NULL,
					record_id TEXT NOT NULL,
					data TEXT,
					previous_data TEXT,
					atomic_ops TEXT,
					wall_time BIGINT NOT NULL,
					logical INTEGER NOT NULL,
					timestamp_node_id TEXT NOT NULL,
					sequence_number INTEGER NOT NULL,
					causal_deps TEXT NOT NULL DEFAULT '[]',
					schema_version INTEGER NOT NULL,
					received_at BIGINT NOT NULL
				)
			`)

			// Backward-compatible migration: add atomic_ops to operation logs created
			// before atomic-op persistence. Nullable, so existing rows read as "no atomic
			// ops" and keep materializing by last-write-wins exactly as before.
			await tx.execute(sql`ALTER TABLE operations ADD COLUMN IF NOT EXISTS atomic_ops TEXT`)

			// Backward-compatible migration: add the delivery_seq column for the gap-free
			// delivery watermark.
			await tx.execute(sql`ALTER TABLE operations ADD COLUMN IF NOT EXISTS delivery_seq BIGINT`)

			await tx.execute(
				sql`CREATE INDEX IF NOT EXISTS idx_node_seq ON operations (node_id, sequence_number)`,
			)
			await tx.execute(sql`CREATE INDEX IF NOT EXISTS idx_collection ON operations (collection)`)
			await tx.execute(sql`CREATE INDEX IF NOT EXISTS idx_received ON operations (received_at)`)
			await tx.execute(
				sql`CREATE INDEX IF NOT EXISTS idx_delivery_seq ON operations (delivery_seq)`,
			)
			// Index for efficient per-record operation lookups during materialization
			await tx.execute(
				sql`CREATE INDEX IF NOT EXISTS idx_collection_record ON operations (collection, record_id)`,
			)

			await tx.execute(sql`
				CREATE TABLE IF NOT EXISTS sync_state (
					node_id TEXT PRIMARY KEY,
					max_sequence_number INTEGER NOT NULL,
					last_seen_at BIGINT NOT NULL
				)
			`)

			// Counter row that assigns delivery sequences in commit order. Every append
			// does `UPDATE ... value = value + 1 RETURNING value` inside its transaction,
			// which holds an exclusive row lock until commit. So a later assigner cannot
			// obtain its number until the earlier one has committed: delivery-sequence
			// order equals commit (visibility) order, which is what makes a `> watermark`
			// stream provably gap-free across instances. This serializes appends through
			// one row (correctness over throughput, per the framework's priorities).
			await tx.execute(sql`
				CREATE TABLE IF NOT EXISTS delivery_counter (
					id INTEGER PRIMARY KEY,
					value BIGINT NOT NULL
				)
			`)

			// Backfill any pre-column rows deterministically, then seed the counter to the
			// resulting maximum. Under the advisory lock two starting servers cannot
			// double-assign. The window scan touches only rows lacking a sequence, so a
			// fresh or already-migrated table does almost no work here.
			await tx.execute(sql`
				WITH ordered AS (
					SELECT id, ROW_NUMBER() OVER (
						ORDER BY received_at ASC, sequence_number ASC, id ASC
					) + COALESCE((SELECT MAX(delivery_seq) FROM operations), 0) AS rn
					FROM operations WHERE delivery_seq IS NULL
				)
				UPDATE operations o SET delivery_seq = ordered.rn
				FROM ordered WHERE o.id = ordered.id
			`)
			await tx.execute(sql`
				INSERT INTO delivery_counter (id, value)
				VALUES (1, COALESCE((SELECT MAX(delivery_seq) FROM operations), 0))
				ON CONFLICT (id) DO UPDATE
					SET value = GREATEST(delivery_counter.value, EXCLUDED.value)
			`)
		})
	}

	/**
	 * Reserve the next delivery sequence inside an open append transaction. The
	 * `UPDATE ... RETURNING` locks the counter row until this transaction commits,
	 * serializing assignment into commit order (see the counter table comment).
	 */
	private async nextDeliverySeq(tx: {
		execute: (query: SQL) => Promise<unknown>
	}): Promise<number> {
		const rows = (await tx.execute(
			sql`UPDATE delivery_counter SET value = value + 1 WHERE id = 1 RETURNING value`,
		)) as unknown as { value: number | string | bigint }[]
		const value = rows[0]?.value
		if (value === undefined || value === null) {
			// The counter row must always exist (ensureTables seeds it). A missing row would
			// silently return 0 and stamp every op with delivery_seq 0, making them invisible
			// to clients (a `> watermark` scan never returns 0). Fail loudly instead of
			// corrupting the delivery stream.
			throw new Error(
				'delivery_counter row (id=1) is missing; the operations log cannot assign delivery sequences',
			)
		}
		return Number(value)
	}

	// ---------------------------------------------------------------------------
	// Operation serialization
	// ---------------------------------------------------------------------------

	private serializeOperation(
		op: Operation,
		receivedAt: number,
		deliverySeq: number,
	): typeof pgOperations.$inferInsert {
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

	private deserializeOperation(row: typeof pgOperations.$inferSelect): Operation {
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
