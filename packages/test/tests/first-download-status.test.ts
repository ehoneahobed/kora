import { defineSchema, t } from '@korajs/core'
import { summarizeSyncStatus } from '@korajs/sync'
import { afterEach, expect, test } from 'vitest'
import { type TestNetwork, createTestNetwork } from '../src/index'

/**
 * Apps gate first-run screens on "the device's first download is not finished" (an empty list
 * can mean "not here yet"). The engine resets its catch-up counters every session, so the status
 * must say which catch-up is the first: a reconnect's catch-up, with the data already here, must
 * not read as downloading, or a restarted till would show "Downloading your shop" every time.
 */
const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { text: t.string() } } },
})

let network: TestNetwork | null = null
afterEach(async () => {
	await network?.close()
	network = null
})

test('a new device’s catch-up is its first download; after a reconnect it is not', async () => {
	network = await createTestNetwork(schema, { devices: 2 })
	const [writer, reader] = network.devices
	if (!writer || !reader) throw new Error('expected two devices')
	await writer.sync()
	await writer.collection('notes').insert({ text: 'hello' })
	await writer.sync()

	await reader.sync()
	const firstSession = reader.getSyncEngine()?.getStatus()
	expect(firstSession?.initialSync?.first).toBe(true)
	expect((await reader.getState('notes')).length).toBe(1)

	await reader.disconnect()
	await reader.reconnect()
	await reader.sync()
	const reconnected = reader.getSyncEngine()?.getStatus()
	expect(reconnected?.initialSync?.first).toBe(false)
	if (reconnected) {
		// Mid catch-up, the summary must call it syncing, not downloading.
		const midCatchUp = {
			...reconnected,
			status: 'syncing' as const,
			initialSync: {
				...reconnected.initialSync,
				complete: false,
				receivedBatches: 0,
				totalBatches: null,
				progress: null,
				first: false,
			},
		}
		expect(summarizeSyncStatus(midCatchUp).downloading).toBe(false)
	}
})
