import { describe, expect, test } from 'vitest'
import { batch, createHarness, makeOp, tick } from '../../repro/rt-fixture'
import { FRESH, auth, autoAck, items, schema } from './shared'

describe('own group creation, acking client', () => {
	test('a comment landing before the next poll is lost for good', async () => {
		const harness = await createHarness(schema, auth, {
			experimentalAccessRules: true,
			deliveryPollIntervalMs: 0,
		})
		const bob = await harness.login('bob', 'bob-node', FRESH)
		autoAck(bob)
		const ann = await harness.login('ann', 'ann-node', FRESH)
		autoAck(ann)
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
		ann.send(
			batch([
				makeOp('ann-node', 1, {
					collection: 'comments',
					recordId: 'c9',
					data: { documentId: 'd9', body: 'from ann', authorId: 'ann' },
				}),
			]),
		)
		await tick(300)
		for (let i = 0; i < 3; i++) {
			await harness.server.pollDeliveryLog()
			await tick(150)
		}
		ann.send(
			batch([
				makeOp('ann-node', 2, {
					collection: 'comments',
					recordId: 'c10',
					data: { documentId: 'd9', body: 'second', authorId: 'ann' },
				}),
			]),
		)
		await tick(300)
		for (let i = 0; i < 3; i++) {
			await harness.server.pollDeliveryLog()
			await tick(150)
		}
		const keys = items(bob.messages).map((i) => `${i.kind}:${i.key}:${i.nodeId}`)
		expect(keys.some((k) => k.includes('comments/c9'))).toBe(true)
	})
})
