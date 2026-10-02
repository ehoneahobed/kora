import { defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import type { TestDevice, TestNetwork } from '../../src/index'
import { createTestNetwork } from '../../src/index'

/**
 * SRV-1 repro: the server's materialized view (replayOperationsForRecord: HLC LWW +
 * atomics) must equal what clients converge to through the real ApplyPipeline merge
 * (add-wins arrays, object key merge, custom resolvers). Server rows feed route
 * handlers, constraint checks, scope backfill and REST reads.
 */
const schema = defineSchema({
	version: 1,
	collections: {
		tasks: {
			fields: {
				title: t.string(),
				note: t.string().optional(),
				tags: t.array(t.string()).default([]),
				meta: t.object({ color: t.string(), size: t.number() }).optional(),
				qty: t.number().default(0),
			},
			resolve: {
				qty: (local, remote, base) => {
					const l = typeof local === 'number' ? local : 0
					const r = typeof remote === 'number' ? remote : 0
					const b = typeof base === 'number' ? base : 0
					return b + (l - b) + (r - b)
				},
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

async function settle(net: TestNetwork, rounds = 3): Promise<void> {
	for (let i = 0; i < rounds; i++) for (const d of net.devices) await d.sync()
}

async function clientRow(d: TestDevice, id: string): Promise<Record<string, unknown> | null> {
	return (await d.collection('tasks').findById(id)) as Record<string, unknown> | null
}

async function serverRow(net: TestNetwork, id: string): Promise<Record<string, unknown> | null> {
	const r = (await net.server.store.findRecord('tasks', id)) as Record<string, unknown> | null
	if (!r || r._deleted === 1 || r._deleted === true) return null
	return r
}

async function concurrentEdit(
	field: string,
	seed: Record<string, unknown>,
	a: Record<string, unknown>,
	b: Record<string, unknown>,
): Promise<{
	client: Record<string, unknown> | null
	client2: Record<string, unknown> | null
	server: Record<string, unknown> | null
}> {
	network = await createTestNetwork(schema, { devices: 2 })
	const [da, db] = network.devices as TestDevice[]
	const created = await da.collection('tasks').insert({ title: 't', ...seed })
	await settle(network)
	await da.collection('tasks').update(created.id, a)
	await db.collection('tasks').update(created.id, b)
	await settle(network)
	const client = await clientRow(da, created.id)
	const client2 = await clientRow(db, created.id)
	const server = await serverRow(network, created.id)
	void field
	return { client, client2, server }
}

describe('SRV-1 server materialization equals client convergence', () => {
	test('array (add-wins) field', async () => {
		const r = await concurrentEdit(
			'tags',
			{ tags: ['base'] },
			{ tags: ['base', 'a'] },
			{ tags: ['base', 'b'] },
		)
		const sort = (v: unknown) => [...((v as string[]) ?? [])].sort()
		expect(sort(r.client?.tags)).toEqual(['a', 'b', 'base'])
		expect(sort(r.client2?.tags)).toEqual(['a', 'b', 'base'])
		expect(sort(r.server?.tags)).toEqual(sort(r.client?.tags))
	}, 30000)

	test('object (key-merge) field', async () => {
		const r = await concurrentEdit(
			'meta',
			{ meta: { color: 'red', size: 1 } },
			{ meta: { color: 'blue', size: 1 } },
			{ meta: { color: 'red', size: 2 } },
		)
		expect(r.client?.meta).toEqual(r.client2?.meta)
		expect(r.server?.meta).toEqual(r.client?.meta)
	}, 30000)

	test('custom resolver field', async () => {
		const r = await concurrentEdit('qty', { qty: 10 }, { qty: 15 }, { qty: 13 })
		expect(r.client?.qty).toBe(18)
		expect(r.client2?.qty).toBe(18)
		expect(r.server?.qty).toBe(r.client?.qty)
	}, 30000)
})
