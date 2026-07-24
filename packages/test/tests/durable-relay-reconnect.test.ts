import { defineSchema, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { afterEach, expect, test } from 'vitest'
import { createTestNetwork } from '../src/index'
import type { TestDevice, TestNetwork } from '../src/index'

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
async function rec(d: TestDevice, id: string): Promise<Record<string, unknown> | undefined> {
	return (await d.getState('items')).find((r) => (r as Record<string, unknown>).id === id) as
		| Record<string, unknown>
		| undefined
}

test('a relay dropped just before reconnect is redelivered on reconnect (durable across sessions)', async () => {
	let droppedOnce = false
	const dropPredicate = (msg: SyncMessage, dir: 'outgoing' | 'incoming'): boolean => {
		if (
			dir === 'incoming' &&
			msg.type === 'operation-batch' &&
			!droppedOnce &&
			JSON.stringify(msg).includes('DROP_ONCE')
		) {
			droppedOnce = true
			return true
		}
		return false
	}
	network = await createTestNetwork(schema, { devices: 2, chaos: { dropPredicate } })
	const [a, b] = network.devices as TestDevice[]
	await a.sync()
	await b.sync()
	const seed = await a.collection('items').insert({ title: 'x', tag: 'init' })
	const id = seed.id
	await a.sync()
	await b.sync()

	await a.collection('items').update(id, { tag: 'DROP_ONCE' }) // delivery batch dropped once on B
	await a.sync()
	await b.sync()

	// B fully disconnects and reconnects. On reconnect the handshake resends the delivery
	// stream from B's persisted watermark, which sits below the dropped operation, so the
	// dropped update is recovered across the reconnect with no lost op.
	await b.disconnect()
	await b.reconnect()
	for (let r = 0; r < 3; r++) {
		await a.sync()
		await b.sync()
	}

	const after = await rec(b, id)
	expect(after?.tag).toBe('DROP_ONCE') // recovered
	const server = await network.server.store.findRecord('items', id)
	expect(after?.tag).toBe(server?.tag)
}, 40000)
