import type { SyncMessage } from '@korajs/sync'
import { describe, expect, test, vi } from 'vitest'
import WebSocket from 'ws'
import { KoraSyncServer } from '../../src/server/kora-sync-server'
import { createProductionServer } from '../../src/server/production-server'
import { MemoryServerStore } from '../../src/store/memory-server-store'
import { createServerTransportPair } from '../../src/transport/memory-server-transport'

/**
 * A session handles its messages one at a time, so frames that arrive while it waits (on a
 * slow sign-in, or a large batch) queue. The queue is bounded: a peer cannot hold the server's
 * memory with parsed frames it sends faster than they are handled.
 */
const handshake = (messageId: string): SyncMessage => ({
	type: 'handshake',
	protocolVersion: 2,
	messageId,
	nodeId: 'flooder',
	versionVector: {},
	schemaVersion: 1,
	authToken: 'token',
})

describe('the inbound queue of a session is bounded', () => {
	test('frames sent while sign-in is pending close the session with a retriable error', async () => {
		const server = createProductionServer({
			store: new MemoryServerStore('s'),
			port: 0,
			staticDir: '/nonexistent',
			syncOptions: { auth: { authenticate: () => new Promise(() => {}) } },
		})
		const base = await server.start()
		try {
			const ws = new WebSocket(`${base.replace('http', 'ws')}/kora-sync`)
			await new Promise((resolve) => ws.once('open', resolve))
			const received: Array<{ type: string; code?: string; retriable?: boolean }> = []
			ws.on('message', (data) => received.push(JSON.parse(String(data))))
			const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()))
			ws.send(JSON.stringify(handshake('hs')))
			const padding = 'x'.repeat(1024 * 1024)
			let sent = 0
			for (; sent < 1000 && ws.readyState === WebSocket.OPEN; sent++) {
				await new Promise<void>((resolve) =>
					ws.send(
						JSON.stringify({
							type: 'operation-batch',
							messageId: `m${sent}`,
							isFinal: true,
							batchIndex: 0,
							operations: [
								{
									id: `op-${sent}`,
									nodeId: 'flooder',
									type: 'insert',
									collection: 'todos',
									recordId: `r-${sent}`,
									data: { title: padding },
									previousData: null,
									timestamp: { wallTime: Date.now(), logical: sent, nodeId: 'flooder' },
									sequenceNumber: sent + 1,
									causalDeps: [],
									schemaVersion: 1,
								},
							],
						}),
						() => resolve(),
					),
				)
			}
			await closed
			const error = received.find((message) => message.type === 'error')
			expect(error).toMatchObject({ code: 'INBOUND_QUEUE_FULL', retriable: true })
			expect(sent).toBeLessThan(200)
		} finally {
			await server.stop()
		}
	}, 60_000)

	test('a flood after the handshake beyond the cap closes the session', async () => {
		const store = new MemoryServerStore('s')
		const server = new KoraSyncServer({ store })
		const { client, server: transport } = createServerTransportPair()
		const messages: SyncMessage[] = []
		client.onMessage((message) => messages.push(message))
		server.handleConnection(transport)
		const { authToken: _token, ...anonymous } = handshake('hs') as SyncMessage & {
			authToken?: string
		}
		client.send(anonymous as SyncMessage)
		await vi.waitFor(() => expect(messages.some((m) => m.type === 'handshake-response')).toBe(true))
		for (let i = 0; i < 1100 && client.isConnected(); i++) {
			client.send({
				type: 'acknowledgment',
				messageId: `a${i}`,
				acknowledgedMessageId: 'none',
				lastSequenceNumber: 0,
			})
		}
		await vi.waitFor(() =>
			expect(messages.find((m) => m.type === 'error')).toMatchObject({
				code: 'INBOUND_QUEUE_FULL',
				retriable: true,
			}),
		)
		await server.stop()
	})
})
