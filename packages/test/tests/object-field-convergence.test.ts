import { defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import type { TestDevice, TestNetwork } from '../src/index'
import { createTestNetwork, expectConvergedEventually } from '../src/index'

/**
 * System-level proof that `object` fields merge as a convergent CRDT through the
 * real store + sync + merge path, not just in a merge unit test.
 *
 * Two devices concurrently edit DIFFERENT keys of the same object field while
 * offline. A framework that stored the object as an opaque last-write-wins blob
 * would drop one device's edit on reconnect. Kora's recursive LWW-map merge must
 * keep both, converge to identical state, and leave untouched keys intact.
 */
const schema = defineSchema({
	version: 1,
	collections: {
		documents: {
			fields: {
				title: t.string(),
				settings: t.object({
					theme: t.string(),
					fontSize: t.number(),
					layout: t.string(),
				}),
				metadata: t.json<Record<string, unknown>>().optional(),
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

function devices(...indices: number[]): TestDevice[] {
	return indices.map((i) => {
		const d = network?.devices[i]
		if (!d) {
			throw new Error(`Device at index ${i} not found`)
		}
		return d
	})
}

describe('object field convergence (real sync path)', () => {
	test('concurrent edits to different keys of an object field both survive', async () => {
		network = await createTestNetwork(schema, { devices: 2 })
		const [deviceA, deviceB] = devices(0, 1)

		const created = await deviceA.collection('documents').insert({
			title: 'Design doc',
			settings: { theme: 'light', fontSize: 12, layout: 'grid' },
		})
		await deviceA.sync()
		await deviceB.sync()

		const onB = await deviceB.collection('documents').findById(created.id)
		expect((onB?.settings as { theme: string }).theme).toBe('light')

		// Offline concurrent edits to DIFFERENT keys of the same object.
		await deviceA.collection('documents').update(created.id, {
			settings: { theme: 'dark', fontSize: 12, layout: 'grid' },
		})
		await deviceB.collection('documents').update(created.id, {
			settings: { theme: 'light', fontSize: 20, layout: 'grid' },
		})

		await deviceA.sync()
		await deviceB.sync()
		await deviceA.sync()
		await deviceB.sync()

		await expectConvergedEventually([deviceA, deviceB], schema)

		for (const device of [deviceA, deviceB]) {
			const rec = await device.collection('documents').findById(created.id)
			const settings = rec?.settings as { theme: string; fontSize: number; layout: string }
			expect(settings.theme, `theme on ${device.name}`).toBe('dark') // A's edit survived
			expect(settings.fontSize, `fontSize on ${device.name}`).toBe(20) // B's edit survived
			expect(settings.layout, `layout on ${device.name}`).toBe('grid') // untouched key intact
		}
	}, 30000)

	test('concurrent edits to different keys of a json field both survive', async () => {
		network = await createTestNetwork(schema, { devices: 2 })
		const [deviceA, deviceB] = devices(0, 1)

		const created = await deviceA.collection('documents').insert({
			title: 'Notes',
			settings: { theme: 'light', fontSize: 12, layout: 'grid' },
			metadata: { author: 'obed', tags: ['draft'] },
		})
		await deviceA.sync()
		await deviceB.sync()

		await deviceA
			.collection('documents')
			.update(created.id, { metadata: { author: 'obed', tags: ['draft'], starred: true } })
		await deviceB
			.collection('documents')
			.update(created.id, { metadata: { author: 'ehoneah', tags: ['draft'] } })

		await deviceA.sync()
		await deviceB.sync()
		await deviceA.sync()
		await deviceB.sync()

		await expectConvergedEventually([deviceA, deviceB], schema)

		for (const device of [deviceA, deviceB]) {
			const rec = await device.collection('documents').findById(created.id)
			const metadata = rec?.metadata as { author: string; starred?: boolean }
			// B's author edit and A's starred addition both converge; every device agrees.
			expect(metadata.starred, `starred on ${device.name}`).toBe(true)
			expect(metadata.author, `author on ${device.name}`).toBe('ehoneah')
		}
	}, 30000)
})
