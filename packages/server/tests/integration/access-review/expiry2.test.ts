import { describe, expect, test } from 'vitest'
import { batch, createHarness, makeOp } from '../../repro/rt-fixture'
import { FRESH, auth, controlClock, items, pollDelivery, schema } from './shared'

describe('expiry with the delivery poll on', () => {
	test('a live session never receives the retraction of an expired, swept membership', async () => {
		// Deterministic: the clock is advanced past the expiry, and each poll is run and
		// awaited here (the timer's interval is longer than the test).
		const clock = controlClock()
		const harness = await createHarness(schema, auth, {
			deliveryPollIntervalMs: 60_000,
		})
		try {
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
			await harness.settle()
			await harness.server.access.grant({
				userId: 'bob',
				group: ['documents', 'd1'],
				role: 'view',
				expiresAt: Date.now() + 60_000,
			})
			const bob = await harness.login('bob', 'bob-node', FRESH)
			await harness.settle()
			expect(items(bob.messages).map((i) => i.key)).toContain('documents/d1')
			clock.advance(120_000)
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
			await harness.settle()
			await pollDelivery(harness.server)
			await harness.settle()
			await harness.server.access.sweepExpired()
			await harness.settle()
			await pollDelivery(harness.server)
			await harness.settle()
			const all = items(bob.messages)
			expect(all.some((i) => i.kind === 'retract' && i.key === 'documents/d1')).toBe(true)
		} finally {
			clock.restore()
			await harness.server.stop?.()
		}
	})
})
