/**
 * `POST <syncPath>/read` on the production HTTP server: the route is mounted before custom
 * routes, bodies are bounded before they are buffered, and the response headers are the
 * non-cacheable ones.
 */
import { defineSchema, t } from '@korajs/core'
import { describe, expect, test } from 'vitest'
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

async function start(syncOptions: Record<string, unknown> = {}, syncPath?: string) {
	const store = new MemoryServerStore('s')
	await store.setSchema(schema)
	const server = createProductionServer({
		store,
		port: 0,
		staticDir: '/nonexistent',
		...(syncPath ? { syncPath } : {}),
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
