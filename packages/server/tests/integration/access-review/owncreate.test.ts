import { describe, expect, test } from 'vitest'
import { batch, createHarness, makeOp, tick } from '../../repro/rt-fixture'
import { FRESH, auth, items, schema } from './shared'

for (const poll of [0, 50]) {
	describe(`own group creation, poll=${poll}`, () => {
		test('a comment another member writes on a document bob just created reaches bob', async () => {
			const harness = await createHarness(schema, auth, {
				experimentalAccessRules: true,
				deliveryPollIntervalMs: poll,
			})
			const bob = await harness.login('bob', 'bob-node', FRESH)
			const ann = await harness.login('ann', 'ann-node', FRESH)
			bob.send(
				batch([
					makeOp('bob-node', 1, {
						collection: 'documents',
						recordId: 'd9',
						data: { title: 'bobs', ownerId: 'bob' },
					}),
				]),
			)
			await tick(200)
			await harness.server.access.grant({ userId: 'ann', group: ['documents', 'd9'], role: 'view' })
			await tick(100)
			ann.send(
				batch([
					makeOp('ann-node', 1, {
						collection: 'comments',
						recordId: 'c9',
						data: { documentId: 'd9', body: 'from ann', authorId: 'ann' },
					}),
				]),
			)
			await tick(400)
			// a later unrelated write, to give any refresh a chance
			ann.send(
				batch([
					makeOp('ann-node', 2, {
						collection: 'comments',
						recordId: 'c10',
						data: { documentId: 'd9', body: 'second', authorId: 'ann' },
					}),
				]),
			)
			await tick(400)
			const keys = items(bob.messages).map((i) => `${i.kind}:${i.key}:${i.nodeId}`)
			expect(keys.filter((k) => k.includes('comments/c9'))).not.toEqual([])
			await harness.server.stop?.()
		})
	})
}
