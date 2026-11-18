import { type Socket, connect } from 'node:net'
import { afterEach, describe, expect, test } from 'vitest'
import { MemoryServerStore } from '../store/memory-server-store'
import { type ProductionServer, createProductionServer } from './production-server'

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
): { socket: Socket; reply: Promise<{ status: number; closedAtMs: number }> } {
	const socket = connect(at.port, at.host)
	sockets.push(socket)
	socket.write(
		`POST /echo HTTP/1.1\r\nHost: ${at.host}\r\nContent-Type: application/json\r\nContent-Length: ${length}\r\n\r\n${first}`,
	)
	let data = ''
	const reply = new Promise<{ status: number; closedAtMs: number }>((resolve) => {
		socket.on('data', (chunk) => {
			data += chunk.toString('utf8')
		})
		const done = () =>
			resolve({
				status: Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1] ?? 0),
				closedAtMs: Date.now(),
			})
		socket.on('close', done)
		socket.on('end', done)
	})
	return { socket, reply }
}

const within = <T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> =>
	Promise.race([
		promise,
		new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), ms)),
	])

describe('custom route bodies', () => {
	test('a sender that stalls after the headers gets 408 and is cut off within the deadline', async () => {
		const at = await start()
		const startedAt = Date.now()
		const { reply } = stalledUpload(at, 1000)
		// 1,000 declared bytes: 2 s grace plus 1 s per KiB.
		const answered = await within(reply, 6_000)
		expect(answered).not.toBe('timeout')
		if (answered === 'timeout') return
		expect(answered.status).toBe(408)
		expect(answered.closedAtMs - startedAt).toBeLessThan(5_000)
	}, 15_000)

	test('past the in-flight cap, another body is refused with 503 at once', async () => {
		const at = await start({ maxConcurrentRequestBodies: 2 })
		stalledUpload(at, 5000)
		stalledUpload(at, 5000)
		await new Promise((resolve) => setTimeout(resolve, 200))
		const third = stalledUpload(at, 10)
		const answered = await within(third.reply, 2_000)
		expect(answered).not.toBe('timeout')
		if (answered === 'timeout') return
		expect(answered.status).toBe(503)
	}, 15_000)

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
