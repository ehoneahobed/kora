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

function tagSet(value: unknown): Set<string> {
	return new Set((value as string[]).map((v) => JSON.stringify(v)))
}

// All three ops are concurrent edits of the same ancestor, so every merge,
// including the second-level one, is three-way against that common ancestor.
// (This test used to pass the first merge's RESULT as the base of the second,
// which encodes the third op as removing everything the others added. The old
// rule hid that because it never applied one-sided removals; MERGE-1.)
function mergedTagsOp(tags: string[], previous: string[]): Operation {
	return createTestOperation({
		id: 'merged',
		nodeId: 'merged',
		data: { tags },
		previousData: { tags: previous },
		timestamp: { wallTime: 0, logical: 0, nodeId: 'merged' },
		sequenceNumber: 0,
	})
}

function tagOpFrom(
	nodeId: string,
	tags: string[],
	previous: string[],
	wallTime: number,
): Operation {
	return createTestOperation({
		id: `op-${nodeId}-${wallTime}`,
		nodeId,
		data: { tags },
		previousData: { tags: previous },
		timestamp: { wallTime, logical: 0, nodeId },
	})
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
				remote: mergedTagsOp(afterAB.tags as string[], baseState.tags),
				baseState,
				collectionDef: simpleCollectionDef,
			})

			const afterBC = tensor(baseState, opB, opC)
			const right = engine.mergeFields({
				local: opA,
				remote: mergedTagsOp(afterBC.tags as string[], baseState.tags),
				baseState,
				collectionDef: simpleCollectionDef,
			})

			const setLeft = tagSet(left.mergedData.tags)
			const setRight = tagSet(right.mergedData.tags)
			const expected = tagSet([...tagsA, ...tagsB, ...tagsC])

			expect(setLeft).toEqual(setRight)
			expect(setLeft).toEqual(expected)
		},
	)

	const subset = fc.subarray(['a', 'b', 'c', 'd', 'e', 'f'])

	test.prop([subset, subset, subset, subset])(
		'is associative with removals against a non-empty common ancestor',
		(base, tagsA, tagsB, tagsC) => {
			const state = { ...baseState, tags: base }
			const opA = tagOpFrom('node-a', tagsA, base, 1)
			const opB = tagOpFrom('node-b', tagsB, base, 2)
			const opC = tagOpFrom('node-c', tagsC, base, 3)

			const afterAB = tensor(state, opA, opB)
			const left = engine.mergeFields({
				local: opC,
				remote: mergedTagsOp(afterAB.tags as string[], base),
				baseState: state,
				collectionDef: simpleCollectionDef,
			})
			const afterBC = tensor(state, opB, opC)
			const right = engine.mergeFields({
				local: opA,
				remote: mergedTagsOp(afterBC.tags as string[], base),
				baseState: state,
				collectionDef: simpleCollectionDef,
			})

			expect(left.mergedData.tags).toEqual(right.mergedData.tags)
			// A base element survives only if every side kept it; an added one if any side added it.
			const all = [tagsA, tagsB, tagsC]
			const expected = new Set(
				[...new Set(all.flat())].filter(
					(x) => !base.includes(x) || all.every((tags) => tags.includes(x)),
				),
			)
			expect(new Set(left.mergedData.tags as string[])).toEqual(expected)
		},
	)
})
