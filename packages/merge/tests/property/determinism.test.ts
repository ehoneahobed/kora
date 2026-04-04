import { test } from '@fast-check/vitest'
import { fc } from '@fast-check/vitest'
import { HybridLogicalClock } from '@kora/core'
import type { Operation } from '@kora/core'
import { describe, expect } from 'vitest'
import { MergeEngine } from '../../src/engine/merge-engine'
import {
	createTestOperation,
	hlcTimestampArb,
	stringFieldValueArb,
} from '../fixtures/test-operations'
import { simpleCollectionDef } from '../fixtures/test-schemas'

const engine = new MergeEngine()

describe('merge determinism', () => {
	test.prop([
		fc.record({
			localValue: stringFieldValueArb,
			remoteValue: stringFieldValueArb,
			baseValue: stringFieldValueArb,
			localTs: hlcTimestampArb,
			remoteTs: hlcTimestampArb,
		}),
	])(
		'two operations merged in either order produce the same title',
		({ localValue, remoteValue, baseValue, localTs, remoteTs }) => {
			const local = createTestOperation({
				id: 'op-a',
				nodeId: 'node-a',
				data: { title: localValue },
				previousData: { title: baseValue },
				timestamp: { ...localTs, nodeId: 'node-a' },
			})
			const remote = createTestOperation({
				id: 'op-b',
				nodeId: 'node-b',
				data: { title: remoteValue },
				previousData: { title: baseValue },
				timestamp: { ...remoteTs, nodeId: 'node-b' },
			})

			const baseState = {
				title: baseValue,
				completed: false,
				count: 0,
				tags: [],
				priority: 'medium',
			}

			const ab = engine.mergeFields({
				local,
				remote,
				baseState,
				collectionDef: simpleCollectionDef,
			})

			const ba = engine.mergeFields({
				local: remote,
				remote: local,
				baseState,
				collectionDef: simpleCollectionDef,
			})

			expect(ab.mergedData.title).toEqual(ba.mergedData.title)
		},
	)

	test.prop([
		fc.record({
			values: fc.array(stringFieldValueArb, { minLength: 3, maxLength: 5 }),
			timestamps: fc.array(hlcTimestampArb, { minLength: 3, maxLength: 5 }),
			baseValue: stringFieldValueArb,
		}),
	])(
		'LWW always picks the value from the operation with the latest HLC timestamp',
		({ values, timestamps, baseValue }) => {
			const count = Math.min(values.length, timestamps.length)
			if (count < 2) return

			const ops: Operation[] = []
			for (let i = 0; i < count; i++) {
				const ts = timestamps[i]
				const val = values[i]
				if (ts === undefined || val === undefined) continue
				ops.push(
					createTestOperation({
						id: `op-${i}`,
						nodeId: `node-${i}`,
						data: { title: val },
						previousData: { title: baseValue },
						timestamp: { ...ts, nodeId: `node-${i}` },
					}),
				)
			}

			if (ops.length < 2) return

			// Find the operation with the latest HLC timestamp
			let latestOp = ops[0]
			if (latestOp === undefined) return
			for (let i = 1; i < ops.length; i++) {
				const op = ops[i]
				if (op === undefined) continue
				if (HybridLogicalClock.compare(op.timestamp, latestOp.timestamp) > 0) {
					latestOp = op
				}
			}
			const expectedTitle = latestOp.data?.title

			// Verify that every pairwise merge involving the latest-timestamp op
			// produces that op's value
			for (const op of ops) {
				if (op === latestOp) continue
				const result = engine.mergeFields({
					local: op,
					remote: latestOp,
					baseState: { title: baseValue, completed: false, count: 0, tags: [], priority: 'medium' },
					collectionDef: simpleCollectionDef,
				})
				expect(result.mergedData.title).toEqual(expectedTitle)

				// Also verify commutativity
				const reversed = engine.mergeFields({
					local: latestOp,
					remote: op,
					baseState: { title: baseValue, completed: false, count: 0, tags: [], priority: 'medium' },
					collectionDef: simpleCollectionDef,
				})
				expect(reversed.mergedData.title).toEqual(expectedTitle)
			}
		},
	)

	test.prop([
		fc.record({
			localValue: fc.integer({ min: -1000, max: 1000 }),
			remoteValue: fc.integer({ min: -1000, max: 1000 }),
			baseValue: fc.integer({ min: -1000, max: 1000 }),
			localTs: hlcTimestampArb,
			remoteTs: hlcTimestampArb,
		}),
	])(
		'custom resolver (additive merge) is deterministic regardless of order',
		({ localValue, remoteValue, baseValue, localTs, remoteTs }) => {
			const collDef = {
				...simpleCollectionDef,
				resolvers: {
					count: (l: unknown, r: unknown, b: unknown): unknown => {
						return Math.max(
							0,
							(b as number) + ((l as number) - (b as number)) + ((r as number) - (b as number)),
						)
					},
				},
			}

			const local = createTestOperation({
				id: 'op-a',
				nodeId: 'node-a',
				data: { count: localValue },
				previousData: { count: baseValue },
				timestamp: { ...localTs, nodeId: 'node-a' },
			})
			const remote = createTestOperation({
				id: 'op-b',
				nodeId: 'node-b',
				data: { count: remoteValue },
				previousData: { count: baseValue },
				timestamp: { ...remoteTs, nodeId: 'node-b' },
			})

			const baseState = {
				title: 'base',
				completed: false,
				count: baseValue,
				tags: [],
				priority: 'medium',
			}

			const ab = engine.mergeFields({ local, remote, baseState, collectionDef: collDef })
			const ba = engine.mergeFields({
				local: remote,
				remote: local,
				baseState,
				collectionDef: collDef,
			})

			expect(ab.mergedData.count).toEqual(ba.mergedData.count)
		},
	)
})
