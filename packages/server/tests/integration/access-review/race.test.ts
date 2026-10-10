import { describe, expect, test } from 'vitest'
import { batch, createHarness, createReproStore, makeOp, tick } from '../../repro/rt-fixture'
import { FRESH, auth, autoAck, items, schema } from './shared'

describe('poll refresh racing a re-scope unit', () => {
	test('a grant refreshed by the poll while a unit is computed is never sent', async () => {
		const store = await createReproStore()
		const harness = await createHarness(
			schema,
			auth,
			{ experimentalAccessRules: true, deliveryPollIntervalMs: 0, batchSize: 1 },
			store,
		)
		const ann = await harness.login('ann', 'ann-node', FRESH)
		autoAck(ann)
		ann.send(
			batch([
				makeOp('ann-node', 1, {
					collection: 'documents',
					recordId: 'd1',
					data: { title: 'one', ownerId: 'ann' },
				}),
				makeOp('ann-node', 2, {
					collection: 'documents',
					recordId: 'd2',
					data: { title: 'two', ownerId: 'ann' },
				}),
			]),
		)
		await tick(200)
		const bob = await harness.login('bob', 'bob-node', FRESH)
		autoAck(bob)
		await tick(100)
		// Slow reads (a loaded database): the unit's record queries take a while.
		const original = store.queryCollection.bind(store)
		let slow = true
		;(store as { queryCollection: typeof original }).queryCollection = async (...args) => {
			if (slow) await new Promise((r) => setTimeout(r, 150))
			return original(...args)
		}
		slow = false
		ann.send(
			batch(
				[1, 2, 3, 4, 5, 6].map((n) =>
					makeOp('ann-node', 10 + n, {
						collection: 'documents',
						recordId: `f${n}`,
						data: { title: 'f', ownerId: 'ann' },
					}),
				),
			),
		)
		const g1 = harness.server.access.grant({
			userId: 'bob',
			group: ['documents', 'd1'],
			role: 'view',
		})
		await g1
		slow = true
		await tick(30) // bob's stream is now inside rescopeUnit for d1
		await harness.server.access.grant({ userId: 'bob', group: ['documents', 'd2'], role: 'view' })
		const sessions = (
			harness.server as unknown as {
				sessions: Map<string, { refreshAccessIfStale(n: number): Promise<void> }>
			}
		).sessions
		// The poll's refresh, landing while bob's stream is inside a unit.
		for (const session of sessions.values()) void session.refreshAccessIfStale(1e9)
		await tick(800)
		slow = false
		ann.send(
			batch([
				makeOp('ann-node', 3, {
					collection: 'documents',
					recordId: 'd5',
					data: { title: 'five', ownerId: 'ann' },
				}),
			]),
		)
		await tick(400)
		const keys = items(bob.messages).map((i) => `${i.kind}:${i.key}:${i.nodeId}`)
		expect(keys.some((k) => k.includes('documents/d1'))).toBe(true)
		expect(keys.some((k) => k.includes('documents/d2'))).toBe(true)
	})
})
