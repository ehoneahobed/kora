import { defineSchema, t } from '@korajs/core'
import { richtextToPlainText } from '@korajs/store'
import { afterEach, expect, test } from 'vitest'
import { createTestNetwork, expectConvergedEventually } from '../src/index'
import type { TestDevice, TestNetwork } from '../src/index'

const schema = defineSchema({
	version: 1,
	collections: { docs: { fields: { notes: t.richtext() } } },
})
let network: TestNetwork | null = null
afterEach(async () => {
	if (network) {
		await network.close()
		network = null
	}
})
async function notesText(d: TestDevice, id: string): Promise<string> {
	const rec = (await d.getState('docs')).find((r) => (r as Record<string, unknown>).id === id) as
		| Record<string, unknown>
		| undefined
	return richtextToPlainText(rec?.notes as never)
}

test('concurrent plain-string richtext sets converge deterministically (no random-clientId divergence)', async () => {
	network = await createTestNetwork(schema, { devices: 2 })
	const [a, b] = network.devices as TestDevice[]
	const seed = await a.collection('docs').insert({ notes: 'base' })
	const id = seed.id
	for (let r = 0; r < 3; r++) {
		await a.sync()
		await b.sync()
	}
	await a.disconnect()
	await b.disconnect()
	await a.collection('docs').update(id, { notes: 'from device A' })
	await b.collection('docs').update(id, { notes: 'from device B' })
	await a.reconnect()
	await b.reconnect()
	for (let r = 0; r < 4; r++) {
		await a.sync()
		await b.sync()
	}
	await expectConvergedEventually(network.devices, schema)
	const ta = await notesText(a, id)
	const tb = await notesText(b, id)
	expect(ta).toBe(tb) // both devices agree on the winning string
	expect(['from device A', 'from device B']).toContain(ta) // LWW picked one
}, 40000)
