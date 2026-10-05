/**
 * Atomic field operations for intent-preserving updates.
 *
 * Instead of read-modify-write patterns, developers express intent:
 * ```typescript
 * await app.stock.update(id, { quantity: op.increment(-5) })
 * ```
 *
 * The operation intent is preserved in the Operation for merge:
 * concurrent increments compose (sum of deltas) instead of LWW.
 */

import type { AtomicOp, AtomicOpType } from '../types'

// Re-export for convenience
export type { AtomicOp, AtomicOpType }

/**
 * Sentinel marker for detecting atomic op objects in update data.
 * Uses Symbol.for() so the sentinel survives module boundary crossings.
 */
const KORA_ATOMIC_OP = Symbol.for('kora.atomic_op')

/** String key used for the sentinel symbol — exported for internal use */
export const KORA_ATOMIC_OP_KEY: typeof KORA_ATOMIC_OP = KORA_ATOMIC_OP

/**
 * Sentinel object returned by op.* helpers.
 * Detected by Collection.update() and resolved to concrete values.
 *
 * The type parameters carry the helper's operation and operand type (RT-113), so an
 * update input accepts numeric helpers only on number and timestamp fields and array
 * helpers, with the element type, only on array fields. The bare `AtomicOpSentinel` is
 * any sentinel.
 */
export interface AtomicOpSentinel<Type extends AtomicOpType = AtomicOpType, Value = unknown> {
	readonly [KORA_ATOMIC_OP_KEY]: true
	readonly type: Type
	readonly value: Value
}

/** The numeric helpers (`op.increment`, `op.decrement`, `op.max`, `op.min`). */
export type NumericAtomicOpSentinel = AtomicOpSentinel<'increment' | 'max' | 'min', number>

/** The array helpers (`op.append`, `op.remove`) for an array of `Item`. */
export type ArrayAtomicOpSentinel<Item> = AtomicOpSentinel<'append' | 'remove', Item>

/**
 * Constraint of an array helper's item: listing the primitive types keeps a literal
 * argument's literal type (`op.append('high')` is `'high'`, assignable to an enum array),
 * while objects are inferred as written (not readonly).
 */
type AtomicItem = string | number | boolean | bigint | symbol | object | null | undefined

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

/**
 * Apply a plain atomic op (`{ type, value }`) to a current value, producing the
 * concrete result. This is the single source of truth for atomic-op semantics:
 * {@link resolveAtomicOp} (sentinel form, used on the write path) delegates here,
 * and the server's materialization replays stored atomic ops through it, so the
 * server's materialized view composes concurrent atomic writes identically to the
 * client. Folding this over a field's writes in HLC order yields, for a same-type
 * atomic chain, exactly the composed intent (sum of increments, max of maxes, ...).
 *
 * @param currentValue - The current value of the field
 * @param atomicOp - The atomic op to apply (type + operand)
 * @returns The resulting concrete value
 */
export function applyAtomicOp(currentValue: unknown, atomicOp: AtomicOp): unknown {
	switch (atomicOp.type) {
		case 'increment': {
			const current = typeof currentValue === 'number' ? currentValue : 0
			const operand = atomicOp.value as number
			return current + operand
		}
		case 'max': {
			const current = typeof currentValue === 'number' ? currentValue : Number.NEGATIVE_INFINITY
			return Math.max(current, atomicOp.value as number)
		}
		case 'min': {
			const current = typeof currentValue === 'number' ? currentValue : Number.POSITIVE_INFINITY
			return Math.min(current, atomicOp.value as number)
		}
		case 'append': {
			const current = Array.isArray(currentValue) ? [...currentValue] : []
			current.push(atomicOp.value)
			return current
		}
		case 'remove': {
			if (!Array.isArray(currentValue)) return []
			// Compare by value (JSON), matching add-wins-set semantics, so removing an
			// object or array element works instead of silently no-op'ing under the
			// reference inequality that `!==` would give for non-primitives.
			const target = JSON.stringify(atomicOp.value)
			return currentValue.filter((item) => JSON.stringify(item) !== target)
		}
	}
}

/**
 * Resolve an atomic op sentinel against a current value to produce a concrete result.
 *
 * @param currentValue - The current value of the field in the database
 * @param sentinel - The atomic op sentinel from the developer's update call
 * @returns The resolved concrete value
 */
export function resolveAtomicOp(currentValue: unknown, sentinel: AtomicOpSentinel): unknown {
	return applyAtomicOp(currentValue, { type: sentinel.type, value: sentinel.value })
}

function createSentinel<Type extends AtomicOpType, Value>(
	type: Type,
	value: Value,
): AtomicOpSentinel<Type, Value> {
	return Object.freeze({
		[KORA_ATOMIC_OP]: true as const,
		type,
		value,
	})
}

/**
 * Atomic operation helpers. Use these in collection.update() calls
 * to express intent-preserving mutations.
 *
 * @example
 * ```typescript
 * import { op } from 'korajs'
 *
 * // Increment a counter (works correctly with concurrent updates)
 * await app.stock.update(id, { quantity: op.increment(-5) })
 *
 * // Keep the maximum value
 * await app.scores.update(id, { highScore: op.max(newScore) })
 *
 * // Append to an array
 * await app.todos.update(id, { tags: op.append('urgent') })
 * ```
 */
export const op = {
	/**
	 * Increment a number field by the given amount.
	 * Concurrent increments compose: the sum of all deltas is applied to the base.
	 *
	 * @param n - The amount to increment (use negative values to decrement)
	 */
	increment(n: number): AtomicOpSentinel<'increment', number> {
		return createSentinel('increment', n)
	},

	/**
	 * Decrement a number field by the given amount.
	 * Syntactic sugar for `op.increment(-n)`.
	 *
	 * @param n - The amount to decrement
	 */
	decrement(n: number): AtomicOpSentinel<'increment', number> {
		return createSentinel('increment', -n)
	},

	/**
	 * Set the field to the maximum of the current value and the given value.
	 * Concurrent max operations take the maximum of all values.
	 *
	 * @param n - The value to compare against the current value
	 */
	max(n: number): AtomicOpSentinel<'max', number> {
		return createSentinel('max', n)
	},

	/**
	 * Set the field to the minimum of the current value and the given value.
	 * Concurrent min operations take the minimum of all values.
	 *
	 * @param n - The value to compare against the current value
	 */
	min(n: number): AtomicOpSentinel<'min', number> {
		return createSentinel('min', n)
	},

	/**
	 * Append an item to an array field.
	 * Concurrent appends include all appended items.
	 *
	 * @param item - The item to append to the array
	 */
	append<Item extends AtomicItem>(item: Item): AtomicOpSentinel<'append', Item> {
		return createSentinel('append', item)
	},

	/**
	 * Remove an item from an array field (by value equality).
	 * Concurrent removes of the same item are idempotent.
	 *
	 * @param item - The item to remove from the array
	 */
	remove<Item extends AtomicItem>(item: Item): AtomicOpSentinel<'remove', Item> {
		return createSentinel('remove', item)
	},
}

/**
 * Extract the serializable AtomicOp from a sentinel (strips the Symbol marker).
 *
 * @param sentinel - The atomic op sentinel
 * @returns A plain object suitable for JSON serialization
 */
export function toAtomicOp(sentinel: AtomicOpSentinel): AtomicOp {
	return { type: sentinel.type, value: sentinel.value }
}
