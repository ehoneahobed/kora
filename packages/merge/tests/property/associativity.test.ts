import { test } from '@fast-check/vitest'
import { fc } from '@fast-check/vitest'
import type { Operation } from '@korajs/core'
import { describe, expect } from 'vitest'
import { MergeEngine } from '../../src/engine/merge-engine'
import { createTestOperation } from '../fixtures/test-operations'
import { simpleCollectionDef } from '../fixtures/test-schemas'

const engine = new MergeEngine()

const baseState = {
	title: 'base',
	completed: false,
	count: 0,
	tags: [] as string[],
	priority: 'medium' as const,
}

function tensor(
	state: Record<string, unknown>,
	local: Operation,
	remote: Operation,
): Record<string, unknown> {
	const result = engine.mergeFields({
		local,
		remote,
		baseState: state,
		collectionDef: simpleCollectionDef,
	})
	return { ...state, ...result.mergedData }
}

function tagOp(nodeId: string, tags: string[], wallTime: number): Operation {
	return createTestOperation({
		id: `op-${nodeId}-${wallTime}`,
		nodeId,
		data: { tags },
		previousData: { tags: [] },
		timestamp: { wallTime, logical: 0, nodeId },
	})
}

function noopTagsOp(tags: string[]): Operation {
	return createTestOperation({
		id: 'noop',
		nodeId: 'noop',
		data: { tags },
		previousData: { tags },
		timestamp: { wallTime: 0, logical: 0, nodeId: 'noop' },
		sequenceNumber: 0,
	})
}

function tagSet(value: unknown): Set<string> {
	return new Set((value as string[]).map((v) => JSON.stringify(v)))
}

describe('merge associativity (add-wins set)', () => {
	test.prop([
		fc.array(fc.string({ minLength: 1, maxLength: 4 }), { maxLength: 4 }),
		fc.array(fc.string({ minLength: 1, maxLength: 4 }), { maxLength: 4 }),
		fc.array(fc.string({ minLength: 1, maxLength: 4 }), { maxLength: 4 }),
	])(
		'merge(merge(A,B),C) equals merge(A,merge(B,C)) for tags add-wins set',
		(tagsA, tagsB, tagsC) => {
			const opA = tagOp('node-a', tagsA, 1)
			const opB = tagOp('node-b', tagsB, 2)
			const opC = tagOp('node-c', tagsC, 3)

			const afterAB = tensor(baseState, opA, opB)
			const left = engine.mergeFields({
				local: opC,
				remote: noopTagsOp(afterAB.tags as string[]),
				baseState: afterAB,
				collectionDef: simpleCollectionDef,
			})

			const afterBC = tensor(baseState, opB, opC)
			const right = engine.mergeFields({
				local: opA,
				remote: noopTagsOp(afterBC.tags as string[]),
				baseState: afterBC,
				collectionDef: simpleCollectionDef,
			})

			const setLeft = tagSet(left.mergedData.tags)
			const setRight = tagSet(right.mergedData.tags)
			const expected = tagSet([...tagsA, ...tagsB, ...tagsC])

			expect(setLeft).toEqual(setRight)
			expect(setLeft).toEqual(expected)
		},
	)
})
