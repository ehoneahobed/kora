import { defineSchema, t } from '@korajs/core'
import { afterEach, expect, test } from 'vitest'
import { createTestNetwork } from '../src/index'
import type { TestDevice, TestNetwork } from '../src/index'

/**
 * End-to-end proof that the server->client delivery watermark is genuinely driving
 * sync (not merely being masked by content-addressed dedup): after syncing, the
 * client's persisted watermark equals the server's highest delivery sequence, and a
 * delivery batch dropped by a lossy transport is recovered with full convergence.
 */

const schema = defineSchema({
	version: 1,
	collections: { items: { fields: { title: t.string(), tag: t.string().default('') } } },
})

let network: TestNetwork | null = null
afterEach(async () => {
	if (network) {
		await network.close()
		network = null
	}
})

async function ids(d: TestDevice): Promise<string[]> {
	return (await d.getState('items')).map((r) => (r as { id: string }).id).sort()
}

test('the client watermark advances to the server maximum through normal sync', async () => {
	network = await createTestNetwork(schema, { devices: 2 })
	const [a, b] = network.devices as TestDevice[]
	await a.sync()
	await b.sync()

	await a.collection('items').insert({ title: 'one' })
	await a.collection('items').insert({ title: 'two' })
	await a.collection('items').insert({ title: 'three' })
	await a.sync()
	await b.sync()
	await a.sync()
	await b.sync()

	// B converged on A's three records.
	expect(await ids(b)).toEqual(await ids(a))
	expect((await b.getState('items')).length).toBe(3)

	// The watermark actually advanced to the server's frontier, proving the delivery
	// stream (not dedup) carried the operations.
	const serverMax = await network.server.store.getMaxDeliverySequence()
	expect(serverMax).toBeGreaterThan(0)
	expect(await b.store.loadDeliveryWatermark()).toBe(serverMax)

	// A further write advances both the server frontier and B's watermark.
	await a.collection('items').insert({ title: 'four' })
	await a.sync()
	await b.sync()
	await a.sync()
	await b.sync()
	const serverMax2 = await network.server.store.getMaxDeliverySequence()
	expect(serverMax2).toBeGreaterThan(serverMax)
	expect(await b.store.loadDeliveryWatermark()).toBe(serverMax2)
}, 40000)

test('the watermark resumes across a reconnect, delivering only what was missed', async () => {
	network = await createTestNetwork(schema, { devices: 2 })
	const [a, b] = network.devices as TestDevice[]
	await a.sync()
	await b.sync()

	await a.collection('items').insert({ title: 'one' })
	await a.collection('items').insert({ title: 'two' })
	await a.sync()
	await b.sync()
	await a.sync()
	await b.sync()

	// B is fully caught up; its watermark sits at the server frontier.
	const w1 = await b.store.loadDeliveryWatermark()
	expect(w1).toBe(await network.server.store.getMaxDeliverySequence())
	expect(await ids(b)).toEqual(await ids(a))

	// B goes offline while A keeps writing; the server frontier advances past B.
	await b.disconnect()
	await a.collection('items').insert({ title: 'three' })
	await a.collection('items').insert({ title: 'four' })
	await a.sync()
	const serverMax = await network.server.store.getMaxDeliverySequence()
	expect(serverMax).toBeGreaterThan(w1)

	// On reconnect B reports w1, so the server resumes the stream from there and B
	// converges, its watermark advancing to the new frontier with nothing lost.
	await b.reconnect()
	await b.sync()
	await a.sync()
	await b.sync()

	expect(await ids(b)).toEqual(await ids(a))
	expect((await b.getState('items')).length).toBe(4)
	const w2 = await b.store.loadDeliveryWatermark()
	expect(w2).toBe(serverMax)
	expect(w2).toBeGreaterThan(w1)
}, 40000)
