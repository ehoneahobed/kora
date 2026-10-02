import { HybridLogicalClock, replayFieldVersionsForRecord } from '@korajs/core'
import type { RecordFieldVersions, VersionedReplayOperation } from '@korajs/core'

/** One stored operation row, as the SQL stores read it for a field-version fold. */
export interface FieldVersionRow {
	type: string
	data: string | null
	wall_time: number | string
	logical: number | string
	timestamp_node_id: string
}

/**
 * Fold a record's stored operation rows into its per-field versions (RT-27). Rows
 * are ordered here, in JavaScript, with {@link HybridLogicalClock.compare}, so the
 * node-id tie-break never depends on a database collation.
 *
 * @param rows - Every stored operation of one record, in any order
 * @returns The live record's field versions, or null when deleted or absent
 */
export function foldFieldVersionRows(rows: readonly FieldVersionRow[]): RecordFieldVersions | null {
	const ops: VersionedReplayOperation[] = rows.map((row) => ({
		type: row.type,
		data: row.data !== null ? (JSON.parse(row.data) as Record<string, unknown>) : null,
		timestamp: {
			wallTime: Number(row.wall_time),
			logical: Number(row.logical),
			nodeId: row.timestamp_node_id,
		},
	}))
	ops.sort((a, b) => HybridLogicalClock.compare(a.timestamp, b.timestamp))
	return replayFieldVersionsForRecord(ops)
}
