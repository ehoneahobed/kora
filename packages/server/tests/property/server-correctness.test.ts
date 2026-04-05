import { test } from '@fast-check/vitest'
import { fc } from '@fast-check/vitest'
import { describe, expect } from 'vitest'
import type { Operation } from '@korajs/core'
import { MemoryServerStore } from '../../src/store/memory-server-store'

// --- Arbitraries ---

const operationArb = fc
	.record({
		seqNum: fc.integer({ min: 1, max: 1000 }),
		nodeIndex: fc.integer({ min: 0, max: 9 }),
		collection: fc.constantFrom('todos', 'projects', 'users'),
	})
	.map(({ seqNum, nodeIndex, collection }) => {
		const nodeId = `node-${nodeIndex}`
		return {
			id: `${nodeId}-${collection}-${seqNum}`,
			nodeId,
			type: 'insert' as const,
			collection,
			recordId: `rec-${nodeId}-${seqNum}`,
			data: { title: `Item ${seqNum}` },
			previousData: null,
			timestamp: { wallTime: 1000 + seqNum, logical: 0, nodeId },
			sequenceNumber: seqNum,
			causalDeps: [],
			schemaVersion: 1,
		} satisfies Operation
	})

const operationsArb = fc.array(operationArb, { minLength: 1, maxLength: 50 })

describe('Property-based server correctness', () => {
	test.prop([operationArb])('dedup idempotency: applying same op multiple times equals once', async (op) => {
		const store = new MemoryServerStore('server-1')

		const result1 = await store.applyRemoteOperation(op)
		expect(result1).toBe('applied')

		const result2 = await store.applyRemoteOperation(op)
		expect(result2).toBe('duplicate')

		const result3 = await store.applyRemoteOperation(op)
		expect(result3).toBe('duplicate')

		expect(await store.getOperationCount()).toBe(1)
	})

	test.prop([operationsArb])('version vector never regresses', async (ops) => {
		const store = new MemoryServerStore('server-1')
		let previousVector = new Map<string, number>()

		for (const op of ops) {
			await store.applyRemoteOperation(op)
			const currentVector = store.getVersionVector()

			// For every node in previous vector, current must be >= previous
			for (const [nodeId, prevSeq] of previousVector) {
				const currSeq = currentVector.get(nodeId) ?? 0
				expect(currSeq).toBeGreaterThanOrEqual(prevSeq)
			}

			previousVector = currentVector
		}
	})

	test.prop([operationsArb])('every applied op retrievable via getOperationRange', async (ops) => {
		const store = new MemoryServerStore('server-1')

		// Apply all ops
		for (const op of ops) {
			await store.applyRemoteOperation(op)
		}

		// For each node in version vector, all ops should be retrievable
		const vv = store.getVersionVector()
		for (const [nodeId, maxSeq] of vv) {
			const range = await store.getOperationRange(nodeId, 1, maxSeq)

			// Every unique op for this node should be in the range
			const uniqueOps = new Map<string, Operation>()
			for (const op of ops) {
				if (op.nodeId === nodeId && !uniqueOps.has(op.id)) {
					uniqueOps.set(op.id, op)
				}
			}

			// Filter unique ops that are within the sequence range
			const expectedInRange = [...uniqueOps.values()].filter(
				(op) => op.sequenceNumber >= 1 && op.sequenceNumber <= maxSeq,
			)

			// Range should cover all unique ops in [1, maxSeq]
			for (const expected of expectedInRange) {
				const found = range.find((r) => r.id === expected.id)
				expect(found).toBeDefined()
			}
		}
	})

	test.prop([operationsArb])('operation count matches unique operations', async (ops) => {
		const store = new MemoryServerStore('server-1')
		const uniqueIds = new Set<string>()

		for (const op of ops) {
			await store.applyRemoteOperation(op)
			uniqueIds.add(op.id)
		}

		expect(await store.getOperationCount()).toBe(uniqueIds.size)
	})
})
