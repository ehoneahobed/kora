/**
 * RT-61: no device may hand-shake as the server. The server's node ids (the store's
 * `kora:server:` id, every id in the `kora:` namespace, legacy and configured server
 * ids) are refused at handshake with a non-retriable INVALID_NODE_ID, whatever the
 * transport (memory, WebSocket, HTTP long-poll), whether or not the id has history.
 */
import type { SyncMessage } from '@korajs/sync'
import { JsonMessageSerializer } from '@korajs/sync'
import { describe, expect, test, vi } from 'vitest'
import WebSocket from 'ws'
import { KoraSyncServer } from '../server/kora-sync-server'
import { createProductionServer } from '../server/production-server'
import { MemoryServerStore } from '../store/memory-server-store'
import { createServerTransportPair } from '../transport/memory-server-transport'

const serializer = new JsonMessageSerializer()

function handshake(nodeId: string): SyncMessage {
	return {
		type: 'handshake',
		messageId: `hs-${nodeId}`,
		nodeId,
		versionVector: {},
		schemaVersion: 1,
		protocolVersion: 2,
		sequenceReservation: true,
	} as unknown as SyncMessage
}

function forbiddenIds(store: MemoryServerStore): string[] {
	return [store.getNodeId(), 'server-legacy', 'kora:server:other-deployment:7', 'kora:scope-entry']
}

describe('RT-61: server node ids are refused at handshake', () => {
	test('memory transport: each server id is refused non-retriably; a device id is accepted', async () => {
		const store = new MemoryServerStore('server-legacy')
		const server = new KoraSyncServer({
			store,
			relayRetransmitIntervalMs: 0,
			deliveryPollIntervalMs: 0,
		})
		for (const nodeId of [...forbiddenIds(store), 'device-1']) {
			const { client, server: transport } = createServerTransportPair()
			const messages: SyncMessage[] = []
			client.onMessage((m) => messages.push(m))
			server.handleConnection(transport)
			client.send(handshake(nodeId))
			await vi.waitFor(() =>
				expect(messages.some((m) => m.type === 'handshake-response' || m.type === 'error')).toBe(
					true,
				),
			)
			const error = messages.find((m) => m.type === 'error') as
				| (SyncMessage & { code: string; retriable: boolean })
				| undefined
			if (nodeId === 'device-1') {
				expect(error).toBeUndefined()
			} else {
				expect(error).toMatchObject({ code: 'INVALID_NODE_ID', retriable: false })
				expect(messages.some((m) => m.type === 'handshake-response')).toBe(false)
			}
		}
		await server.stop()
	})

	test('WebSocket: the server node id is refused', async () => {
		const store = new MemoryServerStore('server-legacy')
		const production = createProductionServer({ store, port: 0, staticDir: '/nonexistent' })
		const base = await production.start()
		try {
			for (const nodeId of [store.getNodeId(), 'server-legacy']) {
				const ws = new WebSocket(`${base.replace('http', 'ws')}/kora-sync`)
				const received: SyncMessage[] = []
				ws.on('message', (data, isBinary) => {
					received.push(serializer.decode(isBinary ? new Uint8Array(data as Buffer) : String(data)))
				})
				await new Promise<void>((resolve) => ws.once('open', () => resolve()))
				ws.send(serializer.encode(handshake(nodeId)) as string)
				await vi.waitFor(() => expect(received.some((m) => m.type === 'error')).toBe(true))
				expect(received.find((m) => m.type === 'error')).toMatchObject({
					code: 'INVALID_NODE_ID',
					retriable: false,
				})
				expect(received.some((m) => m.type === 'handshake-response')).toBe(false)
				ws.close()
			}
		} finally {
			await production.stop()
		}
	})

	test('HTTP long-poll: the server node id is refused', async () => {
		const store = new MemoryServerStore('server-legacy')
		const server = new KoraSyncServer({ store, serializer })
		for (const nodeId of [store.getNodeId(), 'server-legacy']) {
			const opened = await server.handleHttpRequest({
				method: 'POST',
				contentType: 'application/json',
				body: serializer.encode(handshake(nodeId)) as string,
			})
			const sessionId = opened.headers?.['x-kora-session']
			// Either the POST is refused outright, or the session's first message is the error.
			if (opened.status === 202 && sessionId) {
				let message: SyncMessage | null = null
				await vi.waitFor(async () => {
					const poll = await server.handleHttpRequest({ sessionId, method: 'GET' })
					if (poll.status === 200) message = serializer.decode(poll.body as string)
					expect(message).not.toBeNull()
				})
				expect(message).toMatchObject({ type: 'error', code: 'INVALID_NODE_ID', retriable: false })
			} else {
				expect(opened.status).toBeGreaterThanOrEqual(400)
			}
		}
		await server.stop()
	})
})
