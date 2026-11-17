import { describe, expect, test } from 'vitest'
import { MemoryServerStore } from '../store/memory-server-store'
import { createProductionServer } from './production-server'

/**
 * #150 / SRV-6: an oversized request body is refused with 413, and the client receives that
 * answer even while it is still uploading. Destroying the socket right after the reply made a
 * client that keeps sending see "fetch failed" instead of the 413.
 */

function slowBody(
	first: Uint8Array,
	rest: Uint8Array,
	delayMs: number,
): ReadableStream<Uint8Array> {
	let sentFirst = false
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (!sentFirst) {
				sentFirst = true
				controller.enqueue(first)
				return
			}
			// The server has decided by now; the client keeps sending, as a browser would.
			await new Promise((resolve) => setTimeout(resolve, delayMs))
			controller.enqueue(rest)
			controller.close()
		},
	})
}

describe('an oversized body gets its 413 even while the client is still sending (#150)', () => {
	test('without Content-Length: the limit is passed mid-upload', async () => {
		const server = createProductionServer({
			store: new MemoryServerStore('s'),
			port: 0,
			maxRequestBodyBytes: 1024,
			httpRoutes: [{ path: '/echo', handle: async () => ({ status: 200, body: { ok: true } }) }],
		})
		const base = await server.start()
		try {
			const res = await fetch(`${base}/echo`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: slowBody(
					new Uint8Array(64 * 1024).fill(120),
					new Uint8Array(256 * 1024).fill(120),
					100,
				),
				duplex: 'half',
			} as RequestInit)
			expect(res.status).toBe(413)
		} finally {
			await server.stop()
		}
	})

	test('with a declared Content-Length over the limit: refused before reading', async () => {
		const server = createProductionServer({
			store: new MemoryServerStore('s'),
			port: 0,
			maxRequestBodyBytes: 1024,
			httpRoutes: [{ path: '/echo', handle: async () => ({ status: 200, body: { ok: true } }) }],
		})
		const base = await server.start()
		try {
			for (let i = 0; i < 5; i++) {
				const res = await fetch(`${base}/echo`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ pad: 'x'.repeat(4 * 1024 * 1024) }),
				})
				expect(res.status).toBe(413)
			}
		} finally {
			await server.stop()
		}
	})
})
