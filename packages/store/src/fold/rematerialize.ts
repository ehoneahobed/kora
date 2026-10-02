import {
	type FoldState,
	type HLCTimestamp,
	HybridLogicalClock,
	type SchemaDefinition,
	createSnapshotState,
	quoteIdent,
} from '@korajs/core'
import { deserializeRecord } from '../serialization/serializer'
import type { RawCollectionRow, StorageAdapter, Transaction } from '../types'
import { FOLD_BASE_TABLE, FOLD_STATE_TABLE, type RecordFolder } from './record-folder'

/**
 * How a database is re-materialized on its first open with the W7 fold:
 *
 * - `'log'`: the log is clean (W8 integrity scan): every record is rebuilt with the
 *   fold from its operations. This also repairs replicas that diverged under the
 *   pairwise merge of beta.12/13.
 * - `'snapshot+log'`: the log is not complete (it was compacted, or has sequence
 *   gaps): each existing row becomes the record's base snapshot (its values at
 *   their `_field_versions`), and the remaining operations are folded on top.
 * - `'kept'`: the log has quarantined rows (W8): it is never rebuilt from. Rows are
 *   kept exactly as they are; each becomes its record's base snapshot, so later
 *   operations merge onto it.
 */
export type RematerializationMode = 'log' | 'snapshot+log' | 'kept'

/** Result of {@link rematerializeDatabase}. */
export interface RematerializationResult {
	mode: RematerializationMode
	/** Records whose state was rebuilt. */
	records: number
	/** Rows whose visible values changed. */
	changedRows: number
}

const BATCH = 200

/**
 * Rebuild every record's fold state and row. Runs once per database (the store
 * records completion in `_kora_meta`), after the W8 log-integrity scan and the
 * schema migrations. One write transaction per batch of records, so a crash
 * resumes from scratch safely (the rebuild is a pure function of the log and rows).
 */
export async function rematerializeDatabase(
	adapter: StorageAdapter,
	schema: SchemaDefinition,
	folder: RecordFolder,
	mode: RematerializationMode,
): Promise<RematerializationResult> {
	let records = 0
	let changedRows = 0
	for (const [collection, definition] of Object.entries(schema.collections)) {
		const ids = new Set<string>()
		for (const row of await adapter.query<{ id: string }>(
			`SELECT id FROM ${quoteIdent(collection)}`,
		)) {
			ids.add(row.id)
		}
		for (const row of await adapter.query<{ record_id: string }>(
			`SELECT DISTINCT record_id FROM ${quoteIdent(`_kora_ops_${collection}`)}`,
		)) {
			ids.add(row.record_id)
		}
		const all = [...ids].sort()
		for (let i = 0; i < all.length; i += BATCH) {
			const batch = all.slice(i, i + BATCH)
			await adapter.transaction(async (tx) => {
				for (const recordId of batch) {
					records += 1
					const rows = await tx.query<RawCollectionRow>(
						`SELECT * FROM ${quoteIdent(collection)} WHERE id = ?`,
						[recordId],
					)
					const row = rows[0]
					const before = row ? JSON.stringify(deserializeRecord(row, definition.fields)) : null
					await tx.execute(
						`DELETE FROM ${FOLD_STATE_TABLE} WHERE collection = ? AND record_id = ?`,
						[collection, recordId],
					)
					if (mode === 'kept') {
						if (row) {
							const snapshot = snapshotFromRow(row, collection, schema)
							await folder.joinIntoBase(tx, snapshot)
							await folder.saveState(tx, snapshot)
						}
						continue
					}
					if (mode === 'snapshot+log' && row) {
						await folder.joinIntoBase(tx, snapshotFromRow(row, collection, schema))
					}
					const state = await folder.foldFromLog(tx, collection, recordId)
					if (state === null) {
						// No operation and no base: a row the log never had (cannot happen on a
						// clean log; kept as a snapshot rather than dropped).
						if (row) await folder.saveState(tx, snapshotFromRow(row, collection, schema))
						continue
					}
					await folder.saveState(tx, state)
					await folder.materializeRow(tx, state, 'all', { clearRetraction: false })
					const afterRows = await tx.query<RawCollectionRow>(
						`SELECT * FROM ${quoteIdent(collection)} WHERE id = ?`,
						[recordId],
					)
					const after = afterRows[0]
						? JSON.stringify(deserializeRecord(afterRows[0], definition.fields))
						: null
					if (before !== after) changedRows += 1
				}
			})
		}
	}
	return { mode, records, changedRows }
}

/**
 * The base snapshot of a materialized row: its values at their `_field_versions`
 * (rows from before per-field versions fall back to `_version`, then `_updated_at`).
 */
export function snapshotFromRow(
	row: RawCollectionRow,
	collection: string,
	schema: SchemaDefinition,
): FoldState {
	const definition = schema.collections[collection]
	const record = definition ? deserializeRecord(row, definition.fields) : { id: row.id }
	const { id: _id, createdAt: _c, updatedAt: _u, ...values } = record as Record<string, unknown>
	const latest = rowVersion(row)
	const fieldVersions: Record<string, HLCTimestamp> = {}
	const raw = typeof row._field_versions === 'string' ? row._field_versions : '{}'
	try {
		for (const [field, version] of Object.entries(JSON.parse(raw) as Record<string, unknown>)) {
			if (typeof version === 'string' && version.length > 0) {
				fieldVersions[field] = HybridLogicalClock.deserialize(version)
			}
		}
	} catch {
		// Malformed versions: every field falls back to the row version.
	}
	const createdAt = typeof row._created_at === 'number' ? row._created_at : latest.wallTime
	return createSnapshotState(
		{
			collection,
			recordId: row.id,
			values,
			fieldVersions,
			created: { wallTime: createdAt, logical: 0, nodeId: '' },
			latest,
			deleted: row._deleted === 1,
		},
		schema,
	)
}

function rowVersion(row: RawCollectionRow): HLCTimestamp {
	if (typeof row._version === 'string' && row._version.length > 0) {
		try {
			return HybridLogicalClock.deserialize(row._version)
		} catch {
			// fall through
		}
	}
	const wall = typeof row._updated_at === 'number' ? row._updated_at : 0
	return { wallTime: wall, logical: 0, nodeId: '' }
}

/** Remove every fold state and base (replace-mode restore, mode switch). */
export async function clearFoldTables(tx: Transaction): Promise<void> {
	await tx.execute(`DELETE FROM ${FOLD_STATE_TABLE}`)
	await tx.execute(`DELETE FROM ${FOLD_BASE_TABLE}`)
}
