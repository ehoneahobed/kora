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
import {
	FOLD_STATE_VERSION,
	FoldStateError,
	HybridLogicalClock,
	createFoldState,
	deserializeFoldState,
	foldRecord,
	getFoldFieldVersions,
	isFoldStateLive,
	materialize,
	mergeOp,
	serializeFoldState,
} from '@korajs/core'
import type {
	FoldOptions,
	FoldState,
	Operation,
	RecordFieldVersions,
	SchemaDefinition,
} from '@korajs/core'
import { mergeRichtext } from '@korajs/merge'

/**
 * Fold options as the server passes them. `authoritativeNodeIds` lists the node ids
 * whose operations win `merge('server-authoritative')` fields (the server's own node
 * ids). Declared here as well as in core's `FoldOptions` so this module compiles
 * against a core that predates the option; the fold ignores unknown options.
 */
export interface ServerFoldOptions extends FoldOptions {
	authoritativeNodeIds?: readonly string[]
}

/**
 * `kora_server_meta` key holding {@link foldPlanFingerprint} of the schema the stored
 * fold states were built under. A change re-materializes every record.
 */
export const FOLD_PLAN_FINGERPRINT_KEY = 'fold_plan_fingerprint'

/** Table holding each materialized record's serialized fold state (SQLite and Postgres). */
export const FOLD_STATE_TABLE = 'kora_fold_state'

/** Records re-materialized per transaction by the startup migration. */
export const FOLD_MIGRATION_BATCH = 500

/** What a store's startup re-materialization did (W7 step 7). */
export interface FoldMigrationReport {
	/** False when no schema was set (nothing is materialized). */
	ran: boolean
	/** Records re-folded and rewritten. */
	records: number
	/**
	 * Records left with their pre-fold rows because the log has quarantined rows (see
	 * `ServerLogIntegrityReport`); they fold from their remaining log on their next write.
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

/**
 * The fold options every server store uses: the richtext merger, no traces (the
 * server has no DevTools subscriber), and the server's authoritative node ids.
 */
export function serverFoldOptions(authoritativeNodeIds: readonly string[]): ServerFoldOptions {
	return {
		richtext: mergeRichtextUpdatesForServer,
		traces: 'none',
		authoritativeNodeIds: [...authoritativeNodeIds],
	}
}

/**
 * Fingerprint of how `schema` folds each field: field kind, merge strategy and custom
 * resolver (its source text), plus {@link FOLD_STATE_VERSION}. Stored fold states built
 * under a different fingerprint are re-materialized from the log at startup, because
 * the per-field kind or a resolver's output would differ.
 */
export function foldPlanFingerprint(schema: SchemaDefinition): string {
	const parts: string[] = [`fold-v${FOLD_STATE_VERSION}`]
	for (const name of Object.keys(schema.collections).sort()) {
		const collection = schema.collections[name]
		if (!collection) continue
		const fields = Object.keys(collection.fields)
			.sort()
			.map((field) => {
				const descriptor = collection.fields[field]
				const resolver = collection.resolvers?.[field]
				return `${field}:${descriptor?.kind ?? ''}:${descriptor?.mergeStrategy ?? ''}:${
					resolver ? hashText(String(resolver)) : ''
				}`
			})
		const resolverOnly = Object.keys(collection.resolvers ?? {})
			.filter((field) => !(field in collection.fields))
			.sort()
			.map((field) => `${field}:resolver:${hashText(String(collection.resolvers?.[field]))}`)
		parts.push(`${name}(${[...fields, ...resolverOnly].join(',')})`)
	}
	return parts.join('|')
}

/** FNV-1a over UTF-16 code units: a stable, dependency-free text fingerprint. */
function hashText(text: string): string {
	let hash = 0x811c9dc5
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i)
		hash = Math.imul(hash, 0x01000193) >>> 0
	}
	return hash.toString(16).padStart(8, '0')
}

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
 */
export function projectFoldState(state: FoldState, options: ServerFoldOptions): FoldedRow | null {
	if (state.cr === null) return null
	const live = isFoldStateLive(state)
	// A deleted record keeps every field's merged value: materialize it as if the
	// newest delete were absent (`w` is set, since an insert was merged).
	const values = materialize(live ? state : { ...state, d: null }, options) ?? {}
	const createdAt = HybridLogicalClock.deserialize(state.cr.t).wallTime
	const updatedAt = state.u ? HybridLogicalClock.deserialize(state.u.t).wallTime : createdAt
	return { values, createdAt, updatedAt, deleted: !live }
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
