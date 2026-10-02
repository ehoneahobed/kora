import { HybridLogicalClock } from '../clock/hlc'
import type { AtomicOp, HLCTimestamp, Operation } from '../types'
import { applyAtomicOp } from './atomic-ops'
import { canonicalize } from './content-hash'

/** One operation's contribution to a record's materialized state. */
export interface ReplayOperation {
	type: string
	data: Record<string, unknown> | null
	/**
	 * Atomic-op intents carried by this operation, per field. When present, a field
	 * is composed (rather than overwritten) if the previous writer on that field was
	 * an atomic op of the same type. Absent means every field resolves by
	 * last-write-wins.
	 */
	atomicOps?: Record<string, AtomicOp> | null
	/**
	 * For updates: the values the writer saw before its change. Array fields use it
	 * as the base of a three-way set merge (see {@link mergeArraySet}). Absent means
	 * array fields resolve by last-write-wins.
	 */
	previousData?: Record<string, unknown> | null
}

/**
 * Three-way set merge for array fields, shared by the client merge engine
 * (`addWinsSet`) and the record fold, so client and server agree.
 *
 *   result = (local ∩ remote) ∪ (local − base) ∪ (remote − base)
 *
 * A base element is kept only if BOTH sides kept it (a one-sided removal is never
 * undone by the other side's unchanged copy); a non-base element is kept if EITHER
 * side has it. Elements are compared by `JSON.stringify`.
 *
 * Order is role-independent: kept base elements first, in base order, then every
 * other kept element sorted by its serialized form. Swapping `local` and `remote`
 * yields the identical array.
 *
 * Interim (S1): W7 replaces this pairwise rule with a per-element LWW set.
 *
 * @param local - One side's array after its modifications
 * @param remote - The other side's array after its modifications
 * @param base - The common ancestor both sides edited from
 * @returns The merged array
 */
export function mergeArraySet(local: unknown[], remote: unknown[], base: unknown[]): unknown[] {
	const serialize = (v: unknown): string => JSON.stringify(v)

	const baseSet = new Set(base.map(serialize))
	const localSet = new Set(local.map(serialize))
	const remoteSet = new Set(remote.map(serialize))

	const keep = (s: string): boolean =>
		(localSet.has(s) && remoteSet.has(s)) ||
		(!baseSet.has(s) && (localSet.has(s) || remoteSet.has(s)))

	const seen = new Set<string>()
	const result: unknown[] = []
	const addIfKept = (serialized: string, value: unknown): void => {
		if (!seen.has(serialized) && keep(serialized)) {
			seen.add(serialized)
			result.push(value)
		}
	}

	for (const item of base) {
		addIfKept(serialize(item), item)
	}

	const others = new Map<string, unknown>()
	for (const item of [...local, ...remote]) {
		const s = serialize(item)
		if (!baseSet.has(s) && !others.has(s)) {
			others.set(s, item)
		}
	}
	for (const s of [...others.keys()].sort()) {
		addIfKept(s, others.get(s))
	}

	return result
}

/**
 * Resolve a plain (non-atomic) write of an array field onto the running value.
 * When the running value is exactly the writer's base, the write fast-forwards
 * and keeps the writer's element order (what the authoring client materialized).
 * Otherwise a concurrent writer changed the field since that base, so the write's
 * delta is merged with {@link mergeArraySet}, exactly like the client merge.
 */
function resolveArrayWrite(running: unknown, value: unknown, base: unknown): unknown {
	if (!Array.isArray(running) || !Array.isArray(value) || !Array.isArray(base)) {
		return value
	}
	if (canonicalize(running) === canonicalize(base)) {
		return value
	}
	return mergeArraySet(running, value, base)
}

/**
 * Replay a list of operations (MUST be pre-sorted in HLC total order —
 * wallTime, then logical, then nodeId) to produce the current state of a single
 * record, composing atomic-op intents.
 *
 * Per field, an atomic op composes onto the running value only when the field's
 * previous writer was an atomic op of the SAME type (a same-type atomic chain:
 * concurrent increments sum, maxes take the max, appends accumulate); any other
 * write, including the first atomic write after a plain set, resolves by
 * last-write-wins on the resolved value. Because operations are folded in HLC order,
 * the current op always wins that last-write-wins comparison, so the result is
 * deterministic and identical on every replica that folds the same operation set.
 *
 * Plain array writes that carry `previousData` are merged as a set against that
 * base (see {@link mergeArraySet}) when a concurrent writer changed the field since
 * the base, so the fold and the client merge agree on one-sided removals.
 *
 * This is the single definition of atomic materialization shared by the client
 * (`@korajs/store` apply pipeline) and the server (`@korajs/server` materialization),
 * so both converge to the same value for any number of concurrent atomic writers.
 *
 * Returns the record field data (without `id`) or null if the record was deleted
 * or never inserted.
 */
export function replayOperationsForRecord(ops: ReplayOperation[]): Record<string, unknown> | null {
	let record: Record<string, unknown> | null = null
	let deleted = false
	// Per-field provenance of the running value: 'lww' for a plain set, or
	// `atomic:<type>` for an atomic write. Drives the compose-vs-overwrite decision.
	const lastWriterKind: Record<string, string> = {}

	for (const op of ops) {
		switch (op.type) {
			case 'insert':
				if (op.data) {
					record = { ...op.data }
					deleted = false
					for (const field of Object.keys(op.data)) {
						lastWriterKind[field] = 'lww'
					}
				}
				break
			case 'update':
				if (op.data) {
					const next: Record<string, unknown> = { ...(record ?? {}) }
					for (const [field, value] of Object.entries(op.data)) {
						const atomicOp = op.atomicOps?.[field]
						if (atomicOp && lastWriterKind[field] === `atomic:${atomicOp.type}`) {
							// Same-type atomic chain: compose the intent onto the running value.
							next[field] = applyAtomicOp(next[field], atomicOp)
						} else if (!atomicOp && op.previousData && field in op.previousData) {
							// Plain write with a known base: arrays merge as a set against
							// that base; every other kind is last-write-wins.
							next[field] = resolveArrayWrite(next[field], value, op.previousData[field])
						} else {
							// Last-write-wins on the resolved value (later HLC supersedes).
							next[field] = value
						}
						lastWriterKind[field] = atomicOp ? `atomic:${atomicOp.type}` : 'lww'
					}
					record = next
					deleted = false
				}
				break
			case 'delete':
				deleted = true
				break
		}
	}

	return deleted ? null : record
}

/** A {@link ReplayOperation} with the HLC timestamp it was written at. */
export interface VersionedReplayOperation {
	type: string
	data: Record<string, unknown> | null
	timestamp: HLCTimestamp
}

/** Per-field versions of a live record, as folded by {@link replayFieldVersionsForRecord}. */
export interface RecordFieldVersions {
	/** Field name -> HLC of the write that produced the field's current value. */
	fields: Record<string, HLCTimestamp>
	/** The record's first operation (its creation; the server's `_created_at`). */
	created: HLCTimestamp
	/** The record's newest operation. */
	latest: HLCTimestamp
}

/**
 * Fold the per-field versions of one record, mirroring {@link replayOperationsForRecord}
 * exactly (RT-27): an insert resets the field set and stamps every field it carries,
 * an update stamps the fields it writes (composed atomic and array writes included:
 * the field's version is its last writer's), a delete hides the record until a later
 * write revives it. Operations MUST be pre-sorted in HLC total order.
 *
 * @param ops - The record's operations in HLC order
 * @returns The live record's field versions, or null when it is deleted or absent
 */
export function replayFieldVersionsForRecord(
	ops: readonly VersionedReplayOperation[],
): RecordFieldVersions | null {
	let fields: Record<string, HLCTimestamp> | null = null
	let deleted = false
	const first = ops[0]
	const last = ops[ops.length - 1]
	if (!first || !last) return null
	for (const op of ops) {
		switch (op.type) {
			case 'insert':
				if (op.data) {
					fields = {}
					for (const field of Object.keys(op.data)) fields[field] = { ...op.timestamp }
					deleted = false
				}
				break
			case 'update':
				if (op.data) {
					const next: Record<string, HLCTimestamp> = { ...(fields ?? {}) }
					for (const field of Object.keys(op.data)) next[field] = { ...op.timestamp }
					fields = next
					deleted = false
				}
				break
			case 'delete':
				deleted = true
				break
		}
	}
	if (deleted || fields === null) return null
	return { fields, created: { ...first.timestamp }, latest: { ...last.timestamp } }
}

/**
 * Expand operations for a record fold (RT-27). A scope-entry insert carrying
 * per-field versions restates the record's CURRENT values, each produced at its own
 * version; folding it as one insert at a single timestamp would misplace every field
 * relative to the receiver's own writes. It is expanded into an insert at its
 * `timestamp` (the record's creation) followed by one update per newer field version,
 * so a fold in HLC order puts each field exactly where its writer did. Other
 * operations pass through unchanged. The result is sorted in HLC total order (stable,
 * so an expansion keeps insert-before-update on equal timestamps).
 *
 * @param ops - Operations of one record, in any order
 * @returns The operations to fold, in HLC order
 */
export function expandFieldVersionedOperations(ops: readonly Operation[]): Operation[] {
	const expanded: Operation[] = []
	for (const op of ops) {
		if (op.type !== 'insert' || !op.fieldVersions || !op.data) {
			expanded.push(op)
			continue
		}
		const { fieldVersions, ...base } = op
		expanded.push(base)
		const groups = new Map<string, { timestamp: HLCTimestamp; data: Record<string, unknown> }>()
		// A field without its own version falls back to the entry's newest one.
		let newest = op.timestamp
		for (const v of Object.values(fieldVersions)) {
			if (HybridLogicalClock.compare(v, newest) > 0) newest = v
		}
		for (const [field, value] of Object.entries(op.data)) {
			const version = fieldVersions[field] ?? newest
			if (HybridLogicalClock.compare(version, op.timestamp) <= 0) continue
			const key = `${version.wallTime}:${version.logical}:${version.nodeId}`
			const group = groups.get(key) ?? { timestamp: version, data: {} }
			group.data[field] = value
			groups.set(key, group)
		}
		let index = 0
		for (const group of groups.values()) {
			expanded.push({
				...base,
				id: `${op.id}#field-version-${index++}`,
				type: 'update',
				data: group.data,
				previousData: null,
				timestamp: { ...group.timestamp },
			})
		}
	}
	return expanded.sort((a, b) => HybridLogicalClock.compare(a.timestamp, b.timestamp))
}
