import { describe, expect, test } from 'vitest'
import { HybridLogicalClock } from '../../src/clock/hlc'
import { createOperation } from '../../src/operations/operation'
import type { Operation, VersionVector } from '../../src/types'
import {
	type OperationLog,
	advanceVector,
	computeDelta,
	createVersionVector,
	mergeVectors,
} from '../../src/version-vector/version-vector'
import { MockTimeSource } from '../fixtures/timestamps'

describe('Clock → Operations → Version Vectors → Delta integration', () => {
	test('two nodes create operations, exchange version vectors, compute delta', async () => {
		const timeA = new MockTimeSource(1000)
		const timeB = new MockTimeSource(1000)
		const clockA = new HybridLogicalClock('node-a', timeA)
		const clockB = new HybridLogicalClock('node-b', timeB)

		// Node A creates 3 operations
		const opsA: Operation[] = []
		for (let i = 1; i <= 3; i++) {
			timeA.advance(10)
			const op = await createOperation(
				{
					nodeId: 'node-a',
					type: 'insert',
					collection: 'todos',
					recordId: `rec-a-${i}`,
					data: { title: `Todo A${i}` },
					previousData: null,
					sequenceNumber: i,
					causalDeps: opsA.length > 0 ? [opsA[opsA.length - 1]?.id ?? ''] : [],
					schemaVersion: 1,
				},
				clockA,
			)
			opsA.push(op)
		}

		// Node B creates 2 operations
		const opsB: Operation[] = []
		for (let i = 1; i <= 2; i++) {
			timeB.advance(15)
			const op = await createOperation(
				{
					nodeId: 'node-b',
					type: 'insert',
					collection: 'todos',
					recordId: `rec-b-${i}`,
					data: { title: `Todo B${i}` },
					previousData: null,
					sequenceNumber: i,
					causalDeps: opsB.length > 0 ? [opsB[opsB.length - 1]?.id ?? ''] : [],
					schemaVersion: 1,
				},
				clockB,
			)
			opsB.push(op)
		}

		// Build version vectors
		let vectorA = createVersionVector()
		for (const op of opsA) {
			vectorA = advanceVector(vectorA, op.nodeId, op.sequenceNumber)
		}

		let vectorB = createVersionVector()
		for (const op of opsB) {
			vectorB = advanceVector(vectorB, op.nodeId, op.sequenceNumber)
		}

		expect(vectorA.get('node-a')).toBe(3)
		expect(vectorA.get('node-b')).toBeUndefined()
		expect(vectorB.get('node-b')).toBe(2)
		expect(vectorB.get('node-a')).toBeUndefined()

		// Create an operation log containing all operations
		const allOps = [...opsA, ...opsB]
		const log: OperationLog = {
			getRange(nodeId, fromSeq, toSeq) {
				return allOps.filter(
					(op) =>
						op.nodeId === nodeId && op.sequenceNumber >= fromSeq && op.sequenceNumber <= toSeq,
				)
			},
		}

		// Compute what A needs to send to B
		const deltaAtoB = computeDelta(vectorA, vectorB, log)
		expect(deltaAtoB).toHaveLength(3)
		expect(deltaAtoB.every((op) => op.nodeId === 'node-a')).toBe(true)

		// Compute what B needs to send to A
		const deltaBtoA = computeDelta(vectorB, vectorA, log)
		expect(deltaBtoA).toHaveLength(2)
		expect(deltaBtoA.every((op) => op.nodeId === 'node-b')).toBe(true)

		// After exchange, both should have the merged vector
		const mergedVector = mergeVectors(vectorA, vectorB)
		expect(mergedVector.get('node-a')).toBe(3)
		expect(mergedVector.get('node-b')).toBe(2)

		// Delta from merged to either should be empty
		const emptyDelta = computeDelta(mergedVector, mergedVector, log)
		expect(emptyDelta).toHaveLength(0)
	})

	test('operations are in causal order within a delta', async () => {
		const time = new MockTimeSource(1000)
		const clock = new HybridLogicalClock('node-a', time)

		const ops: Operation[] = []
		for (let i = 1; i <= 5; i++) {
			time.advance(10)
			const op = await createOperation(
				{
					nodeId: 'node-a',
					type: 'insert',
					collection: 'todos',
					recordId: `rec-${i}`,
					data: { title: `Todo ${i}` },
					previousData: null,
					sequenceNumber: i,
					causalDeps: ops.length > 0 ? [ops[ops.length - 1]?.id ?? ''] : [],
					schemaVersion: 1,
				},
				clock,
			)
			ops.push(op)
		}

		const localVector: VersionVector = new Map([['node-a', 5]])
		const remoteVector: VersionVector = new Map([['node-a', 2]])

		const log: OperationLog = {
			getRange(nodeId, fromSeq, toSeq) {
				return ops.filter(
					(op) =>
						op.nodeId === nodeId && op.sequenceNumber >= fromSeq && op.sequenceNumber <= toSeq,
				)
			},
		}

		const delta = computeDelta(localVector, remoteVector, log)
		expect(delta).toHaveLength(3)
		expect(delta[0]?.sequenceNumber).toBe(3)
		expect(delta[1]?.sequenceNumber).toBe(4)
		expect(delta[2]?.sequenceNumber).toBe(5)

		// Verify causal order: each operation's deps appear before it
		for (let i = 1; i < delta.length; i++) {
			const op = delta[i]
			if (!op) continue
			for (const depId of op.causalDeps) {
				const depIndex = delta.findIndex((d) => d.id === depId)
				if (depIndex !== -1) {
					expect(depIndex).toBeLessThan(i)
				}
			}
		}
	})

	test('HLC timestamps advance across receive() during sync', async () => {
		const timeA = new MockTimeSource(1000)
		const timeB = new MockTimeSource(2000)
		const clockA = new HybridLogicalClock('node-a', timeA)
		const clockB = new HybridLogicalClock('node-b', timeB)

		// Node B creates an operation at a later physical time
		const opB = await createOperation(
			{
				nodeId: 'node-b',
				type: 'insert',
				collection: 'todos',
				recordId: 'rec-b-1',
				data: { title: 'From B' },
				previousData: null,
				sequenceNumber: 1,
				causalDeps: [],
				schemaVersion: 1,
			},
			clockB,
		)

		// Node A receives the operation and updates its clock
		const receivedTs = clockA.receive(opB.timestamp)

		// Node A's clock should have advanced past its local physical time
		expect(receivedTs.wallTime).toBeGreaterThanOrEqual(opB.timestamp.wallTime)

		// Next local operation should have a timestamp after the received one
		const nextOpA = await createOperation(
			{
				nodeId: 'node-a',
				type: 'insert',
				collection: 'todos',
				recordId: 'rec-a-1',
				data: { title: 'From A after sync' },
				previousData: null,
				sequenceNumber: 1,
				causalDeps: [opB.id],
				schemaVersion: 1,
			},
			clockA,
		)

		expect(HybridLogicalClock.compare(nextOpA.timestamp, opB.timestamp)).toBeGreaterThan(0)
	})
})
