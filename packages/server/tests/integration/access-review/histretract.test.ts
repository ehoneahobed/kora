import { describe, expect, test } from 'vitest'
import { batch, createHarness, makeOp, tick } from '../../repro/rt-fixture'
import { FRESH, auth, items, schema } from './shared'

describe('history before joining', () => {
	test('a pre-join move-out retracts the record the re-scope entry just delivered', async () => {
		const harness = await createHarness(schema, auth, {
			experimentalAccessRules: true,
			batchSize: 1,
		})
		const ann = await harness.login('ann', 'ann-node', FRESH)
		ann.send(
			batch([
				makeOp('ann-node', 1, {
					collection: 'documents',
					recordId: 'd1',
					data: { title: 'one', ownerId: 'ann' },
				}),
				makeOp('ann-node', 2, {
					collection: 'documents',
					recordId: 'd3',
					data: { title: 'three', ownerId: 'ann' },
				}),
				makeOp('ann-node', 3, {
					collection: 'comments',
					recordId: 'c1',
					data: { documentId: 'd1', body: 'hi', authorId: 'ann' },
				}),
			]),
		)
		await tick(200)
		const r1 = await harness.server.applyLocalOperation(
			makeOp('server-1', 1, {
				type: 'update',
				collection: 'comments',
				recordId: 'c1',
				data: { documentId: 'd3' },
				previousData: { documentId: 'd1' },
			}),
		)
		const r2 = await harness.server.applyLocalOperation(
			makeOp('server-1', 2, {
				type: 'update',
				collection: 'comments',
				recordId: 'c1',
				data: { documentId: 'd1' },
				previousData: { documentId: 'd3' },
			}),
		)
		await harness.server.access.grant({ userId: 'bob', group: ['documents', 'd1'], role: 'view' })
		const bob = await harness.login('bob', 'bob-node', FRESH)
		await tick(200)
		const seq = items(bob.messages)
			.filter((i) => i.key === 'comments/c1')
			.map((i) => `${i.kind}:${i.nodeId ?? ''}`)
		// Bob may read c1 now (it is in d1); the last thing he is told about it must not be a retraction.
		expect(seq[seq.length - 1]?.startsWith('retract')).toBe(false)
	})
})
