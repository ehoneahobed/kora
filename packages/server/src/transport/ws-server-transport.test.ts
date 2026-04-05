import {
	type SyncMessage,
	NegotiatedMessageSerializer,
	ProtobufMessageSerializer,
} from '@korajs/sync'
import { describe, expect, test, vi } from 'vitest'
import type { WsWebSocket } from './ws-server-transport'
import { WsServerTransport } from './ws-server-transport'

const WS_OPEN = 1
const WS_CLOSED = 3

function createMockWs(readyState = WS_OPEN): WsWebSocket & {
	listeners: Map<string, ((...args: unknown[]) => void)[]>
	trigger: (event: string, ...args: unknown[]) => void
} {
	const listeners = new Map<string, ((...args: unknown[]) => void)[]>()
	return {
		readyState,
		send: vi.fn(),
		close: vi.fn(),
		on(event: string, listener: (...args: unknown[]) => void) {
			const list = listeners.get(event) ?? []
			list.push(listener)
			listeners.set(event, list)
		},
		removeAllListeners: vi.fn(),
		listeners,
		trigger(event: string, ...args: unknown[]) {
			const list = listeners.get(event) ?? []
			for (const fn of list) fn(...args)
		},
	}
}

const handshakeMsg: SyncMessage = {
	type: 'handshake',
	messageId: 'msg-1',
	nodeId: 'client-1',
	versionVector: {},
	schemaVersion: 1,
}

describe('WsServerTransport', () => {
	test('send encodes and sends message via ws', () => {
		const ws = createMockWs()
		const transport = new WsServerTransport(ws)

		transport.send(handshakeMsg)

		expect(ws.send).toHaveBeenCalledOnce()
		const sent = (ws.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
		expect(JSON.parse(sent as string)).toEqual(handshakeMsg)
	})

	test('send throws when WebSocket is not open', () => {
		const ws = createMockWs(WS_CLOSED)
		const transport = new WsServerTransport(ws)

		expect(() => transport.send(handshakeMsg)).toThrow('WebSocket is not open')
	})

	test('incoming message is decoded and forwarded to handler', () => {
		const ws = createMockWs()
		const transport = new WsServerTransport(ws)
		const handler = vi.fn()
		transport.onMessage(handler)

		ws.trigger('message', JSON.stringify(handshakeMsg))

		expect(handler).toHaveBeenCalledOnce()
		expect(handler).toHaveBeenCalledWith(handshakeMsg)
	})

	test('handles protobuf payloads with negotiated serializer', () => {
		const ws = createMockWs()
		const serializer = new NegotiatedMessageSerializer('protobuf')
		const transport = new WsServerTransport(ws, { serializer })
		const handler = vi.fn()
		transport.onMessage(handler)

		const payload = new ProtobufMessageSerializer().encode(handshakeMsg)
		ws.trigger('message', payload)

		expect(handler).toHaveBeenCalledWith(handshakeMsg)
	})

	test('invalid incoming message triggers error handler', () => {
		const ws = createMockWs()
		const transport = new WsServerTransport(ws)
		const errorHandler = vi.fn()
		transport.onError(errorHandler)

		ws.trigger('message', 'not valid json {{{')

		expect(errorHandler).toHaveBeenCalledOnce()
		expect(errorHandler.mock.calls[0]?.[0]).toBeInstanceOf(Error)
	})

	test('close event is forwarded to close handler', () => {
		const ws = createMockWs()
		const transport = new WsServerTransport(ws)
		const closeHandler = vi.fn()
		transport.onClose(closeHandler)

		ws.trigger('close', 1000, 'normal')

		expect(closeHandler).toHaveBeenCalledWith(1000, 'normal')
	})

	test('error event is forwarded to error handler', () => {
		const ws = createMockWs()
		const transport = new WsServerTransport(ws)
		const errorHandler = vi.fn()
		transport.onError(errorHandler)

		const err = new Error('connection reset')
		ws.trigger('error', err)

		expect(errorHandler).toHaveBeenCalledWith(err)
	})

	test('isConnected returns true when ws is open', () => {
		const ws = createMockWs(WS_OPEN)
		const transport = new WsServerTransport(ws)
		expect(transport.isConnected()).toBe(true)
	})

	test('isConnected returns false when ws is closed', () => {
		const ws = createMockWs(WS_CLOSED)
		const transport = new WsServerTransport(ws)
		expect(transport.isConnected()).toBe(false)
	})

	test('close calls ws.close with code and reason', () => {
		const ws = createMockWs()
		const transport = new WsServerTransport(ws)

		transport.close(4001, 'auth failed')

		expect(ws.close).toHaveBeenCalledWith(4001, 'auth failed')
	})
})
