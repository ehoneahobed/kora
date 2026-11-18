import { defineSchema, t } from '@korajs/core'
import type { AwarenessChange } from '@korajs/sync'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { type TestNetwork, createTestNetwork } from '../src'

/**
 * Presence lasts only while connected (docs/guide/presence.md): when a device's sync session
 * ends, the other people it showed are gone from it at once, and a change says so. Its own
 * state stays and is sent again on reconnect, when the server's catch-up brings the others back.
 */
const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { title: t.string() } } },
})

type Dropping = {
	simulateDisconnect(reason: string): void
	simulateError(error: Error): void
	disconnect(): Promise<void>
}

/** A network drop ends both sides: the server's session, then the client's transport. */
async function drop(transport: Dropping, how: 'close' | 'error'): Promise<void> {
	await transport.disconnect()
	if (how === 'close') transport.simulateDisconnect('network lost')
	else transport.simulateError(new Error('network lost'))
}

let network: TestNetwork | null = null
afterEach(async () => {
	await network?.close()
	network = null
})

async function twoDevicesSeeingEachOther() {
	const transports: Dropping[] = []
	network = await createTestNetwork(schema, {
		devices: 2,
		wrapTransport: (pair) => {
			transports.push(pair.client as unknown as Dropping)
			return pair
		},
	})
	const [a, b] = network.devices
	if (!a || !b) throw new Error('two devices expected')
	await a.sync()
	await b.sync()
	const awarenessA = a.getSyncEngine()?.getAwarenessManager()
	const awarenessB = b.getSyncEngine()?.getAwarenessManager()
	if (!awarenessA || !awarenessB) throw new Error('awareness expected')
	awarenessA.setLocalState({ user: { name: 'Ada', color: '#f00' } })
	awarenessB.setLocalState({ user: { name: 'Bob', color: '#00f' } })
	await vi.waitFor(() => {
		expect(awarenessA.getStates().size).toBe(2)
		expect(awarenessB.getStates().size).toBe(2)
	})
	return { a, awarenessA, transportA: transports[0] as Dropping }
}

const names = (states: Map<number, { user: { name: string } }>) =>
	[...states.values()].map((state) => state.user.name).sort()

describe('remote presence ends with the sync session', () => {
	for (const how of ['close', 'error'] as const) {
		test(`when the transport ${how === 'close' ? 'closes' : 'fails'}, only the device's own presence stays`, async () => {
			const { awarenessA, transportA } = await twoDevicesSeeingEachOther()
			const changes: AwarenessChange[] = []
			awarenessA.on('change', (change) => changes.push(change))
			await drop(transportA, how)
			await vi.waitFor(() => expect(names(awarenessA.getStates())).toEqual(['Ada']))
			expect(changes.some((change) => change.removed.length === 1)).toBe(true)
		})
	}

	test('after reconnecting, the server catch-up shows the others again', async () => {
		const { a, awarenessA, transportA } = await twoDevicesSeeingEachOther()
		await drop(transportA, 'close')
		await vi.waitFor(() => expect(names(awarenessA.getStates())).toEqual(['Ada']))
		await a.disconnect()
		await a.reconnect()
		const fresh = a.getSyncEngine()?.getAwarenessManager()
		fresh?.setLocalState({ user: { name: 'Ada', color: '#f00' } })
		await vi.waitFor(() => expect(names(fresh?.getStates() ?? new Map())).toEqual(['Ada', 'Bob']))
	})
})
