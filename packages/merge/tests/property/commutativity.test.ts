import { test } from '@fast-check/vitest'
import { fc } from '@fast-check/vitest'
import type { CollectionDefinition } from '@kora/core'
import { describe, expect } from 'vitest'
import { MergeEngine } from '../../src/engine/merge-engine'
import {
	concurrentUpdatePairArb,
	numberFieldValueArb,
	stringFieldValueArb,
} from '../fixtures/test-operations'
import { simpleCollectionDef } from '../fixtures/test-schemas'

const engine = new MergeEngine()

describe('merge commutativity: merge(A, B) === merge(B, A)', () => {
	test.prop([concurrentUpdatePairArb('title', stringFieldValueArb)])(
		'string field LWW is commutative',
		({ local, remote, baseValue }) => {
			const baseState = {
				title: baseValue,
				completed: false,
				count: 0,
				tags: [],
				priority: 'medium',
			}

			const resultAB = engine.mergeFields({
				local,
				remote,
				baseState,
				collectionDef: simpleCollectionDef,
			})

			// Swap local/remote
			const resultBA = engine.mergeFields({
				local: remote,
				remote: local,
				baseState,
				collectionDef: simpleCollectionDef,
			})

			expect(resultAB.mergedData.title).toEqual(resultBA.mergedData.title)
		},
	)

	test.prop([concurrentUpdatePairArb('count', numberFieldValueArb)])(
		'number field LWW is commutative',
		({ local, remote, baseValue }) => {
			const baseState = {
				title: 'base',
				completed: false,
				count: baseValue,
				tags: [],
				priority: 'medium',
			}

			const resultAB = engine.mergeFields({
				local,
				remote,
				baseState,
				collectionDef: simpleCollectionDef,
			})

			const resultBA = engine.mergeFields({
				local: remote,
				remote: local,
				baseState,
				collectionDef: simpleCollectionDef,
			})

			expect(resultAB.mergedData.count).toEqual(resultBA.mergedData.count)
		},
	)

	test.prop([concurrentUpdatePairArb('completed', fc.boolean())])(
		'boolean field LWW is commutative',
		({ local, remote, baseValue }) => {
			const baseState = {
				title: 'base',
				completed: baseValue,
				count: 0,
				tags: [],
				priority: 'medium',
			}

			const resultAB = engine.mergeFields({
				local,
				remote,
				baseState,
				collectionDef: simpleCollectionDef,
			})

			const resultBA = engine.mergeFields({
				local: remote,
				remote: local,
				baseState,
				collectionDef: simpleCollectionDef,
			})

			expect(resultAB.mergedData.completed).toEqual(resultBA.mergedData.completed)
		},
	)

	test.prop([
		concurrentUpdatePairArb(
			'tags',
			fc.array(fc.string({ minLength: 1, maxLength: 10 }), { minLength: 0, maxLength: 5 }),
		),
	])('array field add-wins-set is commutative', ({ local, remote, baseValue }) => {
		const baseState = {
			title: 'base',
			completed: false,
			count: 0,
			tags: baseValue,
			priority: 'medium',
		}

		const resultAB = engine.mergeFields({
			local,
			remote,
			baseState,
			collectionDef: simpleCollectionDef,
		})

		const resultBA = engine.mergeFields({
			local: remote,
			remote: local,
			baseState,
			collectionDef: simpleCollectionDef,
		})

		// Arrays may have different ordering due to local-first/remote-first insertion,
		// but the sets should be identical
		const setAB = new Set((resultAB.mergedData.tags as unknown[]).map((v) => JSON.stringify(v)))
		const setBA = new Set((resultBA.mergedData.tags as unknown[]).map((v) => JSON.stringify(v)))
		expect(setAB).toEqual(setBA)
	})

	test.prop([concurrentUpdatePairArb('priority', fc.constantFrom('low', 'medium', 'high'))])(
		'enum field LWW is commutative',
		({ local, remote, baseValue }) => {
			const baseState = { title: 'base', completed: false, count: 0, tags: [], priority: baseValue }

			const resultAB = engine.mergeFields({
				local,
				remote,
				baseState,
				collectionDef: simpleCollectionDef,
			})

			const resultBA = engine.mergeFields({
				local: remote,
				remote: local,
				baseState,
				collectionDef: simpleCollectionDef,
			})

			expect(resultAB.mergedData.priority).toEqual(resultBA.mergedData.priority)
		},
	)
})
