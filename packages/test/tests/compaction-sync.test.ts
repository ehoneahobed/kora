import { defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import { createTestNetwork, expectConverged } from '../src/index'

const schema = defineSchema({
	version: 1,
	collections: {
		todos: {
			fields: {
				title: t.string(),
				completed: t.boolean().default(false),
			},
		},
	},
})

/**
 * Plan 3.3.5: compact op log → reconnect → still fully synced.
 */
describe('operation log compaction sync', () => {
	let network: Awaited<ReturnType<typeof createTestNetwork>> | null = null

	afterEach(async () => {
		if (network) {
			await network.close()
			network = null
		}
	})

	test('compact after sync then new mutations still converge', async () => {
		network = await createTestNetwork(schema, { devices: 2 })
		const [deviceA, deviceB] = network.devices

		await deviceA.collection('todos').insert({ title: 'Before compact' })
		await deviceA.sync()
		await deviceB.sync()

		const serverVector = await deviceA.store.loadLastAckedServerVector()
		const compactResult = await deviceA.store.compact({
			mode: 'after-ack',
			serverVector,
		})
		expect(compactResult.deletedCount).toBeGreaterThan(0)

		await deviceA.collection('todos').insert({ title: 'After compact' })
		await deviceA.sync()
		await deviceB.sync()

		const todosB = await deviceB.getState('todos')
		expect(todosB.length).toBe(2)
		await expectConverged(network.devices, schema)
	})
})
