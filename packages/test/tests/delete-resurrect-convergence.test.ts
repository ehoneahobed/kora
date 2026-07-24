import { defineSchema, op, t } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import { createTestNetwork, expectConvergedEventually } from '../src/index'
import type { TestDevice, TestNetwork } from '../src/index'

/**
 * Convergence around tombstones and resurrection — the cases where the client's
 * incremental apply historically diverged from the server's authoritative fold.
 * The client now resolves a remote update landing on a tombstone by folding the
 * record's whole operation log in HLC order (the same fold the server uses), so
 * every device — including a passive observer that authored nothing — agrees on
 * whether the record is alive and on its field values.
 */
const schema = defineSchema({
	version: 1,
	collections: {
		items: {
			fields: {
				title: t.string(),
				count: t.number().default(0),
				tags: t.array(t.string()).default([]),
			},
		},
	},
})

let network: TestNetwork | null = null

afterEach(async () => {
	if (network) {
		await network.close()
		network = null
	}
})

async function settle(net: TestNetwork, rounds: number): Promise<void> {
	for (let r = 0; r < rounds; r++) {
		for (const d of net.devices) {
			await d.sync()
		}
	}
}

async function record(d: TestDevice, id: string): Promise<Record<string, unknown> | undefined> {
	return (await d.getState('items')).find((r) => (r as Record<string, unknown>).id === id) as
		| Record<string, unknown>
		| undefined
}

describe('tombstone and resurrection convergence', () => {
	test('an update newer than a delete resurrects the record on every device, including a passive observer', async () => {
		network = await createTestNetwork(schema, { devices: 3 })
		const [a, b, d] = network.devices as TestDevice[]

		const seed = await a.collection('items').insert({ title: 'orig', count: 5 })
		const id = seed.id
		await settle(network, 4)

		await a.disconnect()
		await b.disconnect()
		await d.disconnect() // d authors nothing — pure observer

		await a.collection('items').delete(id)
		await new Promise((r) => setTimeout(r, 5))
		await b.collection('items').update(id, { title: 'updated' }) // newer than the delete

		await a.reconnect()
		await b.reconnect()
		await d.reconnect()
		await settle(network, 6)

		await expectConvergedEventually(network.devices, schema)
		// The newer update wins: the record is alive with title 'updated' everywhere,
		// including the passive observer (previously it stayed hidden there).
		expect((await record(a, id))?.title).toBe('updated')
		expect((await record(b, id))?.title).toBe('updated')
		expect((await record(d, id))?.title).toBe('updated')
		const server = await network.server.store.findRecord('items', id)
		expect(server?.title).toBe('updated')
	}, 40000)

	test('a delete newer than an update keeps the record deleted on every device', async () => {
		network = await createTestNetwork(schema, { devices: 3 })
		const [a, b, d] = network.devices as TestDevice[]

		const seed = await a.collection('items').insert({ title: 'orig', count: 5 })
		const id = seed.id
		await settle(network, 4)

		await a.disconnect()
		await b.disconnect()
		await d.disconnect()

		await b.collection('items').update(id, { title: 'stale' }) // older
		await new Promise((r) => setTimeout(r, 5))
		await a.collection('items').delete(id) // newer — wins

		await a.reconnect()
		await b.reconnect()
		await d.reconnect()
		await settle(network, 6)

		await expectConvergedEventually(network.devices, schema)
		expect(await record(a, id)).toBeUndefined()
		expect(await record(b, id)).toBeUndefined()
		expect(await record(d, id)).toBeUndefined()
		expect(await network.server.store.findRecord('items', id)).toBeNull()
	}, 40000)

	test('atomic increments before and after a delete compose on resurrection', async () => {
		network = await createTestNetwork(schema, { devices: 3 })
		const [a, b, c] = network.devices as TestDevice[]

		const seed = await a.collection('items').insert({ title: 'x', count: 5 })
		const id = seed.id
		await settle(network, 4)

		await a.disconnect()
		await b.disconnect()
		await c.disconnect()

		await b.collection('items').update(id, { count: op.increment(10) }) // before the delete
		await new Promise((r) => setTimeout(r, 5))
		await a.collection('items').delete(id)
		await new Promise((r) => setTimeout(r, 5))
		await c.collection('items').update(id, { count: op.increment(20) }) // after the delete

		await a.reconnect()
		await b.reconnect()
		await c.reconnect()
		await settle(network, 8)

		await expectConvergedEventually(network.devices, schema)
		// Fold: insert(5) → +10 (chain) → delete (retained) → +20 composes = 35, alive.
		for (const dev of [a, b, c]) {
			expect((await record(dev, id))?.count).toBe(35)
		}
		expect((await network.server.store.findRecord('items', id))?.count).toBe(35)
	}, 40000)

	test('concurrent appends converge to identical array order on every device and the server', async () => {
		network = await createTestNetwork(schema, { devices: 3 })
		const [a, b, c] = network.devices as TestDevice[]

		const seed = await a.collection('items').insert({ title: 'x', tags: [] })
		const id = seed.id
		await settle(network, 4)

		await a.disconnect()
		await b.disconnect()
		await c.disconnect()
		await a.collection('items').update(id, { tags: op.append('a') })
		await b.collection('items').update(id, { tags: op.append('b') })
		await c.collection('items').update(id, { tags: op.append('c') })

		await a.reconnect()
		await b.reconnect()
		await c.reconnect()
		await settle(network, 6)

		await expectConvergedEventually(network.devices, schema)
		// Add-wins ordered by HLC: identical array (not just membership) everywhere.
		const ta = (await record(a, id))?.tags
		expect((await record(b, id))?.tags).toEqual(ta)
		expect((await record(c, id))?.tags).toEqual(ta)
		expect((await network.server.store.findRecord('items', id))?.tags).toEqual(ta)
	}, 40000)
})
