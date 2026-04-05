import { SyncError } from '@kora/core'
import { describe, expect, test, vi } from 'vitest'
import type { HandshakeMessage, SyncMessage } from '../protocol/messages'
import {
	JsonMessageSerializer,
	NegotiatedMessageSerializer,
	ProtobufMessageSerializer,
} from '../protocol/serializer'
import type { WebSocketConstructor, WebSocketLike } from './websocket-transport'
import { WebSocketTransport } from './websocket-transport'

/**
 * Mock WebSocket for testing. Simulates the browser WebSocket API.
 */
class MockWebSocket implements WebSocketLike {
	readyState = 0 // CONNECTING
	onopen: ((event: unknown) => void) | null = null
	onmessage: ((event: { data: unknown }) => void) | null = null
	onclose: ((event: { reason: string; code: number }) => void) | null = null
	onerror: ((event: unknown) => void) | null = null

	readonly url: string
	readonly sentData: Array<string | Uint8Array> = []

	constructor(url: string) {
		this.url = url
		// Simulate async open
		queueMicrotask(() => {
			if (this.readyState === 0) {
				this.readyState = 1 // OPEN
				this.onopen?.({})
			}
		})
	}

	send(data: string | Uint8Array): void {
		this.sentData.push(data)
	}

	close(_code?: number, _reason?: string): void {
		this.readyState = 3 // CLOSED
	}

	// --- Test helpers ---

	simulateMessage(data: unknown): void {
		this.onmessage?.({ data })
	}

	simulateClose(code: number, reason: string): void {
		this.readyState = 3
		this.onclose?.({ code, reason })
	}

	simulateError(): void {
		this.onerror?.({})
	}
}

/** Factory that returns MockWebSocket instances for testing */
function createMockWSFactory(): {
	factory: WebSocketConstructor
	lastInstance: () => MockWebSocket | null
} {
	let last: MockWebSocket | null = null
	const factory = function MockWSConstructor(url: string) {
		last = new MockWebSocket(url)
		return last
	} as unknown as WebSocketConstructor

	return { factory, lastInstance: () => last }
}

describe('WebSocketTransport', () => {
	describe('connect', () => {
		test('creates WebSocket and resolves on open', async () => {
			const { factory } = createMockWSFactory()
			const transport = new WebSocketTransport({ WebSocketImpl: factory })

			await transport.connect('ws://test-server')
			expect(transport.isConnected()).toBe(true)
		})

		test('appends auth token as query parameter', async () => {
			const { factory, lastInstance } = createMockWSFactory()
			const transport = new WebSocketTransport({ WebSocketImpl: factory })

			await transport.connect('ws://test-server', { authToken: 'my-token' })
			expect(lastInstance()?.url).toBe('ws://test-server?token=my-token')
		})

		test('appends auth token with & when URL has existing params', async () => {
			const { factory, lastInstance } = createMockWSFactory()
			const transport = new WebSocketTransport({ WebSocketImpl: factory })

			await transport.connect('ws://test-server?foo=bar', { authToken: 'my-token' })
			expect(lastInstance()?.url).toBe('ws://test-server?foo=bar&token=my-token')
		})

		test('rejects on connection error', async () => {
			const factory = function FailingWS() {
				// Build a minimal WebSocket-like object that only fires onerror
				const ws = {
					readyState: 0, // stays CONNECTING
					onopen: null as ((event: unknown) => void) | null,
					onmessage: null as ((event: { data: unknown }) => void) | null,
					onclose: null as ((event: { reason: string; code: number }) => void) | null,
					onerror: null as ((event: unknown) => void) | null,
					send(_data: string) {},
					close() {
						this.readyState = 3
					},
				}
				queueMicrotask(() => {
					ws.onerror?.({})
				})
				return ws
			} as unknown as WebSocketConstructor

			const transport = new WebSocketTransport({ WebSocketImpl: factory })
			await expect(transport.connect('ws://fail')).rejects.toThrow(SyncError)
		})

		test('throws if no WebSocket implementation available', async () => {
			// Create transport without WebSocketImpl and with no global WebSocket
			const transport = new WebSocketTransport({ WebSocketImpl: undefined })
			// Access internal field to simulate missing implementation
			;(transport as unknown as { WebSocketImpl: null }).WebSocketImpl = null

			await expect(transport.connect('ws://test')).rejects.toThrow(SyncError)
		})
	})

	describe('send/receive', () => {
		test('sends serialized messages', async () => {
			const { factory, lastInstance } = createMockWSFactory()
			const transport = new WebSocketTransport({ WebSocketImpl: factory })
			await transport.connect('ws://test')

			const msg: HandshakeMessage = {
				type: 'handshake',
				messageId: 'msg-1',
				nodeId: 'node-1',
				versionVector: {},
				schemaVersion: 1,
			}
			transport.send(msg)

			const ws = lastInstance()
			expect(ws?.sentData).toHaveLength(1)
			const sentData = ws?.sentData[0]
			expect(sentData).toBeDefined()
			const parsed = JSON.parse(String(sentData ?? '{}'))
			expect(parsed.type).toBe('handshake')
			expect(parsed.nodeId).toBe('node-1')
		})

		test('throws when sending while disconnected', () => {
			const { factory } = createMockWSFactory()
			const transport = new WebSocketTransport({ WebSocketImpl: factory })

			const msg: HandshakeMessage = {
				type: 'handshake',
				messageId: 'msg-1',
				nodeId: 'n',
				versionVector: {},
				schemaVersion: 1,
			}
			expect(() => transport.send(msg)).toThrow(SyncError)
		})

		test('receives and deserializes messages', async () => {
			const { factory, lastInstance } = createMockWSFactory()
			const transport = new WebSocketTransport({ WebSocketImpl: factory })
			const handler = vi.fn()
			transport.onMessage(handler)

			await transport.connect('ws://test')

			const serializer = new JsonMessageSerializer()
			const msg: SyncMessage = {
				type: 'handshake-response',
				messageId: 'msg-1',
				nodeId: 'server',
				versionVector: {},
				schemaVersion: 1,
				accepted: true,
			}
			lastInstance()?.simulateMessage(serializer.encode(msg))

			expect(handler).toHaveBeenCalledTimes(1)
			expect(handler).toHaveBeenCalledWith(expect.objectContaining({ type: 'handshake-response' }))
		})

		test('sends and receives protobuf payloads when serializer is negotiated', async () => {
			const { factory, lastInstance } = createMockWSFactory()
			const serializer = new NegotiatedMessageSerializer('protobuf')
			const transport = new WebSocketTransport({ WebSocketImpl: factory, serializer })
			const handler = vi.fn()
			transport.onMessage(handler)

			await transport.connect('ws://test')

			const outgoing: HandshakeMessage = {
				type: 'handshake',
				messageId: 'msg-1',
				nodeId: 'node-1',
				versionVector: {},
				schemaVersion: 1,
			}
			transport.send(outgoing)

			expect(lastInstance()?.sentData[0]).toBeInstanceOf(Uint8Array)

			const incoming: SyncMessage = {
				type: 'handshake-response',
				messageId: 'resp-1',
				nodeId: 'server',
				versionVector: {},
				schemaVersion: 1,
				accepted: true,
			}
			const bytes = new ProtobufMessageSerializer().encode(incoming)
			lastInstance()?.simulateMessage(bytes)

			expect(handler).toHaveBeenCalledWith(expect.objectContaining({ type: 'handshake-response' }))
		})

		test('calls error handler on malformed incoming message', async () => {
			const { factory, lastInstance } = createMockWSFactory()
			const transport = new WebSocketTransport({ WebSocketImpl: factory })
			const errorHandler = vi.fn()
			transport.onError(errorHandler)

			await transport.connect('ws://test')
			lastInstance()?.simulateMessage('not-valid-json{')

			expect(errorHandler).toHaveBeenCalledTimes(1)
			const firstCall = errorHandler.mock.calls[0]
			expect(firstCall).toBeDefined()
			expect(firstCall?.[0]).toBeInstanceOf(SyncError)
		})

		test('ignores unsupported incoming message data', async () => {
			const { factory, lastInstance } = createMockWSFactory()
			const transport = new WebSocketTransport({ WebSocketImpl: factory })
			const handler = vi.fn()
			transport.onMessage(handler)

			await transport.connect('ws://test')
			// Simulate unsupported payload
			lastInstance()?.onmessage?.({ data: 123 as unknown })

			expect(handler).not.toHaveBeenCalled()
		})
	})

	describe('disconnect', () => {
		test('closes the WebSocket', async () => {
			const { factory } = createMockWSFactory()
			const transport = new WebSocketTransport({ WebSocketImpl: factory })
			await transport.connect('ws://test')

			await transport.disconnect()
			expect(transport.isConnected()).toBe(false)
		})

		test('disconnect is safe when already disconnected', async () => {
			const { factory } = createMockWSFactory()
			const transport = new WebSocketTransport({ WebSocketImpl: factory })

			// Should not throw
			await transport.disconnect()
		})

		test('triggers close handler on remote close', async () => {
			const { factory, lastInstance } = createMockWSFactory()
			const transport = new WebSocketTransport({ WebSocketImpl: factory })
			const handler = vi.fn()
			transport.onClose(handler)

			await transport.connect('ws://test')
			lastInstance()?.simulateClose(1001, 'server going away')

			expect(handler).toHaveBeenCalledWith('server going away')
		})

		test('provides default close reason when empty', async () => {
			const { factory, lastInstance } = createMockWSFactory()
			const transport = new WebSocketTransport({ WebSocketImpl: factory })
			const handler = vi.fn()
			transport.onClose(handler)

			await transport.connect('ws://test')
			lastInstance()?.simulateClose(1000, '')

			expect(handler).toHaveBeenCalledWith('WebSocket closed with code 1000')
		})
	})

	describe('error handling', () => {
		test('error handler called on WebSocket error', async () => {
			const { factory, lastInstance } = createMockWSFactory()
			const transport = new WebSocketTransport({ WebSocketImpl: factory })
			const errorHandler = vi.fn()
			transport.onError(errorHandler)

			await transport.connect('ws://test')
			lastInstance()?.simulateError()

			expect(errorHandler).toHaveBeenCalledTimes(1)
		})
	})
})
