import { defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import type { TestDevice, TestNetwork } from '../src/index'
import { createTestNetwork, expectConvergedEventually } from '../src/index'

/**
 * Convergence matrix for the conflict types the release must guarantee:
 * delete-vs-update in BOTH orders, add-wins arrays, tier-3 custom resolvers,
 * and repeated same-field contention across multiple offline rounds. Each
 * scenario runs through the REAL sync path (Store + ApplyPipeline +
 * MergeAwareSyncStore + server relay), not merge-engine unit calls.
 */
const schema = defineSchema({
	version: 1,
	collections: {
		tasks: {
			fields: {
				title: t.string(),
				tags: t.array(t.string()).default([]),
				done: t.boolean().default(false),
			},
		},
		inventory: {
			fields: {
				sku: t.string(),
				quantity: t.number().default(0),
			},
			resolve: {
				// Additive merge: both concurrent deltas apply to the base.
				quantity: (local, remote, base) => {
					const l = typeof local === 'number' ? local : 0
					const r = typeof remote === 'number' ? remote : 0
					const b = typeof base === 'number' ? base : 0
					return Math.max(0, b + (l - b) + (r - b))
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

function devices(...indices: number[]): TestDevice[] {
	return indices.map((i) => {
		const d = network?.devices[i]
		if (!d) {
			throw new Error(`Device at index ${i} not found`)
		}
		return d
	})
}

async function fullExchange(all: TestDevice[], rounds = 3): Promise<void> {
	for (let i = 0; i < rounds; i++) {
		for (const device of all) {
			await device.sync()
		}
	}
}

describe('Conflict convergence matrix (real sync path)', () => {
	test('concurrent delete on A vs update on B: both devices agree on the outcome', async () => {
		network = await createTestNetwork(schema, { devices: 2 })
		const [deviceA, deviceB] = devices(0, 1)

		const created = await deviceA
			.collection('tasks')
			.insert({ title: 'target', tags: [], done: false })
		await fullExchange([deviceA, deviceB], 2)

		// Concurrent while both offline: A deletes, B updates.
		await deviceA.collection('tasks').delete(created.id)
		await deviceB.collection('tasks').update(created.id, { title: 'kept alive' })

		await fullExchange([deviceA, deviceB])
		await expectConvergedEventually([deviceA, deviceB], schema)

		// Whichever side won, it won on BOTH devices identically.
		const a = await deviceA.collection('tasks').findById(created.id)
		const b = await deviceB.collection('tasks').findById(created.id)
		expect(a === null).toBe(b === null)
		if (a && b) {
			expect(a.title).toBe(b.title)
		}
	}, 30000)

	test('concurrent update on A vs delete on B (reverse roles): both devices agree', async () => {
		network = await createTestNetwork(schema, { devices: 2 })
		const [deviceA, deviceB] = devices(0, 1)

		const created = await deviceA
			.collection('tasks')
			.insert({ title: 'target-2', tags: [], done: false })
		await fullExchange([deviceA, deviceB], 2)

		await deviceA.collection('tasks').update(created.id, { done: true })
		await deviceB.collection('tasks').delete(created.id)

		await fullExchange([deviceA, deviceB])
		await expectConvergedEventually([deviceA, deviceB], schema)

		const a = await deviceA.collection('tasks').findById(created.id)
		const b = await deviceB.collection('tasks').findById(created.id)
		expect(a === null).toBe(b === null)
		if (a && b) {
			expect(a.done).toBe(b.done)
		}
	}, 30000)

	test('concurrent array edits union via add-wins on every device', async () => {
		network = await createTestNetwork(schema, { devices: 2 })
		const [deviceA, deviceB] = devices(0, 1)

		const created = await deviceA
			.collection('tasks')
			.insert({ title: 'tagged', tags: ['base'], done: false })
		await fullExchange([deviceA, deviceB], 2)

		await deviceA.collection('tasks').update(created.id, { tags: ['base', 'from-a'] })
		await deviceB.collection('tasks').update(created.id, { tags: ['base', 'from-b'] })

		await fullExchange([deviceA, deviceB])
		await expectConvergedEventually([deviceA, deviceB], schema)

		for (const device of [deviceA, deviceB]) {
			const rec = await device.collection('tasks').findById(created.id)
			expect([...((rec?.tags as string[]) ?? [])].sort()).toEqual(['base', 'from-a', 'from-b'])
		}
	}, 30000)

	test('tier-3 custom resolver merges concurrent numeric deltas additively', async () => {
		network = await createTestNetwork(schema, { devices: 2 })
		const [deviceA, deviceB] = devices(0, 1)

		const created = await deviceA.collection('inventory').insert({ sku: 'WIDGET', quantity: 10 })
		await fullExchange([deviceA, deviceB], 2)

		// A sells 3 (10 -> 7), B restocks 5 (10 -> 15). Additive: 10 - 3 + 5 = 12.
		await deviceA.collection('inventory').update(created.id, { quantity: 7 })
		await deviceB.collection('inventory').update(created.id, { quantity: 15 })

		await fullExchange([deviceA, deviceB])
		await expectConvergedEventually([deviceA, deviceB], schema)

		for (const device of [deviceA, deviceB]) {
			const rec = await device.collection('inventory').findById(created.id)
			expect(rec?.quantity).toBe(12)
		}
	}, 30000)

	test('three rounds of same-field contention converge every round', async () => {
		network = await createTestNetwork(schema, { devices: 2 })
		const [deviceA, deviceB] = devices(0, 1)

		const created = await deviceA
			.collection('tasks')
			.insert({ title: 'round-0', tags: [], done: false })
		await fullExchange([deviceA, deviceB], 2)

		for (let round = 1; round <= 3; round++) {
			// Concurrent same-field edits, then full exchange — every round must
			// re-converge (the register must not be poisoned by earlier rounds).
			await deviceA.collection('tasks').update(created.id, { title: `A-round-${round}` })
			await deviceB.collection('tasks').update(created.id, { title: `B-round-${round}` })

			await fullExchange([deviceA, deviceB])
			await expectConvergedEventually([deviceA, deviceB], schema)

			const a = await deviceA.collection('tasks').findById(created.id)
			const b = await deviceB.collection('tasks').findById(created.id)
			expect(a?.title).toBe(b?.title)
			expect([`A-round-${round}`, `B-round-${round}`]).toContain(a?.title)
		}
	}, 60000)
})
