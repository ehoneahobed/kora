import { defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import type { TestDevice } from '../src/index'
import { checkConvergence, createTestNetwork, expectConverged } from '../src/index'
import type { TestNetwork } from '../src/index'

const schema = defineSchema({
	version: 1,
	collections: {
		todos: {
			fields: {
				title: t.string(),
				completed: t.boolean().default(false),
			},
		},
		notes: {
			fields: {
				text: t.string(),
				priority: t.number().default(0),
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

/** Helper to extract devices from the network with proper typing. */
function devices(...indices: number[]): TestDevice[] {
	return indices.map((i) => {
		const d = network?.devices[i]
		if (!d) throw new Error(`Device at index ${i} not found`)
		return d
	})
}

describe('createTestNetwork', () => {
	test('creates a network with default 2 devices', async () => {
		network = await createTestNetwork(schema)
		expect(network.devices).toHaveLength(2)
		expect(network.server).toBeDefined()
		expect(network.devices[0]?.name).toBe('device-0')
		expect(network.devices[1]?.name).toBe('device-1')
	})

	test('creates a network with custom device count', async () => {
		network = await createTestNetwork(schema, { devices: 3 })
		expect(network.devices).toHaveLength(3)
	})

	test('creates a network with custom device names', async () => {
		network = await createTestNetwork(schema, {
			deviceNames: ['alice', 'bob', 'charlie'],
		})
		expect(network.devices).toHaveLength(3)
		expect(network.devices[0]?.name).toBe('alice')
		expect(network.devices[1]?.name).toBe('bob')
		expect(network.devices[2]?.name).toBe('charlie')
	})

	test('each device has a unique node ID', async () => {
		network = await createTestNetwork(schema, { devices: 3 })
		const nodeIds = network.devices.map((d) => d.getNodeId())
		expect(new Set(nodeIds).size).toBe(3)
	})
})

describe('Basic sync flow', () => {
	test('insert on device A syncs to device B', async () => {
		network = await createTestNetwork(schema)
		const [deviceA, deviceB] = devices(0, 1)

		// Insert on device A
		await deviceA.collection('todos').insert({ title: 'Buy milk' })

		// Sync both devices
		await deviceA.sync()
		await deviceB.sync()

		// Device B should have the record
		const todosB = await deviceB.getState('todos')
		expect(todosB).toHaveLength(1)
		expect((todosB[0] as Record<string, unknown>).title).toBe('Buy milk')
	})

	test('bidirectional sync — both devices exchange data', async () => {
		network = await createTestNetwork(schema)
		const [deviceA, deviceB] = devices(0, 1)

		// Insert different records on each device
		await deviceA.collection('todos').insert({ title: 'From A' })
		await deviceB.collection('notes').insert({ text: 'From B', priority: 5 })

		// Sync both
		await deviceA.sync()
		await deviceB.sync()

		// Both should have both records
		const todosA = await deviceA.getState('todos')
		const todosB = await deviceB.getState('todos')
		const notesA = await deviceA.getState('notes')
		const notesB = await deviceB.getState('notes')

		expect(todosA).toHaveLength(1)
		expect(todosB).toHaveLength(1)
		expect(notesA).toHaveLength(1)
		expect(notesB).toHaveLength(1)
	})

	test('three devices converge', async () => {
		network = await createTestNetwork(schema, { devices: 3 })
		const [deviceA, deviceB, deviceC] = devices(0, 1, 2)

		// Each device inserts a record
		await deviceA.collection('todos').insert({ title: 'From A' })
		await deviceB.collection('todos').insert({ title: 'From B' })
		await deviceC.collection('todos').insert({ title: 'From C' })

		// Sync all devices
		await deviceA.sync()
		await deviceB.sync()
		await deviceC.sync()

		// Re-sync A and B to get C's data relayed through server
		await deviceA.disconnect()
		await deviceB.disconnect()
		await deviceA.sync()
		await deviceB.sync()

		// All should have 3 records
		const todosA = await deviceA.getState('todos')
		const todosB = await deviceB.getState('todos')
		const todosC = await deviceC.getState('todos')

		expect(todosA).toHaveLength(3)
		expect(todosB).toHaveLength(3)
		expect(todosC).toHaveLength(3)
	})
})

describe('Offline and reconnection', () => {
	test('offline mutations sync after reconnect', async () => {
		network = await createTestNetwork(schema)
		const [deviceA, deviceB] = devices(0, 1)

		// Connect, then disconnect device A
		await deviceA.sync()
		await deviceA.disconnect()

		// Insert while offline
		await deviceA.collection('todos').insert({ title: 'Offline todo' })

		// Reconnect and sync
		await deviceA.reconnect()
		await deviceB.sync()

		const todosB = await deviceB.getState('todos')
		expect(todosB).toHaveLength(1)
		expect((todosB[0] as Record<string, unknown>).title).toBe('Offline todo')
	})

	test('disconnect and reconnect cycle preserves data', async () => {
		network = await createTestNetwork(schema)
		const [deviceA, deviceB] = devices(0, 1)

		// First sync cycle
		await deviceA.collection('todos').insert({ title: 'First' })
		await deviceA.sync()
		await deviceB.sync()

		// Disconnect both
		await deviceA.disconnect()
		await deviceB.disconnect()

		// Add more data while offline
		await deviceA.collection('todos').insert({ title: 'Second from A' })
		await deviceB.collection('todos').insert({ title: 'From B offline' })

		// Reconnect and sync
		await deviceA.reconnect()
		await deviceB.reconnect()

		// Re-sync to catch relayed data
		await deviceA.disconnect()
		await deviceB.disconnect()
		await deviceA.reconnect()
		await deviceB.reconnect()

		const todosA = await deviceA.getState('todos')
		const todosB = await deviceB.getState('todos')

		expect(todosA).toHaveLength(3)
		expect(todosB).toHaveLength(3)
	})
})

describe('expectConverged', () => {
	test('passes when devices have identical state', async () => {
		network = await createTestNetwork(schema)
		const [deviceA, deviceB] = devices(0, 1)

		await deviceA.collection('todos').insert({ title: 'Shared' })
		await deviceA.sync()
		await deviceB.sync()

		// Should not throw
		await expectConverged(network.devices, schema)
	})

	test('fails when devices have different state', async () => {
		network = await createTestNetwork(schema)
		const [deviceA] = devices(0)

		// Insert on A without syncing
		await deviceA.collection('todos').insert({ title: 'Only on A' })

		// Should throw
		await expect(expectConverged(network.devices, schema)).rejects.toThrow(
			'Devices have not converged',
		)
	})

	test('checkConvergence returns detailed differences', async () => {
		network = await createTestNetwork(schema)
		const [deviceA] = devices(0)

		await deviceA.collection('todos').insert({ title: 'Only on A' })

		const result = await checkConvergence(network.devices, schema)
		expect(result.converged).toBe(false)
		expect(result.differences).toHaveLength(1)
		expect((result.differences[0] as Record<string, unknown>).collection).toBe('todos')
	})

	test('passes with single device', async () => {
		network = await createTestNetwork(schema, { devices: 1 })
		// Should not throw — nothing to compare
		await expectConverged(network.devices, schema)
	})
})

describe('Multi-collection sync', () => {
	test('syncs multiple collections independently', async () => {
		network = await createTestNetwork(schema)
		const [deviceA, deviceB] = devices(0, 1)

		await deviceA.collection('todos').insert({ title: 'Todo 1' })
		await deviceA.collection('todos').insert({ title: 'Todo 2' })
		await deviceA.collection('notes').insert({ text: 'Note 1' })

		await deviceA.sync()
		await deviceB.sync()

		const todosB = await deviceB.getState('todos')
		const notesB = await deviceB.getState('notes')

		expect(todosB).toHaveLength(2)
		expect(notesB).toHaveLength(1)
		expect((notesB[0] as Record<string, unknown>).text).toBe('Note 1')

		await expectConverged(network.devices, schema)
	})
})

describe('Update and delete sync', () => {
	test('updates sync between devices', async () => {
		network = await createTestNetwork(schema)
		const [deviceA, deviceB] = devices(0, 1)

		const record = await deviceA.collection('todos').insert({ title: 'Original' })
		await deviceA.sync()
		await deviceB.sync()

		// Update on A
		await deviceA.collection('todos').update(record.id as string, { title: 'Updated' })
		await deviceA.disconnect()
		await deviceA.sync()
		await deviceB.disconnect()
		await deviceB.sync()

		const todosB = await deviceB.getState('todos')
		expect(todosB).toHaveLength(1)
		expect((todosB[0] as Record<string, unknown>).title).toBe('Updated')
	})

	test('deletes sync between devices', async () => {
		network = await createTestNetwork(schema)
		const [deviceA, deviceB] = devices(0, 1)

		const record = await deviceA.collection('todos').insert({ title: 'To delete' })
		await deviceA.sync()
		await deviceB.sync()

		// Delete on A
		await deviceA.collection('todos').delete(record.id as string)
		await deviceA.disconnect()
		await deviceA.sync()
		await deviceB.disconnect()
		await deviceB.sync()

		const todosB = await deviceB.getState('todos')
		expect(todosB).toHaveLength(0)
	})
})
