import { createRequire } from 'node:module'
import type {
	AtomicOp,
	FoldState,
	HLCTimestamp,
	Operation,
	RecordFieldVersions,
	SchemaDefinition,
	VersionVector,
} from '@korajs/core'
import { generateUUIDv7, quoteIdent } from '@korajs/core'
import type { ApplyResult } from '@korajs/sync'
import type { SQL } from 'drizzle-orm'
import { and, asc, between, count, eq, gt, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { UplinkAuthorizationError } from '../scopes/server-scope-filter'
import { deliveryCounter, operations, syncState } from './drizzle-schema'
import { envelopeColumn, parseEnvelopeColumn } from './envelope-column'
import {
	SERVER_LOG_INTEGRITY_META_KEY,
	SERVER_LOG_QUARANTINE_DDL,
	type ServerLogIntegrityReport,
	type ServerOperationRow,
	checkServerOperationRow,
	quarantineRowJson,
} from './log-integrity'
import {
	deserializeFieldValue,
	generateAllCollectionDDL,
	serializeFieldValue,
	validateFieldName,
} from './materialization'
import {
	EMPTY_FOLD_SCHEMA,
	FOLD_MIGRATION_BATCH,
	FOLD_PLAN_FINGERPRINT_KEY,
	type FoldMigrationReport,
	REFOLD_REQUIRED,
	type ServerFoldOptions,
	foldFieldVersions,
	foldPlanFingerprint,
	mergeIntoFoldState,
	parseStoredFoldState,
	projectFoldState,
	refoldRecord,
	serializeServerFoldState,
	serverFoldOptions,
} from './record-fold'
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

/** Index every (node, sequence) the log holds more than once (RT-48). */
const BACKFILL_SEQUENCE_PAIRS_SQL = `INSERT OR IGNORE INTO sequence_pairs (node_id, sequence_number)
	SELECT node_id, sequence_number FROM operations
	GROUP BY node_id, sequence_number HAVING COUNT(*) > 1`

/**
 * Drop resolutions above their node's restored log, and every `stored-elsewhere`
 * resolution whose operation the restored log does not hold (RT-51; see importBackup).
 */
const PRUNE_RESOLUTIONS_PAST_LOG_SQL = `DELETE FROM operation_resolutions
	WHERE sequence_number > COALESCE(
		(SELECT max_sequence_number FROM sync_state WHERE sync_state.node_id = operation_resolutions.node_id),
		0)
	OR (outcome = 'stored-elsewhere'
		AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.id = operation_resolutions.op_id))`

interface ResolutionRow {
	op_id: string
	node_id: string
	sequence_number: number | string
	outcome: string
	code: string | null
	message: string | null
}

function resolutionFromRow(row: ResolutionRow): OperationResolution {
	return {
		operationId: row.op_id,
		nodeId: row.node_id,
		sequenceNumber: Number(row.sequence_number),
		outcome: row.outcome as OperationResolutionOutcome,
		code: row.code,
		message: row.message,
	}
}

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
	/** See {@link SEQUENCE_ENFORCEMENT_EPOCH_KEY}; fixed per database at first start. */
	private sequenceEpoch = 0
	private logIntegrity: ServerLogIntegrityReport = {
		checkedRows: 0,
		quarantined: [],
		ran: false,
		totalQuarantined: 0,
	}
	private readonly authoritativeNodeIds: string[]
	private readonly foldOptions: ServerFoldOptions
	private foldMigration: FoldMigrationReport = {
		ran: false,
		records: 0,
		skippedUnclean: 0,
		fullRefold: false,
	}

	constructor(
		db: BetterSQLite3Database,
		nodeId?: string,
		options: { authoritativeNodeIds?: string[] } = {},
	) {
		this.db = db
		this.nodeId = nodeId ?? generateUUIDv7()
		this.authoritativeNodeIds = [...new Set([this.nodeId, ...(options.authoritativeNodeIds ?? [])])]
		this.foldOptions = serverFoldOptions(this.authoritativeNodeIds)
		this.ensureTables()
	}

	getAuthoritativeNodeIds(): string[] {
		return [...this.authoritativeNodeIds]
	}

	/** What the last startup re-materialization did (W7 step 7). */
	getFoldMigrationReport(): FoldMigrationReport {
		return { ...this.foldMigration }
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

		// Re-materialize every record whose fold state is missing or stale (W7 step 7).
		this.foldMigration = this.rematerialize()
		// A change in the fields snapshots capture invalidates every snapshot: drop them
		// and rebuild from the log (RT-20). The fingerprint is written last, so a crash
		// mid-way only repeats the rebuild at the next start.
		const fingerprint = scopeSnapshotFingerprint(schema)
		const stored = this.db.all<{ value: string }>(
			sql`SELECT value FROM kora_server_meta WHERE key = ${SCOPE_SNAPSHOT_FINGERPRINT_KEY}`,
		)[0]?.value
		if (stored !== fingerprint) {
			this.db.run(sql`UPDATE operations SET scope_snapshot = NULL`)
		}
		this.backfillScopeSnapshots()
		if (stored !== fingerprint) {
			this.db.run(
				sql`INSERT OR REPLACE INTO kora_server_meta (key, value) VALUES (${SCOPE_SNAPSHOT_FINGERPRINT_KEY}, ${fingerprint})`,
			)
		}
	}

	async applyRemoteOperation(op: Operation, options?: ApplyRemoteOptions): Promise<ApplyResult> {
		this.assertOpen()

		const now = Date.now()

		let sequenceDecision: SequenceHolderVerdict = { verdict: 'free' }
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
			// A different operation under the same (node, sequence) is refused (W3 step 4)
			// when it was stored under enforcement and the writer reserves its sequences;
			// a legacy holder (stored before the epoch) or a legacy writer (RT-37) is
			// accepted, as beta.12 did. Inside the write transaction so no concurrent
			// writer can slip one in.
			const holders = tx.all<{ id: string; delivery_seq: number | null }>(
				sql`SELECT id, delivery_seq FROM operations WHERE node_id = ${op.nodeId} AND sequence_number = ${op.sequenceNumber}`,
			)
			const decision = judgeSequenceHolders(
				op,
				holders.map((row) => ({ id: row.id, deliverySequence: Number(row.delivery_seq ?? 0) })),
				this.sequenceEpoch,
				{ legacySequenceWriter: options?.legacySequenceWriter === true },
			)
			if (decision.verdict === 'conflict') {
				throw new SequenceConflictError(op, decision.holderId)
			}
			sequenceDecision = decision

			// Authorization re-check inside the write transaction: better-sqlite3 runs
			// it synchronously under SQLite's single writer lock, so the row it sees is
			// the row this write commits against. Throwing rolls the transaction back.
			if (options?.authorize) {
				const decision = options.authorize(this.readStoredRow(tx, op.collection, op.recordId))
				if (!decision.allowed) {
					throw new UplinkAuthorizationError(decision.code, decision.message, {
						operationId: op.id,
						collection: op.collection,
						recordId: op.recordId,
					})
				}
			}

			const materialized = this.schema?.collections[op.collection] !== undefined
			const pre = materialized ? this.readScopeValues(tx, op.collection, op.recordId, false) : null

			const deliverySeq = this.nextDeliverySeq(tx)
			const row = this.serializeOperation(op, now, deliverySeq, decision.verdict === 'free')
			tx.insert(operations).values(row).run()
			// A legacy pair: index its sequence so version-vector clients get both (RT-48).
			if (decision.verdict === 'legacy') {
				tx.run(
					sql`INSERT OR IGNORE INTO sequence_pairs (node_id, sequence_number) VALUES (${op.nodeId}, ${op.sequenceNumber})`,
				)
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

			// Dual-write: update materialized collection table if schema is set
			if (materialized) {
				this.mergeIntoRecord(tx, op, deliverySeq)
				// The record's scope values around this write, from the store's own rows.
				const snapshot: OperationScopeSnapshot = {
					pre,
					post: this.readScopeValues(tx, op.collection, op.recordId, true),
				}
				tx.run(
					sql`UPDATE operations SET scope_snapshot = ${JSON.stringify(snapshot)} WHERE id = ${op.id}`,
				)
			}

			return 'applied' as const
		})

		if (result === 'applied') reportLegacyPair(op, sequenceDecision, options)
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
			scopeSnapshot: parseScopeSnapshot(row.scopeSnapshot),
		}))
	}

	async getOperationScopeSnapshots(
		operationIds: string[],
	): Promise<Map<string, OperationScopeSnapshot>> {
		this.assertOpen()
		const result = new Map<string, OperationScopeSnapshot>()
		for (let i = 0; i < operationIds.length; i += 500) {
			const ids = operationIds.slice(i, i + 500)
			if (ids.length === 0) continue
			const rows = this.db.all<{ id: string; scope_snapshot: string | null }>(
				sql`SELECT id, scope_snapshot FROM operations WHERE id IN (${sql.join(
					ids.map((id) => sql`${id}`),
					sql.raw(', '),
				)})`,
			)
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
		const rows = this.db.all<{ wall_time: number; logical: number; timestamp_node_id: string }>(
			sql`SELECT wall_time, logical, timestamp_node_id FROM operations
				WHERE collection = ${collection} AND record_id = ${recordId}
				ORDER BY wall_time DESC, logical DESC, timestamp_node_id DESC LIMIT 1`,
		)
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
		return foldFieldVersions(this.readFoldState(this.db, collection, recordId))
	}

	async getRecordFoldState(collection: string, recordId: string): Promise<FoldState | null> {
		this.assertOpen()
		return this.readFoldState(this.db, collection, recordId)
	}

	async getRecordOperations(collection: string, recordId: string): Promise<Operation[]> {
		this.assertOpen()
		return this.readRecordOperations(this.db, collection, recordId, 0)
	}

	async previewOperation(op: Operation): Promise<MaterializedRecord | null> {
		this.assertOpen()
		const schema = this.schema ?? EMPTY_FOLD_SCHEMA
		const current = this.readFoldState(this.db, op.collection, op.recordId)
		const merged = mergeIntoFoldState(current, [op], schema, this.foldOptions)
		const state =
			merged === REFOLD_REQUIRED
				? refoldRecord(
						[...this.readRecordOperations(this.db, op.collection, op.recordId, 0), op],
						schema,
						this.foldOptions,
					)
				: merged
		const row = state ? projectFoldState(state, this.foldOptions) : null
		if (!row || row.deleted) return null
		return { ...row.values, id: op.recordId }
	}

	async recordBlobOwner(hash: string, owner: string): Promise<void> {
		this.assertOpen()
		this.db.run(
			sql`INSERT OR IGNORE INTO blob_owners (hash, owner, created_at) VALUES (${hash}, ${owner}, ${Date.now()})`,
		)
	}

	async getBlobOwners(hashes: string[]): Promise<Map<string, string[]>> {
		this.assertOpen()
		const result = new Map<string, string[]>(hashes.map((hash) => [hash, []]))
		for (let i = 0; i < hashes.length; i += 500) {
			const slice = hashes.slice(i, i + 500)
			if (slice.length === 0) continue
			const rows = this.db.all<{ hash: string; owner: string }>(
				sql`SELECT hash, owner FROM blob_owners WHERE hash IN (${sql.join(
					slice.map((hash) => sql`${hash}`),
					sql.raw(', '),
				)})`,
			)
			for (const row of rows) result.get(row.hash)?.push(row.owner)
		}
		return result
	}

	async claimBlobIfUnowned(hash: string, owner: string): Promise<boolean> {
		this.assertOpen()
		// better-sqlite3 runs both statements synchronously under SQLite's writer lock,
		// so no other claim interleaves (and the file lock covers other processes).
		this.db.run(
			sql`INSERT OR IGNORE INTO blob_owners (hash, owner, created_at)
				SELECT ${hash}, ${owner}, ${Date.now()}
				WHERE NOT EXISTS (SELECT 1 FROM blob_owners WHERE hash = ${hash})`,
		)
		const rows = this.db.all<{ one: number }>(
			sql`SELECT 1 AS one FROM blob_owners WHERE hash = ${hash} AND owner = ${owner} LIMIT 1`,
		)
		return rows.length > 0
	}

	/**
	 * Scope values of a record as stored, for an operation's scope snapshot. With
	 * `includeDeleted` false a soft-deleted row counts as absent (the pre-image of a
	 * write to a deleted record); with true it keeps its last values (a delete's
	 * post-image).
	 */
	private readScopeValues(
		txOrDb: BetterSQLite3Database,
		collection: string,
		recordId: string,
		includeDeleted: boolean,
	): Record<string, unknown> | null {
		const collectionDef = this.schema?.collections[collection]
		if (!collectionDef) return null
		const rows = txOrDb.all<Record<string, unknown>>(
			sql`SELECT * FROM ${sql.raw(quoteIdent(collection))} WHERE id = ${recordId} LIMIT 1`,
		)
		const row = rows[0]
		if (!row) return null
		if (!includeDeleted && Number(row._deleted) === 1) return null
		return scopeValuesOf(this.schema, collection, recordId, this.deserializeRow(row, collectionDef))
	}

	/**
	 * Rebuild missing scope snapshots from the log (migration from a database written
	 * before snapshots existed), replaying each affected record in commit order.
	 */
	private backfillScopeSnapshots(): void {
		const schema = this.schema
		if (!schema) return
		const pending = this.db.all<{ collection: string; record_id: string }>(
			sql`SELECT DISTINCT collection, record_id FROM operations WHERE scope_snapshot IS NULL`,
		)
		const targets = pending.filter((row) => schema.collections[row.collection] !== undefined)
		if (targets.length === 0) return
		this.db.transaction((tx) => {
			for (const target of targets) {
				const rows = tx
					.select()
					.from(operations)
					.where(
						and(
							eq(operations.collection, target.collection),
							eq(operations.recordId, target.record_id),
						),
					)
					.orderBy(asc(operations.deliverySeq))
					.all()
				const replayed = replayScopeSnapshots(
					schema,
					target.collection,
					target.record_id,
					rows.map((row) => this.deserializeOperation(row)),
					this.foldOptions,
				)
				for (const row of rows) {
					if (row.scopeSnapshot !== null) continue
					const snapshot = replayed.get(row.id)
					if (!snapshot) continue
					tx.run(
						sql`UPDATE operations SET scope_snapshot = ${JSON.stringify(snapshot)} WHERE id = ${row.id}`,
					)
				}
			}
		})
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

	async getNodeIdsAfterDelivery(afterDeliverySequence: number): Promise<string[]> {
		this.assertOpen()
		const rows = this.db.all<{ node_id: string }>(
			sql`SELECT DISTINCT node_id FROM operations WHERE delivery_seq > ${afterDeliverySequence}`,
		)
		return rows.map((row) => row.node_id)
	}

	async getSequencePairOperations(nodeId: string, throughSequence: number): Promise<Operation[]> {
		this.assertOpen()
		const rows = this.db
			.select()
			.from(operations)
			.where(
				and(
					eq(operations.nodeId, nodeId),
					sql`${operations.sequenceNumber} IN (SELECT sequence_number FROM sequence_pairs WHERE node_id = ${nodeId} AND sequence_number <= ${throughSequence})`,
				),
			)
			.orderBy(asc(operations.sequenceNumber), asc(operations.deliverySeq))
			.all()
		return rows.map((row) => this.deserializeOperation(row))
	}

	async recordOperationResolution(resolution: OperationResolution): Promise<void> {
		this.assertOpen()
		this.db.run(
			sql`INSERT OR IGNORE INTO operation_resolutions
				(op_id, node_id, sequence_number, outcome, code, message, resolved_at)
				VALUES (${resolution.operationId}, ${resolution.nodeId}, ${resolution.sequenceNumber},
					${resolution.outcome}, ${resolution.code},
					${resolution.message?.slice(0, MAX_RESOLUTION_MESSAGE_LENGTH) ?? null}, ${Date.now()})`,
		)
	}

	async findOperationResolutions(
		nodeId: string,
		ids: string[],
	): Promise<Map<string, OperationResolution>> {
		this.assertOpen()
		const found = new Map<string, OperationResolution>()
		for (let i = 0; i < ids.length; i += 500) {
			const chunk = ids.slice(i, i + 500)
			if (chunk.length === 0) continue
			const rows = this.db.all<ResolutionRow>(
				sql`SELECT op_id, node_id, sequence_number, outcome, code, message FROM operation_resolutions
					WHERE node_id = ${nodeId} AND op_id IN (${sql.join(
						chunk.map((id) => sql`${id}`),
						sql.raw(', '),
					)})`,
			)
			for (const row of rows) found.set(row.op_id, resolutionFromRow(row))
		}
		return found
	}

	async deleteOperationResolution(nodeId: string, operationId: string): Promise<void> {
		this.assertOpen()
		this.db.run(
			sql`DELETE FROM operation_resolutions WHERE node_id = ${nodeId} AND op_id = ${operationId}`,
		)
	}

	async getResolvedThrough(nodeId: string): Promise<number> {
		this.assertOpen()
		const rows = this.db.all<{ m: number | string | null }>(
			sql`SELECT MAX(sequence_number) AS m FROM operation_resolutions WHERE node_id = ${nodeId}`,
		)
		return Number(rows[0]?.m ?? 0)
	}

	async findStoredOperations(ids: string[]): Promise<Map<string, StoredOperationKey>> {
		this.assertOpen()
		const found = new Map<string, StoredOperationKey>()
		// Chunked to stay far below SQLite's bound-parameter limit.
		for (let i = 0; i < ids.length; i += 500) {
			const chunk = ids.slice(i, i + 500)
			if (chunk.length === 0) continue
			const rows = this.db.all<{ id: string; node_id: string; sequence_number: number | string }>(
				sql`SELECT id, node_id, sequence_number FROM operations WHERE id IN (${sql.join(
					chunk.map((id) => sql`${id}`),
					sql.raw(', '),
				)})`,
			)
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
		this.assertSchema()
		this.assertCollection(collection)
		const schema = this.schema as SchemaDefinition
		const collectionDef = schema.collections[collection] as NonNullable<
			SchemaDefinition['collections'][string]
		>
		const result = new Map<string, MaterializedRecord>()
		// Chunked to stay far below SQLite's bound-parameter limit.
		for (let i = 0; i < ids.length; i += 500) {
			const chunk = ids.slice(i, i + 500)
			if (chunk.length === 0) continue
			const rows = this.db.all<Record<string, unknown>>(
				sql`SELECT * FROM ${sql.raw(quoteIdent(collection))} WHERE id IN (${sql.join(
					chunk.map((id) => sql`${id}`),
					sql.raw(', '),
				)})`,
			)
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

	async claimNode(nodeId: string, userId: string): Promise<boolean> {
		this.assertOpen()
		if (userId === RELEASED_NODE_OWNER) return false
		const now = Date.now()
		// better-sqlite3 runs these synchronously, so no other claim interleaves.
		// A fresh claim is only created for a node without history: history with no
		// claim predates node claims, so its writer is unknown (RT-5).
		this.db.run(
			sql`INSERT OR IGNORE INTO node_claims (node_id, user_id, claimed_at)
				SELECT ${nodeId}, ${userId}, ${now}
				WHERE NOT EXISTS (SELECT 1 FROM operations WHERE node_id = ${nodeId})`,
		)
		// An admin-released node is taken over by its next claimant.
		this.db.run(
			sql`UPDATE node_claims SET user_id = ${userId}, claimed_at = ${now}
				WHERE node_id = ${nodeId} AND user_id = ${RELEASED_NODE_OWNER}`,
		)
		const rows = this.db.all<{ user_id: string }>(
			sql`SELECT user_id FROM node_claims WHERE node_id = ${nodeId} LIMIT 1`,
		)
		return rows[0]?.user_id === userId
	}

	async getNodeClaimOwner(nodeId: string): Promise<string | null> {
		this.assertOpen()
		const rows = this.db.all<{ user_id: string }>(
			sql`SELECT user_id FROM node_claims WHERE node_id = ${nodeId} LIMIT 1`,
		)
		return rows[0]?.user_id ?? null
	}

	async replaceNodeClaim(
		nodeId: string,
		expectedOwner: string,
		newOwner: string,
	): Promise<boolean> {
		this.assertOpen()
		const rows = this.db.all<{ node_id: string }>(
			sql`UPDATE node_claims SET user_id = ${newOwner}, claimed_at = ${Date.now()}
				WHERE node_id = ${nodeId} AND user_id = ${expectedOwner} RETURNING node_id`,
		)
		return rows.length > 0
	}

	async releaseNodeClaim(nodeId: string): Promise<boolean> {
		this.assertOpen()
		const known = this.db.all<{ one: number }>(
			sql`SELECT 1 AS one WHERE EXISTS (SELECT 1 FROM node_claims WHERE node_id = ${nodeId})
				OR EXISTS (SELECT 1 FROM operations WHERE node_id = ${nodeId})`,
		)
		if (known.length === 0) return false
		this.db.run(
			sql`INSERT INTO node_claims (node_id, user_id, claimed_at)
				VALUES (${nodeId}, ${RELEASED_NODE_OWNER}, ${Date.now()})
				ON CONFLICT (node_id) DO UPDATE SET user_id = excluded.user_id, claimed_at = excluded.claimed_at`,
		)
		return true
	}

	/**
	 * The record as currently stored, including a soft-deleted one (whose last field
	 * values are kept), or null when it was never written. Without a materialized
	 * table, the last known values are replayed from the operation log.
	 */
	private readStoredRow(
		txOrDb: BetterSQLite3Database,
		collection: string,
		recordId: string,
	): MaterializedRecord | null {
		const collectionDef = this.schema?.collections[collection]
		if (collectionDef) {
			const rows = txOrDb.all<Record<string, unknown>>(
				sql`SELECT * FROM ${sql.raw(quoteIdent(collection))} WHERE id = ${recordId} LIMIT 1`,
			)
			const row = rows[0]
			return row ? this.deserializeRow(row, collectionDef) : null
		}
		const ops = this.readRecordOperations(txOrDb, collection, recordId, 0)
		if (ops.length === 0) return null
		const state = refoldRecord(ops, this.schema ?? EMPTY_FOLD_SCHEMA, this.foldOptions)
		const lastKnown = state ? projectFoldState(state, this.foldOptions) : null
		return { ...(lastKnown?.values ?? {}), id: recordId }
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

		const { mergeBackupOperations, parseServerBackup } = await import('./server-backup')
		const { operations: ops, versionVector } = parseServerBackup(data)

		if (merge) {
			const merged = await mergeBackupOperations(ops, (op) => this.applyRemoteOperation(op))
			return merged
		}

		// Replace mode: DROP and recreate
		this.db.transaction((tx) => {
			// Restored rows are inserted unflagged (`seq_unique = 0`): they may hold legacy
			// duplicate sequences, and they sit at or below the new epoch, so they stay
			// outside the partial unique index and are judged by the append check.
			tx.run(sql.raw('DELETE FROM operations'))
			tx.run(sql.raw('DELETE FROM sync_state'))
			tx.update(deliveryCounter).set({ value: 0 }).where(eq(deliveryCounter.id, 1)).run()

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
			tx.update(deliveryCounter).set({ value: deliverySeq }).where(eq(deliveryCounter.id, 1)).run()
			// The restored log's legacy pairs (RT-48), and only the resolutions it covers:
			// one past a node's restored log was decided after the backup, and advertising
			// it would hide stored operations the restore lost (RT-45).
			tx.run(sql.raw('DELETE FROM sequence_pairs'))
			tx.run(sql.raw(BACKFILL_SEQUENCE_PAIRS_SQL))
			tx.run(sql.raw(PRUNE_RESOLUTIONS_PAST_LOG_SQL))
			// The restored log is a snapshot that may hold legacy duplicate sequences: it
			// all sits at or below the new epoch, and enforcement resumes above it.
			tx.run(
				sql`INSERT OR REPLACE INTO kora_server_meta (key, value) VALUES (${SEQUENCE_ENFORCEMENT_EPOCH_KEY}, ${String(deliverySeq)})`,
			)
		})
		this.sequenceEpoch = this.ensureSequenceEnforcement()
		// Every restored record is re-materialized through the fold from the restored log.
		this.db.transaction((tx) => {
			tx.run(sql.raw('DELETE FROM kora_fold_state'))
			for (const collection of Object.keys(this.schema?.collections ?? {})) {
				tx.run(sql.raw(`DELETE FROM ${quoteIdent(collection)}`))
			}
		})
		if (this.schema) this.foldMigration = this.rematerialize()
		this.backfillScopeSnapshots()

		return { operationsRestored: ops.length, success: true }
	}

	// ---------------------------------------------------------------------------
	// Materialization internals
	// ---------------------------------------------------------------------------

	/**
	 * Merge a just-appended operation (stored under `deliverySeq`) into its record's
	 * fold state and project the row, inside the append transaction. O(fields the
	 * operation touches): the stored state is read by primary key and the freshness
	 * check is one index probe, never a scan of the record's history (SRV-7).
	 *
	 * The stored state records the highest delivery sequence it covers. If another
	 * writer appended operations to this record without folding them (an older release
	 * during a rolling upgrade), the missing tail is merged first; if the stored state
	 * is unreadable, newer than the log, or built under an incompatible field kind,
	 * the record is re-folded from its log.
	 */
	private mergeIntoRecord(tx: BetterSQLite3Database, op: Operation, deliverySeq: number): void {
		const schema = this.schema
		if (!schema?.collections[op.collection]) return
		const stored = tx.all<{ state: string; covered_seq: number; covered_op_id: string }>(
			sql`SELECT state, covered_seq, covered_op_id FROM kora_fold_state WHERE collection = ${op.collection} AND record_id = ${op.recordId}`,
		)[0]
		// The record's newest operation before this one: the stored state is current iff
		// it covers exactly that operation (sequence AND id, so a state left behind by a
		// dropped or restored log is never mistaken for current).
		const last = tx.all<{ id: string; d: number }>(
			sql`SELECT id, delivery_seq AS d FROM operations WHERE collection = ${op.collection} AND record_id = ${op.recordId} AND delivery_seq < ${deliverySeq} ORDER BY delivery_seq DESC LIMIT 1`,
		)[0]
		const prior = Number(last?.d ?? 0)
		const parsed = stored ? parseStoredFoldState(stored.state, op.collection, op.recordId) : null
		const covered = stored ? Number(stored.covered_seq) : 0
		let state: FoldState | null | typeof REFOLD_REQUIRED
		if (!stored && !last) {
			state = mergeIntoFoldState(null, [op], schema, this.foldOptions)
		} else if (parsed && covered === prior && stored?.covered_op_id === last?.id) {
			state = mergeIntoFoldState(parsed, [op], schema, this.foldOptions)
		} else if (
			parsed &&
			covered > 0 &&
			covered < prior &&
			this.coversStoredOperation(tx, op.collection, op.recordId, covered, stored?.covered_op_id)
		) {
			// Operations appended without folding (an older release during a rolling
			// upgrade): merge the missing tail.
			state = mergeIntoFoldState(
				parsed,
				this.readRecordOperations(tx, op.collection, op.recordId, covered),
				schema,
				this.foldOptions,
			)
		} else {
			state = REFOLD_REQUIRED
		}
		if (state === REFOLD_REQUIRED) {
			state = refoldRecord(
				this.readRecordOperations(tx, op.collection, op.recordId, 0),
				schema,
				this.foldOptions,
			)
		}
		this.writeFoldedRecord(tx, op.collection, op.recordId, state, deliverySeq, op.id)
	}

	/** True when the record's operation at delivery sequence `seq` has id `opId`. */
	private coversStoredOperation(
		txOrDb: BetterSQLite3Database,
		collection: string,
		recordId: string,
		seq: number,
		opId: string | undefined,
	): boolean {
		if (!opId) return false
		return (
			txOrDb.all<{ one: number }>(
				sql`SELECT 1 AS one FROM operations WHERE id = ${opId} AND collection = ${collection} AND record_id = ${recordId} AND delivery_seq = ${seq}`,
			).length > 0
		)
	}

	/**
	 * The record's current fold state for a read: the stored one when it covers the
	 * record's whole log, else folded from the log (nothing is written).
	 */
	private readFoldState(
		txOrDb: BetterSQLite3Database,
		collection: string,
		recordId: string,
	): FoldState | null {
		const schema = this.schema ?? EMPTY_FOLD_SCHEMA
		if (schema.collections[collection]) {
			const stored = txOrDb.all<{ state: string; covered_seq: number; covered_op_id: string }>(
				sql`SELECT state, covered_seq, covered_op_id FROM kora_fold_state WHERE collection = ${collection} AND record_id = ${recordId}`,
			)[0]
			const last = txOrDb.all<{ id: string; d: number }>(
				sql`SELECT id, delivery_seq AS d FROM operations WHERE collection = ${collection} AND record_id = ${recordId} ORDER BY delivery_seq DESC LIMIT 1`,
			)[0]
			const parsed = stored ? parseStoredFoldState(stored.state, collection, recordId) : null
			if (
				parsed &&
				last &&
				Number(stored?.covered_seq) === Number(last.d) &&
				stored?.covered_op_id === last.id
			) {
				return parsed
			}
		}
		const ops = this.readRecordOperations(txOrDb, collection, recordId, 0)
		return ops.length > 0 ? refoldRecord(ops, schema, this.foldOptions) : null
	}

	/** A record's operations stored after `afterDeliverySeq`, in delivery order. */
	private readRecordOperations(
		txOrDb: BetterSQLite3Database,
		collection: string,
		recordId: string,
		afterDeliverySeq: number,
	): Operation[] {
		return txOrDb
			.select()
			.from(operations)
			.where(
				and(
					eq(operations.collection, collection),
					eq(operations.recordId, recordId),
					gt(operations.deliverySeq, afterDeliverySeq),
				),
			)
			.orderBy(asc(operations.deliverySeq))
			.all()
			.map((row) => this.deserializeOperation(row))
	}

	/**
	 * Persist a record's fold state (covering the log up to `coveredSeq`) and project
	 * it onto the materialized row.
	 */
	private writeFoldedRecord(
		txOrDb: BetterSQLite3Database,
		collection: string,
		recordId: string,
		state: FoldState | null,
		coveredSeq: number,
		coveredOpId: string,
	): void {
		const collectionDef = this.schema?.collections[collection]
		if (!collectionDef) return
		if (state) {
			txOrDb.run(
				sql`INSERT INTO kora_fold_state (collection, record_id, state, covered_seq, covered_op_id)
					VALUES (${collection}, ${recordId}, ${serializeServerFoldState(state)}, ${coveredSeq}, ${coveredOpId})
					ON CONFLICT (collection, record_id) DO UPDATE SET state = excluded.state, covered_seq = excluded.covered_seq, covered_op_id = excluded.covered_op_id`,
			)
		} else {
			txOrDb.run(
				sql`DELETE FROM kora_fold_state WHERE collection = ${collection} AND record_id = ${recordId}`,
			)
		}
		const row = state ? projectFoldState(state, this.foldOptions) : null
		if (!row) {
			// Never inserted (an update with no merged insert): no visible row. A row an
			// earlier (replay) materialization produced for it is hidden.
			txOrDb.run(
				sql`UPDATE ${sql.raw(quoteIdent(collection))} SET _deleted = 1 WHERE id = ${recordId}`,
			)
			return
		}
		this.upsertMaterializedRecord(
			txOrDb,
			collection,
			recordId,
			row.values,
			Object.keys(collectionDef.fields),
			collectionDef,
			row.createdAt,
			row.updatedAt,
			row.deleted,
		)
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
		deleted: boolean,
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
			deleted ? 1 : 0,
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
	 * Re-materialization migration (W7 step 7), run by setSchema and after a
	 * replace-mode restore. Every record whose fold state is missing, stale (it covers
	 * less, or more, of the log than is stored) or built under a different fold plan
	 * (field kind, merge strategy, resolver) is re-folded from its log and its row
	 * rewritten; nothing else is touched, so a restart on an up-to-date database does
	 * one aggregate read.
	 *
	 * - Runs only on a log the W8b integrity scan reports clean. With quarantined rows,
	 *   rows materialized before the fold existed are kept as they are (re-folding a
	 *   log that lost operations would bake the loss in) and the skip is logged loudly;
	 *   such a record is folded from its remaining log on its next write. Records with
	 *   no row yet, and fold states this release already wrote, are still processed.
	 * - Idempotent and resumable: each batch commits on its own, and staleness is
	 *   re-derived from the tables at every start, so a crash resumes where it stopped.
	 *   A plan change first marks every stored state stale (one statement), then
	 *   records the new fingerprint, so it is resumable too.
	 */
	private rematerialize(): FoldMigrationReport {
		const schema = this.schema
		const report: FoldMigrationReport = {
			ran: true,
			records: 0,
			skippedUnclean: 0,
			fullRefold: false,
		}
		if (!schema) return { ...report, ran: false }
		const clean = this.logIntegrity.totalQuarantined === 0
		const fingerprint = foldPlanFingerprint(schema)
		const storedFingerprint = this.db.all<{ value: string }>(
			sql`SELECT value FROM kora_server_meta WHERE key = ${FOLD_PLAN_FINGERPRINT_KEY}`,
		)[0]?.value
		if (storedFingerprint !== fingerprint) {
			report.fullRefold = storedFingerprint !== undefined
			this.db.transaction((tx) => {
				tx.run(sql`UPDATE kora_fold_state SET covered_seq = -1`)
				tx.run(
					sql`INSERT OR REPLACE INTO kora_server_meta (key, value) VALUES (${FOLD_PLAN_FINGERPRINT_KEY}, ${fingerprint})`,
				)
			})
		}
		for (const collection of Object.keys(schema.collections)) {
			let cursor = ''
			for (;;) {
				const page = this.db.all<{
					record_id: string
					max_seq: number
					covered: number | null
					has_row: number
				}>(
					sql`SELECT o.record_id AS record_id, MAX(o.delivery_seq) AS max_seq,
						(SELECT f.covered_seq FROM kora_fold_state f WHERE f.collection = o.collection AND f.record_id = o.record_id) AS covered,
						(SELECT f.covered_op_id FROM kora_fold_state f WHERE f.collection = o.collection AND f.record_id = o.record_id) AS covered_op_id,
						EXISTS (SELECT 1 FROM ${sql.raw(quoteIdent(collection))} c WHERE c.id = o.record_id) AS has_row
					FROM operations o
					WHERE o.collection = ${collection} AND o.record_id > ${cursor}
					GROUP BY o.record_id
					HAVING covered IS NULL OR covered <> MAX(o.delivery_seq) OR NOT EXISTS (
						SELECT 1 FROM operations x WHERE x.id = covered_op_id AND x.delivery_seq = covered
					)
					ORDER BY o.record_id
					LIMIT ${FOLD_MIGRATION_BATCH}`,
				)
				if (page.length === 0) break
				cursor = page[page.length - 1]?.record_id ?? cursor
				this.db.transaction((tx) => {
					for (const candidate of page) {
						if (!clean && candidate.covered === null && Number(candidate.has_row) === 1) {
							report.skippedUnclean++
							continue
						}
						const rows = tx
							.select()
							.from(operations)
							.where(
								and(
									eq(operations.collection, collection),
									eq(operations.recordId, candidate.record_id),
								),
							)
							.all()
						let covered = 0
						let coveredOpId = ''
						for (const row of rows) {
							if ((row.deliverySeq ?? 0) > covered) {
								covered = row.deliverySeq ?? 0
								coveredOpId = row.id
							}
						}
						const ops = rows.map((row) => this.deserializeOperation(row))
						this.writeFoldedRecord(
							tx,
							collection,
							candidate.record_id,
							refoldRecord(ops, schema, this.foldOptions),
							covered,
							coveredOpId,
						)
						report.records++
					}
				})
				if (page.length < FOLD_MIGRATION_BATCH) break
			}
		}
		if (report.skippedUnclean > 0) {
			console.error(
				`[kora] Fold re-materialization skipped ${report.skippedUnclean} record(s): the operation log has ${this.logIntegrity.totalQuarantined} quarantined row(s) (see operations_quarantine). Their rows keep their pre-fold values until their next write. Repair or release the quarantined rows, then restart to re-materialize.`,
			)
		}
		return report
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
		// A soft-deleted row (only returned when deleted rows are asked for) says so, so a
		// caller never mistakes the last values the fold keeps on it for a live record.
		if (Number(row._deleted) === 1) record._deleted = 1

		return record
	}

	// ---------------------------------------------------------------------------
	// Fallback materialization (operation replay, no schema)
	// ---------------------------------------------------------------------------

	private materializeFromOpsLog(collection: string): MaterializedRecord[] {
		const ids = this.db.all<{ record_id: string }>(
			sql`SELECT DISTINCT record_id FROM operations WHERE collection = ${collection} ORDER BY record_id`,
		)
		const records: MaterializedRecord[] = []
		for (const { record_id: recordId } of ids) {
			const ops = this.readRecordOperations(this.db, collection, recordId, 0)
			const state = refoldRecord(ops, this.schema ?? EMPTY_FOLD_SCHEMA, this.foldOptions)
			const row = state ? projectFoldState(state, this.foldOptions) : null
			if (row && !row.deleted) records.push({ id: recordId, ...row.values })
		}
		return records
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

		// Backward-compatible migration: the per-operation scope snapshot (RT-14). Rows
		// written before it are backfilled from the log when the schema is set.
		try {
			this.db.run(sql`ALTER TABLE operations ADD COLUMN scope_snapshot TEXT`)
		} catch (e) {
			const msg = e instanceof Error ? e.message : ''
			const causeMsg = e instanceof Error && e.cause instanceof Error ? e.cause.message : ''
			if (!msg.includes('duplicate column') && !causeMsg.includes('duplicate column')) {
				throw e
			}
		}

		// Backward-compatible migration (RT-37): the sole-holder flag behind the partial
		// unique index. Existing rows read 0 (outside the index; the append check still
		// judges them as holders).
		try {
			this.db.run(sql`ALTER TABLE operations ADD COLUMN seq_unique INTEGER NOT NULL DEFAULT 0`)
		} catch (e) {
			const msg = e instanceof Error ? e.message : ''
			const causeMsg = e instanceof Error && e.cause instanceof Error ? e.cause.message : ''
			if (!msg.includes('duplicate column') && !causeMsg.includes('duplicate column')) {
				throw e
			}
		}

		// Content-hash version of the stored id (CORE-1, protocol v2). Null means 1.
		try {
			this.db.run(sql`ALTER TABLE operations ADD COLUMN hash_version INTEGER`)
		} catch (e) {
			const msg = e instanceof Error ? e.message : ''
			const causeMsg = e instanceof Error && e.cause instanceof Error ? e.cause.message : ''
			if (!msg.includes('duplicate column') && !causeMsg.includes('duplicate column')) {
				throw e
			}
		}

		// Encryption envelope of the operation (protocol v2), stored opaquely (JSON).
		try {
			this.db.run(sql`ALTER TABLE operations ADD COLUMN encrypted TEXT`)
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
		// Per-record fold state (W7): the materialized row is projected from it.
		// `covered_seq` / `covered_op_id`: the delivery sequence and id of the record's
		// newest operation merged into it (the state covers every operation up to it).
		this.db.run(sql`
			CREATE TABLE IF NOT EXISTS kora_fold_state (
				collection TEXT NOT NULL,
				record_id TEXT NOT NULL,
				state TEXT NOT NULL,
				covered_seq INTEGER NOT NULL,
				covered_op_id TEXT NOT NULL DEFAULT '',
				PRIMARY KEY (collection, record_id)
			)
		`)
		// A pre-release table may lack it; '' never matches an operation id, so such a
		// state is re-folded on its next use.
		try {
			this.db.run(
				sql`ALTER TABLE kora_fold_state ADD COLUMN covered_op_id TEXT NOT NULL DEFAULT ''`,
			)
		} catch (e) {
			const msg = e instanceof Error ? e.message : ''
			const causeMsg = e instanceof Error && e.cause instanceof Error ? e.cause.message : ''
			if (!msg.includes('duplicate column') && !causeMsg.includes('duplicate column')) {
				throw e
			}
		}
		// Blob content hash -> principals that pushed (or first claimed) it (RT-11).
		this.db.run(sql`
			CREATE TABLE IF NOT EXISTS blob_owners (
				hash TEXT NOT NULL,
				owner TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				PRIMARY KEY (hash, owner)
			)
		`)

		// Small key/value store for server-side metadata (snapshot fingerprint, RT-20).
		this.db.run(sql`
			CREATE TABLE IF NOT EXISTS kora_server_meta (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			)
		`)

		// Node id -> principal binding (see claimNode). One row per device node id.
		this.db.run(sql`
			CREATE TABLE IF NOT EXISTS node_claims (
				node_id TEXT PRIMARY KEY,
				user_id TEXT NOT NULL,
				claimed_at INTEGER NOT NULL
			)
		`)

		this.db.run(sql`
			CREATE INDEX IF NOT EXISTS idx_delivery_seq ON operations (delivery_seq)
		`)

		this.db.run(sql`
			CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_seq_unique
			ON operations (delivery_seq)
			WHERE delivery_seq IS NOT NULL
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
		// A record's newest delivery sequence in one probe (the fold freshness check).
		this.db.run(sql`
			CREATE INDEX IF NOT EXISTS idx_collection_record_delivery ON operations (collection, record_id, delivery_seq)
		`)

		this.db.run(sql`
			CREATE TABLE IF NOT EXISTS sync_state (
				node_id TEXT PRIMARY KEY,
				max_sequence_number INTEGER NOT NULL,
				last_seen_at INTEGER NOT NULL
			)
		`)

		this.db.run(sql`
			CREATE TABLE IF NOT EXISTS delivery_counter (
				id INTEGER PRIMARY KEY,
				value INTEGER NOT NULL
			)
		`)

		// How uploaded operations were resolved without being stored under their sequence
		// (validator `ignore`, terminal refusal, renumbered duplicate; RT-43, RT-47).
		this.db.run(sql`
			CREATE TABLE IF NOT EXISTS operation_resolutions (
				op_id TEXT PRIMARY KEY,
				node_id TEXT NOT NULL,
				sequence_number INTEGER NOT NULL,
				outcome TEXT NOT NULL,
				code TEXT,
				message TEXT,
				resolved_at INTEGER NOT NULL
			)
		`)
		this.db.run(sql`
			CREATE INDEX IF NOT EXISTS idx_resolutions_node_seq
			ON operation_resolutions (node_id, sequence_number)
		`)
		// (node, sequence) held by more than one operation: legacy pairs (RT-48).
		this.db.run(sql`
			CREATE TABLE IF NOT EXISTS sequence_pairs (
				node_id TEXT NOT NULL,
				sequence_number INTEGER NOT NULL,
				PRIMARY KEY (node_id, sequence_number)
			)
		`)

		this.backfillDeliverySequence()
		this.sequenceEpoch = this.ensureSequenceEnforcement()
		this.backfillSequencePairs()
		this.logIntegrity = this.scanLogIntegrityOnce()
	}

	/**
	 * The startup log-integrity scan's result (W8 step 0): rows that could not be read
	 * back into an operation are moved to `operations_quarantine` once per database,
	 * before any fold reads them.
	 */
	getLogIntegrityReport(): ServerLogIntegrityReport {
		return { ...this.logIntegrity, quarantined: [...this.logIntegrity.quarantined] }
	}

	private scanLogIntegrityOnce(): ServerLogIntegrityReport {
		this.db.run(sql.raw(SERVER_LOG_QUARANTINE_DDL))
		const report: ServerLogIntegrityReport = {
			checkedRows: 0,
			quarantined: [],
			ran: false,
			totalQuarantined: 0,
		}
		const done = this.db.all<{ value: string }>(
			sql`SELECT value FROM kora_server_meta WHERE key = ${SERVER_LOG_INTEGRITY_META_KEY}`,
		)
		if (done.length === 0) {
			report.ran = true
			const bad: Array<{
				rowid: number
				row: ServerOperationRow
				problem: string
				detail: string
			}> = []
			let after = 0
			for (;;) {
				const page = this.db.all<ServerOperationRow & { __rowid: number }>(
					sql`SELECT rowid AS __rowid, id, node_id, type, collection, record_id, data, previous_data, atomic_ops, wall_time, logical, timestamp_node_id, sequence_number, causal_deps, schema_version FROM operations WHERE rowid > ${after} ORDER BY rowid LIMIT 1000`,
				)
				for (const { __rowid, ...row } of page) {
					report.checkedRows++
					const verdict = checkServerOperationRow(row)
					if (verdict) bad.push({ rowid: __rowid, row, ...verdict })
				}
				if (page.length < 1000) break
				after = page[page.length - 1]?.__rowid ?? after
			}
			const now = Date.now()
			this.db.transaction((tx) => {
				for (const entry of bad) {
					const id = typeof entry.row.id === 'string' ? entry.row.id : `rowid:${entry.rowid}`
					tx.run(
						sql`INSERT OR REPLACE INTO operations_quarantine (id, problem, detail, row_json, quarantined_at) VALUES (${id}, ${entry.problem}, ${entry.detail}, ${quarantineRowJson(entry.row)}, ${now})`,
					)
					tx.run(sql`DELETE FROM operations WHERE rowid = ${entry.rowid}`)
					report.quarantined.push({ operationId: id, problem: entry.problem, detail: entry.detail })
				}
				tx.run(
					sql`INSERT OR REPLACE INTO kora_server_meta (key, value) VALUES (${SERVER_LOG_INTEGRITY_META_KEY}, ${String(now)})`,
				)
			})
			if (bad.length > 0) {
				console.warn(
					`[kora] Log integrity: ${bad.length} unreadable operation row(s) moved to operations_quarantine.`,
				)
			}
		}
		const total = this.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM operations_quarantine`)
		report.totalQuarantined = Number(total[0]?.n ?? 0)
		return report
	}

	/**
	 * Index the legacy pairs already in the log once (history written before the
	 * `sequence_pairs` table existed); appends maintain it from then on.
	 */
	private backfillSequencePairs(): void {
		this.db.transaction((tx) => {
			const done = tx.all<{ value: string }>(
				sql`SELECT value FROM kora_server_meta WHERE key = ${SEQUENCE_PAIRS_BACKFILLED_KEY}`,
			)
			if (done.length > 0) return
			tx.run(sql.raw(BACKFILL_SEQUENCE_PAIRS_SQL))
			tx.run(
				sql`INSERT OR REPLACE INTO kora_server_meta (key, value) VALUES (${SEQUENCE_PAIRS_BACKFILLED_KEY}, '1')`,
			)
		})
	}

	/**
	 * Record the sequence-enforcement epoch on the first start of this release (the log's
	 * highest delivery sequence then; see {@link SEQUENCE_ENFORCEMENT_EPOCH_KEY}) and
	 * back the append check with the partial unique index over sole-holder rows
	 * ({@link NODE_SEQ_UNIQUE_INDEX}), which therefore always exists: a legacy duplicate
	 * pair is stored unflagged. Replaces the earlier indexes (a full one, created only
	 * when the log had no duplicates, and one over the rows past the epoch, which a
	 * legacy client's pair would violate). Runs in one write transaction, so stores
	 * sharing a file agree on the epoch.
	 */
	private ensureSequenceEnforcement(): number {
		return this.db.transaction((tx) => {
			tx.run(
				sql`INSERT OR IGNORE INTO kora_server_meta (key, value)
					SELECT ${SEQUENCE_ENFORCEMENT_EPOCH_KEY}, CAST(COALESCE(MAX(delivery_seq), 0) AS TEXT) FROM operations`,
			)
			const stored = tx.all<{ value: string }>(
				sql`SELECT value FROM kora_server_meta WHERE key = ${SEQUENCE_ENFORCEMENT_EPOCH_KEY}`,
			)[0]?.value
			// Absent only if the row could not be written: enforce everything (epoch 0).
			const epoch = stored === undefined ? 0 : Number(stored)
			if (!Number.isSafeInteger(epoch) || epoch < 0) {
				throw new Error(
					`kora_server_meta.${SEQUENCE_ENFORCEMENT_EPOCH_KEY} holds "${String(stored)}", not a delivery sequence. Restore it from a backup or delete the row to re-derive it.`,
				)
			}
			for (const superseded of SUPERSEDED_NODE_SEQ_UNIQUE_INDEXES) {
				tx.run(sql.raw(`DROP INDEX IF EXISTS ${superseded}`))
			}
			// A row is flagged only when nothing held its sequence at insert, so flagged
			// duplicates can come only from outside writes (a manual edit, an older release
			// writing into this file). Before (re)creating the index, unflag them: they stay
			// stored and judged by the append check, and the index creation cannot fail.
			const indexed = tx.all<{ name: string }>(
				sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ${NODE_SEQ_UNIQUE_INDEX}`,
			)
			if (indexed.length === 0) {
				tx.run(sql`
					UPDATE operations SET seq_unique = 0
					WHERE seq_unique = 1 AND EXISTS (
						SELECT 1 FROM operations other
						WHERE other.node_id = operations.node_id
							AND other.sequence_number = operations.sequence_number
							AND other.id <> operations.id
					)
				`)
			}
			tx.run(
				sql.raw(
					`CREATE UNIQUE INDEX IF NOT EXISTS ${NODE_SEQ_UNIQUE_INDEX} ON operations (node_id, sequence_number) WHERE seq_unique = 1`,
				),
			)
			return epoch
		})
	}

	/**
	 * Assign delivery sequences to any operations written before the column existed,
	 * then seed the durable counter from the current max. Ordered by
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
			tx.insert(deliveryCounter)
				.values({ id: 1, value: next })
				.onConflictDoUpdate({
					target: deliveryCounter.id,
					set: {
						value: sql`MAX(${deliveryCounter.value}, ${next})`,
					},
				})
				.run()
		})
	}

	/**
	 * Reserve the next delivery sequence inside the append transaction. SQLite locks
	 * the database for the write transaction, and this counter row keeps sequence
	 * allocation shared by every SqliteServerStore instance using the same file.
	 */
	private nextDeliverySeq(tx: BetterSQLite3Database): number {
		const rows = tx
			.update(deliveryCounter)
			.set({ value: sql`${deliveryCounter.value} + 1` })
			.where(eq(deliveryCounter.id, 1))
			.returning({ value: deliveryCounter.value })
			.all()
		const value = rows[0]?.value
		if (value === undefined || value === null) {
			throw new Error(
				'delivery_counter row (id=1) is missing; the operations log cannot assign delivery sequences',
			)
		}
		return value
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
			seqUnique: soleHolder ? 1 : 0,
			hashVersion: op.hashVersion ?? null,
			encrypted: envelopeColumn(op),
		}
	}

	private deserializeOperation(row: typeof operations.$inferSelect): Operation {
		const atomicOps =
			row.atomicOps != null ? (JSON.parse(row.atomicOps) as Record<string, AtomicOp>) : undefined
		const encrypted = parseEnvelopeColumn(row.encrypted)
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
			...(row.hashVersion === 1 || row.hashVersion === 2 ? { hashVersion: row.hashVersion } : {}),
			...(encrypted !== undefined ? { encrypted } : {}),
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
	/** Node ids, besides the store's own, whose operations win server-authoritative fields. */
	authoritativeNodeIds?: string[]
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
	return new SqliteServerStore(db, options.nodeId, {
		...(options.authoritativeNodeIds ? { authoritativeNodeIds: options.authoritativeNodeIds } : {}),
	})
}
