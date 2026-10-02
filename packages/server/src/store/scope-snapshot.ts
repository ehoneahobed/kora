import type { FoldState, Operation, SchemaDefinition } from '@korajs/core'
import {
	REFOLD_REQUIRED,
	type ServerFoldOptions,
	mergeIntoFoldState,
	projectFoldState,
	refoldRecord,
} from './record-fold'
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
		// An over-long string is recorded as null: present (so the current-row fallback
		// of RT-20 never applies to it) and never equal to a scope value (fails closed).
		values[name] =
			typeof value === 'string' && value.length > MAX_SCOPE_SNAPSHOT_STRING_LENGTH ? null : value
	}
	return values
}

/**
 * Fingerprint of the fields scope snapshots capture under `schema` (every scalar
 * field of every collection, with its kind). When it changes (a migration added,
 * renamed or retyped a field), snapshots captured under the old schema no longer
 * describe the records the way the new one would, so the store recomputes them all
 * from the log (RT-20).
 */
export function scopeSnapshotFingerprint(schema: SchemaDefinition): string {
	const parts: string[] = []
	for (const collection of Object.keys(schema.collections).sort()) {
		const fields = schema.collections[collection]?.fields ?? {}
		const captured = Object.keys(fields)
			.filter((name) => SNAPSHOT_KINDS.has(fields[name]?.kind ?? ''))
			.sort()
			.map((name) => `${name}:${fields[name]?.kind ?? ''}`)
		parts.push(`${collection}(${captured.join(',')})`)
	}
	return `v1|${parts.join('|')}`
}

/** Meta key under which stores persist {@link scopeSnapshotFingerprint}. */
export const SCOPE_SNAPSHOT_FINGERPRINT_KEY = 'scope_snapshot_fields'

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

/**
 * Rebuild the snapshot each operation of one record would have received when it was
 * applied, from the server's own log (migration backfill, RT-14). `operations` are
 * in delivery (commit) order; each operation's state is the fold of the operations
 * committed up to and including it, exactly what materialization held (W7: the fold
 * depends only on the set of operations, so merging in commit order is that state).
 *
 * Linear in the operations of one record (one incremental merge per operation).
 *
 * @returns Snapshot per operation id
 */
export function replayScopeSnapshots(
	schema: SchemaDefinition,
	collection: string,
	recordId: string,
	operations: readonly Operation[],
	options: ServerFoldOptions,
): Map<string, OperationScopeSnapshot> {
	const result = new Map<string, OperationScopeSnapshot>()
	const committed: Operation[] = []
	let state: FoldState | null = null
	let pre: Record<string, unknown> | null = null
	for (const operation of operations) {
		committed.push(operation)
		const merged = mergeIntoFoldState(state, [operation], schema, options)
		state = merged === REFOLD_REQUIRED ? refoldRecord(committed, schema, options) : merged
		const row = state ? projectFoldState(state, options) : null
		const post = row ? scopeValuesOf(schema, collection, recordId, { ...row.values }) : null
		result.set(operation.id, { pre, post })
		pre = row && !row.deleted ? post : null
	}
	return result
}
