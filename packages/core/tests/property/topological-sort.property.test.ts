import { fc, test } from '@fast-check/vitest'
import { describe, expect } from 'vitest'
import type { HLCTimestamp, Operation } from '../../src/types'
import { topologicalSort } from '../../src/version-vector/topological-sort'

function makeOp(id: string, deps: string[], timestamp: HLCTimestamp): Operation {
	return {
		id,
		nodeId: 'node-1',
		type: 'insert',
		collection: 'todos',
		recordId: `rec-${id}`,
		data: { title: id },
		previousData: null,
		timestamp,
		sequenceNumber: 1,
		causalDeps: deps,
		schemaVersion: 1,
	}
}

/**
 * Build a random DAG of up to `size` operations with edges only to earlier indices.
 */
function dagArb(size: number) {
	return fc
		.array(fc.nat({ max: Math.max(0, size - 1) }), { minLength: size, maxLength: size })
		.map((depIndices) => {
			const ids = Array.from({ length: size }, (_, i) => `op-${i}`)
			const ops: Operation[] = []
			for (let i = 0; i < size; i++) {
				const deps: string[] = []
				const depSlot = depIndices[i]
				if (depSlot !== undefined && depSlot < i) {
					deps.push(ids[depSlot] as string)
				}
				// Unique wallTime per op so tie-breaking is fully deterministic.
				ops.push(
					makeOp(ids[i] as string, deps, {
						wallTime: 1000 + i,
						logical: 0,
						nodeId: 'node-1',
					}),
				)
			}
			return ops
		})
}

describe('topologicalSort property-based tests', () => {
	test.prop([fc.integer({ min: 1, max: 40 })], { numRuns: 100 })(
		'result respects causal dependencies for random DAGs',
		(size) => {
			const ops = fc.sample(dagArb(size), 1)[0]
			if (!ops || ops.length === 0) {
				return
			}

			const sorted = topologicalSort(ops)
			expect(sorted).toHaveLength(ops.length)

			const position = new Map(sorted.map((op, index) => [op.id, index]))
			for (const op of ops) {
				const opIndex = position.get(op.id)
				expect(opIndex).toBeDefined()
				for (const depId of op.causalDeps) {
					if (!ops.some((candidate) => candidate.id === depId)) {
						continue
					}
					const depIndex = position.get(depId)
					expect(depIndex).toBeDefined()
					expect(depIndex as number).toBeLessThan(opIndex as number)
				}
			}
		},
	)

	test.prop([fc.integer({ min: 2, max: 20 })], { numRuns: 50 })(
		'order is deterministic for the same DAG',
		(size) => {
			const ops = fc.sample(dagArb(size), 1)[0]
			if (!ops) {
				return
			}
			const a = topologicalSort(ops).map((op) => op.id)
			const b = topologicalSort([...ops].reverse()).map((op) => op.id)
			expect(a).toEqual(b)
		},
	)
})
