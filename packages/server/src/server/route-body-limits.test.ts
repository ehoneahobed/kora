import { type Socket, connect } from 'node:net'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { MemoryServerStore } from '../store/memory-server-store'
import {
	type ProductionServer,
	ROUTE_BODIES_IN_FLIGHT,
	ROUTE_BODY_DEADLINE_MS,
	createProductionServer,
} from './production-server'

/**
 * Custom route bodies (auth, webhooks, app APIs) must arrive at a minimum rate and only so many
 * may be read at once: a client that sends headers and then trickles or stalls must not hold a
 * connection until Node's 300 s request timeout, and many of them must not pile up.
 */
let server: ProductionServer | null = null
const sockets: Socket[] = []
afterEach(async () => {
	for (const socket of sockets.splice(0)) socket.destroy()
	await server?.stop()
	server = null
})

async function start(extra: Record<string, unknown> = {}): Promise<{ host: string; port: number }> {
	server = createProductionServer({
		store: new MemoryServerStore('s'),
		port: 0,
		httpRoutes: [{ path: '/echo', handle: async () => ({ status: 200, body: { ok: true } }) }],
		...extra,
	})
	const url = new URL(await server.start())
	return { host: url.hostname, port: Number(url.port) }
}

/** Opens a POST to /echo declaring `length` bytes, sends `first`, then stalls. */
function stalledUpload(
	at: { host: string; port: number },
	length: number,
	first = '{',
): { socket: Socket; reply: Promise<{ status: number }> } {
	const socket = connect(at.port, at.host)
	sockets.push(socket)
	socket.write(
		`POST /echo HTTP/1.1\r\nHost: ${at.host}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${length}\r\n\r\n${first}`,
	)
	let data = ''
	const reply = new Promise<{ status: number }>((resolve) => {
		socket.on('data', (chunk) => {
			data += chunk.toString('utf8')
		})
		const done = () =>
			resolve({
				status: Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1] ?? 0),
			})
		socket.on('close', done)
		socket.on('end', done)
	})
	return { socket, reply }
}

/** How many custom route bodies the server is reading now (its own count, not a guess from time). */
const bodiesInFlight = (): number =>
	(server as unknown as Record<symbol, () => number>)[ROUTE_BODIES_IN_FLIGHT]?.() ?? -1

// No sleeps: deadlines are configured tiny (the rate arithmetic is unit-tested in
// read-body-deadline.test.ts), and ordering waits on the server's in-flight count.
describe('custom route bodies', () => {
	test('a sender that stalls after the headers gets 408 and the connection is closed', async () => {
		const at = await start({ routeBodyTimeoutMs: 50 })
		const { reply } = stalledUpload(at, 1000)
		const answered = await reply
		expect(answered.status).toBe(408)
	})

	test('routeBodyTimeoutMs sets the ceiling below the rate rule', async () => {
		// Read from the server's own deadline function (what its request path uses): no clock.
		const deadlineFor = (): ((contentLength: number) => number) =>
			(server as unknown as Record<symbol, (contentLength: number) => number>)[
				ROUTE_BODY_DEADLINE_MS
			] as (contentLength: number) => number
		await start({ routeBodyTimeoutMs: 50 })
		// A declared 1 KB body would get 3 s by the rate rule; the configured ceiling wins.
		expect(deadlineFor()(1000)).toBe(50)
		await server?.stop()
		await start()
		expect(deadlineFor()(1000)).toBe(3_000)
	})

	// Review of #323: a sender that keeps sending inside the ceiling is answered normally. The
	// ceiling is far above anything scheduling could add; pieces go out across event-loop turns.
	test('a body trickled steadily inside the ceiling gets 200', async () => {
		const at = await start({ routeBodyTimeoutMs: 60_000 })
		const body = JSON.stringify({ text: 'x'.repeat(400) })
		const { socket, reply } = stalledUpload(at, Buffer.byteLength(body), '')
		const step = Math.ceil(body.length / 10)
		for (let i = 0; i < body.length; i += step) {
			socket.write(body.slice(i, i + step))
			await new Promise((resolve) => setImmediate(resolve))
		}
		const answered = await reply
		expect(answered.status).toBe(200)
	})

	test('past the in-flight cap, another body is refused with 503 at once', async () => {
		const at = await start({ maxConcurrentRequestBodies: 2, routeBodyTimeoutMs: 60_000 })
		stalledUpload(at, 5000)
		stalledUpload(at, 5000)
		// Both bodies are being read before the third arrives.
		await vi.waitFor(() => expect(bodiesInFlight()).toBe(2))
		const third = stalledUpload(at, 10)
		const answered = await third.reply
		expect(answered.status).toBe(503)
	})

	test('an ordinary request still gets its answer', async () => {
		const at = await start()
		const res = await fetch(`http://${at.host}:${at.port}/echo`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ hello: 'world' }),
		})
		expect(res.status).toBe(200)
	})
})
