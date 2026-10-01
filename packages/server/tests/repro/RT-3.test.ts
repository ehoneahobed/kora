/**
 * RT-3 repro (red team, 2026-10-01): download visibility is judged on a snapshot in
 * which the writer's `previousData` overrides the stored row. A tenant can push its
 * own (authorized) update carrying `previousData: { userId: '<victim>' }` and have it
 * delivered into another tenant's log, or hide its update from its own devices.
 * Covers the live relay, the version-vector backfill and the delivery-stream
 * backfill. Asserts the CORRECT behaviour (fails before the fix).
 */
import { defineSchema, t } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { TokenAuthProvider } from '../../src/auth/token-auth'
import { batch, createHarness, deliveredOpIds, makeOp, tick } from './rt-fixture'

const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { title: t.string(), userId: t.string() } } },
})

const auth = new TokenAuthProvider({
	validate: async (token) =>
		token.startsWith('alice')
			? { userId: 'alice', scopes: { notes: { userId: 'alice' } } }
			: token.startsWith('bob')
				? { userId: 'bob', scopes: { notes: { userId: 'bob' } } }
				: null,
})

/** Alice inserts her note, then pushes an update whose previousData lies about the owner. */
async function aliceLies(harness: Awaited<ReturnType<typeof createHarness>>) {
	const alice = await harness.login('alice-token', 'alice-node')
	const insert = makeOp('alice-node', 1, {
		recordId: 'alice-note',
		data: { title: 'mine', userId: 'alice' },
	})
	const lie = makeOp('alice-node', 2, {
		type: 'update',
		recordId: 'alice-note',
		data: { title: 'injected into bob' },
		previousData: { title: 'mine', userId: 'bob' },
		causalDeps: [insert.id],
	})
	alice.send(batch([insert]))
	await tick()
	alice.send(batch([lie]))
	await tick()
	// The write itself is authorized (alice's own record stays alice's).
	expect((await harness.store.findRecord('notes', 'alice-note'))?.title).toBe('injected into bob')
	return { insert, lie }
}

describe('RT-3: previousData steers download visibility', () => {
	test("live relay: alice's update is not pushed to bob, and is pushed to alice's other device", async () => {
		const harness = await createHarness(schema, auth)
		const bob = await harness.login('bob-token', 'bob-node')
		const aliceTablet = await harness.login('alice-token-2', 'alice-tablet')
		const { lie } = await aliceLies(harness)
		await tick()
		expect(deliveredOpIds(bob.messages)).not.toContain(lie.id)
		expect(deliveredOpIds(aliceTablet.messages)).toContain(lie.id)
	})

	test("version-vector backfill: bob's initial sync does not receive alice's op; alice's does", async () => {
		const harness = await createHarness(schema, auth)
		const { lie } = await aliceLies(harness)
		const bob = await harness.login('bob-token', 'bob-node-2')
		const aliceTablet = await harness.login('alice-token-2', 'alice-tablet-2')
		expect(deliveredOpIds(bob.messages)).not.toContain(lie.id)
		expect(deliveredOpIds(aliceTablet.messages)).toContain(lie.id)
	})

	test("delivery-stream backfill: bob's watermark resync does not receive alice's op; alice's does", async () => {
		const harness = await createHarness(schema, auth)
		const { lie } = await aliceLies(harness)
		const scope = (user: string) => ({ notes: { userId: user } })
		const bob = await harness.login('bob-token', 'bob-node-3', {
			lastDeliverySequence: 0,
			syncScope: scope('bob'),
		} as never)
		const aliceTablet = await harness.login('alice-token-2', 'alice-tablet-3', {
			lastDeliverySequence: 0,
			syncScope: scope('alice'),
		} as never)
		expect(deliveredOpIds(bob.messages)).not.toContain(lie.id)
		expect(deliveredOpIds(aliceTablet.messages)).toContain(lie.id)
	})
})
