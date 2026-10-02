import { JsonMessageSerializer, type SyncMessage } from '@korajs/sync'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { HttpServerTransport } from './http-server-transport'
import { WsServerTransport, type WsWebSocket } from './ws-server-transport'

/**
 * Transport liveness and buffering (SRV-6, LMS #12): WebSocket ping/pong probing,
 * the slow-consumer ceiling, and the HTTP long-poll queue bound. Fake timers only.
 */

const WS_OPEN = 1

interface FakeWs extends WsWebSocket {
	bufferedAmount: number
	pings: number
	terminated: boolean
	emit(event: string, ...args: unknown[]): void
}

function fakeWs(): FakeWs {
	const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
	const ws: FakeWs = {
		readyState: WS_OPEN,
		bufferedAmount: 0,
		pings: 0,
		terminated: false,
		send: vi.fn(),
		close: vi.fn(),
		removeAllListeners: vi.fn(),
		on(event, listener) {
			listeners.set(event, [...(listeners.get(event) ?? []), listener])
		},
		ping() {
			ws.pings += 1
		},
		terminate() {
			ws.terminated = true
			ws.readyState = 3
			ws.emit('close', 1006, '')
		},
		emit(event, ...args) {
			for (const listener of listeners.get(event) ?? []) listener(...args)
		},
	}
	return ws
}

const message: SyncMessage = { type: 'heartbeat', messageId: 'h' }

afterEach(() => {
	vi.useRealTimers()
})

describe('WsServerTransport liveness', () => {
	test('pings every interval and terminates after two unanswered pings, running the close path', () => {
		vi.useFakeTimers()
		const ws = fakeWs()
		const transport = new WsServerTransport(ws, { heartbeatIntervalMs: 1_000 })
		const onClose = vi.fn()
		transport.onClose(onClose)

		vi.advanceTimersByTime(1_000)
		expect(ws.pings).toBe(1)
		vi.advanceTimersByTime(1_000)
		expect(ws.pings).toBe(2)
		expect(ws.terminated).toBe(false)
		vi.advanceTimersByTime(1_000)
		expect(ws.terminated).toBe(true)
		expect(onClose).toHaveBeenCalledOnce()
		// No more pings after the connection is gone.
		vi.advanceTimersByTime(10_000)
		expect(ws.pings).toBe(2)
	})

	test('a pong (or any inbound message) keeps the connection alive', () => {
		vi.useFakeTimers()
		const ws = fakeWs()
		const transport = new WsServerTransport(ws, { heartbeatIntervalMs: 1_000 })
		transport.onMessage(() => {})
		for (let i = 0; i < 10; i++) {
			vi.advanceTimersByTime(1_000)
			if (i % 2 === 0) ws.emit('pong')
			else ws.emit('message', JSON.stringify(message))
		}
		expect(ws.terminated).toBe(false)
		expect(ws.pings).toBe(10)
	})

	test('probing can be disabled', () => {
		vi.useFakeTimers()
		const ws = fakeWs()
		new WsServerTransport(ws, { heartbeatIntervalMs: 0 })
		vi.advanceTimersByTime(600_000)
		expect(ws.pings).toBe(0)
		expect(ws.terminated).toBe(false)
	})

	test('closing the transport stops the heartbeat', () => {
		vi.useFakeTimers()
		const ws = fakeWs()
		const transport = new WsServerTransport(ws, { heartbeatIntervalMs: 1_000 })
		transport.close()
		vi.advanceTimersByTime(10_000)
		expect(ws.pings).toBe(0)
	})

	test('reports the socket backlog and drops a consumer that falls past the ceiling', () => {
		const ws = fakeWs()
		const transport = new WsServerTransport(ws, {
			heartbeatIntervalMs: 0,
			maxBufferedBytes: 1_000,
		})
		ws.bufferedAmount = 400
		expect(transport.bufferedAmount()).toBe(400)
		transport.send(message)
		expect(ws.terminated).toBe(false)
		ws.bufferedAmount = 5_000
		transport.send(message)
		expect(ws.terminated).toBe(true)
	})
})

describe('HttpServerTransport queue bound', () => {
	test('reports queued bytes and frees them as the client polls', () => {
		const transport = new HttpServerTransport(new JsonMessageSerializer())
		transport.send(message)
		const queued = transport.bufferedAmount()
		expect(queued).toBeGreaterThan(0)
		transport.poll()
		expect(transport.bufferedAmount()).toBe(0)
	})

	test('a client that stops polling is disconnected once its queue passes the ceiling', () => {
		const transport = new HttpServerTransport(new JsonMessageSerializer(), { maxQueuedBytes: 200 })
		const onClose = vi.fn()
		transport.onClose(onClose)
		for (let i = 0; i < 20 && transport.isConnected(); i++) transport.send(message)
		expect(transport.isConnected()).toBe(false)
		expect(onClose).toHaveBeenCalledWith(1001, 'http session queue overflow')
		expect(transport.bufferedAmount()).toBe(0)
	})
})
