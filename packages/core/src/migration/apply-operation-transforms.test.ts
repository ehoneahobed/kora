import { describe, expect, test } from 'vitest'
import type { Operation } from '../types'
import { applyOperationTransforms } from './apply-operation-transforms'
import type { OperationTransform } from './operation-transform'

function makeOp(schemaVersion: number, title: string): Operation {
	return {
		id: `op-${schemaVersion}-${title}`,
		nodeId: 'n1',
		type: 'insert',
		collection: 'todos',
		recordId: 'r1',
		data: { title },
		previousData: null,
		timestamp: { wallTime: 1000, logical: 0, nodeId: 'n1' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion,
	}
}

describe('applyOperationTransforms', () => {
	test('passes through when already at target version', () => {
		const op = makeOp(2, 'hello')
		const result = applyOperationTransforms(op, 2, [])
		expect(result).toEqual(op)
	})

	test('applies v1 to v2 transform', () => {
		const transforms: OperationTransform[] = [
			{
				fromVersion: 1,
				toVersion: 2,
				transform(operation) {
					if (operation.data?.title === 'drop') {
						return null
					}
					return { ...operation, schemaVersion: 2, data: { ...operation.data, priority: 'medium' } }
				},
			},
		]

		const op = makeOp(1, 'hello')
		const result = applyOperationTransforms(op, 2, transforms)
		expect(result?.schemaVersion).toBe(2)
		expect(result?.data).toMatchObject({ title: 'hello', priority: 'medium' })
	})

	test('returns null when transform drops operation', () => {
		const transforms: OperationTransform[] = [
			{
				fromVersion: 1,
				toVersion: 2,
				transform: () => null,
			},
		]
		expect(applyOperationTransforms(makeOp(1, 'x'), 2, transforms)).toBeNull()
	})
})
