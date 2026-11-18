import * as crypto from 'node:crypto'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { MemoryServerStore } from '../store/memory-server-store'
import { tokensMatch } from './operational-token'
import { type ProductionServer, createProductionServer } from './production-server'

/**
 * Operational tokens (admin, metrics, backup) are compared in constant time: `===` stops at
 * the first differing character, so response timing reveals how much of a guess was right.
 */
vi.mock('node:crypto', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:crypto')>()
	return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) }
})

describe('tokensMatch', () => {
	test('compares with timingSafeEqual, whatever the lengths', () => {
		const spy = vi.mocked(crypto.timingSafeEqual)
		spy.mockClear()
		expect(tokensMatch('s3cret-token', 's3cret-token')).toBe(true)
		expect(tokensMatch('s3cret-tokeX', 's3cret-token')).toBe(false)
		expect(tokensMatch('short', 's3cret-token')).toBe(false)
		expect(tokensMatch(null, 's3cret-token')).toBe(false)
		expect(spy).toHaveBeenCalledTimes(4)
	})
})

let server: ProductionServer | null = null
afterEach(async () => {
	await server?.stop()
	server = null
})

describe('operational endpoints check the token in constant time', () => {
	test('the right token passes; wrong ones of equal and different length are refused', async () => {
		server = createProductionServer({
			store: new MemoryServerStore('s'),
			port: 0,
			staticDir: '/nonexistent',
			operationalAuth: { adminToken: 'admin-token-123' },
		})
		const base = await server.start()
		const spy = vi.mocked(crypto.timingSafeEqual)
		spy.mockClear()
		const status = async (token: string) =>
			(await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${token}` } })).status
		expect(await status('admin-token-123')).toBe(200)
		expect(await status('admin-token-124')).toBe(401)
		expect(await status('nope')).toBe(401)
		// The server's own check went through the constant-time comparison.
		expect(spy.mock.calls.length).toBeGreaterThanOrEqual(3)
	})
})
