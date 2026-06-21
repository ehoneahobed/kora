import { defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import { createTestNetwork, expectConverged } from '../src'

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

const CLIENT_COUNT = 3
const OPS_PER_CLIENT = 20

describe('chaos real-path convergence (Store + MergeAware + TestServer)', () => {
	let closeNetwork: (() => Promise<void>) | null = null

	afterEach(async () => {
		if (closeNetwork) {
			await closeNetwork()
			closeNetwork = null
		}
	})

	test('clients converge under lossy transport', async () => {
		const network = await createTestNetwork(schema, {
			devices: CLIENT_COUNT,
			chaos: {
				dropRate: 0.1,
				duplicateRate: 0.05,
				reorderRate: 0.05,
				maxLatency: 10,
				randomSource: seededRandom(42),
			},
		})
		closeNetwork = () => network.close()

		for (let index = 0; index < network.devices.length; index++) {
			const device = network.devices[index]
			if (!device) {
				continue
			}
			for (let op = 0; op < OPS_PER_CLIENT; op++) {
				await device.collection('todos').insert({
					title: `todo-${index}-${op}`,
				})
			}
			await device.sync()
		}

		for (const device of network.devices) {
			await device.disconnect()
			await device.sync()
		}

		await expectConverged(network.devices, schema)

		const serverCount = network.server.getAllOperations().length
		expect(serverCount).toBe(CLIENT_COUNT * OPS_PER_CLIENT)
	})
})

function seededRandom(seed: number): () => number {
	let state = seed
	return () => {
		state = (state * 1103515245 + 12345) & 0x7fffffff
		return state / 0x7fffffff
	}
}
