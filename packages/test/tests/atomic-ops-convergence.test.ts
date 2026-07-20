import { defineSchema, op, t } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import type { TestDevice, TestNetwork } from '../src/index'
import { createTestNetwork, expectConvergedEventually } from '../src/index'

/**
 * Atomic operations are Kora's intent-preserving updates: `op.increment(n)`
 * promises that CONCURRENT increments compose (sum of deltas applied to the
 * base) instead of last-write-wins. That promise must hold through the real
 * sync path — a routing shortcut that sends number-field updates through plain
 * LWW would silently drop one side's delta (classic lost-update).
 */
const schema = defineSchema({
	version: 1,
	collections: {
		counters: {
			fields: {
				name: t.string(),
				count: t.number().default(0),
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

describe('Atomic increment composition through sync', () => {
	test('concurrent increments on two devices compose to the sum of deltas', async () => {
		network = await createTestNetwork(schema, { devices: 2 })
		const [deviceA, deviceB] = devices(0, 1)

		const created = await deviceA.collection('counters').insert({ name: 'hits', count: 10 })
		await fullExchange([deviceA, deviceB], 2)

		const onB = await deviceB.collection('counters').findById(created.id)
		expect(onB?.count).toBe(10)

		// Concurrent intent-preserving updates while both are offline.
		await deviceA.collection('counters').update(created.id, { count: op.increment(3) })
		await deviceB.collection('counters').update(created.id, { count: op.increment(5) })

		await fullExchange([deviceA, deviceB])
		await expectConvergedEventually([deviceA, deviceB], schema)

		// 10 + 3 + 5 = 18 on BOTH devices — neither delta may be lost to LWW.
		for (const device of [deviceA, deviceB]) {
			const rec = await device.collection('counters').findById(created.id)
			expect(rec?.count).toBe(18)
		}
	}, 30000)

	test('increment concurrent with an unrelated field edit preserves both', async () => {
		network = await createTestNetwork(schema, { devices: 2 })
		const [deviceA, deviceB] = devices(0, 1)

		const created = await deviceA.collection('counters').insert({ name: 'clicks', count: 100 })
		await fullExchange([deviceA, deviceB], 2)

		await deviceA.collection('counters').update(created.id, { count: op.increment(-30) })
		await deviceB.collection('counters').update(created.id, { name: 'renamed' })

		await fullExchange([deviceA, deviceB])
		await expectConvergedEventually([deviceA, deviceB], schema)

		for (const device of [deviceA, deviceB]) {
			const rec = await device.collection('counters').findById(created.id)
			expect(rec?.count).toBe(70)
			expect(rec?.name).toBe('renamed')
		}
	}, 30000)
})
