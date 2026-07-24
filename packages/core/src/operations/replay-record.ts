import type { AtomicOp } from '../types'
import { applyAtomicOp } from './atomic-ops'

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
