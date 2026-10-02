import { defineSchema, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { describe, expect, test, vi } from 'vitest'
import { KoraSyncServer } from '../server/kora-sync-server'
import { MemoryServerStore } from '../store/memory-server-store'
import { createServerTransportPair } from '../transport/memory-server-transport'

const schema = defineSchema({
	version: 1,
	collections: { files: { fields: { name: t.string() } } },
})

async function connect(server: KoraSyncServer): Promise<{
	messages: SyncMessage[]
	send: (m: SyncMessage) => void
}> {
	const { client, server: transport } = createServerTransportPair()
	const messages: SyncMessage[] = []
	client.onMessage((m) => messages.push(m))
	server.handleConnection(transport)
	client.send({
		type: 'handshake',
		messageId: 'hs',
		nodeId: 'node-1',
		versionVector: {},
		schemaVersion: 1,
	} as SyncMessage)
	await vi.waitFor(() => expect(messages.some((m) => m.type === 'handshake-response')).toBe(true))
	return { messages, send: (m) => client.send(m) }
}

describe('blob request budget (RT-24)', () => {
	test('blob requests do not spend the operation budget; over their own budget they are throttled', async () => {
		const store = new MemoryServerStore('s')
		await store.setSchema(schema)
		const server = new KoraSyncServer({
			store,
			maxOpsPerMinute: 1,
			blobLimits: { maxRequestsPerMinute: 3 },
			relayRetransmitIntervalMs: 0,
			deliveryPollIntervalMs: 0,
		})
		const c = await connect(server)
		for (let i = 0; i < 5; i++) {
			c.send({
				type: 'blob-chunk-request',
				messageId: `m${i}`,
				requestId: `r${i}`,
				hash: 'a'.repeat(64),
			} as SyncMessage)
		}
		await vi.waitFor(() =>
			expect(c.messages.filter((m) => m.type === 'blob-chunk-response').length).toBe(5),
		)
		const responses = c.messages.filter((m) => m.type === 'blob-chunk-response') as Array<{
			requestId: string
			throttled?: boolean
			retryAfterMs?: number
		}>
		// The first three are answered normally ("not held": nobody has the hash).
		expect(responses.slice(0, 3).every((r) => r.throttled !== true)).toBe(true)
		expect(responses.slice(3).every((r) => r.throttled === true)).toBe(true)
		expect(responses[3]?.retryAfterMs).toBeGreaterThan(0)
		await server.stop()
	})
})
