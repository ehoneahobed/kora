import type { AtomicOp } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { type ReplayOperation, replayOperationsForRecord } from './materialization'

/**
 * Unit tests for the atomic-op composition in materialization replay. These are the
 * fast, deterministic core-algorithm tests; the network-level cross-check that the
 * result equals client convergence lives in @korajs/test.
 *
 * Operations are passed already in HLC total order, as the store's rebuild queries
 * provide them.
 */

const inc = (n: number): AtomicOp => ({ type: 'increment', value: n })
const max = (n: number): AtomicOp => ({ type: 'max', value: n })
const min = (n: number): AtomicOp => ({ type: 'min', value: n })
const append = (v: unknown): AtomicOp => ({ type: 'append', value: v })
const remove = (v: unknown): AtomicOp => ({ type: 'remove', value: v })

describe('replayOperationsForRecord — atomic composition', () => {
	test('a chain of increments sums onto the inserted base', () => {
		const ops: ReplayOperation[] = [
			{ type: 'insert', data: { count: 10 } },
			{ type: 'update', data: { count: 15 }, atomicOps: { count: inc(5) } },
			{ type: 'update', data: { count: 18 }, atomicOps: { count: inc(3) } },
			{ type: 'update', data: { count: 20 }, atomicOps: { count: inc(2) } },
		]
		expect(replayOperationsForRecord(ops)?.count).toBe(20)
	})

	test('the first atomic write after a plain insert seeds the chain by LWW', () => {
		// insert sets base=0 (lww); first increment LWWs its resolved value (7);
		// the second increment composes its delta → 7 + 3 = 10.
		const ops: ReplayOperation[] = [
			{ type: 'insert', data: { count: 0 } },
			{ type: 'update', data: { count: 7 }, atomicOps: { count: inc(7) } },
			{ type: 'update', data: { count: 10 }, atomicOps: { count: inc(3) } },
		]
		expect(replayOperationsForRecord(ops)?.count).toBe(10)
	})

	test('increment composition is order-independent (sum is commutative)', () => {
		const BASE = 100
		const base: ReplayOperation = { type: 'insert', data: { count: BASE } }
		const deltas = [5, -3, 8, 1]
		// Each concurrent increment read BASE, so its resolved value is BASE + delta —
		// exactly what an op carries in the real system. The fold's first-in-chain op
		// takes that resolved value by LWW, then the rest compose their deltas.
		const asOps = (order: number[]): ReplayOperation[] => [
			base,
			...order.map((d) => ({
				type: 'update',
				data: { count: BASE + d },
				atomicOps: { count: inc(d) },
			})),
		]
		// Any permutation of the concurrent increments yields BASE + sum(deltas) = 111.
		const perms: number[][] = [
			[5, -3, 8, 1],
			[1, 8, -3, 5],
			[8, 5, 1, -3],
		]
		for (const perm of perms) {
			expect(replayOperationsForRecord(asOps(perm))?.count).toBe(111)
		}
	})

	test('a plain set supersedes earlier increments, later increments compose onto it', () => {
		const ops: ReplayOperation[] = [
			{ type: 'insert', data: { count: 0 } },
			{ type: 'update', data: { count: 5 }, atomicOps: { count: inc(5) } },
			{ type: 'update', data: { count: 100 } }, // plain set, no atomicOps
			{ type: 'update', data: { count: 107 }, atomicOps: { count: inc(7) } },
		]
		expect(replayOperationsForRecord(ops)?.count).toBe(107)
	})

	test('a plain set after a chain resets the running value (no fold onto stale delta)', () => {
		const ops: ReplayOperation[] = [
			{ type: 'insert', data: { count: 0 } },
			{ type: 'update', data: { count: 5 }, atomicOps: { count: inc(5) } },
			{ type: 'update', data: { count: 3 }, atomicOps: { count: inc(-2) } },
			{ type: 'update', data: { count: 42 } }, // set wins by LWW
		]
		expect(replayOperationsForRecord(ops)?.count).toBe(42)
	})

	test('max composes to the maximum operand across the chain', () => {
		const ops: ReplayOperation[] = [
			{ type: 'insert', data: { high: 0 } },
			{ type: 'update', data: { high: 50 }, atomicOps: { high: max(50) } },
			{ type: 'update', data: { high: 90 }, atomicOps: { high: max(90) } },
			{ type: 'update', data: { high: 90 }, atomicOps: { high: max(70) } },
		]
		expect(replayOperationsForRecord(ops)?.high).toBe(90)
	})

	test('min composes to the minimum operand across the chain', () => {
		const ops: ReplayOperation[] = [
			{ type: 'insert', data: { low: 1000 } },
			{ type: 'update', data: { low: 40 }, atomicOps: { low: min(40) } },
			{ type: 'update', data: { low: 40 }, atomicOps: { low: min(75) } },
			{ type: 'update', data: { low: 12 }, atomicOps: { low: min(12) } },
		]
		expect(replayOperationsForRecord(ops)?.low).toBe(12)
	})

	test('appends accumulate every item; removes drop them', () => {
		const appended: ReplayOperation[] = [
			{ type: 'insert', data: { tags: [] } },
			{ type: 'update', data: { tags: ['a'] }, atomicOps: { tags: append('a') } },
			{ type: 'update', data: { tags: ['a', 'b'] }, atomicOps: { tags: append('b') } },
			{ type: 'update', data: { tags: ['a', 'b', 'c'] }, atomicOps: { tags: append('c') } },
		]
		expect(replayOperationsForRecord(appended)?.tags).toEqual(['a', 'b', 'c'])

		// A remove is a different atomic type than append, so it breaks the append chain
		// and resolves by last-write-wins on its resolved value (['a','c'], what the
		// writer computed against ['a','b','c']).
		const removed: ReplayOperation[] = [
			...appended,
			{ type: 'update', data: { tags: ['a', 'c'] }, atomicOps: { tags: remove('b') } },
		]
		expect(replayOperationsForRecord(removed)?.tags).toEqual(['a', 'c'])
	})

	test('a different atomic type breaks the chain and resolves by LWW', () => {
		// increment then max on the same field are different intents; the max does not
		// compose onto the increment result, it wins by LWW on its resolved value.
		const ops: ReplayOperation[] = [
			{ type: 'insert', data: { n: 0 } },
			{ type: 'update', data: { n: 5 }, atomicOps: { n: inc(5) } },
			{ type: 'update', data: { n: 3 }, atomicOps: { n: max(3) } },
		]
		expect(replayOperationsForRecord(ops)?.n).toBe(3)
	})

	test('backward compatible: operations without atomicOps materialize by pure LWW', () => {
		const ops: ReplayOperation[] = [
			{ type: 'insert', data: { title: 'a', count: 1 } },
			{ type: 'update', data: { count: 2 } },
			{ type: 'update', data: { title: 'b' } },
		]
		expect(replayOperationsForRecord(ops)).toEqual({ title: 'b', count: 2 })
	})

	test('atomic composition survives independent fields in the same operations', () => {
		const ops: ReplayOperation[] = [
			{ type: 'insert', data: { count: 0, label: 'x' } },
			{ type: 'update', data: { count: 5, label: 'y' }, atomicOps: { count: inc(5) } },
			{ type: 'update', data: { count: 8 }, atomicOps: { count: inc(3) } },
		]
		// count composes to 8; label resolves by LWW to 'y'.
		expect(replayOperationsForRecord(ops)).toEqual({ count: 8, label: 'y' })
	})

	test('delete tombstones the record even after an atomic chain', () => {
		const ops: ReplayOperation[] = [
			{ type: 'insert', data: { count: 0 } },
			{ type: 'update', data: { count: 5 }, atomicOps: { count: inc(5) } },
			{ type: 'delete', data: null },
		]
		expect(replayOperationsForRecord(ops)).toBeNull()
	})
})
