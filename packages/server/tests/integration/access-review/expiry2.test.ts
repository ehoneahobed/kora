import { describe, expect, test } from 'vitest'
import { batch, createHarness, makeOp, tick } from '../../repro/rt-fixture'
import { FRESH, auth, items, schema } from './shared'

describe('expiry with the delivery poll on', () => {
	test('a live session never receives the retraction of an expired, swept membership', async () => {
		const harness = await createHarness(schema, auth, {
			experimentalAccessRules: true,
			deliveryPollIntervalMs: 50,
		})
		const ann = await harness.login('ann', 'ann-node', FRESH)
		ann.send(
			batch([
				makeOp('ann-node', 1, {
					collection: 'documents',
					recordId: 'd1',
					data: { title: 'v1', ownerId: 'ann' },
				}),
			]),
		)
		ann.send(
			batch([
				makeOp('ann-node', 2, {
					collection: 'documents',
					recordId: 'd2',
					data: { title: 'other', ownerId: 'ann' },
				}),
			]),
		)
		await tick(150)
		await harness.server.access.grant({
			userId: 'bob',
			group: ['documents', 'd1'],
			role: 'view',
			expiresAt: Date.now() + 400,
		})
		const bob = await harness.login('bob', 'bob-node', FRESH)
		await tick(100)
		expect(items(bob.messages).map((i) => i.key)).toContain('documents/d1')
		await tick(500)
		// any unrelated write: the poll refreshes bob's grant (d1 expired)
		ann.send(
			batch([
				makeOp('ann-node', 3, {
					type: 'update',
					collection: 'documents',
					recordId: 'd2',
					data: { title: 'x' },
					previousData: { title: 'other' },
				}),
			]),
		)
		await tick(300)
		await harness.server.access.sweepExpired()
		await tick(400)
		const all = items(bob.messages)
		expect(all.some((i) => i.kind === 'retract' && i.key === 'documents/d1')).toBe(true)
		await harness.server.stop?.()
	})
})
