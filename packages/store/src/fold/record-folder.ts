import {
	FOLD_STATE_VERSION,
	type FoldOptions,
	type FoldState,
	FoldStateError,
	type FoldTrace,
	HybridLogicalClock,
	type MergeTrace,
	type Operation,
	type SchemaDefinition,
	createFoldState,
	deserializeFoldState,
	getFoldFieldVersions,
	isFoldStateLive,
	joinStates,
	materialize,
	mergeOp,
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
/** `_kora_meta` key recording how the rows of this database are materialized. */
export const FOLD_MATERIALIZATION_META_KEY = 'fold_materialization'
/** `_kora_meta` key holding the authoritative node ids (JSON array) the states were folded with. */
export const AUTHORITATIVE_NODES_META_KEY = 'fold_authoritative_nodes'
/** Value of {@link FOLD_MATERIALIZATION_META_KEY} once rows are materializations of the current fold. */
export const FOLD_MATERIALIZATION_CURRENT = `fold-v${FOLD_STATE_VERSION}`
/** Value of {@link FOLD_MATERIALIZATION_META_KEY} while the legacy (beta.13) paths write rows. */
export const FOLD_MATERIALIZATION_LEGACY = 'legacy'

/** DDL for the fold tables. Idempotent. */
export const FOLD_TABLES_DDL: readonly string[] = [
	`CREATE TABLE IF NOT EXISTS ${FOLD_STATE_TABLE} (collection TEXT NOT NULL, record_id TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY (collection, record_id))`,
	`CREATE TABLE IF NOT EXISTS ${FOLD_BASE_TABLE} (collection TEXT NOT NULL, record_id TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY (collection, record_id))`,
	`CREATE TABLE IF NOT EXISTS ${COMPACTED_THROUGH_TABLE} (node_id TEXT PRIMARY KEY, sequence_number INTEGER NOT NULL)`,
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

	constructor(private readonly schema: SchemaDefinition) {}

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
			traces,
			...(this.authoritative.size > 0 ? { authoritativeNodeIds: this.authoritative } : {}),
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
		const prior = await this.loadOrRebuild(tx, op.collection, op.recordId, op.id)
		const result = mergeOp(
			prior.state,
			op,
			this.schema,
			this.options(mode === 'remote' ? 'conflicts' : 'none'),
		)
		const scopeEntry = op.type === 'insert'
		if (!result.changed && !prior.rebuilt && !scopeEntry) {
			return { changed: false, traces: await this.toMergeTraces(tx, result.traces) }
		}
		await this.saveState(tx, result.state)
		const revived = isDeadState(prior.state) && !isDeadState(result.state)
		const fields: MaterializeFields =
			prior.rebuilt || revived || op.foldState !== undefined
				? 'all'
				: new Set(Object.keys(op.data ?? {}))
		await this.materializeRow(tx, result.state, fields, { clearRetraction: scopeEntry })
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
		await this.materializeRow(tx, state, 'all', { clearRetraction: false })
		return state
	}

	/** `join(base, fold(log - terminally rejected))`, or null when neither exists. */
	async foldFromLog(
		tx: Transaction,
		collection: string,
		recordId: string,
	): Promise<FoldState | null> {
		const ops = await this.loadRecordOperations(tx, collection, recordId)
		const rejected = await this.loadTerminalRejections(
			tx,
			ops.map((op) => op.id),
		)
		let state = await this.loadBase(tx, collection, recordId)
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

	/** Which of `ids` carry a terminal rejection marker. */
	async loadTerminalRejections(tx: Transaction, ids: readonly string[]): Promise<Set<string>> {
		const found = new Set<string>()
		const CHUNK = 500
		for (let i = 0; i < ids.length; i += CHUNK) {
			const chunk = ids.slice(i, i + CHUNK)
			const rows = await tx.query<{ operation_id: string }>(
				`SELECT operation_id FROM ${TERMINAL_REJECTIONS_TABLE} WHERE operation_id IN (${chunk.map(() => '?').join(', ')})`,
				chunk,
			)
			for (const row of rows) found.add(row.operation_id)
		}
		return found
	}

	/** The record's stored state, or null (none, or another format version). */
	async loadState(
		tx: Transaction,
		collection: string,
		recordId: string,
	): Promise<FoldState | null> {
		return this.readStateRow(tx, FOLD_STATE_TABLE, collection, recordId)
	}

	async loadBase(tx: Transaction, collection: string, recordId: string): Promise<FoldState | null> {
		return this.readStateRow(tx, FOLD_BASE_TABLE, collection, recordId)
	}

	async saveState(tx: Transaction, state: FoldState): Promise<void> {
		await tx.execute(
			`INSERT OR REPLACE INTO ${FOLD_STATE_TABLE} (collection, record_id, state) VALUES (?, ?, ?)`,
			[state.c, state.r, serializeFoldState(state)],
		)
	}

	async saveBase(tx: Transaction, state: FoldState): Promise<void> {
		await tx.execute(
			`INSERT OR REPLACE INTO ${FOLD_BASE_TABLE} (collection, record_id, state) VALUES (?, ?, ?)`,
			[state.c, state.r, serializeFoldState(state)],
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
		options: { clearRetraction: boolean },
	): Promise<void> {
		const collection = state.c
		const definition = this.schema.collections[collection]
		if (!definition) return
		const table = quoteIdent(collection)
		const rows = await tx.query<RawCollectionRow>(
			`SELECT id, _deleted FROM ${table} WHERE id = ?`,
			[state.r],
		)
		const existing = rows[0]
		if (state.cr === null || state.u === null) {
			if (existing && existing._deleted !== 1) {
				await tx.execute(`UPDATE ${table} SET _deleted = 1 WHERE id = ?`, [state.r])
			}
			return
		}
		const asLive: FoldState = { ...state, d: null }
		const values = materialize(asLive, { richtext: mergeYjsUpdates }) ?? {}
		const versions = getFoldFieldVersions(asLive)
		const latest = HybridLogicalClock.deserialize(state.u.t)
		const created = HybridLogicalClock.deserialize(state.cr.t)
		// Sorted keys: replicas holding the same state write byte-identical columns.
		const fieldVersions: Record<string, string> = {}
		for (const field of Object.keys(versions?.fields ?? {}).sort()) {
			const version = versions?.fields[field]
			if (version) fieldVersions[field] = HybridLogicalClock.serialize(version)
		}
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
		for (const field of writable) fieldValues[field] = values[field] ?? null
		const serialized = serializeRecord(fieldValues, definition.fields)
		const meta: Record<string, unknown> = {
			_updated_at: latest.wallTime,
			_version: HybridLogicalClock.serialize(latest),
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
		const ops = await this.loadRecordOperations(tx, collection, recordId)
		if (!hasRow && ops.every((op) => op.id === appendedId)) {
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
function isDeadState(state: FoldState): boolean {
	return !isFoldStateLive(state)
}
