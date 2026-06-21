import { defineSchema, t } from '@korajs/core'
import type { SyncEngine } from '@korajs/sync'
import { afterEach, describe, expect, test } from 'vitest'
import * as Y from 'yjs'
import { createTestNetwork } from '../src'

const schema = defineSchema({
	version: 1,
	collections: {
		articles: {
			fields: {
				title: t.string(),
				body: t.richtext(),
			},
		},
	},
})

describe('Yjs doc channel (real sync path)', () => {
	let closeNetwork: (() => Promise<void>) | null = null

	afterEach(async () => {
		if (closeNetwork) {
			await closeNetwork()
			closeNetwork = null
		}
	})

	test('relays incremental updates between devices', async () => {
		const network = await createTestNetwork(schema, { devices: 2 })
		closeNetwork = () => network.close()

		const [deviceA, deviceB] = network.devices
		const record = await deviceA.collection('articles').insert({
			title: 'Doc channel',
			body: 'x'.repeat(5000),
		})

		await deviceA.sync()
		await deviceB.sync()

		const engineA = deviceA.getSyncEngine()
		const engineB = deviceB.getSyncEngine()
		await waitForStreaming(engineA)
		await waitForStreaming(engineB)
		expect(engineA).not.toBeNull()
		expect(engineB).not.toBeNull()

		const channelA = engineA?.getRichtextDocChannel()
		const channelB = engineB?.getRichtextDocChannel()
		expect(channelA?.shouldUseChannel(5000)).toBe(true)

		const received: Uint8Array[] = []
		const unsubscribe = channelB?.subscribe('articles', record.id, 'body', (update) => {
			received.push(update)
		})

		const doc = new Y.Doc()
		doc.getText('content').insert(0, 'Hello')
		const delta = Y.encodeStateAsUpdate(doc)
		channelA?.send('articles', record.id, 'body', delta)

		await waitForReceived(received, 2000)

		expect(received.length).toBeGreaterThan(0)
		const merged = new Y.Doc()
		Y.applyUpdate(merged, received[0] as Uint8Array)
		expect(merged.getText('content').toString()).toBe('Hello')

		unsubscribe?.()
	})
})

async function waitForStreaming(engine: SyncEngine | null | undefined): Promise<void> {
	const deadline = Date.now() + 5000
	while (engine && engine.getState() !== 'streaming') {
		if (Date.now() > deadline) {
			throw new Error(`sync engine stuck in ${engine.getState()}`)
		}
		await wait(10)
	}
}

async function waitForReceived(received: Uint8Array[], timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (received.length === 0) {
		if (Date.now() > deadline) {
			throw new Error('timed out waiting for yjs-doc-update relay')
		}
		await wait(10)
	}
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}
