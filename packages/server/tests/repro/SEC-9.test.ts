/**
 * SEC-9 repro (the parts that hold):
 *  (a) getClientIp trusts X-Forwarded-For from any peer, so a direct client chooses its
 *      own request.ip (the key @korajs/auth uses to rate-limit sign-in / sign-up).
 *  (b) sqlDefaultLiteral does not escape quotes, so a schema default containing an
 *      apostrophe produces invalid DDL and the server store cannot open.
 * Asserts CORRECT behavior (fails today).
 */
import { defineSchema, t } from '@korajs/core'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { describe, expect, test } from 'vitest'
import { createProductionServer } from '../../src/server/production-server'
import { MemoryServerStore } from '../../src/store/memory-server-store'
import { SqliteServerStore } from '../../src/store/sqlite-server-store'

describe('SEC-9', () => {
	test('(a) request.ip is not taken from a spoofed X-Forwarded-For when no trusted proxy is configured', async () => {
		const server = createProductionServer({
			store: new MemoryServerStore('server-1'),
			port: 0,
			httpRoutes: [
				{
					path: '/whoami',
					async handle(request) {
						return { status: 200, body: { ip: request.ip } }
					},
				},
			],
		})
		const base = await server.start()
		try {
			const res = await fetch(`${base}/whoami`, {
				headers: { 'X-Forwarded-For': '203.0.113.77' },
			})
			const body = (await res.json()) as { ip?: string }
			expect(body.ip).not.toBe('203.0.113.77')
		} finally {
			await server.stop()
		}
	})

	test('(b) a string default containing a quote yields valid DDL', async () => {
		const schema = defineSchema({
			version: 1,
			collections: { notes: { fields: { status: t.string().default("don't know") } } },
		})
		const store = new SqliteServerStore(drizzle(new Database(':memory:')), 'server-1')
		await expect(store.setSchema(schema)).resolves.not.toThrow()
	})
})
