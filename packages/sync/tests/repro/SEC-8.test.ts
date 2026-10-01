/**
 * SEC-8 repro: WebSocketTransport puts the bearer token in the connection URL
 * (?token=...), where proxies, load balancers and server access logs record it. The
 * server never reads it (auth comes from the handshake message), so the URL copy is
 * pure exposure. Asserts CORRECT behavior (fails today).
 */
import { describe, expect, test } from 'vitest'
import type { WebSocketConstructor, WebSocketLike } from '../../src/transport/websocket-transport'
import { WebSocketTransport } from '../../src/transport/websocket-transport'

describe('SEC-8: auth token in WebSocket URL', () => {
	test('connect() does not place the auth token in the URL', async () => {
		const urls: string[] = []
		const Impl = ((url: string): WebSocketLike => {
			urls.push(url)
			const ws: WebSocketLike & { readyState: number } = {
				readyState: 0,
				onopen: null,
				onmessage: null,
				onclose: null,
				onerror: null,
				send() {},
				close() {},
			} as unknown as WebSocketLike & { readyState: number }
			queueMicrotask(() => {
				ws.readyState = 1
				ws.onopen?.({})
			})
			return ws
		}) as unknown as WebSocketConstructor
		const transport = new WebSocketTransport({ WebSocketImpl: Impl })
		await transport.connect('wss://sync.example.com/kora', { authToken: 'eyJ.secret.jwt' })
		expect(urls[0]).not.toContain('eyJ.secret.jwt')
	})
})
