import type { HLCTimestamp, SchemaDefinition } from '../types'
import { isAuthoritativeNodeId } from './authority'
import { FoldConfigurationError } from './errors'
import { planField } from './field-kind'
import { elementKey, fieldStamp, materializeField } from './field-states'
import { createFoldState } from './fold'
import { fieldStateMatchesPlan, mismatchedFoldFields } from './plan'
import { stampOf } from './stamp'
import type { ElementState, FieldState, FoldOptions, FoldState, KeyState, Stamp } from './types'
import { canonicalKey, isPlainObject, normalizeValue } from './values'

/**
 * Operation-id sentinels of snapshot stamps. They sort after every real operation
 * id (`￿` is above any id character), so a snapshot write dominates every
 * operation with the same HLC: the snapshot already reflects that operation.
 */
const SNAPSHOT_CLEAR_ID = '￿kora-snapshot:0'
const SNAPSHOT_WRITE_ID = '￿kora-snapshot:1'

/** A materialized row and its versions, the input of {@link createSnapshotState}. */
export interface FoldSnapshotInput {
	collection: string
	recordId: string
	/** Field values of the row (record or op-data form; binary is normalized). */
	values: Record<string, unknown>
	/** Per-field version: the HLC of the newest write of each field. */
	fieldVersions: Record<string, HLCTimestamp>
	/** HLC of the row's creation. */
	created: HLCTimestamp
	/** HLC of the newest operation the row reflects (its `_version`). */
	latest: HLCTimestamp
	/** The row is a domain tombstone. */
	deleted: boolean
}

function snapshotField(
	plan: ReturnType<typeof planField>,
	raw: unknown,
	clear: Stamp,
	write: Stamp,
): FieldState {
	const v = normalizeValue(raw)
	switch (plan.kind) {
		case 'reg':
			return { k: 'reg', e: [{ s: write, v }], val: v }
		case 'res':
			return { k: 'res', e: [{ s: write, v, z: 1 }], val: v }
		case 'ctr':
			return { k: 'ctr', base: { s: write, v }, d: [], val: v }
		case 'max':
		case 'min':
			return typeof v === 'number' && !Number.isNaN(v)
				? { k: plan.kind, best: { s: write, v }, reg: null }
				: { k: plan.kind, best: null, reg: { s: write, v } }
		case 'set': {
			if (!Array.isArray(v)) {
				return {
					k: 'set',
					ao: plan.appendOnly,
					sh: { s: write, arr: false, v },
					clr: write,
					el: {},
				}
			}
			const el: Record<string, ElementState> = {}
			const counts = new Map<string, number>()
			v.forEach((item, index) => {
				const canonical = canonicalKey(item)
				const n = counts.get(canonical) ?? 0
				counts.set(canonical, n + 1)
				el[elementKey(canonical, n)] = {
					v: JSON.parse(canonical) as unknown,
					n,
					a: write,
					f: { s: write, i: index },
					r: null,
				}
			})
			return { k: 'set', ao: plan.appendOnly, sh: { s: write, arr: true }, clr: clear, el }
		}
		case 'map': {
			if (!isPlainObject(v)) {
				return { k: 'map', sh: { s: write, obj: false, v }, clr: write, keys: {} }
			}
			const keys: Record<string, KeyState> = {}
			for (const [key, member] of Object.entries(v)) keys[key] = { s: write, del: false, v: member }
			return { k: 'map', sh: { s: write, obj: true }, clr: clear, keys }
		}
		case 'rt': {
			if (v === null || typeof v === 'string' || !isPlainObject(v) || !('$koraBytes' in v)) {
				return { k: 'rt', reset: { s: write, v }, u: {} }
			}
			const update = String(v.$koraBytes)
			return { k: 'rt', reset: { s: clear, v: null }, u: { [update]: write } }
		}
	}
}

/** Options of {@link createSnapshotState}. */
export interface FoldSnapshotOptions {
	/**
	 * A fold state this replica still holds for the record (its stored
	 * `_kora_fold_state`, or the base of a compacted record). Every field whose stored
	 * kind still matches the schema is taken from it as-is (exact: element, delta and
	 * update stamps included); only the other fields are rebuilt from the row.
	 */
	seed?: FoldState | null
	/**
	 * Legacy authoritative node ids (`FoldOptions.authoritativeNodeIds`). A
	 * `merge('server-authoritative')` field whose version was written by an
	 * authoritative node (a `kora:server:` node or one of these) is stamped with
	 * authority class 1, so a client write it beat cannot overturn it when merged again.
	 */
	authoritativeNodeIds?: ReadonlySet<string>
}

/**
 * Build a record's fold state from a materialized row: the base snapshot used when
 * the operations that produced the row are no longer all in the log (a database
 * compacted before W7, or a record that owns quarantined log rows).
 *
 * Exact where the replica still has the data: fields of `options.seed` (a stored
 * fold state) whose kind is unchanged are used verbatim, and the record stamps come
 * from it. Every other field is written at its own version with a sentinel
 * operation id that sorts after any real id, so the snapshot dominates every
 * operation it reflects: re-merging such an operation changes nothing (the record's
 * remaining log is folded on top of it again on every re-fold), while a later
 * operation merges on top as usual. Arrays and objects also clear elements / keys
 * written before the snapshot (so an older add the row no longer shows is not
 * resurrected), richtext hides older updates, counters drop older deltas and
 * custom-resolver fields start a fresh log at the snapshot value. A
 * `merge('server-authoritative')` field whose version is a server node's write
 * keeps its authority class.
 *
 * Approximate for a row-only field (RT-68 residual): a concurrent write OLDER than
 * the field's version that arrives later folds against the snapshot value, not
 * against the original operations (a late counter delta or array add is dropped).
 * It cannot be otherwise without the original operations: the row alone does not
 * say whether an older write is already in its value. The store marks such records
 * approximate, and the server's fold state replaces the snapshot when the record
 * next enters the device's scope.
 *
 * @param input - The row's values and versions
 * @param schema - The schema (selects each field's fold kind)
 * @param options - Seed state and authoritative node ids
 */
export function createSnapshotState(
	input: FoldSnapshotInput,
	schema: SchemaDefinition,
	options: FoldSnapshotOptions = {},
): FoldState {
	const state = createFoldState(input.collection, input.recordId)
	const collection = schema.collections[input.collection]
	const seed =
		options.seed && options.seed.c === input.collection && options.seed.r === input.recordId
			? options.seed
			: null
	const fields: Record<string, FieldState> = {}
	for (const [field, raw] of Object.entries(input.values)) {
		if (raw === undefined) continue
		const seeded = seed?.f[field]
		if (seeded !== undefined && fieldStateMatchesPlan(collection, field, seeded)) {
			fields[field] = seeded
			continue
		}
		const version = input.fieldVersions[field] ?? input.latest
		const plan = planField(collection, field)
		const authoritative =
			plan.authoritative === true &&
			isAuthoritativeNodeId(version.nodeId, options.authoritativeNodeIds)
		fields[field] = snapshotField(
			plan,
			raw,
			classed(stampOf(version, SNAPSHOT_CLEAR_ID), authoritative),
			classed(stampOf(version, SNAPSHOT_WRITE_ID), authoritative),
		)
	}
	if (seed !== null && seed.cr !== null && seed.u !== null) {
		return { ...state, cr: seed.cr, w: seed.w, d: seed.d, u: seed.u, f: fields }
	}
	const latestClear = stampOf(input.latest, SNAPSHOT_CLEAR_ID)
	const latestWrite = stampOf(input.latest, SNAPSHOT_WRITE_ID)
	return {
		...state,
		cr: stampOf(input.created, SNAPSHOT_WRITE_ID),
		w: input.deleted ? latestClear : latestWrite,
		d: input.deleted ? latestWrite : null,
		u: latestWrite,
		f: fields,
	}
}

function classed(stamp: Stamp, authoritative: boolean): Stamp {
	return authoritative ? { ...stamp, c: 1 } : stamp
}

/** Result of {@link adaptFoldState}. */
export interface AdaptedFoldState {
	state: FoldState
	/** Fields rebuilt as snapshots (their stored kind no longer matched the schema). */
	adapted: string[]
}

/**
 * Make a stored fold state mergeable under the current schema after a change of a
 * field's fold kind (RT-63): every field whose stored kind no longer matches the
 * plan is replaced by a snapshot of its materialized value at its newest write (as
 * {@link createSnapshotState} builds from a row), keeping its authority class.
 * Fields whose kind is unchanged are kept exactly. Used for compacted base states,
 * whose operations are no longer in the log to re-fold with the new plan.
 *
 * @param state - A stored fold state (base or record state)
 * @param schema - The current schema
 * @param options - `richtext` merger, to materialize a richtext field with several updates
 */
export function adaptFoldState(
	state: FoldState,
	schema: SchemaDefinition,
	options: Pick<FoldOptions, 'richtext'> = {},
): AdaptedFoldState {
	const mismatched = mismatchedFoldFields(state, schema)
	if (mismatched.length === 0) return { state, adapted: [] }
	const collection = schema.collections[state.c]
	const fields: Record<string, FieldState> = { ...state.f }
	for (const field of mismatched) {
		const old = fields[field] as FieldState
		delete fields[field]
		const stamp = fieldStamp(old)
		if (stamp === null) continue
		let value: unknown
		try {
			value = materializeField(old, field, options.richtext)
		} catch (error) {
			if (error instanceof FoldConfigurationError) continue
			throw error
		}
		if (value === undefined) continue
		const plan = planField(collection, field)
		const authoritative = stamp.c === 1 && plan.authoritative === true
		fields[field] = snapshotField(
			plan,
			value,
			classed({ t: stamp.t, o: SNAPSHOT_CLEAR_ID }, authoritative),
			classed({ t: stamp.t, o: SNAPSHOT_WRITE_ID }, authoritative),
		)
	}
	return { state: { ...state, f: fields }, adapted: mismatched }
}
