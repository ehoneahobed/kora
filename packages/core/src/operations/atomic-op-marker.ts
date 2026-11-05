import type { AtomicOpSentinel } from './atomic-ops'

/**
 * Sentinel marker for detecting atomic op objects in update data.
 * Uses Symbol.for() so the sentinel survives module boundary crossings.
 */
export const KORA_ATOMIC_OP = Symbol.for('kora.atomic_op')

/** String key used for the sentinel symbol — exported for internal use */
export const KORA_ATOMIC_OP_KEY: typeof KORA_ATOMIC_OP = KORA_ATOMIC_OP

/**
 * Type guard: checks whether a value is an atomic op sentinel.
 *
 * @param value - Any value to check
 * @returns true if the value is an AtomicOpSentinel
 */
export function isAtomicOp(value: unknown): value is AtomicOpSentinel {
	return (
		typeof value === 'object' &&
		value !== null &&
		KORA_ATOMIC_OP in value &&
		(value as Record<symbol, unknown>)[KORA_ATOMIC_OP] === true
	)
}
