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

async function connect(
	server: KoraSyncServer,
	nodeId = 'node-1',
): Promise<{
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
		nodeId,
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

	test('blobLimits reach the relay: the pending cap and the request lifetime', async () => {
		const store = new MemoryServerStore('s')
		await store.setSchema(schema)
		const server = new KoraSyncServer({
			store,
			blobLimits: { maxPendingRequestsPerSession: 1, pendingRequestTtlMs: 5_000 },
			relayRetransmitIntervalMs: 0,
			deliveryPollIntervalMs: 0,
		})
		const requester = await connect(server, 'node-1')
		const peer = await connect(server, 'node-2')
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
		try {
			const ask = (requestId: string): void =>
				requester.send({
					type: 'blob-chunk-request',
					messageId: `m-${requestId}`,
					requestId,
					hash: 'b'.repeat(64),
				} as SyncMessage)
			const answers = () =>
				requester.messages.filter((m) => m.type === 'blob-chunk-response') as Array<{
					requestId: string
					bytes: unknown
					throttled?: boolean
				}>
			// Without advancing the clock (vi.waitFor would advance fake time).
			const settle = async (done: () => boolean): Promise<void> => {
				for (let i = 0; i < 200 && !done(); i++) await vi.advanceTimersByTimeAsync(0)
			}
			ask('r1')
			await settle(() => peer.messages.some((m) => m.type === 'blob-chunk-request'))
			ask('r2')
			await settle(() => answers().length > 0)
			expect(answers()).toHaveLength(1)
			expect(answers()[0]).toMatchObject({ requestId: 'r2', throttled: true })
			await vi.advanceTimersByTimeAsync(4_999)
			expect(answers()).toHaveLength(1)
			await vi.advanceTimersByTimeAsync(1)
			expect(answers()[1]).toMatchObject({ requestId: 'r1', bytes: null })
		} finally {
			vi.useRealTimers()
			await server.stop()
		}
	})
})
