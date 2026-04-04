import { describe, expect, test } from 'vitest'
import { OperationError } from '../errors/errors'
import type { HLCTimestamp, Operation } from '../types'
import { topologicalSort } from './topological-sort'

function makeOp(
	id: string,
	deps: string[] = [],
	timestamp?: Partial<HLCTimestamp>,
): Operation {
	return {
		id,
		nodeId: 'node-1',
		type: 'insert',
		collection: 'todos',
		recordId: `rec-${id}`,
		data: { title: id },
		previousData: null,
		timestamp: {
			wallTime: 1000,
			logical: 0,
			nodeId: 'node-1',
			...timestamp,
		},
		sequenceNumber: 1,
		causalDeps: deps,
		schemaVersion: 1,
	}
}

describe('topologicalSort', () => {
	test('returns empty array for empty input', () => {
		expect(topologicalSort([])).toEqual([])
	})

	test('returns single operation unchanged', () => {
		const op = makeOp('a')
		const result = topologicalSort([op])
		expect(result).toHaveLength(1)
		expect(result[0]?.id).toBe('a')
	})

	test('sorts a linear dependency chain', () => {
		const ops = [
			makeOp('c', ['b'], { wallTime: 1002 }),
			makeOp('a', [], { wallTime: 1000 }),
			makeOp('b', ['a'], { wallTime: 1001 }),
		]

		const sorted = topologicalSort(ops)
		expect(sorted.map((op) => op.id)).toEqual(['a', 'b', 'c'])
	})

	test('handles diamond dependency pattern', () => {
		//   a
		//  / \
		// b   c
		//  \ /
		//   d
		const ops = [
			makeOp('d', ['b', 'c'], { wallTime: 1003 }),
			makeOp('b', ['a'], { wallTime: 1001, logical: 0, nodeId: 'b' }),
			makeOp('c', ['a'], { wallTime: 1001, logical: 0, nodeId: 'c' }),
			makeOp('a', [], { wallTime: 1000 }),
		]

		const sorted = topologicalSort(ops)
		const ids = sorted.map((op) => op.id)

		// a must come before b and c
		expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('b'))
		expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('c'))

		// b and c must come before d
		expect(ids.indexOf('b')).toBeLessThan(ids.indexOf('d'))
		expect(ids.indexOf('c')).toBeLessThan(ids.indexOf('d'))
	})

	test('uses HLC timestamp for tie-breaking (deterministic)', () => {
		// Three independent operations — no deps between them
		const ops = [
			makeOp('c', [], { wallTime: 1002 }),
			makeOp('a', [], { wallTime: 1000 }),
			makeOp('b', [], { wallTime: 1001 }),
		]

		const sorted = topologicalSort(ops)
		expect(sorted.map((op) => op.id)).toEqual(['a', 'b', 'c'])
	})

	test('ignores causal deps that are outside the operation set', () => {
		// op-b depends on op-a, but op-a is not in the set
		const ops = [
			makeOp('c', ['b'], { wallTime: 1002 }),
			makeOp('b', ['a'], { wallTime: 1001 }),
		]

		const sorted = topologicalSort(ops)
		expect(sorted.map((op) => op.id)).toEqual(['b', 'c'])
	})

	test('throws OperationError on cycle', () => {
		const ops = [
			makeOp('a', ['b']),
			makeOp('b', ['a']),
		]

		expect(() => topologicalSort(ops)).toThrow(OperationError)
	})

	test('produces a consistent order across multiple runs', () => {
		const ops = [
			makeOp('e', ['c', 'd'], { wallTime: 1004 }),
			makeOp('d', ['b'], { wallTime: 1003 }),
			makeOp('c', ['a'], { wallTime: 1002 }),
			makeOp('b', ['a'], { wallTime: 1001 }),
			makeOp('a', [], { wallTime: 1000 }),
		]

		const result1 = topologicalSort(ops).map((op) => op.id)
		const result2 = topologicalSort([...ops].reverse()).map((op) => op.id)

		expect(result1).toEqual(result2)
	})
})
