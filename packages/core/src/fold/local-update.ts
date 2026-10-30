import { HybridLogicalClock, MAX_LOGICAL } from '../clock/hlc'
import type { Operation, SchemaDefinition } from '../types'
import { planField } from './field-kind'
import type { FieldPlan } from './field-kind'
import { createFoldState, isFoldStateLive, materialize, mergeOp } from './fold'
import {
	FOLD_STATE_VERSION,
	type FieldState,
	type FoldOptions,
	type FoldState,
	type Stamp,
} from './types'
import { canonicalKey, normalizeValue } from './values'

/*
 * Predicting what a LOCAL update will fold to, without the record's fold state.
 *
 * The overlay (instant UI updates, `@korajs/store`) shows a write before it commits. For
 * a plain last-write-wins field the written value is the materialized value. For an
 * atomic op (`op.increment`, `op.append`), a counter, a max or min, or an array, it is
 * not: the result depends on how the field folds. Rather than restate those rules, this
 * module runs the real fold: it rebuilds the part of the fold state the update can
 * observe from the record's current values, merges the update's operation into it with
 * `mergeOp`, and materializes. The prediction therefore cannot drift from the committed
 * fold, only from the database's state at commit (a concurrent remote write), which the
 * caller detects by comparing `previousData`.
 *
 * Why the current values are enough, per fold kind (the local operation is the newest
 * writer of every field it touches, because the HLC is past everything this device has
 * received):
 * - register: the value is the update's resolved value, or `applyAtomicOp(current)`;
 * - counter: `current + delta`, where the fold's running sum equals the current value;
 * - max / min: the better of the current value and the written one;
 * Not enough: an array. Which copy of a value is present is the element's identity
 * (`value#k`, the k-th copy ever added), and a removal or a re-add acts on that identity,
 * not on the visible position. After concurrent edits the visible copy of `y` can be
 * `y#1` while `y#0` is a tombstone, so removing "the" `y` and re-adding a removed `y`
 * both depend on state the record's values do not carry. An array write needs the fold
 * state (`baseState`).
 */

/** Why an update cannot be predicted from the record's current values alone. */
export type LocalUpdateDecline =
	/** An array is written: which copy is present is in the real fold state only. */
	| 'array-needs-state'
	/** A written field folds as a resolver, key map, richtext or authoritative register. */
	| 'unsupported-plan'
	/** The given fold state does not describe the record's current values. */
	| 'state-mismatch'

/** Input of {@link predictLocalUpdate}. */
export interface LocalUpdateInput {
	/** The schema (merge strategies and resolvers come from it). */
	readonly schema: SchemaDefinition
	/**
	 * The update operation as the write path will build it: `data` the resolved values,
	 * `previousData` the current values of the written fields, `atomicOps` the intents.
	 * Its id, sequence number and causal parents are placeholders; its timestamp must be
	 * later than anything the record holds (the caller passes `max(now, wall time floor)`;
	 * with a `baseState` it is raised above the state's newest write).
	 */
	readonly op: Operation
	/** The record's current values by field name, in the shape reads return. */
	readonly current: Readonly<Record<string, unknown>>
	/**
	 * The record's real fold state, when the caller has it. Then the update is merged
	 * into it as is (exact, including array adds). Without it a synthetic state is built
	 * from `current`.
	 */
	readonly baseState?: FoldState | null
	/** Fold options of the database (richtext merger, transforms). */
	readonly options: FoldOptions
}

/** The result of {@link predictLocalUpdate}. */
export interface LocalUpdatePrediction {
	/** The materialized value of each written field (`null` where the fold holds none). */
	readonly values: Record<string, unknown>
	/** The record's state after the update: only when a real `baseState` was given. */
	readonly state: FoldState | null
}

/** Stamp older than any write: the stand-in for "written before the update". */
const BEFORE_EVERYTHING: Stamp = {
	t: HybridLogicalClock.serialize({ wallTime: 0, logical: 0, nodeId: 'overlay-base' }),
	o: 'overlay-base',
}

/** The synthetic state of one field holding `current`, or null when it cannot be built. */
function syntheticField(plan: FieldPlan, current: unknown): FieldState | null {
	const present = current !== null && current !== undefined
	switch (plan.kind) {
		case 'reg':
			if (plan.authoritative) return null
			return present
				? { k: 'reg', e: [{ s: BEFORE_EVERYTHING, v: normalizeValue(current) }], val: current }
				: { k: 'reg', e: [], val: undefined }
		case 'ctr':
			return present
				? {
						k: 'ctr',
						base: { s: BEFORE_EVERYTHING, v: normalizeValue(current) },
						d: [],
						val: current,
					}
				: { k: 'ctr', base: null, d: [], val: undefined }
		case 'max':
		case 'min':
			if (typeof current === 'number' && !Number.isNaN(current)) {
				return { k: plan.kind, best: { s: BEFORE_EVERYTHING, v: current }, reg: null }
			}
			return {
				k: plan.kind,
				best: null,
				reg: present ? { s: BEFORE_EVERYTHING, v: normalizeValue(current) } : null,
			}
		// An array's identity (which copy of a value is present) is in the real fold state only.
		case 'set':
			return null
		default:
			return null
	}
}

/** An operation's timestamp raised above `state.u`, so the update is its newest write. */
function raisedAbove(op: Operation, state: FoldState): Operation | null {
	if (state.u === null) return op
	const newest = HybridLogicalClock.deserialize(state.u.t)
	if (HybridLogicalClock.compare(op.timestamp, newest) > 0) return op
	if (newest.logical >= MAX_LOGICAL) return null
	return {
		...op,
		timestamp: { wallTime: newest.wallTime, logical: newest.logical + 1, nodeId: op.nodeId },
	}
}

/**
 * Predict the materialized values of the fields a local update writes.
 *
 * @param input - The update, the record's current values and, optionally, its fold state
 * @returns The values, or why the update cannot be predicted
 *
 * @example
 * ```typescript
 * const prediction = predictLocalUpdate({ schema, op, current: { hits: 4 }, options })
 * // op.data = { hits: 5 }, op.atomicOps = { hits: { type: 'increment', value: 1 } }
 * if (!('declined' in prediction)) prediction.values.hits // 5
 * ```
 */
export function predictLocalUpdate(
	input: LocalUpdateInput,
): LocalUpdatePrediction | { readonly declined: LocalUpdateDecline } {
	const { schema, current, options } = input
	const data = input.op.data ?? {}
	const written = Object.keys(data)
	const collection = schema.collections[input.op.collection]
	let state: FoldState
	let op = input.op
	const real = input.baseState ?? null
	if (real !== null) {
		if (!isFoldStateLive(real)) return { declined: 'state-mismatch' }
		// The state must describe the values the caller derived the update from.
		const shown = materialize(real, { richtext: options.richtext, fields: new Set(written) }) ?? {}
		for (const field of written) {
			const held = shown[field] ?? null
			const given = current[field] ?? null
			if (canonicalKey(held) !== canonicalKey(given)) return { declined: 'state-mismatch' }
		}
		const raised = raisedAbove(op, real)
		if (raised === null) return { declined: 'state-mismatch' }
		op = raised
		state = real
	} else {
		const fields: Record<string, FieldState> = {}
		for (const field of written) {
			const plan = planField(collection, field)
			const synthetic = syntheticField(plan, current[field])
			if (synthetic === null) {
				return { declined: plan.kind === 'set' ? 'array-needs-state' : 'unsupported-plan' }
			}
			fields[field] = synthetic
		}
		state = {
			...createFoldState(input.op.collection, input.op.recordId),
			v: FOLD_STATE_VERSION,
			cr: BEFORE_EVERYTHING,
			w: BEFORE_EVERYTHING,
			u: BEFORE_EVERYTHING,
			f: fields,
		}
	}
	for (const field of written) {
		const plan = planField(collection, field)
		if (plan.kind === 'res' || plan.kind === 'map' || plan.kind === 'rt' || plan.authoritative) {
			return { declined: 'unsupported-plan' }
		}
	}
	const merged = mergeOp(state, op, schema, { ...options, traces: 'none' })
	const values =
		materialize(merged.state, { richtext: options.richtext, fields: new Set(written) }) ?? {}
	const out: Record<string, unknown> = {}
	for (const field of written) out[field] = values[field] ?? null
	return { values: out, state: real === null ? null : merged.state }
}
