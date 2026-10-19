/**
 * Server materialization through the one deterministic fold (W7 Stage B2).
 *
 * Every server store (memory, SQLite, Postgres) keeps, per materialized record, the
 * record's serialized {@link FoldState} next to its collection row. Applying an
 * operation is "append, then `mergeOp`": O(fields the operation touches), never a
 * replay of the record's history (SRV-7). The collection row is a pure projection of
 * the fold state ({@link projectFoldState}), so the server's rows are exactly what a
 * client that holds the same operations materializes (SRV-1).
 *
 * The fold is pure JavaScript: ordering uses HLC stamps compared in JS, never a
 * database collation (the Phase 1 COLLATE "C" concern disappears for materialization).
 *
 * Old helpers (`replayOperationsForRecord`, `mergeArraySet`) are no longer used to
 * materialize; they stay exported from core for legacy comparison only.
 */
import { createHash } from 'node:crypto'
import {
	FoldStateError,
	HybridLogicalClock,
	base64ToBytes,
	createFoldState,
	deserializeFoldState,
	foldPlanFingerprint,
	foldRecord,
	getFoldFieldVersions,
	isFoldStateLive,
	materialize,
	mergeOp,
	operationSchemaView,
	serializeFoldState,
} from '@korajs/core'
import type {
	FieldDescriptor,
	FoldOptions,
	FoldState,
	Operation,
	OperationTransform,
	RecordFieldVersions,
	RichtextKeyedMerger,
	SchemaDefinition,
} from '@korajs/core'
import { mergeRichtext, mergeRichtextUpdate } from '@korajs/merge'
import {
	SERVER_NODE_PREFIX,
	ServerAuthoritySet,
	normalizeLegacyAuthorities,
} from './server-identity'
import type { MaterializedRecord } from './server-store'

/**
 * Fold options as the server passes them. `authoritativeNodeIds` holds the node ids
 * whose operations win `merge('server-authoritative')` fields (the server's own node
 * ids); it is exactly the list the handshake advertises to clients.
 */
export type ServerFoldOptions = FoldOptions

/**
 * `kora_server_meta` key holding {@link foldPlanFingerprint} of the schema the stored
 * fold states were built under. A change re-materializes every record.
 */
export const FOLD_PLAN_FINGERPRINT_KEY = 'fold_plan_fingerprint'

/** Table holding each materialized record's serialized fold state (SQLite and Postgres). */
export const FOLD_STATE_TABLE = 'kora_fold_state'

/** Records re-materialized per transaction by the startup migration (at most). */
export const FOLD_MIGRATION_BATCH = 500

/**
 * Operations the startup migration re-folds per transaction (a record is never split:
 * a record with more operations is a transaction of its own). A transaction holds the
 * lock every append takes, so this bounds how long a re-fold keeps other instances'
 * writes waiting, whatever the records' history lengths.
 */
export const FOLD_MIGRATION_BATCH_OPERATIONS = 2_000

/**
 * Split `items` (records, in order) into consecutive batches of at most
 * {@link FOLD_MIGRATION_BATCH} items whose operation counts add up to at most
 * `maxOperations`, except that a batch always takes at least one item.
 *
 * @param items - The records to re-fold
 * @param operationsOf - The number of operations of a record
 * @param maxOperations - Operation budget of a batch
 */
export function batchesByOperations<T>(
	items: readonly T[],
	operationsOf: (item: T) => number,
	maxOperations: number = FOLD_MIGRATION_BATCH_OPERATIONS,
): T[][] {
	const batches: T[][] = []
	let batch: T[] = []
	let operations = 0
	for (const item of items) {
		const count = Math.max(1, operationsOf(item))
		if (
			batch.length > 0 &&
			(operations + count > maxOperations || batch.length >= FOLD_MIGRATION_BATCH)
		) {
			batches.push(batch)
			batch = []
			operations = 0
		}
		batch.push(item)
		operations += count
	}
	if (batch.length > 0) batches.push(batch)
	return batches
}

/** Interval between two progress lines of a long re-materialization. */
export const FOLD_MIGRATION_PROGRESS_INTERVAL_MS = 5_000

/**
 * Progress lines of a long startup migration step (re-materialization, scope snapshot
 * rebuild), so an operator (or a startup probe's logs) sees it working: nothing for a
 * step shorter than the interval, then a line per interval (`records done / total`) and
 * a final line. Wall-clock time is used only to pace the log, never to order data.
 */
export class FoldMigrationProgress {
	private readonly started: number
	private lastLine: number
	private checked = 0
	private changed = 0
	private total: number | null = null
	private reported = false

	/**
	 * @param task - What is running, as the lines name it
	 * @param log - Where lines go
	 * @param now - Clock in milliseconds (tests)
	 * @param interval - Milliseconds between lines
	 */
	constructor(
		private readonly task: string,
		private readonly log: (line: string) => void = (line) => console.info(line),
		private readonly now: () => number = () => Date.now(),
		private readonly interval: number = FOLD_MIGRATION_PROGRESS_INTERVAL_MS,
	) {
		this.started = now()
		this.lastLine = this.started
	}

	/** Count records looked at and records rewritten (a batch committed). */
	advance(checked: number, changed: number): void {
		this.checked += checked
		this.changed += changed
	}

	/** True when a progress line is due. */
	due(): boolean {
		return this.now() - this.lastLine >= this.interval
	}

	/** Whether the total is still unknown (counted only once a line is due). */
	needsTotal(): boolean {
		return this.total === null
	}

	/** Set the number of records the step looks at. */
	setTotal(total: number): void {
		this.total = total
	}

	/** Write a progress line. */
	report(): void {
		const at = this.now()
		this.lastLine = at
		if (!this.reported) {
			this.reported = true
			this.log(
				`[kora] ${this.task} in progress: rebuilt from the operation log in committed batches (a restart resumes where it stopped); the store's setup completes when it is done.`,
			)
		}
		this.log(
			`[kora] ${this.task}: ${this.checked}${this.total !== null ? ` / ${this.total}` : ''} records done, ${this.changed} rewritten (${Math.round((at - this.started) / 1000)} s).`,
		)
	}

	/** Final line, written only when progress lines were. */
	finish(): void {
		if (!this.reported) return
		this.log(
			`[kora] ${this.task} done: ${this.checked} records, ${this.changed} rewritten, in ${Math.round((this.now() - this.started) / 1000)} s.`,
		)
	}
}

/** What a store's startup re-materialization did (W7 step 7). */
export interface FoldMigrationReport {
	/** False when no schema was set (nothing is materialized). */
	ran: boolean
	/** Records re-folded and rewritten. */
	records: number
	/**
	 * Records that own quarantined operations (see `ServerLogIntegrityReport`): their log
	 * is incomplete, so their pre-fold rows were kept as a snapshot base with the
	 * remaining operations folded onto it (RT-70), never re-folded from the log alone.
	 */
	skippedUnclean: number
	/** True when the fold plan (field kinds, strategies, resolvers) changed: every record was re-folded. */
	fullRefold: boolean
}

/** A schema with no collections: every field folds as a last-write-wins register. */
export const EMPTY_FOLD_SCHEMA: SchemaDefinition = {
	version: 0,
	collections: {},
	relations: {},
	migrations: {},
}

/**
 * Merge the opaque Yjs updates of a richtext field into one update (the fold's
 * `richtext` option). Built on `mergeRichtext`, which applies updates into a fresh
 * Y.Doc; the encoded state depends only on the set of updates, so every server and
 * client produce the same bytes.
 */
export function mergeRichtextUpdatesForServer(updates: Uint8Array[]): Uint8Array {
	const [first, ...rest] = updates
	if (first === undefined) return mergeRichtext(null, null, null)
	let merged = first
	for (const update of rest) merged = mergeRichtext(merged, update, null)
	return merged
}

/** Default memory bound of a {@link RichtextMergeCache}: merged bytes plus update keys. */
export const RICHTEXT_MERGE_CACHE_BYTES = 64 * 1024 * 1024

/** Default number of richtext fields a {@link RichtextMergeCache} remembers. */
export const RICHTEXT_MERGE_CACHE_ENTRIES = 1024

interface RichtextMergeCacheEntry {
	/** The live updates (base64 keys) `bytes` merges. */
	keys: Set<string>
	/** Exactly what {@link mergeRichtextUpdatesForServer} returns for `keys`. */
	bytes: Uint8Array
	/** Every merge behind `bytes` integrated everything (nothing pending): extendable. */
	complete: boolean
	cost: number
}

/**
 * Incremental richtext materialization for the server's fold (the fold's
 * `richtextKeyed` option). Devices save a full Yjs snapshot per edit and the server's
 * fold state keeps every one, so merging a field's live updates from scratch costs one
 * Yjs merge per edit of the field's history; done on every write (and, before this,
 * on every operation of a re-fold) that made writes O(history) and re-materialization
 * O(history^2).
 *
 * Per record field it keeps the merge of the update set it materialized last. The same
 * set reuses it. When the next set contains it (a write adds an update), only the added
 * updates are merged onto it, which gives the bytes the from-scratch merge gives when
 * every merge involved integrated everything: Yjs then holds the same structs whatever
 * the order and grouping of the merges. When content is pending (a delta update whose
 * base is missing), Yjs may encode the same document differently depending on when the
 * pending content was integrated, so such a merge is never used incrementally: the set
 * is merged from scratch, exactly as {@link mergeRichtextUpdatesForServer} does.
 * Property-tested against the from-scratch merge in `record-fold-richtext.test.ts`.
 * Any other set (a reset hid updates, a write was rolled back) is merged from scratch.
 *
 * An entry is a pure (update set, merged bytes) pair, so concurrent transactions and
 * rolled-back ones can never make it wrong, only miss. Bounded: least recently used
 * entries are dropped beyond `maxBytes` (merged bytes plus key characters) or
 * `maxEntries`, and a field larger than `maxBytes` alone is not cached.
 */
export class RichtextMergeCache {
	private readonly entries = new Map<string, RichtextMergeCacheEntry>()
	private total = 0

	/**
	 * @param maxBytes - Memory bound (merged bytes plus key characters)
	 * @param maxEntries - Fields remembered at most
	 */
	constructor(
		private readonly maxBytes = RICHTEXT_MERGE_CACHE_BYTES,
		private readonly maxEntries = RICHTEXT_MERGE_CACHE_ENTRIES,
	) {}

	/** {@link RichtextKeyedMerger}: the merge of `updates` (base64, sorted, two or more). */
	readonly merge: RichtextKeyedMerger = (updates, scope) => {
		const key = `${scope.collection}\u0000${scope.recordId}\u0000${scope.field}`
		const entry = this.entries.get(key)
		if (entry) {
			const added: string[] = []
			let kept = 0
			for (const update of updates) {
				if (entry.keys.has(update)) kept++
				else added.push(update)
			}
			if (kept === entry.keys.size && added.length === 0) {
				// The same set: refresh its recency and reuse it.
				this.entries.delete(key)
				this.entries.set(key, entry)
				return entry.bytes
			}
			if (kept === entry.keys.size && entry.complete) {
				let merged = entry.bytes
				let complete = true
				for (const update of added) {
					const step = mergeRichtextUpdate(merged, base64ToBytes(update))
					merged = step.merged
					complete = complete && step.complete
					if (!complete) break
				}
				if (complete) {
					this.remember(key, updates, merged, true)
					return merged
				}
			}
		}
		// From scratch: the steps of mergeRichtextUpdatesForServer, noting completeness.
		const [first, ...rest] = updates
		let merged = base64ToBytes(first ?? '')
		let complete = true
		for (const update of rest) {
			const step = mergeRichtextUpdate(merged, base64ToBytes(update))
			merged = step.merged
			complete = complete && step.complete
		}
		this.remember(key, updates, merged, complete)
		return merged
	}

	/** Fields currently remembered (diagnostics and tests). */
	get size(): number {
		return this.entries.size
	}

	private remember(
		key: string,
		updates: readonly string[],
		bytes: Uint8Array,
		complete: boolean,
	): void {
		const previous = this.entries.get(key)
		if (previous) {
			this.entries.delete(key)
			this.total -= previous.cost
		}
		let cost = bytes.length
		for (const update of updates) cost += update.length
		if (cost > this.maxBytes) return
		this.entries.set(key, { keys: new Set(updates), bytes, complete, cost })
		this.total += cost
		for (const [oldest, entry] of this.entries) {
			if (this.total <= this.maxBytes && this.entries.size <= this.maxEntries) break
			this.entries.delete(oldest)
			this.total -= entry.cost
		}
	}
}

/**
 * The fold options every server store uses: the richtext merger (with an incremental
 * {@link RichtextMergeCache} for materialization), no traces (the server has no
 * DevTools subscriber), and the server's authority: every node id in the
 * `kora:server:` namespace (the prefix rule, RT-62) plus `explicitAuthorities` (legacy
 * server node ids and configured extras).
 */
export function serverFoldOptions(
	explicitAuthorities: readonly string[],
	transforms: readonly OperationTransform[] = [],
): ServerFoldOptions {
	return {
		richtext: mergeRichtextUpdatesForServer,
		richtextKeyed: new RichtextMergeCache().merge,
		traces: 'none',
		authoritativeNodeIds: new ServerAuthoritySet(explicitAuthorities),
		...(transforms.length > 0 ? { transforms } : {}),
	}
}

/**
 * The operation as the server's schema reads it (transforms at fold time, RT-84): what
 * authorization, validators, constraint checks and scope filters judge. The store keeps
 * the operation exactly as uploaded and folds this same view. Null when no transform
 * path exists or a transform drops it.
 *
 * @param store - Anything that knows the server schema and transforms
 * @param op - The operation as stored or uploaded
 */
export function serverOperationView(
	store: {
		getSchema(): SchemaDefinition | null
		getOperationTransforms?(): readonly OperationTransform[]
	},
	op: Operation,
): Operation | null {
	const schema = store.getSchema()
	if (schema === null) return op
	return operationSchemaView(op, schema.version, store.getOperationTransforms?.())
}

/**
 * Fold plan fingerprint of the server: the schema's plan (with its schema transforms,
 * RT-84) plus the explicit authorities (the prefix rule is constant). A change in the explicit authorities re-folds every
 * record, so a stored fold state never keeps (or lacks) an authority class the current
 * authority set would not give.
 */
export function serverFoldPlanFingerprint(
	schema: SchemaDefinition,
	explicitAuthorities: readonly string[],
	transforms: readonly OperationTransform[] = [],
): string {
	const explicit = normalizeLegacyAuthorities(explicitAuthorities)
	return `${foldPlanFingerprint(schema, transforms)}|auth:${SERVER_NODE_PREFIX}*${
		explicit.length > 0 ? `,${explicit.join(',')}` : ''
	}`
}

/**
 * A short stamp of a server fold plan fingerprint ({@link serverFoldPlanFingerprint}),
 * stored with each fold state so a state folded with another plan (another instance
 * during a rolling deploy) is recognized and re-folded.
 */
export function planStampOf(fingerprint: string): string {
	return createHash('sha256').update(fingerprint).digest('hex').slice(0, 16)
}

/**
 * Where the sweep of outdated records goes on: batches take records in key order from
 * where the last one ended and wrap around at the end, so records that cannot be folded
 * (a transform throwing on them) never keep the others back, and are retried each lap.
 */
export class OutdatedRecordCursor {
	private after: { collection: string; recordId: string } | null = null

	/** The key the next batch starts after (null: from the start). */
	position(): { collection: string; recordId: string } | null {
		return this.after
	}

	/** A batch of `limit` read `rows` (in key order): the next one starts after them. */
	advance(rows: readonly { collection: string; record_id: string }[], limit: number): void {
		const last = rows[rows.length - 1]
		this.after =
			rows.length < limit || !last
				? null
				: { collection: last.collection, recordId: last.record_id }
	}
}

/**
 * Fingerprint of how `schema` folds each field: field kind, merge strategy and custom
 * resolver (its source text), plus `FOLD_STATE_VERSION`. Stored fold states built
 * under a different fingerprint are re-materialized from the log at startup. This is
 * the core definition (`@korajs/core` `foldPlanFingerprint`), re-exported so clients
 * and the server can never disagree on whether a plan changed.
 */
export { foldPlanFingerprint }

/**
 * Parse a stored fold state, or null when it is unreadable (unknown format version,
 * malformed JSON, a different record): the caller then re-folds the record from its
 * operation log.
 */
export function parseStoredFoldState(
	json: string | null | undefined,
	collection: string,
	recordId: string,
): FoldState | null {
	if (typeof json !== 'string' || json.length === 0) return null
	try {
		const state = deserializeFoldState(json)
		return state.c === collection && state.r === recordId ? state : null
	} catch (error) {
		if (error instanceof FoldStateError) return null
		throw error
	}
}

/** Returned by {@link mergeIntoFoldState} when the stored state cannot take the operations. */
export const REFOLD_REQUIRED = Symbol('kora.refold-required')

/**
 * Merge operations into a record's state, incrementally: O(fields the operations
 * touch). Returns {@link REFOLD_REQUIRED} when the stored state cannot take them (a
 * field whose fold kind changed since the state was built raises
 * {@link FoldStateError}); the caller then re-folds the record from its log with
 * {@link refoldRecord}. Synchronous, so SQLite's synchronous write transaction and
 * the memory store's synchronous apply can call it.
 *
 * @param state - The record's current state, or null for none
 * @param ops - The operations to merge (any order; duplicates are no-ops)
 * @param schema - The schema
 * @param options - Server fold options
 */
export function mergeIntoFoldState(
	state: FoldState | null,
	ops: readonly Operation[],
	schema: SchemaDefinition,
	options: ServerFoldOptions,
): FoldState | null | typeof REFOLD_REQUIRED {
	const first = ops[0]
	if (first === undefined) return state
	try {
		let next = state ?? createFoldState(first.collection, first.recordId)
		for (const op of ops) next = mergeOp(next, op, schema, options).state
		return next
	} catch (error) {
		if (error instanceof FoldStateError) return REFOLD_REQUIRED
		throw error
	}
}

/**
 * Fold a record from scratch: the reference definition of its state.
 *
 * @returns The state, or null when `ops` is empty
 */
export function refoldRecord(
	ops: readonly Operation[],
	schema: SchemaDefinition,
	options: ServerFoldOptions,
): FoldState | null {
	return foldRecord(ops, schema, options).state
}

/** A fold state projected onto a server collection row. */
export interface FoldedRow {
	/**
	 * The record's field values. For a deleted record: the values it had (every
	 * field's merged value; the server keeps them on the soft-deleted row so scope
	 * judgments and authorization still see the record's last known fields).
	 */
	values: Record<string, unknown>
	/** Wall time of the record's creation (its oldest insert). */
	createdAt: number
	/** Wall time of the record's newest operation of any type. */
	updatedAt: number
	/** True when the newest delete is later than the newest write. */
	deleted: boolean
}

/**
 * Project a fold state onto a collection row, or null when the record was never
 * inserted (an update with no merged insert does not materialize a row; W7 semantic
 * change 9).
 *
 * @param state - The record's fold state
 * @param options - Server fold options (the richtext merger)
 * @param fields - Only these fields' values (the others are never computed): for a
 *   caller that keeps a few fields, such as per-operation scope snapshots, which must
 *   not merge a richtext body per operation
 */
export function projectFoldState(
	state: FoldState,
	options: ServerFoldOptions,
	fields?: ReadonlySet<string>,
): FoldedRow | null {
	if (state.cr === null) return null
	const live = isFoldStateLive(state)
	// A deleted record keeps every field's merged value: materialize it as if the
	// newest delete were absent (`w` is set, since an insert was merged).
	const values =
		materialize(live ? state : { ...state, d: null }, {
			...(options.richtext ? { richtext: options.richtext } : {}),
			...(options.richtextKeyed ? { richtextKeyed: options.richtextKeyed } : {}),
			...(fields ? { fields } : {}),
		}) ?? {}
	const createdAt = HybridLogicalClock.deserialize(state.cr.t).wallTime
	const updatedAt = state.u ? HybridLogicalClock.deserialize(state.u.t).wallTime : createdAt
	return { values, createdAt, updatedAt, deleted: !live }
}

/**
 * The value a materialized row holds for a schema field (RT-106): the fold's value, or,
 * for a field the fold never wrote (every operation of the record predates the field),
 * the schema default. That is what every device's row holds: the client store writes
 * only the fields its fold holds, so such a column keeps the value it was created or
 * added with.
 *
 * @param values - The projected values ({@link projectFoldState})
 * @param field - The schema field
 * @param descriptor - Its descriptor in the current schema
 */
export function materializedFieldValue(
	values: Readonly<Record<string, unknown>>,
	field: string,
	descriptor: FieldDescriptor,
): unknown {
	if (field in values) return values[field] ?? null
	return descriptor.defaultValue ?? null
}

/** A field value as a store's column round trip leaves it (identity for the memory store). */
export type StoredFieldValue = (value: unknown, descriptor: FieldDescriptor) => unknown

/**
 * The field values a store persists for a projected row: every schema field as
 * {@link materializedFieldValue} makes it (the schema default for a field the fold never
 * wrote, RT-106), through the store's column round trip. Fields outside the schema are
 * kept only with `keepOthers` (the memory store keeps them; the SQL stores have no column
 * for them). A collection outside the schema keeps the projected values as they are.
 * The one materialization behind the persisted row, the stored row a write is judged
 * against and the record the write leaves (`previewResult`), so all three agree.
 *
 * @param values - The projected values ({@link projectFoldState})
 * @param fields - The collection's schema fields, or undefined outside the schema
 * @param asStored - The store's column round trip
 * @param keepOthers - Keep projected values of fields outside the schema
 */
export function materializedValues(
	values: Readonly<Record<string, unknown>>,
	fields: Readonly<Record<string, FieldDescriptor>> | undefined,
	asStored: StoredFieldValue,
	keepOthers: boolean,
): Record<string, unknown> {
	if (!fields) return { ...values }
	const out: Record<string, unknown> = keepOthers ? { ...values } : {}
	for (const [field, descriptor] of Object.entries(fields)) {
		out[field] = asStored(materializedFieldValue(values, field, descriptor), descriptor)
	}
	return out
}

/**
 * The record a fold state leaves, as the store materializes it ({@link materializedValues}),
 * or null when it leaves no row: what `previewResult` hands access rules.
 */
export function foldedResult(
	state: FoldState | null,
	fields: Readonly<Record<string, FieldDescriptor>> | undefined,
	options: ServerFoldOptions,
	asStored: StoredFieldValue,
	keepOthers: boolean,
): { values: Record<string, unknown>; deleted: boolean } | null {
	const row = state ? projectFoldState(state, options) : null
	if (!row) return null
	return {
		values: materializedValues(row.values, fields, asStored, keepOthers),
		deleted: row.deleted,
	}
}

/**
 * The materialized row a fold state stands for, exactly as a store would read it back
 * from its collection table (`readStoredRow`), or null when the fold leaves no row. For
 * judging a write against the record the active fold plan defines when the row on disk
 * was materialized under another plan (an old-plan instance during a rolling deploy).
 *
 * @param recordId - The record id
 * @param state - The record's fold state under the active plan
 * @param fields - The collection's schema fields
 * @param options - Server fold options
 * @param asStored - A field value as the store's column round trip leaves it
 */
export function foldedStoredRow(
	recordId: string,
	state: FoldState | null,
	fields: Readonly<Record<string, FieldDescriptor>>,
	options: ServerFoldOptions,
	asStored: StoredFieldValue,
): MaterializedRecord | null {
	const row = state ? projectFoldState(state, options) : null
	if (!row) return null
	const record: MaterializedRecord = {
		...materializedValues(row.values, fields, asStored, false),
		id: recordId,
	}
	record._created_at = row.createdAt
	record._updated_at = row.updatedAt
	if (row.deleted) record._deleted = 1
	return record
}

/**
 * Per-field versions of a live record, from its fold state (RT-27): each field's
 * newest affecting write, the record's creation and its newest operation. Null when
 * the record is not live.
 */
export function foldFieldVersions(state: FoldState | null): RecordFieldVersions | null {
	if (!state) return null
	return getFoldFieldVersions(state)
}

/**
 * A copy of `state` restricted to `fields` (the fields a receiver may see), for a
 * scope-entry operation (RT-29). Record-level stamps are kept: they carry no field
 * values.
 */
export function filterFoldStateFields(state: FoldState, fields: Iterable<string>): FoldState {
	const keep = new Set(fields)
	const filtered: FoldState['f'] = {}
	for (const [field, fieldState] of Object.entries(state.f)) {
		if (keep.has(field)) filtered[field] = fieldState
	}
	return { ...state, f: filtered }
}

/** Serialize a fold state for storage or the wire (canonical JSON). */
export function serializeServerFoldState(state: FoldState): string {
	return serializeFoldState(state)
}
