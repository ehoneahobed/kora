import { defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import { createTestNetwork } from '../src'

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
 * PRODUCTION_PATH: durable queue + op-log pending semantics across reconnect.
 */
describe('PRODUCTION_PATH sync reconnect', () => {
	let closeNetwork: (() => Promise<void>) | null = null

	afterEach(async () => {
		if (closeNetwork) {
			await closeNetwork()
			closeNetwork = null
		}
	})

	test('op log counts unsynced ops before first connect', async () => {
		const network = await createTestNetwork(schema, { devices: 1 })
		closeNetwork = () => network.close()

		const device = network.devices[0]
		if (!device) {
			return
		}

		await device.collection('todos').insert({ title: 'Offline' })
		await device.collection('todos').insert({ title: 'Also offline' })

		const unsynced = await device.store.countUnsyncedOperations(new Map())
		expect(unsynced).toBe(2)
	})

	test('reconnect does not grow server op log when already synced', async () => {
		const network = await createTestNetwork(schema, { devices: 1 })
		closeNetwork = () => network.close()

		const device = network.devices[0]
		if (!device) {
			return
		}

		await device.collection('todos').insert({ title: 'A' })
		await device.collection('todos').insert({ title: 'B' })
		await device.sync()
		expect(network.server.getAllOperations()).toHaveLength(2)

		await device.disconnect()
		await device.reconnect()

		expect(network.server.getAllOperations()).toHaveLength(2)

		const engine = device.getSyncEngine()
		expect(engine).not.toBeNull()
		const pending = await engine?.getPendingSyncOperations()
		expect(pending?.length ?? 0).toBe(0)
		expect(engine?.getStatus().pendingOperations).toBe(0)
	})

	test('offline ops after disconnect sync on reconnect', async () => {
		const network = await createTestNetwork(schema, { devices: 1 })
		closeNetwork = () => network.close()

		const device = network.devices[0]
		if (!device) {
			return
		}

		await device.collection('todos').insert({ title: 'Synced' })
		await device.sync()
		await device.disconnect()

		await device.collection('todos').insert({ title: 'After disconnect' })
		const ackedBefore = await device.store.loadLastAckedServerVector()
		expect(await device.store.countUnsyncedOperations(ackedBefore)).toBe(1)

		await device.reconnect()
		expect(network.server.getAllOperations()).toHaveLength(2)

		const ackedAfter = await device.store.loadLastAckedServerVector()
		expect(await device.store.countUnsyncedOperations(ackedAfter)).toBe(0)
	})
})
