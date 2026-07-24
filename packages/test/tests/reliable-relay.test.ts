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

test('a relay dropped by a lossy transport is retransmitted and recovered (no lost op)', async () => {
	// Drop exactly the first relayed batch that carries the marker, then allow resends.
	let droppedOnce = false
	const dropPredicate = (msg: SyncMessage, dir: 'outgoing' | 'incoming'): boolean => {
		if (dir === 'incoming' && msg.type === 'operation-batch' && !droppedOnce) {
			if (JSON.stringify(msg).includes('DROP_ONCE')) {
				droppedOnce = true
				return true
			}
		}
		return false
	}

	network = await createTestNetwork(schema, { devices: 2, chaos: { dropPredicate } })
	const [a, b] = network.devices as TestDevice[]

	// Connect both so relays flow live from A to B.
	await a.sync()
	await b.sync()

	const seed = await a.collection('items').insert({ title: 'x', tag: 'init' })
	const id = seed.id
	await a.sync()
	await b.sync()

	// The first update (delivered to B) is dropped once.
	await a.collection('items').update(id, { tag: 'DROP_ONCE' })
	// A later update follows it. The delivery stream resumes from B's last acknowledged
	// position, so this next push re-includes the dropped update: B recovers it as soon as
	// the next operation flows, with no lost op and without needing a reconnect. It never
	// forms a torn version-vector gap (it applies the two updates in order).
	await a.collection('items').update(id, { title: 'later' })
	await a.sync()
	await b.sync()

	const after = await rec(b, id)
	expect(after?.tag).toBe('DROP_ONCE') // dropped update recovered
	expect(after?.title).toBe('later')
	const server = await network.server.store.findRecord('items', id)
	expect(after?.tag).toBe(server?.tag)
	expect(after?.title).toBe(server?.title)
}, 40000)
