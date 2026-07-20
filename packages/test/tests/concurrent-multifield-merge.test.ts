import { defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import type { TestDevice, TestNetwork } from '../src/index'
import { createTestNetwork, expectConvergedEventually } from '../src/index'

/**
 * System-level proof that a concurrent update touching DIFFERENT fields of the
 * same record converges without corrupting untouched required siblings.
 *
 * The merge engine emits only the fields the two concurrent operations actually
 * changed (the union of their deltas). Before that fix it re-materialized every
 * schema field, so a conflicting single-field update wrote `null` over required
 * siblings: a NOT NULL crash on apply, or silent data loss for optional ones.
 * This test uses a schema full of required, non-null fields specifically to
 * catch that regression at the store + sync + merge level, not just in a merge
 * unit test.
 */
const schema = defineSchema({
	version: 1,
	collections: {
		tasks: {
			fields: {
				title: t.string(),
				assignee: t.string(),
				priority: t.enum(['low', 'medium', 'high']).default('medium'),
				done: t.boolean().default(false),
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

describe('Concurrent multi-field merge preserves untouched required siblings', () => {
	test('disjoint concurrent field edits converge with every field intact', async () => {
		network = await createTestNetwork(schema, { devices: 2 })
		const [deviceA, deviceB] = devices(0, 1)

		// Seed a fully-populated record and get both devices onto it.
		const created = await deviceA
			.collection('tasks')
			.insert({ title: 'ship v0.7', assignee: 'obed', priority: 'high', done: false })
		await deviceA.sync()
		await deviceB.sync()

		const onB = await deviceB.collection('tasks').findById(created.id)
		expect(onB?.title).toBe('ship v0.7')
		expect(onB?.assignee).toBe('obed')

		// Concurrent edits to DIFFERENT fields, while both are offline.
		await deviceA.collection('tasks').update(created.id, { title: 'ship v0.7.0' })
		await deviceB.collection('tasks').update(created.id, { done: true })

		// Exchange until convergence.
		await deviceA.sync()
		await deviceB.sync()
		await deviceA.sync()
		await deviceB.sync()

		await expectConvergedEventually([deviceA, deviceB], schema)

		// Both edits survived, and neither untouched required sibling was nulled.
		for (const device of [deviceA, deviceB]) {
			const rec = await device.collection('tasks').findById(created.id)
			expect(rec, `record present on ${device.name}`).not.toBeNull()
			expect(rec?.title).toBe('ship v0.7.0')
			expect(rec?.done).toBe(true)
			expect(rec?.assignee).toBe('obed') // untouched by either edit → preserved
			expect(rec?.priority).toBe('high') // untouched by either edit → preserved
		}
	}, 30000)

	test('conflicting edit on one field leaves the other required fields untouched', async () => {
		network = await createTestNetwork(schema, { devices: 2 })
		const [deviceA, deviceB] = devices(0, 1)

		const created = await deviceA
			.collection('tasks')
			.insert({ title: 'draft', assignee: 'obed', priority: 'low', done: false })
		await deviceA.sync()
		await deviceB.sync()

		// Both edit the SAME field concurrently (a real conflict); LWW resolves it.
		await deviceA.collection('tasks').update(created.id, { title: 'title from A' })
		await deviceB.collection('tasks').update(created.id, { title: 'title from B' })

		await deviceA.sync()
		await deviceB.sync()
		await deviceA.sync()
		await deviceB.sync()

		await expectConvergedEventually([deviceA, deviceB], schema)

		const a = await deviceA.collection('tasks').findById(created.id)
		const b = await deviceB.collection('tasks').findById(created.id)
		// Both devices agree on the winner, and the untouched fields are intact.
		expect(a?.title).toBe(b?.title)
		expect(['title from A', 'title from B']).toContain(a?.title)
		expect(a?.assignee).toBe('obed')
		expect(a?.priority).toBe('low')
		expect(a?.done).toBe(false)
	}, 30000)

	test('three devices with overlapping and disjoint edits all converge', async () => {
		network = await createTestNetwork(schema, { devices: 3 })
		const [deviceA, deviceB, deviceC] = devices(0, 1, 2)

		const created = await deviceA
			.collection('tasks')
			.insert({ title: 'seed', assignee: 'obed', priority: 'low', done: false })
		await deviceA.sync()
		await deviceB.sync()
		await deviceC.sync()

		// A and B both contend on `title` (same field), while A also owns `priority`,
		// B owns `done`, and C owns `assignee` — a mix of same-field conflicts and
		// disjoint edits, all offline and concurrent.
		await deviceA.collection('tasks').update(created.id, { title: 'A wins?', priority: 'high' })
		await deviceB.collection('tasks').update(created.id, { title: 'B wins?', done: true })
		await deviceC.collection('tasks').update(created.id, { assignee: 'ada' })

		// Exchange in a deliberately uneven order to exercise arrival-order paths.
		await deviceC.sync()
		await deviceA.sync()
		await deviceB.sync()
		await deviceC.sync()
		await deviceA.sync()
		await deviceB.sync()

		await expectConvergedEventually([deviceA, deviceB, deviceC], schema)

		const recs = await Promise.all(
			[deviceA, deviceB, deviceC].map((d) => d.collection('tasks').findById(created.id)),
		)
		const [ra, rb, rc] = recs
		// All three converge to one identical record.
		expect(ra).toEqual(rb)
		expect(rb).toEqual(rc)
		// Disjoint edits from each device all survived; the contested title is one
		// of the two writers (never a lost/rolled-back value), agreed by everyone.
		expect(ra?.priority).toBe('high') // only A wrote priority
		expect(ra?.done).toBe(true) // only B wrote done
		expect(ra?.assignee).toBe('ada') // only C wrote assignee
		expect(['A wins?', 'B wins?']).toContain(ra?.title)
	}, 30000)
})
