import { describe, expect, test } from 'vitest'
import { isAtomicOp, op, resolveAtomicOp, toAtomicOp } from './atomic-ops'

describe('op helpers', () => {
	test('op.increment creates a sentinel with correct type and value', () => {
		const sentinel = op.increment(5)
		expect(sentinel.type).toBe('increment')
		expect(sentinel.value).toBe(5)
		expect(isAtomicOp(sentinel)).toBe(true)
	})

	test('op.increment with negative value', () => {
		const sentinel = op.increment(-3)
		expect(sentinel.type).toBe('increment')
		expect(sentinel.value).toBe(-3)
	})

	test('op.decrement is sugar for increment(-n)', () => {
		const sentinel = op.decrement(5)
		expect(sentinel.type).toBe('increment')
		expect(sentinel.value).toBe(-5)
	})

	test('op.max creates a sentinel with correct type and value', () => {
		const sentinel = op.max(100)
		expect(sentinel.type).toBe('max')
		expect(sentinel.value).toBe(100)
		expect(isAtomicOp(sentinel)).toBe(true)
	})

	test('op.min creates a sentinel with correct type and value', () => {
		const sentinel = op.min(0)
		expect(sentinel.type).toBe('min')
		expect(sentinel.value).toBe(0)
		expect(isAtomicOp(sentinel)).toBe(true)
	})

	test('op.append creates a sentinel with correct type and value', () => {
		const sentinel = op.append('tag')
		expect(sentinel.type).toBe('append')
		expect(sentinel.value).toBe('tag')
		expect(isAtomicOp(sentinel)).toBe(true)
	})

	test('op.remove creates a sentinel with correct type and value', () => {
		const sentinel = op.remove('old-tag')
		expect(sentinel.type).toBe('remove')
		expect(sentinel.value).toBe('old-tag')
		expect(isAtomicOp(sentinel)).toBe(true)
	})

	test('sentinels are frozen (immutable)', () => {
		const sentinel = op.increment(5)
		expect(Object.isFrozen(sentinel)).toBe(true)
	})
})

describe('isAtomicOp', () => {
	test('returns true for sentinel objects', () => {
		expect(isAtomicOp(op.increment(1))).toBe(true)
		expect(isAtomicOp(op.max(1))).toBe(true)
		expect(isAtomicOp(op.min(1))).toBe(true)
		expect(isAtomicOp(op.append('x'))).toBe(true)
		expect(isAtomicOp(op.remove('x'))).toBe(true)
	})

	test('returns false for regular values', () => {
		expect(isAtomicOp(5)).toBe(false)
		expect(isAtomicOp('hello')).toBe(false)
		expect(isAtomicOp(null)).toBe(false)
		expect(isAtomicOp(undefined)).toBe(false)
		expect(isAtomicOp(true)).toBe(false)
		expect(isAtomicOp([])).toBe(false)
		expect(isAtomicOp({})).toBe(false)
	})

	test('returns false for objects that look similar but lack the symbol', () => {
		expect(isAtomicOp({ type: 'increment', value: 5 })).toBe(false)
	})
})

describe('resolveAtomicOp', () => {
	describe('increment', () => {
		test('adds to a number', () => {
			expect(resolveAtomicOp(10, op.increment(5))).toBe(15)
		})

		test('subtracts with negative value', () => {
			expect(resolveAtomicOp(10, op.increment(-3))).toBe(7)
		})

		test('treats non-number current as 0', () => {
			expect(resolveAtomicOp(undefined, op.increment(5))).toBe(5)
			expect(resolveAtomicOp(null, op.increment(5))).toBe(5)
			expect(resolveAtomicOp('hello', op.increment(5))).toBe(5)
		})

		test('handles zero increment', () => {
			expect(resolveAtomicOp(10, op.increment(0))).toBe(10)
		})

		test('handles floating point', () => {
			expect(resolveAtomicOp(1.5, op.increment(0.3))).toBeCloseTo(1.8)
		})
	})

	describe('max', () => {
		test('keeps current when larger', () => {
			expect(resolveAtomicOp(100, op.max(50))).toBe(100)
		})

		test('takes new when larger', () => {
			expect(resolveAtomicOp(50, op.max(100))).toBe(100)
		})

		test('handles equal values', () => {
			expect(resolveAtomicOp(50, op.max(50))).toBe(50)
		})

		test('treats non-number current as -Infinity', () => {
			expect(resolveAtomicOp(undefined, op.max(5))).toBe(5)
		})
	})

	describe('min', () => {
		test('keeps current when smaller', () => {
			expect(resolveAtomicOp(10, op.min(50))).toBe(10)
		})

		test('takes new when smaller', () => {
			expect(resolveAtomicOp(50, op.min(10))).toBe(10)
		})

		test('treats non-number current as Infinity', () => {
			expect(resolveAtomicOp(undefined, op.min(5))).toBe(5)
		})
	})

	describe('append', () => {
		test('appends to an existing array', () => {
			expect(resolveAtomicOp(['a', 'b'], op.append('c'))).toEqual(['a', 'b', 'c'])
		})

		test('creates array from non-array current', () => {
			expect(resolveAtomicOp(undefined, op.append('x'))).toEqual(['x'])
			expect(resolveAtomicOp(null, op.append('x'))).toEqual(['x'])
		})

		test('does not mutate original array', () => {
			const original = ['a', 'b']
			const result = resolveAtomicOp(original, op.append('c'))
			expect(original).toEqual(['a', 'b'])
			expect(result).toEqual(['a', 'b', 'c'])
		})
	})

	describe('remove', () => {
		test('removes matching item from array', () => {
			expect(resolveAtomicOp(['a', 'b', 'c'], op.remove('b'))).toEqual(['a', 'c'])
		})

		test('removes all matching items', () => {
			expect(resolveAtomicOp(['a', 'b', 'a'], op.remove('a'))).toEqual(['b'])
		})

		test('returns empty array when item not found', () => {
			expect(resolveAtomicOp(['a', 'b'], op.remove('x'))).toEqual(['a', 'b'])
		})

		test('handles non-array current', () => {
			expect(resolveAtomicOp(undefined, op.remove('x'))).toEqual([])
		})
	})
})

describe('toAtomicOp', () => {
	test('extracts serializable AtomicOp from sentinel', () => {
		const sentinel = op.increment(5)
		const atomicOp = toAtomicOp(sentinel)
		expect(atomicOp).toEqual({ type: 'increment', value: 5 })
	})

	test('result does not contain the symbol marker', () => {
		const atomicOp = toAtomicOp(op.max(100))
		const keys = Object.keys(atomicOp)
		expect(keys).toEqual(['type', 'value'])
		// Verify it's JSON-serializable
		expect(JSON.parse(JSON.stringify(atomicOp))).toEqual(atomicOp)
	})
})
