import type { AtomicOpType, Operation } from '@korajs/core'
import { applyAtomicOp } from '@korajs/core'
import { canonicalize } from '@korajs/core/internal'

/** Rejection code for an operation whose atomic intents are malformed or disagree with its data. */
export const INVALID_ATOMIC_OP_CODE = 'INVALID_ATOMIC_OP'

const NUMERIC_TYPES: ReadonlySet<string> = new Set<AtomicOpType>(['increment', 'max', 'min'])
const ELEMENT_TYPES: ReadonlySet<string> = new Set<AtomicOpType>(['append', 'remove'])

/**
 * Why an operation's atomic intents (`atomicOps`) are not ones the server stores, or
 * null when they are (or it has none).
 *
 * - Every intent has a known type and an operand of that type: a finite number for
 *   `increment`, `max` and `min`; any JSON value for `append` and `remove`.
 * - A delete carries none.
 * - The field is written (`data[field]` is set): the fold ignores an intent whose field
 *   the operation does not write, so it must not be judged as if it did.
 * - The written value agrees with the intent, exactly as every Kora writer produces it
 *   (the client's update path and `kora.apply`): on an update,
 *   `data[field] = intent(previousData[field])`; on an insert,
 *   `data[field] = intent(unset)`. The fold stores `data[field]` whenever the field's
 *   chain does not compose (always for a new record), and access rules are judged on
 *   it, so an intent that claims one value while the data stores another is refused.
 *
 * @param op - The operation as the server schema reads it
 */
export function atomicOpsViolation(op: Operation): string | null {
	const intents: unknown = op.atomicOps
	if (intents === undefined) return null
	if (intents === null || typeof intents !== 'object' || Array.isArray(intents)) {
		return `Operation "${op.id}" has atomicOps that are not an object of field intents.`
	}
	const entries = Object.entries(intents as Record<string, unknown>)
	if (entries.length === 0) return null
	if (op.type === 'delete') {
		return `Operation "${op.id}" is a delete with atomic intents; a delete writes no field.`
	}
	const data = op.data
	for (const [field, raw] of entries) {
		if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
			return `Operation "${op.id}" has an atomic intent for "${field}" that is not { type, value }.`
		}
		const intent = raw as { type?: unknown; value?: unknown }
		const type = intent.type
		if (typeof type !== 'string' || !(NUMERIC_TYPES.has(type) || ELEMENT_TYPES.has(type))) {
			return `Operation "${op.id}" has an atomic intent of unknown type "${String(type)}" for "${field}". Known types: increment, max, min, append, remove.`
		}
		if (NUMERIC_TYPES.has(type)) {
			if (typeof intent.value !== 'number' || !Number.isFinite(intent.value)) {
				return `Operation "${op.id}" has a "${type}" intent for "${field}" whose operand is not a finite number.`
			}
		} else if (intent.value === undefined) {
			return `Operation "${op.id}" has a "${type}" intent for "${field}" without an operand.`
		}
		if (data === null || data === undefined || data[field] === undefined) {
			return `Operation "${op.id}" has an atomic intent for "${field}" but does not write the field.`
		}
		const base = op.type === 'insert' ? undefined : op.previousData?.[field]
		const expected = applyAtomicOp(base, { type: type as AtomicOpType, value: intent.value })
		if (!sameCanonical(expected, data[field])) {
			return `Operation "${op.id}" writes "${field}" with a value that is not its "${type}" intent applied to ${op.type === 'insert' ? 'an unset field' : 'its previousData'}; the data and the intent must agree.`
		}
	}
	return null
}

function sameCanonical(a: unknown, b: unknown): boolean {
	try {
		return canonicalize(a) === canonicalize(b)
	} catch {
		// A value with no canonical form cannot be shown to agree: refused (fail closed).
		return false
	}
}
