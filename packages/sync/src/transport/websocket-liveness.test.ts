import { afterEach, describe, expect, test, vi } from 'vitest'
import type { SyncMessage } from '../protocol/messages'
import { JsonMessageSerializer } from '../protocol/serializer'
import type { WebSocketConstructor, WebSocketLike } from './websocket-transport'
import { WebSocketTransport } from './websocket-transport'

/**
 * Socket generations (SYNC-5) and heartbeat liveness (LMS #12) of the client
 * WebSocket transport. Time is fake throughout.
 */

const json = new JsonMessageSerializer()

class FakeSocket implements WebSocketLike {
	readyState = 0
	onopen: ((event: unknown) => void) | null = null
	onmessage: ((event: { data: unknown }) => void) | null = null
	onclose: ((event: { reason: string; code: number }) => void) | null = null
	onerror: ((event: unknown) => void) | null = null
	readonly sent: string[] = []
	closed = false
	constructor(readonly url: string) {
		sockets.push(this)
		queueMicrotask(() => {
			if (this.readyState !== 0) return
			this.readyState = 1
			this.onopen?.({})
		})
	}
	send(data: string | Uint8Array): void {
		this.sent.push(String(data))
	}
	close(): void {
		this.closed = true
		this.readyState = 3
	}
	receive(message: SyncMessage): void {
		this.onmessage?.({ data: json.encode(message) })
	}
	serverClose(reason = 'server closed'): void {
		this.readyState = 3
		this.onclose?.({ reason, code: 1001 })
	}
}

let sockets: FakeSocket[] = []

function transport(options: ConstructorParameters<typeof WebSocketTransport>[0] = {}) {
	return new WebSocketTransport({
		WebSocketImpl: FakeSocket as unknown as WebSocketConstructor,
		...options,
	})
}

const handshake: SyncMessage = {
	type: 'handshake',
	messageId: 'hs',
	nodeId: 'n',
	versionVector: {},
	schemaVersion: 1,
}

function handshakeResponse(heartbeatIntervalMs?: number): SyncMessage {
	return {
		type: 'handshake-response',
		messageId: 'hr',
		nodeId: 'server',
		versionVector: {},
		schemaVersion: 1,
		accepted: true,
		...(heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs } : {}),
	}
}

afterEach(() => {
	sockets = []
	vi.useRealTimers()
})

describe('socket generations (SYNC-5)', () => {
	test('connecting again closes and detaches the previous socket', async () => {
		const t = transport()
		const onClose = vi.fn()
		const onMessage = vi.fn()
		t.onClose(onClose)
		t.onMessage(onMessage)
		await t.connect('ws://a')
		await t.connect('ws://a')
		const [first, second] = sockets
		expect(first?.closed).toBe(true)
		expect(second?.closed).toBe(false)

		// The stale socket's late events reach nobody and cannot sever the live one.
		first?.serverClose()
		first?.receive(handshakeResponse())
		expect(onClose).not.toHaveBeenCalled()
		expect(onMessage).not.toHaveBeenCalled()
		expect(t.isConnected()).toBe(true)

		second?.receive(handshakeResponse())
		expect(onMessage).toHaveBeenCalledOnce()
	})

	test('an intentional disconnect fires no close handler, even if the socket closes later', async () => {
		const t = transport()
		const onClose = vi.fn()
		t.onClose(onClose)
		await t.connect('ws://a')
		const socket = sockets[0]
		await t.disconnect()
		socket?.serverClose()
		expect(onClose).not.toHaveBeenCalled()
		expect(t.isConnected()).toBe(false)
	})
})

describe('heartbeat liveness (LMS #12)', () => {
	test('the handshake advertises heartbeat support (and can opt out)', async () => {
		const t = transport()
		await t.connect('ws://a')
		t.send(handshake)
		expect(JSON.parse(sockets[0]?.sent[0] ?? '{}').supportsHeartbeat).toBe(true)

		const off = transport({ heartbeat: false })
		await off.connect('ws://b')
		off.send(handshake)
		expect(JSON.parse(sockets[1]?.sent[0] ?? '{}').supportsHeartbeat).toBeUndefined()
	})

	test('silence for 2.5 heartbeat intervals closes the connection and reports it', async () => {
		vi.useFakeTimers()
		const t = transport()
		const onClose = vi.fn()
		const onMessage = vi.fn()
		t.onClose(onClose)
		t.onMessage(onMessage)
		const connected = t.connect('ws://a')
		await vi.advanceTimersByTimeAsync(0)
		await connected
		const socket = sockets[0] as FakeSocket
		socket.receive(handshakeResponse(1_000))

		// Heartbeats keep it alive and are not passed to the engine.
		for (let i = 0; i < 5; i++) {
			vi.advanceTimersByTime(1_000)
			socket.receive({ type: 'heartbeat', messageId: `h${i}` })
		}
		expect(onClose).not.toHaveBeenCalled()
		expect(onMessage).toHaveBeenCalledTimes(1) // only the handshake response

		vi.advanceTimersByTime(2_499)
		expect(onClose).not.toHaveBeenCalled()
		vi.advanceTimersByTime(1)
		expect(onClose).toHaveBeenCalledOnce()
		expect(String(onClose.mock.calls[0]?.[0])).toContain('Heartbeat timeout')
		expect(socket.closed).toBe(true)
		expect(t.isConnected()).toBe(false)
	})

	test('without a server heartbeat interval nothing is watched', async () => {
		vi.useFakeTimers()
		const t = transport()
		const onClose = vi.fn()
		t.onClose(onClose)
		const connected = t.connect('ws://a')
		await vi.advanceTimersByTimeAsync(0)
		await connected
		sockets[0]?.receive(handshakeResponse())
		vi.advanceTimersByTime(3_600_000)
		expect(onClose).not.toHaveBeenCalled()
	})
})
