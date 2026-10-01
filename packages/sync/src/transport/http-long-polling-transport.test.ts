import { describe, expect, test, vi } from 'vitest'
import type { SyncMessage } from '../protocol/messages'
import { JsonMessageSerializer, ProtobufMessageSerializer } from '../protocol/serializer'
import { HttpLongPollingTransport } from './http-long-polling-transport'
import type { SyncTransport } from './transport'

function handshakeResponse(): SyncMessage {
	return {
		type: 'handshake-response',
		messageId: 'resp-1',
		nodeId: 'server',
		versionVector: {},
		schemaVersion: 1,
		accepted: true,
	}
}

const handshake: SyncMessage = {
	type: 'handshake',
	messageId: 'hs-1',
	nodeId: 'node-1',
	versionVector: {},
	schemaVersion: 1,
}

/** The server's answer to the session-opening POST: 202 plus the issued session id. */
function sessionOpened(id = 's'.repeat(43)): Response {
	return new Response(null, { status: 202, headers: { 'x-kora-session': id } })
}

describe('HttpLongPollingTransport', () => {
	test('polls JSON messages and forwards decoded payloads', async () => {
		const serializer = new JsonMessageSerializer()
		const responseMessage = serializer.encode(handshakeResponse())

		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(sessionOpened())
			.mockResolvedValueOnce(
				new Response(responseMessage, {
					status: 200,
					headers: { 'content-type': 'application/json' },
				}),
			)
			.mockResolvedValue(new Response(null, { status: 204 }))

		const transport = new HttpLongPollingTransport({
			fetchImpl,
			retryDelayMs: 1,
			preferWebSocket: false,
		})

		const handler = vi.fn()
		transport.onMessage(handler)

		await transport.connect('http://localhost:3000/sync')
		transport.send(handshake)
		await new Promise((resolve) => setTimeout(resolve, 10))
		await transport.disconnect()

		expect(handler).toHaveBeenCalledWith(expect.objectContaining({ type: 'handshake-response' }))
		expect(fetchImpl).toHaveBeenCalledWith(
			'http://localhost:3000/sync',
			expect.objectContaining({ method: 'GET' }),
		)
	})

	test('does not poll before the server issues a session id (RT-2)', async () => {
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }))
		const transport = new HttpLongPollingTransport({
			fetchImpl,
			retryDelayMs: 1,
			preferWebSocket: false,
		})
		await transport.connect('http://localhost:3000/sync')
		await new Promise((resolve) => setTimeout(resolve, 10))
		await transport.disconnect()
		expect(fetchImpl).not.toHaveBeenCalled()
	})

	test('sends the bearer credential and the issued session id on every later request (RT-2)', async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(sessionOpened('issued-session-id'))
			.mockResolvedValue(new Response(null, { status: 204 }))
		const transport = new HttpLongPollingTransport({
			fetchImpl,
			retryDelayMs: 1,
			preferWebSocket: false,
		})
		await transport.connect('http://localhost:3000/sync', { authToken: 'tok' })
		transport.send(handshake)
		transport.send({
			type: 'acknowledgment',
			messageId: 'ack-1',
			acknowledgedMessageId: 'm',
			lastSequenceNumber: 0,
		})
		await new Promise((resolve) => setTimeout(resolve, 15))
		await transport.disconnect()

		const headersOf = (index: number) => new Headers(fetchImpl.mock.calls[index]?.[1]?.headers)
		const first = headersOf(0)
		expect(first.get('authorization')).toBe('Bearer tok')
		expect(first.get('x-kora-session')).toBeNull()
		const later = fetchImpl.mock.calls.slice(1)
		expect(later.length).toBeGreaterThan(1)
		for (const [, init] of later) {
			const headers = new Headers(init?.headers)
			expect(headers.get('authorization')).toBe('Bearer tok')
			expect(headers.get('x-kora-session')).toBe('issued-session-id')
		}
		// The second POST waited for the first: it already carries the session id.
		const posts = fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')
		expect(posts).toHaveLength(2)
	})

	test.each([401, 403, 404, 410])('a %s from the server ends the transport', async (status) => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(sessionOpened())
			.mockResolvedValue(new Response(null, { status }))
		const transport = new HttpLongPollingTransport({
			fetchImpl,
			retryDelayMs: 1,
			preferWebSocket: false,
		})
		const onClose = vi.fn()
		transport.onClose(onClose)
		await transport.connect('http://localhost:3000/sync')
		transport.send(handshake)
		await new Promise((resolve) => setTimeout(resolve, 15))
		expect(onClose).toHaveBeenCalledOnce()
		expect(transport.isConnected()).toBe(false)
		await transport.disconnect()
	})

	test('posts outgoing message payloads', async () => {
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }))

		const transport = new HttpLongPollingTransport({
			fetchImpl,
			preferWebSocket: false,
		})

		await transport.connect('http://localhost:3000/sync')

		const message: SyncMessage = {
			type: 'acknowledgment',
			messageId: 'ack-1',
			acknowledgedMessageId: 'msg-1',
			lastSequenceNumber: 3,
		}
		transport.send(message)
		await new Promise((resolve) => setTimeout(resolve, 10))
		await transport.disconnect()

		const postCall = fetchImpl.mock.calls.find(([, init]) => init?.method === 'POST')
		expect(postCall).toBeDefined()
		expect(postCall?.[1]?.headers).toBeDefined()
	})

	test('decodes protobuf poll responses', async () => {
		const protobuf = new ProtobufMessageSerializer()
		const payload = protobuf.encode(handshakeResponse())
		const body = toArrayBuffer(payload)

		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(sessionOpened())
			.mockResolvedValueOnce(
				new Response(body, {
					status: 200,
					headers: { 'content-type': 'application/x-protobuf' },
				}),
			)
			.mockResolvedValue(new Response(null, { status: 204 }))

		const transport = new HttpLongPollingTransport({
			fetchImpl,
			retryDelayMs: 1,
			preferWebSocket: false,
		})

		const handler = vi.fn()
		transport.onMessage(handler)

		await transport.connect('http://localhost:3000/sync')
		transport.send(handshake)
		await new Promise((resolve) => setTimeout(resolve, 10))
		await transport.disconnect()

		expect(handler).toHaveBeenCalledWith(expect.objectContaining({ type: 'handshake-response' }))
	})

	test('upgrades to websocket transport when available', async () => {
		const connect = vi.fn(async () => {})
		const disconnect = vi.fn(async () => {})
		const send = vi.fn()

		const wsTransport: SyncTransport = {
			connect,
			disconnect,
			send,
			onMessage: vi.fn(),
			onClose: vi.fn(),
			onError: vi.fn(),
			isConnected: () => true,
		}

		const transport = new HttpLongPollingTransport({
			preferWebSocket: true,
			webSocketFactory: () => wsTransport,
		})

		await transport.connect('http://localhost:3000/sync')
		transport.send({
			type: 'acknowledgment',
			messageId: 'ack-1',
			acknowledgedMessageId: 'msg-1',
			lastSequenceNumber: 1,
		})
		await transport.disconnect()

		expect(connect).toHaveBeenCalledOnce()
		expect(send).toHaveBeenCalledOnce()
		expect(disconnect).toHaveBeenCalledOnce()
	})
})

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
	const copied = new Uint8Array(data.byteLength)
	copied.set(data)
	return copied.buffer
}
