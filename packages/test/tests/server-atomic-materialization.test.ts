import { defineSchema, op, t } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import { createTestNetwork, expectConvergedEventually } from '../src/index'
import type { TestDevice, TestNetwork } from '../src/index'

/**
 * Proves the server's materialized view composes atomic operations identically to
 * what clients converge to. Concurrent, offline atomic writes are synced through the
 * server; the server's materialized record (read via findRecord, the source for REST
 * reads and initial-sync hydration) must equal the clients' converged state, not a
 * last-write-wins collapse that would drop all but one write.
 *
 * Both the clients and the server converge to the known-correct composed value, for
 * two-device and N-device concurrent writes, and for a passive observer that never
 * authored an atomic op — the client and server share one atomic-aware fold, so they
 * agree by construction.
 */
const schema = defineSchema({
	version: 1,
	collections: {
		counters: {
			fields: {
				label: t.string(),
				count: t.number().default(0),
				high: t.number().default(0),
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

/**
 * Push and pull every device several times so operations relay fully through the
 * hub-and-spoke server (a device's op reaches every other after at most two rounds).
 */
async function settle(net: TestNetwork): Promise<void> {
	for (let round = 0; round < 3; round++) {
		for (const device of net.devices) {
			await device.sync()
		}
	}
}

/** Read the server's materialized value for a record field. */
async function serverField(net: TestNetwork, id: string, field: string): Promise<unknown> {
	const record = await net.server.store.findRecord('counters', id)
	return record?.[field]
}

/** Read one client's materialized value for a record field. */
async function clientField(device: TestDevice, id: string, field: string): Promise<unknown> {
	const record = (await device.getState('counters')).find(
		(r) => (r as Record<string, unknown>).id === id,
	) as Record<string, unknown> | undefined
	return record?.[field]
}

describe('server materializes atomic ops to match client convergence', () => {
	test('concurrent offline increments sum on both the client and the server', async () => {
		network = await createTestNetwork(schema, { devices: 2 })
		const [a, b] = network.devices as TestDevice[]

		const seed = await a.collection('counters').insert({ label: 'likes', count: 0 })
		const id = seed.id
		await settle(network)

		// Both devices increment offline — the canonical offline-first counter race.
		await a.disconnect()
		await b.disconnect()
		await a.collection('counters').update(id, { count: op.increment(5) })
		await b.collection('counters').update(id, { count: op.increment(3) })

		await a.reconnect()
		await b.reconnect()
		await settle(network)

		await expectConvergedEventually(network.devices, schema)
		// Client converges to base + sum; the server's materialized view agrees exactly
		// (plain last-write-wins would show 5 or 3, dropping one increment).
		expect(await clientField(a, id, 'count')).toBe(8)
		expect(await serverField(network, id, 'count')).toBe(8)
	}, 30000)

	test('concurrent max composes to the maximum on both the client and the server', async () => {
		network = await createTestNetwork(schema, { devices: 2 })
		const [a, b] = network.devices as TestDevice[]

		const seed = await a.collection('counters').insert({ label: 'score', high: 0 })
		const id = seed.id
		await settle(network)

		await a.disconnect()
		await b.disconnect()
		await a.collection('counters').update(id, { high: op.max(50) })
		await b.collection('counters').update(id, { high: op.max(90) })

		await a.reconnect()
		await b.reconnect()
		await settle(network)

		await expectConvergedEventually(network.devices, schema)
		expect(await clientField(a, id, 'high')).toBe(90)
		expect(await serverField(network, id, 'high')).toBe(90)
	}, 30000)

	test('concurrent appends accumulate on the server (add-wins set membership)', async () => {
		// Add-wins array merge preserves set membership but not element order, so
		// clients may hold the two items in different orders. The invariant that
		// matters, and that plain last-write-wins would break by dropping one item, is
		// that BOTH items survive on the server and on every client.
		network = await createTestNetwork(schema, { devices: 2 })
		const [a, b] = network.devices as TestDevice[]

		const seed = await a.collection('counters').insert({ label: 'tags', tags: [] })
		const id = seed.id
		await settle(network)

		await a.disconnect()
		await b.disconnect()
		await a.collection('counters').update(id, { tags: op.append('urgent') })
		await b.collection('counters').update(id, { tags: op.append('review') })

		await a.reconnect()
		await b.reconnect()
		await settle(network)

		const asSet = (v: unknown): unknown[] => [...(v as unknown[])].sort()
		expect(asSet(await serverField(network, id, 'tags'))).toEqual(['review', 'urgent'])
		expect(asSet(await clientField(a, id, 'tags'))).toEqual(['review', 'urgent'])
		expect(asSet(await clientField(b, id, 'tags'))).toEqual(['review', 'urgent'])
	}, 30000)

	test('server materialization equals client convergence for a set racing an increment', async () => {
		// A plain set concurrent with an increment is the case a naive "always compose"
		// fold gets wrong. The server must match whatever the client merge engine
		// converges to (last-write-wins between the set and the increment's resolved
		// value), not fold the delta onto the set.
		network = await createTestNetwork(schema, { devices: 2 })
		const [a, b] = network.devices as TestDevice[]

		const seed = await a.collection('counters').insert({ label: 'mixed', count: 10 })
		const id = seed.id
		await settle(network)

		await a.disconnect()
		await b.disconnect()
		await a.collection('counters').update(id, { count: 100 }) // plain set
		await b.collection('counters').update(id, { count: op.increment(5) }) // atomic

		await a.reconnect()
		await b.reconnect()
		await settle(network)

		await expectConvergedEventually(network.devices, schema)
		// Whatever the clients agree on, the server's materialized view agrees too.
		const clientValue = await clientField(a, id, 'count')
		expect(await serverField(network, id, 'count')).toBe(clientValue)
	}, 30000)

	test('three concurrent increments converge on every client and the server', async () => {
		network = await createTestNetwork(schema, { devices: 3 })
		const [a, b, c] = network.devices as TestDevice[]

		const seed = await a.collection('counters').insert({ label: 'nway', count: 0 })
		const id = seed.id
		await settle(network)

		await a.disconnect()
		await b.disconnect()
		await c.disconnect()
		await a.collection('counters').update(id, { count: op.increment(5) })
		await b.collection('counters').update(id, { count: op.increment(3) })
		await c.collection('counters').update(id, { count: op.increment(2) })

		await a.reconnect()
		await b.reconnect()
		await c.reconnect()
		await settle(network)

		await expectConvergedEventually(network.devices, schema)
		expect(await clientField(a, id, 'count')).toBe(10)
		expect(await clientField(b, id, 'count')).toBe(10)
		expect(await clientField(c, id, 'count')).toBe(10)
		expect(await serverField(network, id, 'count')).toBe(10)
	}, 30000)

	test('a passive observer that never wrote converges to the composed value', async () => {
		// Device d authors nothing; it only observes three concurrent increments from
		// a, b, c relayed through the server. It must still fold them to base + sum,
		// the case that exposed the client-side lost-update bug this fix closes.
		network = await createTestNetwork(schema, { devices: 4 })
		const [a, b, c, d] = network.devices as TestDevice[]

		const seed = await a.collection('counters').insert({ label: 'observer', count: 0 })
		const id = seed.id
		await settle(network)

		await a.disconnect()
		await b.disconnect()
		await c.disconnect()
		await d.disconnect()
		await a.collection('counters').update(id, { count: op.increment(5) })
		await b.collection('counters').update(id, { count: op.increment(3) })
		await c.collection('counters').update(id, { count: op.increment(2) })

		await a.reconnect()
		await b.reconnect()
		await c.reconnect()
		await d.reconnect()
		await settle(network)

		await expectConvergedEventually(network.devices, schema)
		expect(await clientField(d, id, 'count')).toBe(10)
		expect(await serverField(network, id, 'count')).toBe(10)
	}, 30000)
})
