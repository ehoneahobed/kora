import { defineSchema, t } from '@korajs/core'
import { createTestNetwork, expectConverged } from '@korajs/test'
import { afterEach, describe, expect, test } from 'vitest'
import { createApp } from '../../src/create-app'

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

describe('createApp sync integration (production path)', () => {
	afterEach(async () => {
		// network closed per test
	})

	test('two devices converge through test network after offline insert', async () => {
		const network = await createTestNetwork(schema, { devices: 2 })
		try {
			const deviceA = network.devices[0]
			const deviceB = network.devices[1]
			if (!deviceA || !deviceB) {
				throw new Error('expected two devices')
			}

			await deviceA.collection('todos').insert({ title: 'Offline on A' })
			await deviceA.sync()
			await deviceB.sync()

			await expectConverged(network.devices, schema)

			const stateB = await deviceB.getState('todos')
			expect(stateB).toHaveLength(1)
			expect(stateB[0]?.title).toBe('Offline on A')
		} finally {
			await network.close()
		}
	})

	test('createApp with sync config wires merge-aware store and queues ops', async () => {
		const app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
			sync: { url: 'wss://localhost:9999' },
		})
		await app.ready

		const todos = (app as Record<string, unknown>).todos as {
			insert: (data: Record<string, unknown>) => Promise<{ id: string }>
		}
		await todos.insert({ title: 'Queued' })

		expect(app.getSyncEngine()?.getOutboundQueue().totalPending).toBe(1)
		await app.close()
	})
})
