import type { AtomicOp } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { mergeAtomicOps } from './atomic-merge'

describe('mergeAtomicOps', () => {
	describe('increment + increment', () => {
		test('composes by summing deltas on base', () => {
			const local: AtomicOp = { type: 'increment', value: 3 }
			const remote: AtomicOp = { type: 'increment', value: 5 }
			const result = mergeAtomicOps(local, remote, 10)
			expect(result.merged).toBe(true)
			if (result.merged) {
				expect(result.value).toBe(18) // 10 + 3 + 5
				expect(result.strategy).toBe('atomic-increment')
			}
		})

		test('handles negative increments (decrements)', () => {
			const local: AtomicOp = { type: 'increment', value: -2 }
			const remote: AtomicOp = { type: 'increment', value: -3 }
			const result = mergeAtomicOps(local, remote, 100)
			expect(result.merged).toBe(true)
			if (result.merged) {
				expect(result.value).toBe(95) // 100 + (-2) + (-3)
			}
		})

		test('handles mixed positive and negative', () => {
			const local: AtomicOp = { type: 'increment', value: 10 }
			const remote: AtomicOp = { type: 'increment', value: -3 }
			const result = mergeAtomicOps(local, remote, 50)
			expect(result.merged).toBe(true)
			if (result.merged) {
				expect(result.value).toBe(57) // 50 + 10 + (-3)
			}
		})

		test('treats non-number base as 0', () => {
			const local: AtomicOp = { type: 'increment', value: 3 }
			const remote: AtomicOp = { type: 'increment', value: 5 }
			const result = mergeAtomicOps(local, remote, undefined)
			expect(result.merged).toBe(true)
			if (result.merged) {
				expect(result.value).toBe(8)
			}
		})

		test('is commutative', () => {
			const a: AtomicOp = { type: 'increment', value: 3 }
			const b: AtomicOp = { type: 'increment', value: 5 }
			const resultAB = mergeAtomicOps(a, b, 10)
			const resultBA = mergeAtomicOps(b, a, 10)
			expect(resultAB).toEqual(resultBA)
		})
	})

	describe('max + max', () => {
		test('takes the maximum of base, local, and remote', () => {
			const local: AtomicOp = { type: 'max', value: 50 }
			const remote: AtomicOp = { type: 'max', value: 80 }
			const result = mergeAtomicOps(local, remote, 60)
			expect(result.merged).toBe(true)
			if (result.merged) {
				expect(result.value).toBe(80)
				expect(result.strategy).toBe('atomic-max')
			}
		})

		test('base wins when largest', () => {
			const local: AtomicOp = { type: 'max', value: 50 }
			const remote: AtomicOp = { type: 'max', value: 30 }
			const result = mergeAtomicOps(local, remote, 100)
			expect(result.merged).toBe(true)
			if (result.merged) {
				expect(result.value).toBe(100)
			}
		})

		test('is commutative', () => {
			const a: AtomicOp = { type: 'max', value: 50 }
			const b: AtomicOp = { type: 'max', value: 80 }
			const resultAB = mergeAtomicOps(a, b, 60)
			const resultBA = mergeAtomicOps(b, a, 60)
			expect(resultAB).toEqual(resultBA)
		})
	})

	describe('min + min', () => {
		test('takes the minimum of base, local, and remote', () => {
			const local: AtomicOp = { type: 'min', value: 50 }
			const remote: AtomicOp = { type: 'min', value: 30 }
			const result = mergeAtomicOps(local, remote, 60)
			expect(result.merged).toBe(true)
			if (result.merged) {
				expect(result.value).toBe(30)
				expect(result.strategy).toBe('atomic-min')
			}
		})

		test('base wins when smallest', () => {
			const local: AtomicOp = { type: 'min', value: 50 }
			const remote: AtomicOp = { type: 'min', value: 80 }
			const result = mergeAtomicOps(local, remote, 10)
			expect(result.merged).toBe(true)
			if (result.merged) {
				expect(result.value).toBe(10)
			}
		})

		test('is commutative', () => {
			const a: AtomicOp = { type: 'min', value: 50 }
			const b: AtomicOp = { type: 'min', value: 30 }
			const resultAB = mergeAtomicOps(a, b, 60)
			const resultBA = mergeAtomicOps(b, a, 60)
			expect(resultAB).toEqual(resultBA)
		})
	})

	describe('append + append', () => {
		test('includes both appended items', () => {
			const local: AtomicOp = { type: 'append', value: 'x' }
			const remote: AtomicOp = { type: 'append', value: 'y' }
			const result = mergeAtomicOps(local, remote, ['a', 'b'])
			expect(result.merged).toBe(true)
			if (result.merged) {
				expect(result.value).toEqual(['a', 'b', 'x', 'y'])
				expect(result.strategy).toBe('atomic-append')
			}
		})

		test('handles non-array base', () => {
			const local: AtomicOp = { type: 'append', value: 'x' }
			const remote: AtomicOp = { type: 'append', value: 'y' }
			const result = mergeAtomicOps(local, remote, undefined)
			expect(result.merged).toBe(true)
			if (result.merged) {
				expect(result.value).toEqual(['x', 'y'])
			}
		})
	})

	describe('remove + remove', () => {
		test('removes both items from base', () => {
			const local: AtomicOp = { type: 'remove', value: 'a' }
			const remote: AtomicOp = { type: 'remove', value: 'b' }
			const result = mergeAtomicOps(local, remote, ['a', 'b', 'c'])
			expect(result.merged).toBe(true)
			if (result.merged) {
				expect(result.value).toEqual(['c'])
				expect(result.strategy).toBe('atomic-remove')
			}
		})

		test('handles removing the same item (idempotent)', () => {
			const local: AtomicOp = { type: 'remove', value: 'a' }
			const remote: AtomicOp = { type: 'remove', value: 'a' }
			const result = mergeAtomicOps(local, remote, ['a', 'b'])
			expect(result.merged).toBe(true)
			if (result.merged) {
				expect(result.value).toEqual(['b'])
			}
		})
	})

	describe('mismatched types', () => {
		test('returns fallback for increment + max', () => {
			const local: AtomicOp = { type: 'increment', value: 5 }
			const remote: AtomicOp = { type: 'max', value: 50 }
			const result = mergeAtomicOps(local, remote, 10)
			expect(result.merged).toBe(false)
		})

		test('returns fallback for append + remove', () => {
			const local: AtomicOp = { type: 'append', value: 'x' }
			const remote: AtomicOp = { type: 'remove', value: 'y' }
			const result = mergeAtomicOps(local, remote, ['a'])
			expect(result.merged).toBe(false)
		})
	})
})
