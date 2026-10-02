import type { HLCTimestamp, SchemaDefinition } from '../types'
import { planField } from './field-kind'
import { elementKey } from './field-states'
import { createFoldState } from './fold'
import { stampOf } from './stamp'
import type { ElementState, FieldState, FoldState, KeyState, Stamp } from './types'
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

/**
 * Build a record's fold state from a materialized row: the base snapshot used when
 * the operations that produced the row are no longer all in the log (a database
 * compacted before W7, or a log with quarantined rows).
 *
 * Every field is written at its own version with a sentinel operation id that
 * sorts after any real id, so the snapshot dominates every operation it reflects:
 * re-merging such an operation changes nothing, while a later operation merges on
 * top as usual. Arrays and objects also clear elements / keys written before the
 * snapshot (so an older add the row no longer shows is not resurrected), richtext
 * hides older updates, counters drop older deltas and custom-resolver fields start
 * a fresh log at the snapshot value.
 *
 * Lossy by construction: history the row does not show (concurrent writes of an
 * older HLC that arrive later) folds against the snapshot value, not against the
 * original operations.
 *
 * @param input - The row's values and versions
 * @param schema - The schema (selects each field's fold kind)
 */
export function createSnapshotState(input: FoldSnapshotInput, schema: SchemaDefinition): FoldState {
	const state = createFoldState(input.collection, input.recordId)
	const collection = schema.collections[input.collection]
	const fields: Record<string, FieldState> = {}
	for (const [field, raw] of Object.entries(input.values)) {
		if (raw === undefined) continue
		const version = input.fieldVersions[field] ?? input.latest
		const clear = stampOf(version, SNAPSHOT_CLEAR_ID)
		const write = stampOf(version, SNAPSHOT_WRITE_ID)
		fields[field] = snapshotField(planField(collection, field), raw, clear, write)
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
