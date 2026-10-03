import {
	FOLD_STATE_VERSION,
	type FoldOptions,
	type FoldState,
	FoldStateError,
	type FoldTrace,
	HybridLogicalClock,
	type MergeTrace,
	type Operation,
	type OperationTransform,
	type SchemaDefinition,
	adaptFoldState,
	base64ToBytes,
	createFoldState,
	deserializeFoldState,
	getFoldFieldVersionStrings,
	isFoldStateLive,
	joinStates,
	materialize,
	mergeOp,
	mismatchedFoldFields,
	quoteIdent,
	serializeFoldState,
	toMergeTrace,
} from '@korajs/core'
import * as Y from 'yjs'
import { buildInsertQuery } from '../query/sql-builder'
import { deserializeOperationWithCollection, serializeRecord } from '../serialization/serializer'
import { loadRetainedConflictRows } from '../store/sequence-repair'
import { TERMINAL_REJECTIONS_TABLE } from '../sync/local-sync-records'
import type { OperationRow, RawCollectionRow, Transaction } from '../types'

/** Per-record fold state (serialized `FoldState`) of every record this database holds. */
export const FOLD_STATE_TABLE = '_kora_fold_state'
/**
 * Per-record base state of operations no longer in the log (compacted, or a snapshot
 * of a row whose history was compacted or quarantined before W7). A record's state
 * is always `join(base, fold(log))`.
 */
export const FOLD_BASE_TABLE = '_kora_fold_base'
/** Per-node sequence prefix removed by compaction: ids at or below it are duplicates. */
export const COMPACTED_THROUGH_TABLE = '_kora_compacted_through'
/**
 * Per-record row snapshots (RT-68): the base built from a materialized row when the
 * record's history is not all in the log (a pre-W7 compaction, quarantined log rows).
 * Kept apart from `_kora_fold_base` (which holds only exact, operation-built states)
 * so the approximation can be dropped once the record's history is complete again:
 * when the server's fold state arrives in a scope entry, or after a full resync.
 * A record's state is `join(base, snapshot, fold(log))`.
 */
export const FOLD_SNAPSHOT_TABLE = '_kora_fold_snapshot'
/**
 * Local-only provisional side effects (RT-69): the cascades / set-nulls a device
 * derives for a REMOTE delete. They fold into the record like operations but are
 * never logged, sequenced or uploaded (the server derives and relays its own
 * copy); each is retired when the server's copy for the same parent and record
 * arrives, or when the device's delivery stream has caught up.

 */
export const PROVISIONAL_OPS_TABLE = '_kora_provisional_ops'
/**
 * Terminal-rejection codes the fold does NOT exclude: the user discarded a held
 * node's writes (they stay in the local database; only their upload stops).
 */
const KEPT_REJECTION_CODES: readonly string[] = ['HELD_DISCARDED']
/** `_kora_meta` key recording how the rows of this database are materialized. */
export const FOLD_MATERIALIZATION_META_KEY = 'fold_materialization'
/** Value of {@link FOLD_MATERIALIZATION_META_KEY} once rows are materializations of the current fold. */
export const FOLD_MATERIALIZATION_CURRENT = `fold-v${FOLD_STATE_VERSION}`
/** Value of {@link FOLD_MATERIALIZATION_META_KEY} while the legacy (beta.13) paths write rows. */
export const FOLD_MATERIALIZATION_LEGACY = 'legacy'

/** DDL for the fold tables. Idempotent. */
export const FOLD_TABLES_DDL: readonly string[] = [
	`CREATE TABLE IF NOT EXISTS ${FOLD_STATE_TABLE} (collection TEXT NOT NULL, record_id TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY (collection, record_id))`,
	`CREATE TABLE IF NOT EXISTS ${FOLD_BASE_TABLE} (collection TEXT NOT NULL, record_id TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY (collection, record_id))`,
	`CREATE TABLE IF NOT EXISTS ${COMPACTED_THROUGH_TABLE} (node_id TEXT PRIMARY KEY, sequence_number INTEGER NOT NULL)`,
	`CREATE TABLE IF NOT EXISTS ${FOLD_SNAPSHOT_TABLE} (collection TEXT NOT NULL, record_id TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY (collection, record_id))`,
	`CREATE TABLE IF NOT EXISTS ${PROVISIONAL_OPS_TABLE} (id TEXT PRIMARY KEY, collection TEXT NOT NULL, record_id TEXT NOT NULL, parent_id TEXT NOT NULL, operation TEXT NOT NULL)`,
	`CREATE INDEX IF NOT EXISTS ${PROVISIONAL_OPS_TABLE}_record ON ${PROVISIONAL_OPS_TABLE} (collection, record_id)`,
]

/**
 * Merges richtext Yjs updates for the fold (core has no Yjs dependency): applies
 * every update to one fresh document and encodes its state. The encoding depends
 * only on the document's content, not on how it was split into updates, so every
 * replica materializes byte-identical richtext.
 */
export function mergeYjsUpdates(updates: Uint8Array[]): Uint8Array {
	const doc = new Y.Doc()
	for (const update of updates) Y.applyUpdate(doc, update)
	return Y.encodeStateAsUpdate(doc)
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
	return true
}

/**
 * Whether Yjs update `a` adds nothing to update `b` (the fold's richtext space
 * bound): the canonical encoding of `b` alone equals that of `a` and `b` merged.
 */
export function yjsSubsumes(a: Uint8Array, b: Uint8Array): boolean {
	return sameBytes(mergeYjsUpdates([b]), mergeYjsUpdates([a, b]))
}

/**
 * Whether an operation lies in a node's compacted prefix: its row is gone from the
 * log, but its effect is in the record's base state, so it is a duplicate (STORE-14).
 */
export async function isCompacted(tx: Transaction, op: Operation): Promise<boolean> {
	const rows = await tx.query<{ sequence_number: number }>(
		`SELECT sequence_number FROM ${COMPACTED_THROUGH_TABLE} WHERE node_id = ?`,
		[op.nodeId],
	)
	const through = rows[0]?.sequence_number
	return through !== undefined && op.sequenceNumber <= through
}

/** Which fields of a row to (re)write from the fold state. */
export type MaterializeFields = 'all' | ReadonlySet<string>

/** Result of merging one operation into its record. */
export interface FoldApplyOutcome {
	/** The merge changed the record's state. */
	changed: boolean
	/** Merge traces (MergeTrace form), for `merge:*` events. */
	traces: MergeTrace[]
}

/**
 * The client side of the W7 fold: every write to a materialized row — local
 * writes, remote operations, scope entries, rejection re-merges, re-materialization
 * — goes through this class, inside the write transaction that appends the
 * operation ("append, then merge"). A row is always the materialization of its
 * record's fold state.
 */
export class RecordFolder {
	private authoritative: ReadonlySet<string> = new Set()

	constructor(
		private readonly schema: SchemaDefinition,
		private readonly transforms: readonly OperationTransform[] = [],
	) {}

	/** The schema transforms every merge applies (transforms at fold time, RT-84). */
	getOperationTransforms(): readonly OperationTransform[] {
		return this.transforms
	}

	/**
	 * The fields an operation's merge can change: its own data's keys, or every field
	 * when the fold reads it through a schema transform (whose view may name others).
	 */
	private touchedFields(op: Operation): MaterializeFields {
		if (this.transforms.length > 0 && op.schemaVersion !== this.schema.version) return 'all'
		return new Set(Object.keys(op.data ?? {}))
	}

	/** Node ids whose writes win `merge('server-authoritative')` fields. */
	getAuthoritativeNodeIds(): ReadonlySet<string> {
		return this.authoritative
	}

	/** @internal Set by the store from persisted meta / the sync handshake. */
	setAuthoritativeNodeIds(ids: Iterable<string>): void {
		this.authoritative = new Set(ids)
	}

	/** Fold options every merge of this database uses. */
	options(traces: FoldOptions['traces'] = 'none'): FoldOptions {
		return {
			richtext: mergeYjsUpdates,
			richtextSubsumes: yjsSubsumes,
			traces,
			...(this.authoritative.size > 0 ? { authoritativeNodeIds: this.authoritative } : {}),
			...(this.transforms.length > 0 ? { transforms: this.transforms } : {}),
		}
	}

	/** Whether the schema has a `merge('server-authoritative')` field in `collection`. */
	hasAuthoritativeFields(collection: string): boolean {
		const definition = this.schema.collections[collection]
		if (!definition) return false
		return Object.values(definition.fields).some(
			(field) => field.mergeStrategy === 'server-authoritative',
		)
	}

	/**
	 * Merge one operation (already appended to the log) into its record and
	 * re-materialize the row.
	 *
	 * @param tx - The write transaction that appended the operation
	 * @param op - The operation
	 * @param mode - 'remote' emits merge traces; 'local' does not (a local write is
	 *   computed from the row it updates, so it is never concurrent with it)
	 */
	async applyInTx(
		tx: Transaction,
		op: Operation,
		mode: 'local' | 'remote',
	): Promise<FoldApplyOutcome> {
		const scopeEntry = op.type === 'insert'
		if (mode === 'remote') {
			// The record's approximations end here: a provisional cascade of this parent
			// is replaced by the real one (RT-69), and a row snapshot by the server's
			// complete fold state (RT-68). The operation is already in the log, so the
			// record is re-folded without them.
			const retired = await this.deleteProvisional(tx, op.collection, op.recordId, op.causalDeps)
			const replaced = await this.dropSnapshotForCarriedState(tx, op)
			if (retired > 0 || replaced) {
				await this.refoldInTx(tx, op.collection, op.recordId, { clearRetraction: scopeEntry })
				return { changed: true, traces: [] }
			}
		}
		// A local insert has a fresh UUIDv7 record id: no state, log or row precedes it.
		const fresh = mode === 'local' && op.type === 'insert'
		const prior = fresh
			? { state: createFoldState(op.collection, op.recordId), rebuilt: false }
			: await this.loadOrRebuild(tx, op.collection, op.recordId, op.id)
		let result: ReturnType<typeof mergeOp>
		try {
			result = mergeOp(
				prior.state,
				op,
				this.schema,
				this.options(mode === 'remote' ? 'conflicts' : 'none'),
			)
		} catch (error) {
			if (!(error instanceof FoldStateError)) throw error
			// A stored state the current plan cannot take (RT-63): re-fold the record from
			// its base and log (the operation is already appended) once. A second
			// FoldStateError propagates; the sync engine then quarantines the operation
			// instead of stalling its delivery stream.
			await this.refoldInTx(tx, op.collection, op.recordId, { clearRetraction: scopeEntry })
			return { changed: true, traces: [] }
		}
		if (!result.changed && !prior.rebuilt && !scopeEntry) {
			return { changed: false, traces: await this.toMergeTraces(tx, result.traces) }
		}
		await this.saveState(tx, result.state)
		const revived = isDeadState(prior.state) && !isDeadState(result.state)
		const fields: MaterializeFields =
			prior.rebuilt || revived || op.foldState !== undefined ? 'all' : this.touchedFields(op)
		await this.materializeRow(tx, result.state, fields, {
			clearRetraction: scopeEntry,
			...(fresh ? { absent: true } : {}),
		})
		return { changed: result.changed, traces: await this.toMergeTraces(tx, result.traces) }
	}

	/**
	 * Fold a record from its base state and its log, leaving out operations the
	 * server terminally rejected, and re-materialize its row (all fields).
	 *
	 * @returns The new state (null when nothing of the record remains)
	 */
	async refoldInTx(
		tx: Transaction,
		collection: string,
		recordId: string,
		options: { clearRetraction?: boolean } = {},
	): Promise<FoldState | null> {
		const state = await this.foldFromLog(tx, collection, recordId)
		if (state === null) {
			await tx.execute(`DELETE FROM ${FOLD_STATE_TABLE} WHERE collection = ? AND record_id = ?`, [
				collection,
				recordId,
			])
			// Nothing of the record remains (its insert was refused): hide the row.
			await tx.execute(`UPDATE ${quoteIdent(collection)} SET _deleted = 1 WHERE id = ?`, [recordId])
			return null
		}
		await this.saveState(tx, state)
		await this.materializeRow(tx, state, 'all', {
			clearRetraction: options.clearRetraction ?? false,
		})
		return state
	}

	/**
	 * `join(base, snapshot, fold(log - terminally rejected, provisional effects))`, or
	 * null when none exists. Base and snapshot are adapted to the current fold plan
	 * (RT-63): a field whose kind changed is rebuilt from its materialized value.
	 */
	async foldFromLog(
		tx: Transaction,
		collection: string,
		recordId: string,
	): Promise<FoldState | null> {
		const ops = [
			...(await this.loadRecordOperations(tx, collection, recordId)),
			...(await this.loadProvisional(tx, collection, recordId)),
		]
		const rejected = await this.loadTerminalRejections(
			tx,
			ops.map((op) => op.id),
		)
		const base = await this.loadBase(tx, collection, recordId)
		const snapshot = await this.loadSnapshot(tx, collection, recordId)
		let state =
			base !== null && snapshot !== null
				? joinStates(base, snapshot, this.schema)
				: (base ?? snapshot)
		for (const op of ops) {
			if (rejected.has(op.id)) continue
			state = mergeOp(
				state ?? createFoldState(collection, recordId),
				op,
				this.schema,
				this.options(),
			).state
		}
		return state
	}

	/** The record's operations (log + retained sequence-conflict rows). */
	async loadRecordOperations(
		tx: Transaction,
		collection: string,
		recordId: string,
	): Promise<Operation[]> {
		const rows = [
			...(await tx.query<OperationRow>(
				`SELECT * FROM ${quoteIdent(`_kora_ops_${collection}`)} WHERE record_id = ?`,
				[recordId],
			)),
			...(await loadRetainedConflictRows(
				(sql, params) => tx.query(sql, params),
				collection,
				recordId,
			)),
		]
		return rows.map((row) => deserializeOperationWithCollection(row, collection))
	}

	/**
	 * Which of `ids` the fold leaves out: operations with a terminal-rejection marker
	 * from the server (or quarantined by a scope retraction, which the server never
	 * receives). Writes the user chose to discard from a held node are NOT left out:
	 * discarding stops the upload, it is not a rollback.
	 */
	async loadTerminalRejections(tx: Transaction, ids: readonly string[]): Promise<Set<string>> {
		const found = new Set<string>()
		const CHUNK = 500
		for (let i = 0; i < ids.length; i += CHUNK) {
			const chunk = ids.slice(i, i + CHUNK)
			const rows = await tx.query<{ operation_id: string }>(
				`SELECT operation_id FROM ${TERMINAL_REJECTIONS_TABLE} WHERE code NOT IN (${KEPT_REJECTION_CODES.map(() => '?').join(', ')}) AND operation_id IN (${chunk.map(() => '?').join(', ')})`,
				[...KEPT_REJECTION_CODES, ...chunk],
			)
			for (const row of rows) found.add(row.operation_id)
		}
		return found
	}

	/**
	 * The record's stored state, or null (none, another format version, or a field
	 * whose fold kind the schema has changed since: the caller re-folds, RT-63).
	 */
	async loadState(
		tx: Transaction,
		collection: string,
		recordId: string,
	): Promise<FoldState | null> {
		const state = await this.readStateRow(tx, FOLD_STATE_TABLE, collection, recordId)
		if (state === null || mismatchedFoldFields(state, this.schema).length > 0) return null
		return state
	}

	/** The stored state as it is, even when the plan changed (a snapshot seed). */
	async loadStoredState(
		tx: Transaction,
		collection: string,
		recordId: string,
	): Promise<FoldState | null> {
		return this.readStateRow(tx, FOLD_STATE_TABLE, collection, recordId)
	}

	/** The record's compacted base, adapted to the current fold plan (RT-63). */
	async loadBase(tx: Transaction, collection: string, recordId: string): Promise<FoldState | null> {
		const base = await this.readStateRow(tx, FOLD_BASE_TABLE, collection, recordId)
		return base === null ? null : adaptFoldState(base, this.schema, this.options()).state
	}

	/** The record's row snapshot (RT-68), adapted to the current fold plan. */
	async loadSnapshot(
		tx: Transaction,
		collection: string,
		recordId: string,
	): Promise<FoldState | null> {
		const snapshot = await this.readStateRow(tx, FOLD_SNAPSHOT_TABLE, collection, recordId)
		return snapshot === null ? null : adaptFoldState(snapshot, this.schema, this.options()).state
	}

	/** Store `snapshot` as the record's row snapshot (joined with an existing one). */
	async saveSnapshot(tx: Transaction, snapshot: FoldState): Promise<void> {
		const existing = await this.loadSnapshot(tx, snapshot.c, snapshot.r)
		const state = existing === null ? snapshot : joinStates(existing, snapshot, this.schema)
		await tx.execute(
			`INSERT OR REPLACE INTO ${FOLD_SNAPSHOT_TABLE} (collection, record_id, state) VALUES (?, ?, ?)`,
			[state.c, state.r, persistedForm(state)],
		)
	}

	/**
	 * A scope entry carrying the server's fold state (RT-29) replaces the record's row
	 * snapshot (RT-68): the server's state is built from every operation of the record
	 * the device was missing, so with the device's own log it is the exact state.
	 * Only a carried state this schema can read and join counts (otherwise the entry
	 * merges by its data and the snapshot stays).
	 *
	 * @returns Whether a snapshot was dropped
	 */
	private async dropSnapshotForCarriedState(tx: Transaction, op: Operation): Promise<boolean> {
		if (op.type !== 'insert' || op.foldState === undefined) return false
		const rows = await tx.query<{ n: number }>(
			`SELECT COUNT(*) AS n FROM ${FOLD_SNAPSHOT_TABLE} WHERE collection = ? AND record_id = ?`,
			[op.collection, op.recordId],
		)
		if ((rows[0]?.n ?? 0) === 0) return false
		let carried: FoldState
		try {
			carried = deserializeFoldState(op.foldState)
		} catch (error) {
			if (error instanceof FoldStateError) return false
			throw error
		}
		if (carried.c !== op.collection || carried.r !== op.recordId) return false
		if (mismatchedFoldFields(carried, this.schema).length > 0) return false
		await tx.execute(`DELETE FROM ${FOLD_SNAPSHOT_TABLE} WHERE collection = ? AND record_id = ?`, [
			op.collection,
			op.recordId,
		])
		return true
	}

	/** Records that still fold against a row snapshot (approximate, RT-68). */
	async listSnapshotRecords(
		tx: Transaction,
	): Promise<Array<{ collection: string; recordId: string }>> {
		const rows = await tx.query<{ collection: string; record_id: string }>(
			`SELECT collection, record_id FROM ${FOLD_SNAPSHOT_TABLE} ORDER BY collection, record_id`,
		)
		return rows.map((row) => ({ collection: row.collection, recordId: row.record_id }))
	}

	/**
	 * After a full resync, a record whose log holds its insert again no longer needs
	 * its row snapshot: drop it and re-fold the record from base and log (RT-68).
	 *
	 * @returns Whether the snapshot was dropped
	 */
	async settleSnapshotInTx(
		tx: Transaction,
		collection: string,
		recordId: string,
	): Promise<boolean> {
		const ops = await this.loadRecordOperations(tx, collection, recordId)
		const rejected = await this.loadTerminalRejections(
			tx,
			ops.map((op) => op.id),
		)
		const hasInsert = ops.some((op) => op.type === 'insert' && !rejected.has(op.id))
		const base = await this.loadBase(tx, collection, recordId)
		if (!hasInsert && (base?.cr ?? null) === null) return false
		await tx.execute(`DELETE FROM ${FOLD_SNAPSHOT_TABLE} WHERE collection = ? AND record_id = ?`, [
			collection,
			recordId,
		])
		await this.refoldInTx(tx, collection, recordId)
		return true
	}

	/**
	 * Fold a local-only provisional side effect (RT-69) into its record: stored apart
	 * from the log (never sequenced, never uploaded) and kept until the real copy of
	 * the effect arrives or the delivery stream catches up.
	 *
	 * @param parentId - The remote operation that caused it (the parent delete)
	 */
	async applyProvisionalInTx(tx: Transaction, op: Operation, parentId: string): Promise<void> {
		const existing = await tx.query<{ id: string }>(
			`SELECT id FROM ${PROVISIONAL_OPS_TABLE} WHERE id = ?`,
			[op.id],
		)
		if (existing.length > 0) return
		await tx.execute(
			`INSERT INTO ${PROVISIONAL_OPS_TABLE} (id, collection, record_id, parent_id, operation) VALUES (?, ?, ?, ?, ?)`,
			[op.id, op.collection, op.recordId, parentId, JSON.stringify(op)],
		)
		const prior = await this.loadOrRebuild(tx, op.collection, op.recordId, op.id)
		const result = mergeOp(prior.state, op, this.schema, this.options())
		if (!result.changed && !prior.rebuilt) return
		await this.saveState(tx, result.state)
		await this.materializeRow(tx, result.state, prior.rebuilt ? 'all' : this.touchedFields(op), {
			clearRetraction: false,
		})
	}

	/**
	 * Remove provisional effects of a record (those caused by one of `parentIds`, or
	 * all of them when null). The caller re-folds the record.
	 *
	 * @returns How many were removed
	 */
	async deleteProvisional(
		tx: Transaction,
		collection: string,
		recordId: string,
		parentIds: readonly string[] | null,
	): Promise<number> {
		if (parentIds !== null && parentIds.length === 0) return 0
		const filter =
			parentIds === null ? '' : ` AND parent_id IN (${parentIds.map(() => '?').join(', ')})`
		const rows = await tx.query<{ id: string }>(
			`SELECT id FROM ${PROVISIONAL_OPS_TABLE} WHERE collection = ? AND record_id = ?${filter}`,
			[collection, recordId, ...(parentIds ?? [])],
		)
		if (rows.length === 0) return 0
		await tx.execute(
			`DELETE FROM ${PROVISIONAL_OPS_TABLE} WHERE id IN (${rows.map(() => '?').join(', ')})`,
			rows.map((row) => row.id),
		)
		return rows.length
	}

	/** Records with provisional effects. */
	async listProvisionalRecords(
		tx: Transaction,
	): Promise<Array<{ collection: string; recordId: string }>> {
		const rows = await tx.query<{ collection: string; record_id: string }>(
			`SELECT DISTINCT collection, record_id FROM ${PROVISIONAL_OPS_TABLE} ORDER BY collection, record_id`,
		)
		return rows.map((row) => ({ collection: row.collection, recordId: row.record_id }))
	}

	private async loadProvisional(
		tx: Transaction,
		collection: string,
		recordId: string,
	): Promise<Operation[]> {
		const rows = await tx.query<{ operation: string }>(
			`SELECT operation FROM ${PROVISIONAL_OPS_TABLE} WHERE collection = ? AND record_id = ?`,
			[collection, recordId],
		)
		return rows.map((row) => JSON.parse(row.operation) as Operation)
	}

	async saveState(tx: Transaction, state: FoldState): Promise<void> {
		await tx.execute(
			`INSERT OR REPLACE INTO ${FOLD_STATE_TABLE} (collection, record_id, state) VALUES (?, ?, ?)`,
			[state.c, state.r, persistedForm(state)],
		)
	}

	async saveBase(tx: Transaction, state: FoldState): Promise<void> {
		await tx.execute(
			`INSERT OR REPLACE INTO ${FOLD_BASE_TABLE} (collection, record_id, state) VALUES (?, ?, ?)`,
			[state.c, state.r, persistedForm(state)],
		)
	}

	/** Join `addition` into the record's base state. */
	async joinIntoBase(tx: Transaction, addition: FoldState): Promise<void> {
		const base = await this.loadBase(tx, addition.c, addition.r)
		await this.saveBase(tx, base === null ? addition : joinStates(base, addition, this.schema))
	}

	/**
	 * Write the row of a record from its fold state.
	 *
	 * - No insert merged: no row (an existing one is hidden).
	 * - Otherwise the row holds the fold's values (also while deleted: a tombstone
	 *   keeps its last values), `_deleted` from the record's liveness, and versions
	 *   from the state: `_version` / `_updated_at` = newest operation, `_created_at` =
	 *   creation, `_field_versions` = each field's newest write.
	 * - Only `fields` are written to an existing row; columns the fold never wrote
	 *   (a column a schema migration added with a default, a local-only backfill)
	 *   keep their stored value.
	 * - A row hidden by a scope retraction stays hidden unless `clearRetraction`
	 *   (a scope-entry insert) is set.
	 */
	async materializeRow(
		tx: Transaction,
		state: FoldState,
		fields: MaterializeFields,
		options: { clearRetraction: boolean; absent?: boolean },
	): Promise<void> {
		const collection = state.c
		const definition = this.schema.collections[collection]
		if (!definition) return
		const table = quoteIdent(collection)
		const rows = options.absent
			? []
			: await tx.query<RawCollectionRow>(`SELECT id, _deleted FROM ${table} WHERE id = ?`, [
					state.r,
				])
		const existing = rows[0]
		if (state.cr === null || state.u === null) {
			if (existing && existing._deleted !== 1) {
				await tx.execute(`UPDATE ${table} SET _deleted = 1 WHERE id = ?`, [state.r])
			}
			return
		}
		const asLive: FoldState = { ...state, d: null }
		const values = materialize(asLive, { richtext: mergeYjsUpdates }) ?? {}
		const latest = HybridLogicalClock.deserialize(state.u.t)
		const created = HybridLogicalClock.deserialize(state.cr.t)
		// Sorted keys: replicas holding the same state write byte-identical columns.
		const fieldVersions = getFoldFieldVersionStrings(state)
		let deleted = isDeadState(state) ? 1 : 0
		if (existing && deleted === 0) {
			const retracted = await tx.query<{ record_id: string }>(
				'SELECT record_id FROM _kora_scope_retractions WHERE collection = ? AND record_id = ?',
				[collection, state.r],
			)
			if (retracted.length > 0) {
				if (options.clearRetraction) {
					await tx.execute(
						'DELETE FROM _kora_scope_retractions WHERE collection = ? AND record_id = ?',
						[collection, state.r],
					)
				} else {
					deleted = 1
				}
			}
		}
		const known = Object.keys(definition.fields)
		// A tombstone keeps the values it had when it was deleted: a write that lost to
		// the delete never shows, not even in the hidden row. A revival rewrites them all.
		const writable =
			existing && deleted === 1
				? []
				: known.filter((field) => field in state.f && (fields === 'all' || fields.has(field)))
		const fieldValues: Record<string, unknown> = {}
		for (const field of writable) {
			const value = values[field] ?? null
			// A richtext field with a single live update materializes as that update's
			// own bytes; re-encode it so every replica stores the same canonical bytes,
			// however its state happens to be split into updates.
			fieldValues[field] =
				definition.fields[field]?.kind === 'richtext' &&
				value !== null &&
				typeof value === 'object' &&
				'$koraBytes' in value
					? mergeYjsUpdates([base64ToBytes(String((value as { $koraBytes: string }).$koraBytes))])
					: value
		}
		const serialized = serializeRecord(fieldValues, definition.fields)
		const meta: Record<string, unknown> = {
			_updated_at: latest.wallTime,
			_version: state.u.t,
			_field_versions: JSON.stringify(fieldVersions),
			_deleted: deleted,
		}
		if (!existing) {
			const insert = buildInsertQuery(collection, {
				id: state.r,
				...serialized,
				...meta,
				_created_at: created.wallTime,
			})
			await tx.execute(insert.sql, insert.params)
			return
		}
		const changes: Record<string, unknown> = {
			...serialized,
			...meta,
			_created_at: created.wallTime,
		}
		const columns = Object.keys(changes)
		await tx.execute(
			`UPDATE ${table} SET ${columns.map((c) => `${quoteIdent(c)} = ?`).join(', ')} WHERE id = ?`,
			[...columns.map((c) => changes[c]), state.r],
		)
	}

	/**
	 * Load the record's state; rebuild it from base + log when it is missing or in
	 * another format version. `rebuilt` tells the caller to rewrite the whole row.
	 */
	private async loadOrRebuild(
		tx: Transaction,
		collection: string,
		recordId: string,
		appendedId: string,
	): Promise<{ state: FoldState; rebuilt: boolean }> {
		const stored = await this.loadState(tx, collection, recordId)
		if (stored !== null) return { state: stored, rebuilt: false }
		const hasRow = await this.hasStateRow(tx, collection, recordId)
		const others = await tx.query<{ n: number }>(
			`SELECT COUNT(*) AS n FROM ${quoteIdent(`_kora_ops_${collection}`)} WHERE record_id = ? AND id != ?`,
			[recordId, appendedId],
		)
		const retained = await loadRetainedConflictRows(
			(sql, params) => tx.query(sql, params),
			collection,
			recordId,
		)
		const hasBase =
			(await this.loadBase(tx, collection, recordId)) !== null ||
			(await this.loadSnapshot(tx, collection, recordId)) !== null ||
			(await this.loadProvisional(tx, collection, recordId)).some((p) => p.id !== appendedId)
		if (
			!hasRow &&
			!hasBase &&
			(others[0]?.n ?? 0) === 0 &&
			retained.every((row) => row.id === appendedId)
		) {
			// A new record: nothing to rebuild.
			return { state: createFoldState(collection, recordId), rebuilt: false }
		}
		const rebuilt = await this.foldFromLog(tx, collection, recordId)
		return { state: rebuilt ?? createFoldState(collection, recordId), rebuilt: true }
	}

	private async hasStateRow(
		tx: Transaction,
		collection: string,
		recordId: string,
	): Promise<boolean> {
		const rows = await tx.query<{ n: number }>(
			`SELECT COUNT(*) AS n FROM ${FOLD_STATE_TABLE} WHERE collection = ? AND record_id = ?`,
			[collection, recordId],
		)
		return (rows[0]?.n ?? 0) > 0
	}

	private async readStateRow(
		tx: Transaction,
		table: string,
		collection: string,
		recordId: string,
	): Promise<FoldState | null> {
		const rows = await tx.query<{ state: string }>(
			`SELECT state FROM ${table} WHERE collection = ? AND record_id = ?`,
			[collection, recordId],
		)
		const raw = rows[0]?.state
		if (raw === undefined) return null
		try {
			return deserializeFoldState(raw)
		} catch (error) {
			// Another format version: the caller re-folds the record.
			if (error instanceof FoldStateError) return null
			throw error
		}
	}

	private async toMergeTraces(tx: Transaction, traces: FoldTrace[]): Promise<MergeTrace[]> {
		const out: MergeTrace[] = []
		for (const trace of traces) {
			let prior: Operation | null = null
			if (trace.priorOperationId !== null) {
				const rows = await tx.query<OperationRow>(
					`SELECT * FROM ${quoteIdent(`_kora_ops_${trace.operation.collection}`)} WHERE id = ?`,
					[trace.priorOperationId],
				)
				const row = rows[0]
				if (row) prior = deserializeOperationWithCollection(row, trace.operation.collection)
			}
			out.push(toMergeTrace(trace, prior))
		}
		return out
	}
}

/** No insert merged yet, or the newest delete is later than the newest write. */
/**
 * The stored form of a fold state: plain JSON, read back by `deserializeFoldState`.
 * The canonical form (`serializeFoldState`, sorted keys) is for comparing and
 * exchanging states; a local row only needs to round-trip, and plain JSON is several
 * times cheaper on the write path.
 */
function persistedForm(state: FoldState): string {
	return JSON.stringify(state)
}

function isDeadState(state: FoldState): boolean {
	return !isFoldStateLive(state)
}
