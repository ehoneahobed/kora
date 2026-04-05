import { SyncError } from '@korajs/core'
import { describe, expect, test, vi } from 'vitest'
import type { HandshakeMessage } from '../protocol/messages'
import { MemoryTransport, createMemoryTransportPair } from './memory-transport'

function makeHandshake(nodeId: string): HandshakeMessage {
	return {
		type: 'handshake',
		messageId: `msg-${nodeId}`,
		nodeId,
		versionVector: {},
		schemaVersion: 1,
	}
}

describe('createMemoryTransportPair', () => {
	test('creates linked client and server transports', () => {
		const { client, server } = createMemoryTransportPair()
		expect(client).toBeInstanceOf(MemoryTransport)
		expect(server).toBeInstanceOf(MemoryTransport)
	})

	test('both start disconnected', () => {
		const { client, server } = createMemoryTransportPair()
		expect(client.isConnected()).toBe(false)
		expect(server.isConnected()).toBe(false)
	})

	test('connect sets both sides as connected', async () => {
		const { client, server } = createMemoryTransportPair()
		await client.connect('ws://test')
		expect(client.isConnected()).toBe(true)
		expect(server.isConnected()).toBe(true)
	})
})

describe('MemoryTransport message delivery', () => {
	test('client sends to server', async () => {
		const { client, server } = createMemoryTransportPair()
		const handler = vi.fn()
		server.onMessage(handler)

		await client.connect('ws://test')
		client.send(makeHandshake('client-1'))

		expect(handler).toHaveBeenCalledTimes(1)
		expect(handler).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'handshake', nodeId: 'client-1' }),
		)
	})

	test('server sends to client', async () => {
		const { client, server } = createMemoryTransportPair()
		const handler = vi.fn()
		client.onMessage(handler)

		await client.connect('ws://test')
		server.send(makeHandshake('server-1'))

		expect(handler).toHaveBeenCalledTimes(1)
		expect(handler).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'handshake', nodeId: 'server-1' }),
		)
	})

	test('bidirectional communication', async () => {
		const { client, server } = createMemoryTransportPair()
		const clientHandler = vi.fn()
		const serverHandler = vi.fn()
		client.onMessage(clientHandler)
		server.onMessage(serverHandler)

		await client.connect('ws://test')

		client.send(makeHandshake('client-1'))
		server.send(makeHandshake('server-1'))

		expect(serverHandler).toHaveBeenCalledTimes(1)
		expect(clientHandler).toHaveBeenCalledTimes(1)
	})

	test('getSentMessages tracks sent messages', async () => {
		const { client } = createMemoryTransportPair()
		await client.connect('ws://test')

		const msg1 = makeHandshake('n1')
		const msg2 = makeHandshake('n2')
		client.send(msg1)
		client.send(msg2)

		expect(client.getSentMessages()).toHaveLength(2)
		expect(client.getSentMessages()[0]).toEqual(msg1)
		expect(client.getSentMessages()[1]).toEqual(msg2)
	})

	test('clearSentMessages resets history', async () => {
		const { client } = createMemoryTransportPair()
		await client.connect('ws://test')

		client.send(makeHandshake('n1'))
		client.clearSentMessages()

		expect(client.getSentMessages()).toHaveLength(0)
	})
})

describe('MemoryTransport disconnect', () => {
	test('disconnect sets both sides as disconnected', async () => {
		const { client, server } = createMemoryTransportPair()
		await client.connect('ws://test')
		await client.disconnect()

		expect(client.isConnected()).toBe(false)
		expect(server.isConnected()).toBe(false)
	})

	test('disconnect triggers close handler on peer', async () => {
		const { client, server } = createMemoryTransportPair()
		const handler = vi.fn()
		server.onClose(handler)

		await client.connect('ws://test')
		await client.disconnect()

		expect(handler).toHaveBeenCalledWith('peer disconnected')
	})

	test('disconnect is no-op when already disconnected', async () => {
		const { client } = createMemoryTransportPair()
		// Should not throw
		await client.disconnect()
	})

	test('send throws when disconnected', async () => {
		const { client } = createMemoryTransportPair()
		await client.connect('ws://test')
		await client.disconnect()

		expect(() => client.send(makeHandshake('n1'))).toThrow(SyncError)
	})
})

describe('MemoryTransport simulation helpers', () => {
	test('simulateIncoming delivers to message handler', () => {
		const transport = new MemoryTransport()
		const handler = vi.fn()
		transport.onMessage(handler)

		transport.simulateIncoming(makeHandshake('sim'))
		expect(handler).toHaveBeenCalledWith(expect.objectContaining({ nodeId: 'sim' }))
	})

	test('simulateDisconnect triggers close handler', () => {
		const transport = new MemoryTransport()
		const handler = vi.fn()
		transport.onClose(handler)

		transport.simulateDisconnect('test reason')
		expect(handler).toHaveBeenCalledWith('test reason')
		expect(transport.isConnected()).toBe(false)
	})

	test('simulateError triggers error handler', () => {
		const transport = new MemoryTransport()
		const handler = vi.fn()
		transport.onError(handler)

		const err = new Error('test error')
		transport.simulateError(err)
		expect(handler).toHaveBeenCalledWith(err)
	})

	test('connect throws if no peer linked', async () => {
		const transport = new MemoryTransport()
		await expect(transport.connect('ws://test')).rejects.toThrow(SyncError)
	})
})
