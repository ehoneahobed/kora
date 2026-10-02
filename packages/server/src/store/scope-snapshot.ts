import type { AtomicOp, HLCTimestamp, SchemaDefinition } from '@korajs/core'
import { replayOperationsForRecord } from './materialization'
import { MAX_SCOPE_SNAPSHOT_STRING_LENGTH, type OperationScopeSnapshot } from './server-store'

/** Field kinds a scope predicate can match (compared with `Object.is`). */
const SNAPSHOT_KINDS = new Set(['string', 'number', 'boolean', 'enum', 'timestamp'])

/**
 * The scope-relevant values of a stored row: `id` plus every scalar field, with
 * over-long strings left out (see {@link OperationScopeSnapshot}). Returns null when
 * there is no row or the collection is not in the schema.
 *
 * @param schema - The store schema
 * @param collection - The row's collection
 * @param recordId - The row's id (always used as `id`)
 * @param row - The row as stored, or null
 */
export function scopeValuesOf(
	schema: SchemaDefinition | null,
	collection: string,
	recordId: string,
	row: Record<string, unknown> | null,
): Record<string, unknown> | null {
	if (!row) return null
	const definition = schema?.collections[collection]
	if (!definition) return null
	const values: Record<string, unknown> = { id: recordId }
	for (const [name, field] of Object.entries(definition.fields)) {
		if (!SNAPSHOT_KINDS.has(field.kind) || !(name in row)) continue
		const value = row[name]
		if (typeof value === 'string' && value.length > MAX_SCOPE_SNAPSHOT_STRING_LENGTH) continue
		values[name] = value
	}
	return values
}

/** Parse a persisted snapshot column; null for an absent or malformed value. */
export function parseScopeSnapshot(raw: unknown): OperationScopeSnapshot | null {
	if (typeof raw !== 'string' || raw.length === 0) return null
	try {
		const parsed = JSON.parse(raw) as { pre?: unknown; post?: unknown }
		const asValues = (value: unknown): Record<string, unknown> | null =>
			value && typeof value === 'object' && !Array.isArray(value)
				? (value as Record<string, unknown>)
				: null
		return { pre: asValues(parsed.pre), post: asValues(parsed.post) }
	} catch {
		return null
	}
}

/** One stored operation of a record, as the snapshot backfill replays it. */
export interface SnapshotReplayOperation {
	id: string
	type: string
	data: Record<string, unknown> | null
	atomicOps: Record<string, AtomicOp> | null
	timestamp: HLCTimestamp
}

/**
 * Rebuild the snapshot each operation of one record would have received when it was
 * applied, from the server's own log (migration backfill, RT-14). `operations` are
 * in delivery (commit) order; each operation's state is the HLC-ordered replay of the
 * operations committed up to and including it, exactly what materialization held.
 *
 * Quadratic in the operations of one record; it runs once per legacy record.
 *
 * @returns Snapshot per operation id
 */
export function replayScopeSnapshots(
	schema: SchemaDefinition,
	collection: string,
	recordId: string,
	operations: SnapshotReplayOperation[],
): Map<string, OperationScopeSnapshot> {
	const result = new Map<string, OperationScopeSnapshot>()
	const committed: SnapshotReplayOperation[] = []
	let pre: Record<string, unknown> | null = null
	for (const operation of operations) {
		committed.push(operation)
		const ordered = [...committed].sort(compareReplayTimestamps)
		const state = replayOperationsForRecord(ordered.map(toReplay))
		const lastKnown =
			state ?? replayOperationsForRecord(ordered.filter((op) => op.type !== 'delete').map(toReplay))
		const post = scopeValuesOf(schema, collection, recordId, lastKnown ? { ...lastKnown } : null)
		result.set(operation.id, { pre, post })
		// A deleted record has no pre-image for the next operation (it was not visible).
		pre = state ? post : null
	}
	return result
}

function toReplay(op: SnapshotReplayOperation): {
	type: string
	data: Record<string, unknown> | null
	atomicOps: Record<string, AtomicOp> | null
} {
	return { type: op.type, data: op.data, atomicOps: op.atomicOps }
}

function compareReplayTimestamps(a: SnapshotReplayOperation, b: SnapshotReplayOperation): number {
	if (a.timestamp.wallTime !== b.timestamp.wallTime)
		return a.timestamp.wallTime - b.timestamp.wallTime
	if (a.timestamp.logical !== b.timestamp.logical) return a.timestamp.logical - b.timestamp.logical
	return a.timestamp.nodeId < b.timestamp.nodeId
		? -1
		: a.timestamp.nodeId > b.timestamp.nodeId
			? 1
			: 0
}
