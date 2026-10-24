import type { FoldState, Operation, SchemaDefinition } from '@korajs/core'
import {
	LIVE_VIEW_REPLAY_PAGE,
	MAX_TOMBSTONE_LOOKBACK,
	type RecordLiveViews,
	advanceLiveViews,
	emptyLiveViews,
	tombstoneStartOf,
	yieldToEventLoop,
} from './live-views'
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
 * The fields {@link scopeValuesOf} keeps for `collection` (its scalar fields), the only
 * ones a snapshot needs materialized.
 */
export function scopeFieldNames(schema: SchemaDefinition, collection: string): ReadonlySet<string> {
	const names = new Set<string>()
	for (const [name, field] of Object.entries(schema.collections[collection]?.fields ?? {})) {
		if (SNAPSHOT_KINDS.has(field.kind)) names.add(name)
	}
	return names
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
	// The tombstone state (`deleted`) is additive and is NOT part of the fingerprint: an
	// absent value reads as unknown and is filled in the background (see live-views.ts),
	// so instances of different versions never wipe each other's snapshots.
	return `v1|${parts.join('|')}`
}

/** Meta key under which stores persist {@link scopeSnapshotFingerprint}. */
export const SCOPE_SNAPSHOT_FINGERPRINT_KEY = 'scope_snapshot_fields'

/**
 * Meta key recording that every snapshot was dropped for a rebuild under this
 * {@link scopeSnapshotFingerprint}: a restart before the rebuild completes resumes it
 * (fills the snapshots still missing) instead of dropping and rebuilding all of them.
 */
export const SCOPE_SNAPSHOT_PENDING_KEY = 'scope_snapshot_fields_pending'

/**
 * The scope snapshot of an operation from the record's state after it: its values
 * and, when known, whether the fold left it a tombstone.
 */
export function scopeSnapshotOf(
	pre: Record<string, unknown> | null,
	post: Record<string, unknown> | null,
	deleted: boolean,
): OperationScopeSnapshot {
	return post ? { pre, post, deleted } : { pre, post }
}

/** Parse a persisted snapshot column; null for an absent or malformed value. */
export function parseScopeSnapshot(raw: unknown): OperationScopeSnapshot | null {
	if (typeof raw !== 'string' || raw.length === 0) return null
	try {
		const parsed = JSON.parse(raw) as { pre?: unknown; post?: unknown; deleted?: unknown }
		const asValues = (value: unknown): Record<string, unknown> | null =>
			value && typeof value === 'object' && !Array.isArray(value)
				? (value as Record<string, unknown>)
				: null
		const snapshot: OperationScopeSnapshot = {
			pre: asValues(parsed.pre),
			post: asValues(parsed.post),
		}
		if (typeof parsed.deleted === 'boolean') snapshot.deleted = parsed.deleted
		return snapshot
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
	return replayRecordHistory(
		schema,
		collection,
		recordId,
		operations.map((operation, index) => ({ operation, deliverySequence: index + 1 })),
		options,
		null,
	).snapshots
}

/**
 * {@link replayScopeSnapshots} with the record's live-view summary over `viewFields`
 * (null: none), from operations with their delivery sequences, in delivery order.
 */
export function replayRecordHistory(
	schema: SchemaDefinition,
	collection: string,
	recordId: string,
	delivered: readonly { operation: Operation; deliverySequence: number }[],
	options: ServerFoldOptions,
	viewFields: readonly string[] | null,
): { snapshots: Map<string, OperationScopeSnapshot>; views: RecordLiveViews | null } {
	const replayer = new RecordHistoryReplayer(schema, collection, recordId, options, viewFields)
	replayer.push(delivered)
	return { snapshots: replayer.snapshots, views: replayer.views }
}

/**
 * Incremental {@link replayRecordHistory}: operations are pushed in delivery order, in
 * as many steps as the caller likes (a background rebuild pushes a page at a time and
 * yields between pages, so a long history never blocks the process).
 */
export class RecordHistoryReplayer {
	readonly snapshots = new Map<string, OperationScopeSnapshot>()
	views: RecordLiveViews | null
	private readonly committed: Operation[] = []
	private readonly fields: ReadonlySet<string>
	private state: FoldState | null = null
	private pre: Record<string, unknown> | null = null

	constructor(
		private readonly schema: SchemaDefinition,
		private readonly collection: string,
		private readonly recordId: string,
		private readonly options: ServerFoldOptions,
		viewFields: readonly string[] | null,
	) {
		this.views = viewFields ? emptyLiveViews(viewFields) : null
		// Only the fields a snapshot keeps are materialized per operation: a richtext body
		// (one Yjs merge per live update), an element set or a key map would cost
		// O(history) each, making the replay O(history^2) for values it throws away.
		this.fields = scopeFieldNames(schema, collection)
	}

	/** Merge the next operations (in delivery order). */
	push(delivered: readonly { operation: Operation; deliverySequence: number }[]): void {
		for (const { operation, deliverySequence } of delivered) {
			this.committed.push(operation)
			const merged = mergeIntoFoldState(this.state, [operation], this.schema, this.options)
			this.state =
				merged === REFOLD_REQUIRED
					? refoldRecord(this.committed, this.schema, this.options)
					: merged
			const row = this.state ? projectFoldState(this.state, this.options, this.fields) : null
			const post = row
				? scopeValuesOf(this.schema, this.collection, this.recordId, { ...row.values })
				: null
			const deleted = row?.deleted === true
			this.snapshots.set(operation.id, scopeSnapshotOf(this.pre, post, deleted))
			if (this.views) {
				this.views = advanceLiveViews(this.views, {
					seq: deliverySequence,
					op: operation,
					live: row !== null && !deleted,
					values: post,
				})
			}
			this.pre = row && !row.deleted ? post : null
		}
	}
}

/** Most operations of one record a tombstone-start lookup replays (beyond: unknown). */
export const MAX_TOMBSTONE_REPLAY = 5_000

/** One stored operation of a record, with its delivery sequence and stored snapshot. */
export interface RecordHistoryEntry {
	operation: Operation
	deliverySequence: number
	scopeSnapshot: OperationScopeSnapshot | null
}

/**
 * Where a record's current tombstone began, as of just before the operation at `before`
 * (see tombstoneStartOf). The stored snapshots' tombstone state is read newest first
 * (bounded by MAX_TOMBSTONE_LOOKBACK); when that cannot pin it down (an operation
 * written by an instance that records no tombstone state, or a longer tombstone), the
 * record's history before `before` is replayed (bounded by MAX_TOMBSTONE_REPLAY) and
 * decided exactly. Null when even that cannot: the history is longer than the bound.
 *
 * @param newest - The record's operations before `before`, newest first, at most `limit`
 * @param page - The record's operations after `afterSeq` and before `before`, in
 *   delivery order, at most `limit`
 */
export async function resolveTombstoneStart(
	schema: SchemaDefinition,
	collection: string,
	recordId: string,
	options: ServerFoldOptions,
	newest: (limit: number) => Promise<{ seq: number; deleted: boolean | undefined }[]>,
	page: (afterSeq: number, limit: number) => Promise<RecordHistoryEntry[]>,
): Promise<number | null> {
	const quick = tombstoneStartOf(await newest(MAX_TOMBSTONE_LOOKBACK))
	if (quick !== null) return quick
	const replayer = new RecordHistoryReplayer(schema, collection, recordId, options, null)
	const order: { seq: number; id: string }[] = []
	let after = 0
	for (;;) {
		const entries = await page(after, LIVE_VIEW_REPLAY_PAGE)
		if (entries.length === 0) break
		replayer.push(entries)
		for (const entry of entries) order.push({ seq: entry.deliverySequence, id: entry.operation.id })
		if (order.length > MAX_TOMBSTONE_REPLAY) return null
		after = entries[entries.length - 1]?.deliverySequence ?? after
		if (entries.length < LIVE_VIEW_REPLAY_PAGE) break
		await yieldToEventLoop()
	}
	return tombstoneStartOf(
		order.reverse().map(({ seq, id }) => ({
			seq,
			deleted: replayer.snapshots.get(id)?.deleted === true,
		})),
		true,
	)
}
