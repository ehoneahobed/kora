import { defineSchema, t } from '@korajs/core'
import { addWinsSet } from '@korajs/merge'
import { afterEach, describe, expect, test } from 'vitest'
import type { TestNetwork } from '../../src/index'
import { createTestNetwork } from '../../src/index'

/**
 * MERGE-1: a one-sided removal must survive a concurrent add of a DIFFERENT
 * element. OR-set "add-wins" only means a concurrent add of the SAME element
 * beats a remove. The helper's own docstring says "if one side adds an element
 * while another removes a different element, both changes are preserved".
 */
const schema = defineSchema({
	version: 1,
	collections: {
		tickets: { fields: { title: t.string(), tags: t.array(t.string()) } },
	},
})

let network: TestNetwork | null = null
afterEach(async () => {
	await network?.close()
	network = null
})

describe('MERGE-1 add-wins set preserves one-sided removals', () => {
	test('helper: remove urgent vs add billing => [billing]', () => {
		expect(addWinsSet([], ['urgent', 'billing'], ['urgent'])).toEqual(['billing'])
		expect(addWinsSet(['urgent', 'billing'], [], ['urgent'])).toEqual(['billing'])
	})

	test('end to end: A removes urgent, B adds billing concurrently => all show [billing]', async () => {
		network = await createTestNetwork(schema, { devices: 2 })
		const [a, b] = network.devices as [(typeof network.devices)[0], (typeof network.devices)[0]]
		const rec = await a.collection('tickets').insert({ title: 'x', tags: ['urgent'] })
		await a.sync()
		await b.sync()
		expect((await b.collection('tickets').findById(rec.id))?.tags).toEqual(['urgent'])

		await a.disconnect()
		await b.disconnect()
		await a.collection('tickets').update(rec.id, { tags: [] })
		await b.collection('tickets').update(rec.id, { tags: ['urgent', 'billing'] })

		for (let i = 0; i < 3; i++) {
			await a.sync()
			await b.sync()
		}

		const onA = (await a.collection('tickets').findById(rec.id))?.tags
		const onB = (await b.collection('tickets').findById(rec.id))?.tags
		const onServer = (await network.server.store.findRecord('tickets', rec.id))?.tags
		expect({ onA, onB, onServer }).toEqual({
			onA: ['billing'],
			onB: ['billing'],
			onServer: ['billing'],
		})
	}, 30000)

	test('end to end, removal has the later HLC: clients and server must agree on [billing]', async () => {
		network = await createTestNetwork(schema, { devices: 2 })
		const [a, b] = network.devices as [(typeof network.devices)[0], (typeof network.devices)[0]]
		const rec = await a.collection('tickets').insert({ title: 'x', tags: ['urgent'] })
		await a.sync()
		await b.sync()
		expect((await b.collection('tickets').findById(rec.id))?.tags).toEqual(['urgent'])

		await a.disconnect()
		await b.disconnect()
		await b.collection('tickets').update(rec.id, { tags: ['urgent', 'billing'] })
		await new Promise((r) => setTimeout(r, 5))
		await a.collection('tickets').update(rec.id, { tags: [] })

		for (let i = 0; i < 3; i++) {
			await a.sync()
			await b.sync()
		}

		const onA = (await a.collection('tickets').findById(rec.id))?.tags
		const onB = (await b.collection('tickets').findById(rec.id))?.tags
		const onServer = (await network.server.store.findRecord('tickets', rec.id))?.tags
		expect({ onA, onB, onServer }).toEqual({
			onA: ['billing'],
			onB: ['billing'],
			onServer: ['billing'],
		})
	}, 30000)
})
