import { defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import type { TestNetwork } from '../../src/index'
import { createTestNetwork } from '../../src/index'

/**
 * NEW-MERGE-1: a concurrent update that does NOT change the array (e.g. a
 * form save that re-sends every field, tags unchanged) resurrects an element
 * another device removed. applyMergedUpdate puts every remote field into the
 * local diff and addWinsSet keeps a base element unless BOTH sides removed it,
 * so "unchanged" counts as a vote to keep.
 */
const schema = defineSchema({
	version: 1,
	collections: { tickets: { fields: { title: t.string(), tags: t.array(t.string()) } } },
})

let network: TestNetwork | null = null
afterEach(async () => {
	await network?.close()
	network = null
})

describe('NEW-MERGE-1 unchanged array in a concurrent update must not undo a removal', () => {
	test('A removes urgent; B saves {title, tags unchanged} => tags []', async () => {
		network = await createTestNetwork(schema, { devices: 2 })
		const [a, b] = network.devices as [(typeof network.devices)[0], (typeof network.devices)[0]]
		const rec = await a.collection('tickets').insert({ title: 'x', tags: ['urgent'] })
		await a.sync()
		await b.sync()
		await a.disconnect()
		await b.disconnect()
		await a.collection('tickets').update(rec.id, { tags: [] })
		await b.collection('tickets').update(rec.id, { title: 'renamed', tags: ['urgent'] })
		for (let i = 0; i < 3; i++) {
			await a.sync()
			await b.sync()
		}
		const onA = await a.collection('tickets').findById(rec.id)
		const onB = await b.collection('tickets').findById(rec.id)
		expect({ a: [onA?.title, onA?.tags], b: [onB?.title, onB?.tags] }).toEqual({
			a: ['renamed', []],
			b: ['renamed', []],
		})
	}, 30000)
})
