import { type Socket, connect } from 'node:net'
/**
 * `POST <syncPath>/read` on the production HTTP server: the route is mounted before custom
 * routes, bodies are bounded before they are buffered, and the response headers are the
 * non-cacheable ones.
 */
import { defineSchema, t } from '@korajs/core'
import { describe, expect, test, vi } from 'vitest'
import { TokenAuthProvider } from '../../src/auth/token-auth'
import { createProductionServer } from '../../src/server/production-server'
import { MemoryServerStore } from '../../src/store/memory-server-store'

const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { team: t.string(), text: t.string() } } },
})

const auth = new TokenAuthProvider({
	validate: async (token) =>
		token === 'ann' ? { userId: 'ann', scopes: { notes: { team: 't1' } } } : null,
})

async function start(
	syncOptions: Record<string, unknown> = {},
	syncPath?: string,
	trustProxy?: number,
) {
	const store = new MemoryServerStore('s')
	await store.setSchema(schema)
	const server = createProductionServer({
		store,
		port: 0,
		staticDir: '/nonexistent',
		...(syncPath ? { syncPath } : {}),
		...(trustProxy !== undefined ? { trustProxy } : {}),
		syncOptions: { auth, accessSweepIntervalMs: 0, ...syncOptions },
		httpRoutes: [{ path: '/kora-sync/read', handle: async () => ({ status: 200, body: {} }) }],
	})
	const base = await server.start()
	await server.kora.apply({
		collection: 'notes',
		type: 'insert',
		recordId: 'n1',
		data: { team: 't1', text: 'mine' },
	})
	await server.kora.apply({
		collection: 'notes',
		type: 'insert',
		recordId: 'n2',
		data: { team: 't2', text: 'theirs' },
	})
	return { server, base }
}

const body = JSON.stringify({
	v: 1,
	schemaVersion: 1,
	queries: [{ key: 'q', collection: 'notes', where: {}, orderBy: [] }],
})

describe('read-through over HTTP', () => {
	test('answers an authenticated read with non-cacheable headers', async () => {
		const { server, base } = await start()
		try {
			const response = await fetch(`${base}/kora-sync/read`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: 'Bearer ann' },
				body,
			})
			expect(response.status).toBe(200)
			expect(response.headers.get('cache-control')).toBe('no-store, private')
			const answer = (await response.json()) as {
				frontier: number
				results: Array<{ records: Array<{ id: string }> }>
			}
			expect(answer.results[0]?.records.map((r) => r.id)).toEqual(['n1'])
			expect(answer.frontier).toBeGreaterThanOrEqual(2)
		} finally {
			await server.stop()
		}
	})

	test('401 without a credential, 405 for GET, 415 for a wrong content type', async () => {
		const { server, base } = await start()
		try {
			const call = (init: RequestInit) => fetch(`${base}/kora-sync/read`, init)
			expect(
				(await call({ method: 'POST', headers: { 'content-type': 'application/json' }, body }))
					.status,
			).toBe(401)
			expect((await call({ method: 'GET', headers: { authorization: 'Bearer ann' } })).status).toBe(
				405,
			)
			expect(
				(
					await call({
						method: 'POST',
						headers: { 'content-type': 'text/plain', authorization: 'Bearer ann' },
						body,
					})
				).status,
			).toBe(415)
		} finally {
			await server.stop()
		}
	})

	test('an oversized body is 413 and is never parsed', async () => {
		const { server, base } = await start({ readThrough: { maxRequestBytes: 300 } })
		try {
			const response = await fetch(`${base}/kora-sync/read`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: 'Bearer ann' },
				body: JSON.stringify({ pad: 'x'.repeat(2000) }),
			})
			expect(response.status).toBe(413)
			const answer = (await response.json()) as { error: { code: string; limit: number } }
			expect(answer.error.limit).toBe(300)
		} finally {
			await server.stop()
		}
	})

	test('follows a custom syncPath, and a disabled endpoint is 404', async () => {
		const custom = await start({}, '/sync')
		try {
			const response = await fetch(`${custom.base}/sync/read`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: 'Bearer ann' },
				body,
			})
			expect(response.status).toBe(200)
		} finally {
			await custom.server.stop()
		}
		const off = await start({ readThrough: { enabled: false } })
		try {
			const response = await fetch(`${off.base}/kora-sync/read`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: 'Bearer ann' },
				body,
			})
			expect(response.status).toBe(404)
		} finally {
			await off.server.stop()
		}
	})
})

/**
 * Sockets that announce a body and never send it, each holding a body slot until the
 * server's rate rule closes it.
 */
function stall(base: string, count: number, headers: string[] = []): Socket[] {
	const { port } = new URL(base)
	return Array.from({ length: count }, () => {
		const socket = connect(Number(port), '127.0.0.1')
		socket.on('error', () => undefined)
		socket.write(
			[
				'POST /kora-sync/read HTTP/1.1',
				'Host: localhost',
				'Content-Type: application/json',
				'Authorization: Bearer nobody',
				'Content-Length: 1000',
				...headers,
				'',
				'',
			].join('\r\n'),
		)
		return socket
	})
}

const post = (base: string, token: string, headers: Record<string, string> = {}) =>
	fetch(`${base}/kora-sync/read`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
		body,
	})

describe('read-through body slots under stalled senders', () => {
	test('stalled uncached senders cannot starve a cached user, even with no trusted address', async () => {
		const { server, base } = await start()
		let sockets: Socket[] = []
		try {
			// Ann reads once, so her token is cached. 40 stalled senders are more than the 32
			// uncached bodies allowed when no address is trusted, and far fewer than the 128 of a
			// whole pool.
			expect((await post(base, 'ann')).status).toBe(200)
			sockets = stall(base, 40)
			// Wait until the server holds the stalled bodies: a cold read is then refused.
			await vi.waitFor(async () => expect((await post(base, 'cold')).status).toBe(429), {
				timeout: 5_000,
			})
			// The cached principal has her own pool and is served throughout.
			expect((await post(base, 'ann')).status).toBe(200)
		} finally {
			for (const socket of sockets) socket.destroy()
			await server.stop()
		}
	})

	test('a whole pool of stalled uncached senders leaves cached users their own pool', async () => {
		const { server, base } = await start({}, undefined, 1)
		const sockets: Socket[] = []
		try {
			expect((await post(base, 'ann', { 'x-forwarded-for': '198.51.100.9' })).status).toBe(200)
			// Nine addresses at 16 bodies each fill the 128 uncached slots.
			for (let a = 1; a <= 9; a++) {
				sockets.push(...stall(base, 16, [`X-Forwarded-For: 203.0.113.${a}`]))
			}
			await vi.waitFor(
				async () =>
					expect((await post(base, 'cold', { 'x-forwarded-for': '198.51.100.20' })).status).toBe(
						429,
					),
				{ timeout: 10_000 },
			)
			expect((await post(base, 'ann', { 'x-forwarded-for': '198.51.100.9' })).status).toBe(200)
		} finally {
			for (const socket of sockets) socket.destroy()
			await server.stop()
		}
	})

	test('body slots are released after each read', async () => {
		const { server, base } = await start(
			{ readThrough: { rate: { perSecond: 1000, burst: 1000 } } },
			undefined,
			1,
		)
		try {
			// More sequential reads than one trusted address may hold at once (16): a leaked slot
			// would end them in 429.
			for (let i = 0; i < 25; i++) {
				expect((await post(base, 'ann', { 'x-forwarded-for': '198.51.100.9' })).status).toBe(200)
			}
			// More uncached reads than the whole pool holds (128), each from its own address.
			for (let i = 0; i < 140; i++) {
				const answer = await post(base, 'nobody', { 'x-forwarded-for': `192.0.2.${i + 1}` })
				expect(answer.status).toBe(401)
			}
		} finally {
			await server.stop()
		}
	})

	test('one trusted address cannot hold more than its share of body slots', async () => {
		const { server, base } = await start({}, undefined, 1)
		let sockets: Socket[] = []
		try {
			sockets = stall(base, 40, ['X-Forwarded-For: 203.0.113.1'])
			// The flooding address is refused...
			await vi.waitFor(
				async () =>
					expect((await post(base, 'cold', { 'x-forwarded-for': '203.0.113.1' })).status).toBe(429),
				{ timeout: 5_000 },
			)
			// ...and a cold read from any other address is not (401: the token is simply unknown).
			expect((await post(base, 'cold', { 'x-forwarded-for': '198.51.100.2' })).status).toBe(401)
			expect((await post(base, 'ann', { 'x-forwarded-for': '198.51.100.2' })).status).toBe(200)
		} finally {
			for (const socket of sockets) socket.destroy()
			await server.stop()
		}
	})
})
