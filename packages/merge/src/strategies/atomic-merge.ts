import type { AtomicOp } from '@korajs/core'

/**
 * Result of merging two atomic operations on the same field.
 * If `merged` is false, the caller should fall back to LWW on the resolved values.
 */
export interface AtomicMergeResult {
	merged: true
	value: unknown
	strategy: string
}

/**
 * Sentinel returned when atomic ops cannot be composed (e.g., mismatched types).
 */
export interface AtomicMergeFallback {
	merged: false
}

/**
 * Compose two concurrent atomic operations on the same field.
 *
 * When both operations expressed an atomic intent (e.g., both used op.increment()),
 * their intents can be composed to produce a correct merged result without LWW:
 *
 * - increment + increment → sum of both deltas applied to base
 * - max + max → max of all values (base, local, remote)
 * - min + min → min of all values (base, local, remote)
 * - append + append → base array with both appended items
 * - remove + remove → base array with both items removed
 *
 * Falls back (returns { merged: false }) when atomic op types differ,
 * since there is no meaningful composition for mixed intents.
 *
 * @param localAtomicOp - The atomic op from the local operation
 * @param remoteAtomicOp - The atomic op from the remote operation
 * @param baseValue - The field value before either operation was applied
 * @returns The composed result, or a fallback signal to use LWW
 */
export function mergeAtomicOps(
	localAtomicOp: AtomicOp,
	remoteAtomicOp: AtomicOp,
	baseValue: unknown,
): AtomicMergeResult | AtomicMergeFallback {
	// Both must be the same type to compose
	if (localAtomicOp.type !== remoteAtomicOp.type) {
		return { merged: false }
	}

	switch (localAtomicOp.type) {
		case 'increment': {
			// Sum of both deltas applied to base
			const base = typeof baseValue === 'number' ? baseValue : 0
			const localDelta = localAtomicOp.value as number
			const remoteDelta = remoteAtomicOp.value as number
			return {
				merged: true,
				value: base + localDelta + remoteDelta,
				strategy: 'atomic-increment',
			}
		}

		case 'max': {
			// Take the maximum of base, local operand, and remote operand
			const base = typeof baseValue === 'number' ? baseValue : Number.NEGATIVE_INFINITY
			const localVal = localAtomicOp.value as number
			const remoteVal = remoteAtomicOp.value as number
			return {
				merged: true,
				value: Math.max(base, localVal, remoteVal),
				strategy: 'atomic-max',
			}
		}

		case 'min': {
			// Take the minimum of base, local operand, and remote operand
			const base = typeof baseValue === 'number' ? baseValue : Number.POSITIVE_INFINITY
			const localVal = localAtomicOp.value as number
			const remoteVal = remoteAtomicOp.value as number
			return {
				merged: true,
				value: Math.min(base, localVal, remoteVal),
				strategy: 'atomic-min',
			}
		}

		case 'append': {
			// Include both appended items
			const base = Array.isArray(baseValue) ? [...baseValue] : []
			base.push(localAtomicOp.value)
			base.push(remoteAtomicOp.value)
			return {
				merged: true,
				value: base,
				strategy: 'atomic-append',
			}
		}

		case 'remove': {
			// Remove both items from the base
			const base = Array.isArray(baseValue) ? [...baseValue] : []
			const localItem = localAtomicOp.value
			const remoteItem = remoteAtomicOp.value
			const result = base.filter((item) => item !== localItem && item !== remoteItem)
			return {
				merged: true,
				value: result,
				strategy: 'atomic-remove',
			}
		}

		default:
			return { merged: false }
	}
}
