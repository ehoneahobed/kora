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
	FoldStateError,
	HybridLogicalClock,
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
	SchemaDefinition,
} from '@korajs/core'
import { mergeRichtext } from '@korajs/merge'
import {
	SERVER_NODE_PREFIX,
	ServerAuthoritySet,
	normalizeLegacyAuthorities,
} from './server-identity'

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

/** Records re-materialized per transaction by the startup migration. */
export const FOLD_MIGRATION_BATCH = 500

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

/**
 * The fold options every server store uses: the richtext merger, no traces (the
 * server has no DevTools subscriber), and the server's authority: every node id in
 * the `kora:server:` namespace (the prefix rule, RT-62) plus `explicitAuthorities`
 * (legacy server node ids and configured extras).
 */
export function serverFoldOptions(
	explicitAuthorities: readonly string[],
	transforms: readonly OperationTransform[] = [],
): ServerFoldOptions {
	return {
		richtext: mergeRichtextUpdatesForServer,
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
