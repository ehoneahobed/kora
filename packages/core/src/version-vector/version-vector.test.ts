import { describe, expect, test } from 'vitest'
import type { Operation, VersionVector } from '../types'
import {
	type OperationLog,
	advanceVector,
	computeDelta,
	createVersionVector,
	deserializeVector,
	dominates,
	mergeVectors,
	serializeVector,
	vectorsEqual,
} from './version-vector'

function makeOp(overrides: Partial<Operation>): Operation {
	return {
		id: 'op-1',
		nodeId: 'node-1',
		type: 'insert',
		collection: 'todos',
		recordId: 'rec-1',
		data: { title: 'test' },
		previousData: null,
		timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-1' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
		...overrides,
	}
}

describe('createVersionVector', () => {
	test('creates an empty vector', () => {
		const vv = createVersionVector()
		expect(vv.size).toBe(0)
	})
})

describe('mergeVectors', () => {
	test('merges two vectors taking max values', () => {
		const a: VersionVector = new Map([
			['node-1', 5],
			['node-2', 3],
		])
		const b: VersionVector = new Map([
			['node-1', 3],
			['node-2', 7],
			['node-3', 1],
		])

		const merged = mergeVectors(a, b)
		expect(merged.get('node-1')).toBe(5)
		expect(merged.get('node-2')).toBe(7)
		expect(merged.get('node-3')).toBe(1)
	})

	test('is commutative', () => {
		const a: VersionVector = new Map([['n1', 5]])
		const b: VersionVector = new Map([
			['n1', 3],
			['n2', 7],
		])

		const ab = mergeVectors(a, b)
		const ba = mergeVectors(b, a)

		expect([...ab.entries()].sort()).toEqual([...ba.entries()].sort())
	})

	test('is idempotent', () => {
		const a: VersionVector = new Map([
			['n1', 5],
			['n2', 3],
		])
		const result = mergeVectors(a, a)
		expect(vectorsEqual(result, a)).toBe(true)
	})

	test('handles empty vectors', () => {
		const a: VersionVector = new Map([['n1', 5]])
		const empty = createVersionVector()

		expect(vectorsEqual(mergeVectors(a, empty), a)).toBe(true)
		expect(vectorsEqual(mergeVectors(empty, a), a)).toBe(true)
	})
})

describe('advanceVector', () => {
	test('advances a node to a new sequence number', () => {
		const vv = new Map([['n1', 3]]) as VersionVector
		const advanced = advanceVector(vv, 'n1', 5)
		expect(advanced.get('n1')).toBe(5)
	})

	test('does not go backward', () => {
		const vv = new Map([['n1', 5]]) as VersionVector
		const advanced = advanceVector(vv, 'n1', 3)
		expect(advanced.get('n1')).toBe(5)
	})

	test('adds new nodes', () => {
		const vv = createVersionVector()
		const advanced = advanceVector(vv, 'n1', 1)
		expect(advanced.get('n1')).toBe(1)
	})

	test('does not mutate the original', () => {
		const vv = new Map([['n1', 3]]) as VersionVector
		advanceVector(vv, 'n1', 5)
		expect(vv.get('n1')).toBe(3)
	})
})

describe('dominates', () => {
	test('empty vector dominates empty vector', () => {
		expect(dominates(createVersionVector(), createVersionVector())).toBe(true)
	})

	test('non-empty dominates empty', () => {
		const a: VersionVector = new Map([['n1', 1]])
		expect(dominates(a, createVersionVector())).toBe(true)
	})

	test('detects domination', () => {
		const a: VersionVector = new Map([
			['n1', 5],
			['n2', 3],
		])
		const b: VersionVector = new Map([
			['n1', 3],
			['n2', 2],
		])
		expect(dominates(a, b)).toBe(true)
		expect(dominates(b, a)).toBe(false)
	})

	test('concurrent vectors do not dominate each other', () => {
		const a: VersionVector = new Map([
			['n1', 5],
			['n2', 1],
		])
		const b: VersionVector = new Map([
			['n1', 3],
			['n2', 7],
		])
		expect(dominates(a, b)).toBe(false)
		expect(dominates(b, a)).toBe(false)
	})
})

describe('vectorsEqual', () => {
	test('empty vectors are equal', () => {
		expect(vectorsEqual(createVersionVector(), createVersionVector())).toBe(true)
	})

	test('identical vectors are equal', () => {
		const a: VersionVector = new Map([['n1', 5]])
		const b: VersionVector = new Map([['n1', 5]])
		expect(vectorsEqual(a, b)).toBe(true)
	})

	test('different vectors are not equal', () => {
		const a: VersionVector = new Map([['n1', 5]])
		const b: VersionVector = new Map([['n1', 3]])
		expect(vectorsEqual(a, b)).toBe(false)
	})

	test('vectors with different keys are not equal', () => {
		const a: VersionVector = new Map([['n1', 5]])
		const b: VersionVector = new Map([
			['n1', 5],
			['n2', 1],
		])
		expect(vectorsEqual(a, b)).toBe(false)
	})
})

describe('computeDelta', () => {
	test('returns operations the remote does not have', () => {
		const localVector: VersionVector = new Map([['n1', 3]])
		const remoteVector: VersionVector = new Map([['n1', 1]])

		const ops = [
			makeOp({ id: 'op-1', nodeId: 'n1', sequenceNumber: 1, causalDeps: [] }),
			makeOp({ id: 'op-2', nodeId: 'n1', sequenceNumber: 2, causalDeps: ['op-1'] }),
			makeOp({ id: 'op-3', nodeId: 'n1', sequenceNumber: 3, causalDeps: ['op-2'] }),
		]

		const log: OperationLog = {
			getRange(nodeId, fromSeq, toSeq) {
				return ops.filter(
					(op) =>
						op.nodeId === nodeId && op.sequenceNumber >= fromSeq && op.sequenceNumber <= toSeq,
				)
			},
		}

		const delta = computeDelta(localVector, remoteVector, log)
		expect(delta).toHaveLength(2)
		expect(delta[0]?.id).toBe('op-2')
		expect(delta[1]?.id).toBe('op-3')
	})

	test('returns empty array when vectors are equal', () => {
		const vector: VersionVector = new Map([['n1', 3]])
		const log: OperationLog = { getRange: () => [] }

		const delta = computeDelta(vector, vector, log)
		expect(delta).toHaveLength(0)
	})

	test('returns operations from multiple nodes', () => {
		const localVector: VersionVector = new Map([
			['n1', 2],
			['n2', 1],
		])
		const remoteVector: VersionVector = new Map([['n1', 1]])

		const ops = [
			makeOp({
				id: 'op-n1-2',
				nodeId: 'n1',
				sequenceNumber: 2,
				causalDeps: [],
				timestamp: { wallTime: 1000, logical: 0, nodeId: 'n1' },
			}),
			makeOp({
				id: 'op-n2-1',
				nodeId: 'n2',
				sequenceNumber: 1,
				causalDeps: [],
				timestamp: { wallTime: 1001, logical: 0, nodeId: 'n2' },
			}),
		]

		const log: OperationLog = {
			getRange(nodeId, fromSeq, toSeq) {
				return ops.filter(
					(op) =>
						op.nodeId === nodeId && op.sequenceNumber >= fromSeq && op.sequenceNumber <= toSeq,
				)
			},
		}

		const delta = computeDelta(localVector, remoteVector, log)
		expect(delta).toHaveLength(2)
	})
})

describe('serialize/deserialize vector', () => {
	test('round-trips correctly', () => {
		const vv: VersionVector = new Map([
			['n1', 5],
			['n2', 3],
			['n3', 1],
		])
		const serialized = serializeVector(vv)
		const deserialized = deserializeVector(serialized)
		expect(vectorsEqual(deserialized, vv)).toBe(true)
	})

	test('serialization is deterministic (sorted keys)', () => {
		const a: VersionVector = new Map([
			['n2', 3],
			['n1', 5],
		])
		const b: VersionVector = new Map([
			['n1', 5],
			['n2', 3],
		])
		expect(serializeVector(a)).toBe(serializeVector(b))
	})

	test('handles empty vector', () => {
		const vv = createVersionVector()
		const roundTripped = deserializeVector(serializeVector(vv))
		expect(roundTripped.size).toBe(0)
	})
})
