import { test } from '@fast-check/vitest'
import { describe, expect } from 'vitest'
import { MergeEngine } from '../../src/engine/merge-engine'
import {
	concurrentUpdatePairArb,
	numberFieldValueArb,
	stringFieldValueArb,
} from '../fixtures/test-operations'
import { simpleCollectionDef } from '../fixtures/test-schemas'

const engine = new MergeEngine()

describe('merge idempotency', () => {
	test.prop([concurrentUpdatePairArb('title', stringFieldValueArb)])(
		'merging an operation with itself produces its own value',
		({ local, baseValue }) => {
			const baseState = {
				title: baseValue,
				completed: false,
				count: 0,
				tags: [],
				priority: 'medium',
			}

			// Merge local with itself
			const result = engine.mergeFields({
				local,
				remote: local,
				baseState,
				collectionDef: simpleCollectionDef,
			})

			// When both sides are the same op, the result should be that op's value
			const localData = local.data ?? {}
			if ('title' in localData) {
				expect(result.mergedData.title).toEqual(localData.title)
			}
		},
	)

	test.prop([concurrentUpdatePairArb('count', numberFieldValueArb)])(
		'merging a number field with itself is idempotent',
		({ local, baseValue }) => {
			const baseState = {
				title: 'base',
				completed: false,
				count: baseValue,
				tags: [],
				priority: 'medium',
			}

			const result = engine.mergeFields({
				local,
				remote: local,
				baseState,
				collectionDef: simpleCollectionDef,
			})

			const localData = local.data ?? {}
			if ('count' in localData) {
				expect(result.mergedData.count).toEqual(localData.count)
			}
		},
	)

	test.prop([concurrentUpdatePairArb('title', stringFieldValueArb)])(
		'applying the merge result twice yields the same result',
		({ local, remote, baseValue }) => {
			const baseState = {
				title: baseValue,
				completed: false,
				count: 0,
				tags: [],
				priority: 'medium',
			}

			// First merge
			const first = engine.mergeFields({
				local,
				remote,
				baseState,
				collectionDef: simpleCollectionDef,
			})

			// Merge again with the same inputs (simulating reapplication)
			const second = engine.mergeFields({
				local,
				remote,
				baseState,
				collectionDef: simpleCollectionDef,
			})

			expect(first.mergedData.title).toEqual(second.mergedData.title)
		},
	)
})
