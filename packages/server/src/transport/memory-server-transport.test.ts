import type { SyncMessage } from '@kora/sync'
import { describe, expect, test, vi } from 'vitest'
import { MemoryServerTransport, createServerTransportPair } from './memory-server-transport'

const handshakeMsg: SyncMessage = {
	type: 'handshake',
	messageId: 'msg-1',
	nodeId: 'client-1',
	versionVector: {},
	schemaVersion: 1,
}

const handshakeResponseMsg: SyncMessage = {
	type: 'handshake-response',
	messageId: 'msg-2',
	nodeId: 'server-1',
	versionVector: {},
	schemaVersion: 1,
	accepted: true,
}

describe('MemoryServerTransport', () => {
	test('messages flow from client to server', () => {
		const { client, server } = createServerTransportPair()
		const handler = vi.fn()
		server.onMessage(handler)

		client.send(handshakeMsg)

		expect(handler).toHaveBeenCalledOnce()
		expect(handler).toHaveBeenCalledWith(handshakeMsg)
	})

	test('messages flow from server to client', () => {
		const { client, server } = createServerTransportPair()
		const handler = vi.fn()
		client.onMessage(handler)

		server.send(handshakeResponseMsg)

		expect(handler).toHaveBeenCalledOnce()
		expect(handler).toHaveBeenCalledWith(handshakeResponseMsg)
	})

	test('client disconnect notifies server', () => {
		const { client, server } = createServerTransportPair()
		const closeHandler = vi.fn()
		server.onClose(closeHandler)

		client.disconnect()

		expect(closeHandler).toHaveBeenCalledOnce()
		expect(closeHandler).toHaveBeenCalledWith(1000, 'client disconnected')
		expect(server.isConnected()).toBe(false)
	})

	test('server close notifies client', () => {
		const { client, server } = createServerTransportPair()
		const closeHandler = vi.fn()
		client.onClose(closeHandler)

		server.close(1000, 'server shutdown')

		expect(closeHandler).toHaveBeenCalledOnce()
		expect(closeHandler).toHaveBeenCalledWith('server disconnected')
		expect(client.isConnected()).toBe(false)
	})

	test('isConnected reflects connection state', () => {
		const { client, server } = createServerTransportPair()
		expect(server.isConnected()).toBe(true)
		expect(client.isConnected()).toBe(true)

		client.disconnect()

		expect(server.isConnected()).toBe(false)
		expect(client.isConnected()).toBe(false)
	})

	test('getSentMessages tracks server-sent messages', () => {
		const { server } = createServerTransportPair()

		server.send(handshakeResponseMsg)
		server.send(handshakeResponseMsg)

		const sent = server.getSentMessages()
		expect(sent).toHaveLength(2)
		expect(sent[0]).toEqual(handshakeResponseMsg)
	})
})
