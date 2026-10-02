import type {
	AtomicOp,
	HLCTimestamp,
	Operation,
	RecordFieldVersions,
	SchemaDefinition,
	TimeSource,
	VersionVector,
} from '@korajs/core'
import { HybridLogicalClock, generateUUIDv7, quoteIdent } from '@korajs/core'
import type { ApplyResult } from '@korajs/sync'
import type { SQL } from 'drizzle-orm'
import { and, asc, between, count, desc, eq, gt, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { UplinkAuthorizationError } from '../scopes/server-scope-filter'
import { pgOperations, pgSyncState } from './drizzle-pg-schema'
import {
	deserializeFieldValue,
	generateAllCollectionDDL,
	replayOperationsForRecord,
	serializeFieldValue,
	validateFieldName,
} from './materialization'
import { type FieldVersionRow, foldFieldVersionRows } from './record-field-versions'
import {
	SCOPE_SNAPSHOT_FINGERPRINT_KEY,
	parseScopeSnapshot,
	replayScopeSnapshots,
	scopeSnapshotFingerprint,
	scopeValuesOf,
} from './scope-snapshot'
import type {
	ApplyRemoteOptions,
	CollectionQueryOptions,
	ConditionalApplyInput,
	ConditionalApplyResult,
	DeliveredOperation,
	MaterializedRecord,
	OperationResolution,
	OperationResolutionOutcome,
	OperationScopeSnapshot,
	ServerStore,
} from './server-store'
import {
	MAX_RESOLUTION_MESSAGE_LENGTH,
	NODE_SEQ_UNIQUE_INDEX,
	RELEASED_NODE_OWNER,
	SEQUENCE_ENFORCEMENT_EPOCH_KEY,
	SEQUENCE_PAIRS_BACKFILLED_KEY,
	SUPERSEDED_NODE_SEQ_UNIQUE_INDEXES,
	SequenceConflictError,
	type SequenceHolderVerdict,
	judgeSequenceHolders,
	reportLegacyPair,
} from './server-store'
import type { StoredOperationKey } from './server-store'

/** Thrown inside an append transaction to roll it back when the operation is a duplicate. */
class DuplicateOperationRollback extends Error {
	constructor() {
		super('duplicate operation; append rolled back')
		this.name = 'DuplicateOperationRollback'
	}
}

/** Index every (node, sequence) the log holds more than once (RT-48). */
const BACKFILL_SEQUENCE_PAIRS_SQL = `INSERT INTO sequence_pairs (node_id, sequence_number)
	SELECT node_id, sequence_number FROM operations
	GROUP BY node_id, sequence_number HAVING COUNT(*) > 1
	ON CONFLICT DO NOTHING`

/**
 * Drop resolutions above their node's restored log, and every `stored-elsewhere`
 * resolution whose operation the restored log does not hold (RT-51; see importBackup).
 */
const PRUNE_RESOLUTIONS_PAST_LOG_SQL = `DELETE FROM operation_resolutions r
	WHERE r.sequence_number > COALESCE(
		(SELECT s.max_sequence_number FROM sync_state s WHERE s.node_id = r.node_id), 0)
	OR (r.outcome = 'stored-elsewhere'
		AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.id = r.op_id))`

/** Postgres unique_violation. */
const PG_UNIQUE_VIOLATION = '23505'

/** True when `error` (or its drizzle-wrapped cause) is a Postgres unique violation. */
function isUniqueViolation(error: unknown): boolean {
	const codeOf = (value: unknown): unknown =>
		value && typeof value === 'object' && 'code' in value
			? (value as { code: unknown }).code
			: undefined
	if (codeOf(error) === PG_UNIQUE_VIOLATION) return true
	return error instanceof Error && codeOf(error.cause) === PG_UNIQUE_VIOLATION
}

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
	/** See {@link SEQUENCE_ENFORCEMENT_EPOCH_KEY}; fixed per database at first start. */
	private sequenceEpoch = 0
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
		// A change in the fields snapshots capture invalidates every snapshot: drop them
		// and rebuild from the log (RT-20). The fingerprint is written last, so a crash
		// (or a concurrent instance) only repeats the idempotent rebuild.
		const fingerprint = scopeSnapshotFingerprint(schema)
		const metaRows = (await this.db.execute(
			sql`SELECT value FROM kora_server_meta WHERE key = ${SCOPE_SNAPSHOT_FINGERPRINT_KEY}`,
		)) as unknown as { value: string }[]
		const stored = metaRows[0]?.value
		if (stored !== fingerprint) {
			await this.db.execute(sql`UPDATE operations SET scope_snapshot = NULL`)
		}
		await this.backfillScopeSnapshots()
		if (stored !== fingerprint) {
			await this.db.execute(
				sql`INSERT INTO kora_server_meta (key, value) VALUES (${SCOPE_SNAPSHOT_FINGERPRINT_KEY}, ${fingerprint})
					ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
			)
		}
	}

	async applyRemoteOperation(op: Operation, options?: ApplyRemoteOptions): Promise<ApplyResult> {
		this.assertOpen()
		await this.ready

		const now = Date.now()
		let sequenceDecision: SequenceHolderVerdict = { verdict: 'free' }

		try {
			await this.db.transaction(async (tx) => {
				// Take the delivery-counter row lock first (see nextDeliverySeq). Every append
				// on every instance, conditional applies included, takes it until commit, so
				// from here on every earlier append is committed and visible to this READ
				// COMMITTED transaction, and no later one can commit before it. That makes
				// the dedup and sequence checks below atomic with the write across instances
				// (SRV-4): a concurrent duplicate on another instance either committed first
				// (and is seen here) or waits for this one. A duplicate rolls back, so it
				// neither burns a delivery sequence nor runs any side effect (NEW-SRV-2).
				const deliverySeq = await this.nextDeliverySeq(tx)

				const inserted = await this.insertOperationRow(tx, op, now, deliverySeq, {
					legacySequenceWriter: options?.legacySequenceWriter === true,
				})
				if (inserted === 'duplicate') throw new DuplicateOperationRollback()
				sequenceDecision = inserted

				// Authorization re-check against the committed row, under the same lock, so
				// no write can commit between this read and this transaction's write.
				// Throwing rolls back, the operation row included.
				if (options?.authorize) {
					const stored = await this.readStoredRow(tx, op.collection, op.recordId)
					const decision = options.authorize(stored)
					if (!decision.allowed) {
						throw new UplinkAuthorizationError(decision.code, decision.message, {
							operationId: op.id,
							collection: op.collection,
							recordId: op.recordId,
						})
					}
				}

				const materialized = this.schema?.collections[op.collection] !== undefined
				const pre = materialized
					? await this.readScopeValues(tx, op.collection, op.recordId, false)
					: null

				await this.advanceSyncState(tx, op, now)

				// Dual-write: update materialized collection table if schema is set
				if (materialized) {
					await this.rebuildMaterializedRecord(tx, op.collection, op.recordId)
					await this.writeScopeSnapshot(tx, op, pre)
				}
			})
		} catch (error) {
			if (error instanceof DuplicateOperationRollback) return 'duplicate'
			throw error
		}

		// Keep this instance's cached vector current for its synchronous readers. The
		// authoritative, cross-instance vector is readVersionVector().
		const currentMax = this.versionVector.get(op.nodeId) ?? 0
		if (op.sequenceNumber > currentMax) {
			this.versionVector.set(op.nodeId, op.sequenceNumber)
		}

		reportLegacyPair(op, sequenceDecision, options)
		return 'applied'
	}

	/**
	 * The version vector as committed in `sync_state`, shared by every instance
	 * (SRV-4). Also refreshes this instance's cache, which `getVersionVector()` serves.
	 */
	async readVersionVector(): Promise<VersionVector> {
		this.assertOpen()
		await this.ready
		const rows = await this.db
			.select({
				nodeId: pgSyncState.nodeId,
				maxSequenceNumber: pgSyncState.maxSequenceNumber,
			})
			.from(pgSyncState)
		const vector: VersionVector = new Map()
		for (const row of rows) {
			const seq = Number(row.maxSequenceNumber)
			vector.set(row.nodeId, seq)
			if (seq > (this.versionVector.get(row.nodeId) ?? 0)) this.versionVector.set(row.nodeId, seq)
		}
		return vector
	}

	/**
	 * Insert one operation row inside an append transaction that already holds the
	 * delivery-counter lock. Returns `'duplicate'` (writing nothing) when an operation
	 * with the same id is stored; throws {@link SequenceConflictError} when a DIFFERENT
	 * operation stored after the sequence-enforcement epoch holds its (node, sequence)
	 * and the writer reserves its sequences (W3 step 4); a legacy holder or a legacy
	 * writer (RT-37) is accepted and the row is stored unflagged. Otherwise returns the
	 * verdict the row was stored under. The partial unique index over sole-holder rows
	 * backs the check against a writer that bypasses the counter lock.
	 */
	private async insertOperationRow(
		tx: PostgresJsDatabase,
		op: Operation,
		now: number,
		deliverySeq: number,
		writer: { legacySequenceWriter?: boolean } = {},
	): Promise<Exclude<SequenceHolderVerdict, { verdict: 'conflict' }> | 'duplicate'> {
		const holders = (await tx.execute(
			sql`SELECT id, delivery_seq FROM operations WHERE node_id = ${op.nodeId} AND sequence_number = ${op.sequenceNumber}`,
		)) as unknown as { id: string; delivery_seq: string | number | null }[]
		// Already stored (a legacy pair may hold the sequence twice: check every holder).
		if (holders.some((row) => row.id === op.id)) return 'duplicate'
		const decision = judgeSequenceHolders(
			op,
			holders.map((row) => ({ id: row.id, deliverySequence: Number(row.delivery_seq ?? 0) })),
			this.sequenceEpoch,
			writer,
		)
		if (decision.verdict === 'conflict') {
			throw new SequenceConflictError(op, decision.holderId)
		}
		const holder = holders[0]
		try {
			const inserted = await tx
				.insert(pgOperations)
				.values(this.serializeOperation(op, now, deliverySeq, decision.verdict === 'free'))
				.onConflictDoNothing({ target: pgOperations.id })
				.returning({ id: pgOperations.id })
			if (inserted.length === 0) return 'duplicate'
			// A legacy pair: index its sequence so version-vector clients get both (RT-48).
			if (decision.verdict === 'legacy') {
				await tx.execute(
					sql`INSERT INTO sequence_pairs (node_id, sequence_number) VALUES (${op.nodeId}, ${op.sequenceNumber})
						ON CONFLICT DO NOTHING`,
				)
			}
			return decision
		} catch (error) {
			if (isUniqueViolation(error)) {
				throw new SequenceConflictError(op, holder?.id ?? '(unknown)')
			}
			throw error
		}
	}

	/** Advance `sync_state` (the persisted version vector) for an appended operation. */
	private async advanceSyncState(
		tx: PostgresJsDatabase,
		op: Operation,
		now: number,
	): Promise<void> {
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
			// Also take the delivery-counter row lock now (every append takes it until
			// commit), so the reads below, including the authorization reads of the
			// built operations, see every earlier commit and no append can commit
			// between them and this transaction's writes. Lock order (advisory, then
			// counter) matches every other path, so this cannot deadlock.
			await tx.execute(sql`SELECT value FROM delivery_counter WHERE id = 1 FOR UPDATE`)

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

			const ops = await input.buildOperations(current, {
				clock,
				readStoredRow: (collection, id) => this.readStoredRow(tx, collection, id),
			})
			const now = Date.now()
			for (const op of ops) {
				const deliverySeq = await this.nextDeliverySeq(tx)
				const materialized = this.schema?.collections[op.collection] !== undefined
				const pre = materialized
					? await this.readScopeValues(tx, op.collection, op.recordId, false)
					: null
				// A built operation is new by construction (fresh id, reserved sequence); a
				// duplicate would mean it is already committed, so it is not written twice.
				if ((await this.insertOperationRow(tx, op, now, deliverySeq)) === 'duplicate') continue
				await this.advanceSyncState(tx, op, now)
				if (materialized) {
					await this.rebuildMaterializedRecord(tx, op.collection, op.recordId)
					await this.writeScopeSnapshot(tx, op, pre)
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
			scopeSnapshot: parseScopeSnapshot(row.scopeSnapshot),
		}))
	}

	async getOperationScopeSnapshots(
		operationIds: string[],
	): Promise<Map<string, OperationScopeSnapshot>> {
		this.assertOpen()
		await this.ready
		const result = new Map<string, OperationScopeSnapshot>()
		for (let i = 0; i < operationIds.length; i += 500) {
			const ids = operationIds.slice(i, i + 500)
			if (ids.length === 0) continue
			const rows = (await this.db.execute(
				sql`SELECT id, scope_snapshot FROM operations WHERE id IN (${sql.join(
					ids.map((id) => sql`${id}`),
					sql.raw(', '),
				)})`,
			)) as unknown as { id: string; scope_snapshot: string | null }[]
			for (const row of rows) {
				const snapshot = parseScopeSnapshot(row.scope_snapshot)
				if (snapshot) result.set(row.id, snapshot)
			}
		}
		return result
	}

	async getRecordLatestTimestamp(
		collection: string,
		recordId: string,
	): Promise<HLCTimestamp | null> {
		this.assertOpen()
		await this.ready
		// COLLATE "C" so the node-id tie-break is the same byte order as HLC.compare.
		const rows = (await this.db.execute(
			sql`SELECT wall_time, logical, timestamp_node_id FROM operations
				WHERE collection = ${collection} AND record_id = ${recordId}
				ORDER BY wall_time DESC, logical DESC, timestamp_node_id COLLATE "C" DESC LIMIT 1`,
		)) as unknown as { wall_time: number | string; logical: number; timestamp_node_id: string }[]
		const row = rows[0]
		return row
			? {
					wallTime: Number(row.wall_time),
					logical: Number(row.logical),
					nodeId: row.timestamp_node_id,
				}
			: null
	}

	async getRecordFieldVersions(
		collection: string,
		recordId: string,
	): Promise<RecordFieldVersions | null> {
		this.assertOpen()
		await this.ready
		const rows = (await this.db.execute(
			sql`SELECT type, data, wall_time, logical, timestamp_node_id FROM operations
				WHERE collection = ${collection} AND record_id = ${recordId}`,
		)) as unknown as FieldVersionRow[]
		return foldFieldVersionRows(rows)
	}

	async recordBlobOwner(hash: string, owner: string): Promise<void> {
		this.assertOpen()
		await this.ready
		await this.db.execute(
			sql`INSERT INTO blob_owners (hash, owner, created_at) VALUES (${hash}, ${owner}, ${Date.now()})
				ON CONFLICT (hash, owner) DO NOTHING`,
		)
	}

	async getBlobOwners(hashes: string[]): Promise<Map<string, string[]>> {
		this.assertOpen()
		await this.ready
		const result = new Map<string, string[]>(hashes.map((hash) => [hash, []]))
		for (let i = 0; i < hashes.length; i += 500) {
			const slice = hashes.slice(i, i + 500)
			if (slice.length === 0) continue
			const rows = (await this.db.execute(
				sql`SELECT hash, owner FROM blob_owners WHERE hash IN (${sql.join(
					slice.map((hash) => sql`${hash}`),
					sql.raw(', '),
				)})`,
			)) as unknown as { hash: string; owner: string }[]
			for (const row of rows) result.get(row.hash)?.push(row.owner)
		}
		return result
	}

	async claimBlobIfUnowned(hash: string, owner: string): Promise<boolean> {
		this.assertOpen()
		await this.ready
		// A transaction-scoped advisory lock per hash makes "insert when nobody owns it"
		// atomic across instances (two concurrent first claims cannot both win).
		return this.db.transaction(async (tx) => {
			await tx.execute(
				sql`SELECT pg_advisory_xact_lock(hashtextextended(${`kora:blob:${hash}`}, 0))`,
			)
			await tx.execute(
				sql`INSERT INTO blob_owners (hash, owner, created_at)
					SELECT ${hash}, ${owner}, ${Date.now()}
					WHERE NOT EXISTS (SELECT 1 FROM blob_owners WHERE hash = ${hash})
					ON CONFLICT (hash, owner) DO NOTHING`,
			)
			const rows = (await tx.execute(
				sql`SELECT 1 AS one FROM blob_owners WHERE hash = ${hash} AND owner = ${owner} LIMIT 1`,
			)) as unknown as unknown[]
			return rows.length > 0
		})
	}

	/**
	 * Scope values of a record as stored, for an operation's scope snapshot. With
	 * `includeDeleted` false a soft-deleted row counts as absent; with true it keeps
	 * its last values (a delete's post-image).
	 */
	private async readScopeValues(
		txOrDb: PostgresJsDatabase,
		collection: string,
		recordId: string,
		includeDeleted: boolean,
	): Promise<Record<string, unknown> | null> {
		const collectionDef = this.schema?.collections[collection]
		if (!collectionDef) return null
		const rows = (await txOrDb.execute(
			sql`SELECT * FROM ${sql.raw(quoteIdent(collection))} WHERE id = ${recordId} LIMIT 1`,
		)) as unknown as Record<string, unknown>[]
		const row = rows[0]
		if (!row) return null
		if (!includeDeleted && Number(row._deleted) === 1) return null
		return scopeValuesOf(this.schema, collection, recordId, this.deserializeRow(row, collectionDef))
	}

	/** Persist the scope snapshot of a just-applied operation (RT-14). */
	private async writeScopeSnapshot(
		tx: PostgresJsDatabase,
		op: Operation,
		pre: Record<string, unknown> | null,
	): Promise<void> {
		const snapshot: OperationScopeSnapshot = {
			pre,
			post: await this.readScopeValues(tx, op.collection, op.recordId, true),
		}
		await tx.execute(
			sql`UPDATE operations SET scope_snapshot = ${JSON.stringify(snapshot)} WHERE id = ${op.id}`,
		)
	}

	/**
	 * Rebuild missing scope snapshots from the log (migration from a database written
	 * before snapshots existed), replaying each affected record in commit order.
	 */
	private async backfillScopeSnapshots(): Promise<void> {
		const schema = this.schema
		if (!schema) return
		const pending = (await this.db.execute(
			sql`SELECT DISTINCT collection, record_id FROM operations WHERE scope_snapshot IS NULL`,
		)) as unknown as { collection: string; record_id: string }[]
		const targets = pending.filter((row) => schema.collections[row.collection] !== undefined)
		for (const target of targets) {
			const rows = await this.db
				.select()
				.from(pgOperations)
				.where(
					and(
						eq(pgOperations.collection, target.collection),
						eq(pgOperations.recordId, target.record_id),
					),
				)
				.orderBy(asc(pgOperations.deliverySeq))
			const replayed = replayScopeSnapshots(
				schema,
				target.collection,
				target.record_id,
				rows.map((row) => {
					const op = this.deserializeOperation(row)
					return {
						id: op.id,
						type: op.type,
						data: op.data,
						atomicOps: op.atomicOps ?? null,
						timestamp: op.timestamp,
					}
				}),
			)
			for (const row of rows) {
				if (row.scopeSnapshot !== null) continue
				const snapshot = replayed.get(row.id)
				if (!snapshot) continue
				// Only fill a still-empty column: a concurrent apply's own snapshot wins.
				await this.db.execute(
					sql`UPDATE operations SET scope_snapshot = ${JSON.stringify(snapshot)}
						WHERE id = ${row.id} AND scope_snapshot IS NULL`,
				)
			}
		}
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

	async getNodeIdsAfterDelivery(afterDeliverySequence: number): Promise<string[]> {
		this.assertOpen()
		await this.ready
		const rows = (await this.db.execute(
			sql`SELECT DISTINCT node_id FROM operations WHERE delivery_seq > ${afterDeliverySequence}`,
		)) as unknown as { node_id: string }[]
		return rows.map((row) => row.node_id)
	}

	async getSequencePairOperations(nodeId: string, throughSequence: number): Promise<Operation[]> {
		this.assertOpen()
		await this.ready
		const rows = await this.db
			.select()
			.from(pgOperations)
			.where(
				and(
					eq(pgOperations.nodeId, nodeId),
					sql`${pgOperations.sequenceNumber} IN (SELECT sequence_number FROM sequence_pairs WHERE node_id = ${nodeId} AND sequence_number <= ${throughSequence})`,
				),
			)
			.orderBy(asc(pgOperations.sequenceNumber), asc(pgOperations.deliverySeq))
		return rows.map((row) => this.deserializeOperation(row))
	}

	async recordOperationResolution(resolution: OperationResolution): Promise<void> {
		this.assertOpen()
		await this.ready
		await this.db.execute(
			sql`INSERT INTO operation_resolutions
				(op_id, node_id, sequence_number, outcome, code, message, resolved_at)
				VALUES (${resolution.operationId}, ${resolution.nodeId}, ${resolution.sequenceNumber},
					${resolution.outcome}, ${resolution.code},
					${resolution.message?.slice(0, MAX_RESOLUTION_MESSAGE_LENGTH) ?? null}, ${Date.now()})
				ON CONFLICT (op_id) DO NOTHING`,
		)
	}

	async findOperationResolutions(
		nodeId: string,
		ids: string[],
	): Promise<Map<string, OperationResolution>> {
		this.assertOpen()
		await this.ready
		const found = new Map<string, OperationResolution>()
		for (let i = 0; i < ids.length; i += 1000) {
			const chunk = ids.slice(i, i + 1000)
			if (chunk.length === 0) continue
			const rows = (await this.db.execute(
				sql`SELECT op_id, node_id, sequence_number, outcome, code, message FROM operation_resolutions
					WHERE node_id = ${nodeId} AND op_id IN (${sql.join(
						chunk.map((id) => sql`${id}`),
						sql.raw(', '),
					)})`,
			)) as unknown as {
				op_id: string
				node_id: string
				sequence_number: number | string
				outcome: string
				code: string | null
				message: string | null
			}[]
			for (const row of rows) {
				found.set(row.op_id, {
					operationId: row.op_id,
					nodeId: row.node_id,
					sequenceNumber: Number(row.sequence_number),
					outcome: row.outcome as OperationResolutionOutcome,
					code: row.code,
					message: row.message,
				})
			}
		}
		return found
	}

	async deleteOperationResolution(nodeId: string, operationId: string): Promise<void> {
		this.assertOpen()
		await this.ready
		await this.db.execute(
			sql`DELETE FROM operation_resolutions WHERE node_id = ${nodeId} AND op_id = ${operationId}`,
		)
	}

	async getResolvedThrough(nodeId: string): Promise<number> {
		this.assertOpen()
		await this.ready
		const rows = (await this.db.execute(
			sql`SELECT MAX(sequence_number) AS m FROM operation_resolutions WHERE node_id = ${nodeId}`,
		)) as unknown as { m: string | number | null }[]
		return Number(rows[0]?.m ?? 0)
	}

	async findStoredOperations(ids: string[]): Promise<Map<string, StoredOperationKey>> {
		this.assertOpen()
		await this.ready
		const found = new Map<string, StoredOperationKey>()
		// One statement per 1000 ids, well below the bind-parameter limit.
		for (let i = 0; i < ids.length; i += 1000) {
			const chunk = ids.slice(i, i + 1000)
			if (chunk.length === 0) continue
			const rows = (await this.db.execute(
				sql`SELECT id, node_id, sequence_number FROM operations WHERE id IN (${sql.join(
					chunk.map((id) => sql`${id}`),
					sql.raw(', '),
				)})`,
			)) as unknown as { id: string; node_id: string; sequence_number: number | string }[]
			for (const row of rows) {
				found.set(row.id, { nodeId: row.node_id, sequenceNumber: Number(row.sequence_number) })
			}
		}
		return found
	}

	async findRecordsByIds(
		collection: string,
		ids: string[],
	): Promise<Map<string, MaterializedRecord>> {
		this.assertOpen()
		await this.ready
		this.assertSchema()
		this.assertCollection(collection)
		const schema = this.schema as SchemaDefinition
		const collectionDef = schema.collections[collection] as NonNullable<
			SchemaDefinition['collections'][string]
		>
		const result = new Map<string, MaterializedRecord>()
		// One statement per 1000 ids (LMS #11), well below the bind-parameter limit.
		for (let i = 0; i < ids.length; i += 1000) {
			const chunk = ids.slice(i, i + 1000)
			if (chunk.length === 0) continue
			const rows = (await this.db.execute(
				sql`SELECT * FROM ${sql.raw(quoteIdent(collection))} WHERE id IN (${sql.join(
					chunk.map((id) => sql`${id}`),
					sql.raw(', '),
				)})`,
			)) as unknown as Record<string, unknown>[]
			for (const row of rows) {
				const record = this.deserializeRow(row, collectionDef)
				result.set(record.id, record)
			}
		}
		return result
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

		const { mergeBackupOperations, parseServerBackup } = await import('./server-backup')
		const { operations, versionVector } = parseServerBackup(data)

		if (merge) {
			const merged = await mergeBackupOperations(operations, (op) => this.applyRemoteOperation(op))
			// Re-seed the sequence counter from the (possibly advanced) version vector,
			// in case the merge restored operations on this node with higher numbers.
			this.sequenceCounter = null
			return merged
		}

		const now = Date.now()
		const restoredMax = await this.db.transaction(async (tx) => {
			// Restored rows are inserted unflagged (`seq_unique = 0`: a legacy log may reuse
			// a sequence), so they stay outside the partial unique index; they sit at or
			// below the new epoch and the append check judges them as holders.
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
			// The restored log's legacy pairs (RT-48), and only the resolutions it covers:
			// one past a node's restored log was decided after the backup, and advertising
			// it would hide stored operations the restore lost (RT-45).
			await tx.execute(sql`DELETE FROM sequence_pairs`)
			await tx.execute(sql.raw(BACKFILL_SEQUENCE_PAIRS_SQL))
			await tx.execute(sql.raw(PRUNE_RESOLUTIONS_PAST_LOG_SQL))
			// The restored snapshot sits at or below the new epoch (see
			// SEQUENCE_ENFORCEMENT_EPOCH_KEY); enforcement resumes above it.
			await tx.execute(
				sql`INSERT INTO kora_server_meta (key, value) VALUES (${SEQUENCE_ENFORCEMENT_EPOCH_KEY}, ${String(deliverySeq)})
					ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
			)
			return deliverySeq
		})
		this.sequenceEpoch = restoredMax
		await this.backfillScopeSnapshots()

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
				// Byte order (COLLATE "C"), like HLC.compare.
				sql`${pgOperations.timestampNodeId} COLLATE "C" DESC`,
			)
			.limit(1)

		const row = rows[0]
		if (!row) {
			return null
		}
		return { wallTime: row.wallTime, logical: row.logical, nodeId: row.timestampNodeId }
	}

	async claimNode(nodeId: string, userId: string): Promise<boolean> {
		this.assertOpen()
		await this.ready
		if (userId === RELEASED_NODE_OWNER) return false
		const now = Date.now()
		// Each statement is atomic on the node_claims primary key. A fresh claim is
		// only created for a node without history: history with no claim predates
		// node claims, so its writer is unknown (RT-5).
		await this.db.execute(
			sql`INSERT INTO node_claims (node_id, user_id, claimed_at)
				SELECT ${nodeId}, ${userId}, ${now}
				WHERE NOT EXISTS (SELECT 1 FROM operations WHERE node_id = ${nodeId})
				ON CONFLICT (node_id) DO NOTHING`,
		)
		// An admin-released node is taken over by its next claimant (one winner).
		await this.db.execute(
			sql`UPDATE node_claims SET user_id = ${userId}, claimed_at = ${now}
				WHERE node_id = ${nodeId} AND user_id = ${RELEASED_NODE_OWNER}`,
		)
		const rows = (await this.db.execute(
			sql`SELECT user_id FROM node_claims WHERE node_id = ${nodeId} LIMIT 1`,
		)) as unknown as { user_id: string }[]
		return rows[0]?.user_id === userId
	}

	async getNodeClaimOwner(nodeId: string): Promise<string | null> {
		this.assertOpen()
		await this.ready
		const rows = (await this.db.execute(
			sql`SELECT user_id FROM node_claims WHERE node_id = ${nodeId} LIMIT 1`,
		)) as unknown as { user_id: string }[]
		return rows[0]?.user_id ?? null
	}

	async replaceNodeClaim(
		nodeId: string,
		expectedOwner: string,
		newOwner: string,
	): Promise<boolean> {
		this.assertOpen()
		await this.ready
		// One statement, atomic on the row: concurrent re-issues have one winner.
		const rows = (await this.db.execute(
			sql`UPDATE node_claims SET user_id = ${newOwner}, claimed_at = ${Date.now()}
				WHERE node_id = ${nodeId} AND user_id = ${expectedOwner} RETURNING node_id`,
		)) as unknown as { node_id: string }[]
		return rows.length > 0
	}

	async releaseNodeClaim(nodeId: string): Promise<boolean> {
		this.assertOpen()
		await this.ready
		const known = (await this.db.execute(
			sql`SELECT 1 AS one WHERE EXISTS (SELECT 1 FROM node_claims WHERE node_id = ${nodeId})
				OR EXISTS (SELECT 1 FROM operations WHERE node_id = ${nodeId})`,
		)) as unknown as { one: number }[]
		if (known.length === 0) return false
		await this.db.execute(
			sql`INSERT INTO node_claims (node_id, user_id, claimed_at)
				VALUES (${nodeId}, ${RELEASED_NODE_OWNER}, ${Date.now()})
				ON CONFLICT (node_id) DO UPDATE SET user_id = EXCLUDED.user_id, claimed_at = EXCLUDED.claimed_at`,
		)
		return true
	}

	/**
	 * The record as currently stored, including a soft-deleted one (whose last field
	 * values are kept), or null when it was never written. Without a materialized
	 * table, the last known values are replayed from the operation log.
	 */
	private async readStoredRow(
		txOrDb: PostgresJsDatabase,
		collection: string,
		recordId: string,
	): Promise<MaterializedRecord | null> {
		const collectionDef = this.schema?.collections[collection]
		if (collectionDef) {
			const rows = (await txOrDb.execute(
				sql`SELECT * FROM ${sql.raw(quoteIdent(collection))} WHERE id = ${recordId} LIMIT 1`,
			)) as unknown as Record<string, unknown>[]
			const row = rows[0]
			return row ? this.deserializeRow(row, collectionDef) : null
		}
		const ops = await txOrDb
			.select({
				type: pgOperations.type,
				data: pgOperations.data,
				atomicOps: pgOperations.atomicOps,
			})
			.from(pgOperations)
			.where(and(eq(pgOperations.collection, collection), eq(pgOperations.recordId, recordId)))
			.orderBy(
				asc(pgOperations.wallTime),
				asc(pgOperations.logical),
				// Byte order (COLLATE "C"), never the database collation: ties on node id
				// must break exactly like HLC.compare on every replica.
				sql`${pgOperations.timestampNodeId} COLLATE "C" ASC`,
			)
		if (ops.length === 0) return null
		const lastKnown = replayOperationsForRecord(
			ops
				.filter((o) => o.type !== 'delete')
				.map((o) => ({
					type: o.type,
					data: o.data !== null ? JSON.parse(o.data) : null,
					atomicOps:
						o.atomicOps != null ? (JSON.parse(o.atomicOps) as Record<string, AtomicOp>) : null,
				})),
		)
		return { ...(lastKnown ?? {}), id: recordId }
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
				previousData: pgOperations.previousData,
				wallTime: pgOperations.wallTime,
			})
			.from(pgOperations)
			.where(and(eq(pgOperations.collection, collection), eq(pgOperations.recordId, recordId)))
			// HLC total order (wallTime, logical, nodeId) so atomic composition and LWW
			// see operations in exactly the order the merge engine converges them.
			.orderBy(
				asc(pgOperations.wallTime),
				asc(pgOperations.logical),
				// Byte order (COLLATE "C"), never the database collation: ties on node id
				// must break exactly like HLC.compare on every replica.
				sql`${pgOperations.timestampNodeId} COLLATE "C" ASC`,
			)

		// Replay to get current state
		const parsedOps = ops.map((op) => ({
			type: op.type,
			data: op.data !== null ? JSON.parse(op.data) : null,
			atomicOps:
				op.atomicOps != null ? (JSON.parse(op.atomicOps) as Record<string, AtomicOp>) : null,
			previousData: op.previousData !== null ? JSON.parse(op.previousData) : null,
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
				previousData: pgOperations.previousData,
				wallTime: pgOperations.wallTime,
			})
			.from(pgOperations)
			.where(eq(pgOperations.collection, collectionName))
			// HLC total order (wallTime, logical, nodeId) for correct atomic composition.
			.orderBy(
				asc(pgOperations.wallTime),
				asc(pgOperations.logical),
				// Byte order (COLLATE "C"), never the database collation: ties on node id
				// must break exactly like HLC.compare on every replica.
				sql`${pgOperations.timestampNodeId} COLLATE "C" ASC`,
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
				previousData: op.previousData !== null ? JSON.parse(op.previousData) : null,
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
					sequence_number BIGINT NOT NULL,
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

			// Backward-compatible migration: the per-operation scope snapshot (RT-14).
			// Rows written before it are backfilled from the log when the schema is set.
			await tx.execute(sql`ALTER TABLE operations ADD COLUMN IF NOT EXISTS scope_snapshot TEXT`)

			// Backward-compatible migration (RT-37): the sole-holder flag behind the partial
			// unique index. Existing rows (and rows an older instance writes during a rolling
			// upgrade) read 0: outside the index, still judged as holders by the append check.
			await tx.execute(
				sql`ALTER TABLE operations ADD COLUMN IF NOT EXISTS seq_unique INTEGER NOT NULL DEFAULT 0`,
			)

			// Blob content hash -> principals that pushed (or first claimed) it (RT-11).
			await tx.execute(sql`
				CREATE TABLE IF NOT EXISTS blob_owners (
					hash TEXT NOT NULL,
					owner TEXT NOT NULL,
					created_at BIGINT NOT NULL,
					PRIMARY KEY (hash, owner)
				)
			`)

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

			// Small key/value store for server-side metadata (snapshot fingerprint, RT-20).
			await tx.execute(sql`
				CREATE TABLE IF NOT EXISTS kora_server_meta (
					key TEXT PRIMARY KEY,
					value TEXT NOT NULL
				)
			`)

			// Node id -> principal binding (see claimNode). One row per device node id.
			await tx.execute(sql`
				CREATE TABLE IF NOT EXISTS node_claims (
					node_id TEXT PRIMARY KEY,
					user_id TEXT NOT NULL,
					claimed_at BIGINT NOT NULL
				)
			`)

			await tx.execute(sql`
				CREATE TABLE IF NOT EXISTS sync_state (
					node_id TEXT PRIMARY KEY,
					max_sequence_number BIGINT NOT NULL,
					last_seen_at BIGINT NOT NULL
				)
			`)

			// Migration (SRV-4): sequence numbers were INTEGER, so a node past 2^31-1 writes
			// failed. Widen both columns once; the type check keeps restarts free (ALTER
			// TYPE rewrites the table under an exclusive lock, so it must not repeat).
			const narrowColumns = (await tx.execute(sql`
				SELECT table_name, column_name FROM information_schema.columns
				WHERE table_schema = current_schema() AND data_type = 'integer' AND (
					(table_name = 'operations' AND column_name = 'sequence_number') OR
					(table_name = 'sync_state' AND column_name = 'max_sequence_number')
				)
			`)) as unknown as { table_name: string; column_name: string }[]
			for (const column of narrowColumns) {
				await tx.execute(
					sql.raw(
						`ALTER TABLE ${quoteIdent(column.table_name)} ALTER COLUMN ${quoteIdent(column.column_name)} TYPE BIGINT`,
					),
				)
			}

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

			// Sequence enforcement (W3 step 4): record the epoch on the first start of this
			// release (the log's highest delivery sequence then; see
			// SEQUENCE_ENFORCEMENT_EPOCH_KEY), then back the append check with a partial
			// unique index over sole-holder rows (NODE_SEQ_UNIQUE_INDEX), which therefore
			// always exists: a legacy duplicate pair is stored unflagged. It replaces the
			// earlier indexes (a full one, and one over the rows past the epoch, which a
			// legacy client's pair and an older instance's insert would violate, RT-37).
			await tx.execute(sql`
				INSERT INTO kora_server_meta (key, value)
				SELECT ${SEQUENCE_ENFORCEMENT_EPOCH_KEY}, COALESCE(MAX(delivery_seq), 0)::text FROM operations
				ON CONFLICT (key) DO NOTHING
			`)
			const epochRows = (await tx.execute(
				sql`SELECT value FROM kora_server_meta WHERE key = ${SEQUENCE_ENFORCEMENT_EPOCH_KEY}`,
			)) as unknown as { value: string }[]
			// Absent only if the row could not be written: enforce everything (epoch 0).
			const epoch = epochRows[0] === undefined ? 0 : Number(epochRows[0].value)
			if (!Number.isSafeInteger(epoch) || epoch < 0) {
				throw new Error(
					`kora_server_meta.${SEQUENCE_ENFORCEMENT_EPOCH_KEY} holds "${String(epochRows[0]?.value)}", not a delivery sequence. Restore it from a backup or delete the row to re-derive it.`,
				)
			}
			this.sequenceEpoch = epoch
			for (const superseded of SUPERSEDED_NODE_SEQ_UNIQUE_INDEXES) {
				await tx.execute(sql.raw(`DROP INDEX IF EXISTS ${superseded}`))
			}
			// A row is flagged only when nothing held its sequence at insert, so flagged
			// duplicates can come only from outside writes (a manual edit). Before
			// (re)creating the index, unflag them: they stay stored and judged by the append
			// check, and the index creation cannot fail.
			const indexed = (await tx.execute(
				sql`SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = ${NODE_SEQ_UNIQUE_INDEX}`,
			)) as unknown as unknown[]
			if (indexed.length === 0) {
				await tx.execute(sql`
					UPDATE operations o SET seq_unique = 0
					WHERE o.seq_unique = 1 AND EXISTS (
						SELECT 1 FROM operations other
						WHERE other.node_id = o.node_id
							AND other.sequence_number = o.sequence_number
							AND other.id <> o.id
					)
				`)
			}
			await tx.execute(
				sql.raw(
					`CREATE UNIQUE INDEX IF NOT EXISTS ${NODE_SEQ_UNIQUE_INDEX} ON operations (node_id, sequence_number) WHERE seq_unique = 1`,
				),
			)

			// How uploaded operations were resolved without being stored under their
			// sequence (validator `ignore`, terminal refusal, renumbered duplicate; RT-43,
			// RT-47).
			await tx.execute(sql`
				CREATE TABLE IF NOT EXISTS operation_resolutions (
					op_id TEXT PRIMARY KEY,
					node_id TEXT NOT NULL,
					sequence_number BIGINT NOT NULL,
					outcome TEXT NOT NULL,
					code TEXT,
					message TEXT,
					resolved_at BIGINT NOT NULL
				)
			`)
			await tx.execute(
				sql`CREATE INDEX IF NOT EXISTS idx_resolutions_node_seq ON operation_resolutions (node_id, sequence_number)`,
			)
			// (node, sequence) held by more than one operation: legacy pairs (RT-48),
			// indexed once from the existing log, then maintained by appends.
			await tx.execute(sql`
				CREATE TABLE IF NOT EXISTS sequence_pairs (
					node_id TEXT NOT NULL,
					sequence_number BIGINT NOT NULL,
					PRIMARY KEY (node_id, sequence_number)
				)
			`)
			const pairsBackfilled = (await tx.execute(
				sql`SELECT 1 FROM kora_server_meta WHERE key = ${SEQUENCE_PAIRS_BACKFILLED_KEY}`,
			)) as unknown as unknown[]
			if (pairsBackfilled.length === 0) {
				await tx.execute(sql.raw(BACKFILL_SEQUENCE_PAIRS_SQL))
				await tx.execute(
					sql`INSERT INTO kora_server_meta (key, value) VALUES (${SEQUENCE_PAIRS_BACKFILLED_KEY}, '1')
						ON CONFLICT (key) DO NOTHING`,
				)
			}
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

	/**
	 * @param soleHolder - Nothing else held the (node, sequence) at insert: the row is
	 *   flagged `seq_unique` and covered by {@link NODE_SEQ_UNIQUE_INDEX}. False for a
	 *   legacy pair's second operation and for restored backup rows.
	 */
	private serializeOperation(
		op: Operation,
		receivedAt: number,
		deliverySeq: number,
		soleHolder = false,
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
			seqUnique: soleHolder ? 1 : 0,
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
