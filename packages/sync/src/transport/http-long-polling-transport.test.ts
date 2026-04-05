import { describe, expect, test, vi } from 'vitest'
import type { SyncMessage } from '../protocol/messages'
import { JsonMessageSerializer, ProtobufMessageSerializer } from '../protocol/serializer'
import type { SyncTransport } from './transport'
import { HttpLongPollingTransport } from './http-long-polling-transport'

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

describe('HttpLongPollingTransport', () => {
	test('polls JSON messages and forwards decoded payloads', async () => {
		const serializer = new JsonMessageSerializer()
		const responseMessage = serializer.encode(handshakeResponse())

		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(responseMessage, {
					status: 200,
					headers: { 'content-type': 'application/json' },
				}),
			)
			.mockResolvedValueOnce(new Response(null, { status: 204 }))

		const transport = new HttpLongPollingTransport({
			fetchImpl,
			retryDelayMs: 1,
			preferWebSocket: false,
		})

		const handler = vi.fn()
		transport.onMessage(handler)

		await transport.connect('http://localhost:3000/sync')
		await new Promise((resolve) => setTimeout(resolve, 10))
		await transport.disconnect()

		expect(handler).toHaveBeenCalledWith(expect.objectContaining({ type: 'handshake-response' }))
		expect(fetchImpl).toHaveBeenCalledWith(
			'http://localhost:3000/sync',
			expect.objectContaining({ method: 'GET' }),
		)
	})

	test('posts outgoing message payloads', async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response(null, { status: 204 }))

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

		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(payload, {
					status: 200,
					headers: { 'content-type': 'application/x-protobuf' },
				}),
			)
			.mockResolvedValueOnce(new Response(null, { status: 204 }))

		const transport = new HttpLongPollingTransport({
			fetchImpl,
			retryDelayMs: 1,
			preferWebSocket: false,
		})

		const handler = vi.fn()
		transport.onMessage(handler)

		await transport.connect('http://localhost:3000/sync')
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
