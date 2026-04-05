import type { CollectionDefinition, Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { MergeEngine } from '../engine/merge-engine'
import { lastWriteWins } from '../strategies/lww'

const REGRESSION_FACTOR = 1.1
const MERGE_1K_LIMIT_MS = 500 * REGRESSION_FACTOR
const LWW_AVG_LIMIT_NS = 1_000 * REGRESSION_FACTOR

function createCollectionDef(): CollectionDefinition {
	return {
		fields: {
			title: {
				kind: 'string',
				required: true,
				defaultValue: '',
				auto: false,
				enumValues: null,
				itemKind: null,
			},
			completed: {
				kind: 'boolean',
				required: true,
				defaultValue: false,
				auto: false,
				enumValues: null,
				itemKind: null,
			},
			count: {
				kind: 'number',
				required: true,
				defaultValue: 0,
				auto: false,
				enumValues: null,
				itemKind: null,
			},
		},
		indexes: [],
		constraints: [],
		resolvers: {},
	}
}

function createOp(nodeId: string, wallTime: number, data: Record<string, unknown>): Operation {
	return {
		id: `${nodeId}-${wallTime}`,
		nodeId,
		type: 'update',
		collection: 'todos',
		recordId: 'record-1',
		data,
		previousData: { title: 'base', completed: false, count: 0 },
		timestamp: { wallTime, logical: 0, nodeId },
		sequenceNumber: wallTime,
		causalDeps: [],
		schemaVersion: 1,
	}
}

describe('Merge performance gates', () => {
	test('merge 1,000 concurrent operations under target', async () => {
		const engine = new MergeEngine()
		const collectionDef = createCollectionDef()

		const localOps = Array.from({ length: 1000 }, (_, index) =>
			createOp('node-a', index + 1000, { title: `local-${index}`, completed: index % 2 === 0 }),
		)
		const remoteOps = Array.from({ length: 1000 }, (_, index) =>
			createOp('node-b', index + 500, { title: `remote-${index}`, count: index }),
		)

		const startNs = process.hrtime.bigint()
		for (let index = 0; index < 1000; index++) {
			const local = localOps[index]
			const remote = remoteOps[index]
			if (!local || !remote) {
				throw new Error('Expected operation pair to exist')
			}

			await engine.merge({
				local,
				remote,
				baseState: { title: 'base', completed: false, count: 0 },
				collectionDef,
			})
		}
		const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1_000_000

		expect(elapsedMs).toBeLessThan(MERGE_1K_LIMIT_MS)
	}, 20_000)

	test('LWW comparison average latency under 1 microsecond', () => {
		const iterations = 1_000_000
		const localTimestamp = { wallTime: 2_000, logical: 0, nodeId: 'node-a' }
		const remoteTimestamp = { wallTime: 1_000, logical: 0, nodeId: 'node-b' }

		const startNs = process.hrtime.bigint()
		for (let index = 0; index < iterations; index++) {
			lastWriteWins(index, index + 1, localTimestamp, remoteTimestamp)
		}
		const elapsedNs = Number(process.hrtime.bigint() - startNs)
		const averageNs = elapsedNs / iterations

		expect(averageNs).toBeLessThan(LWW_AVG_LIMIT_NS)
	})
})
