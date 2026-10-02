/**
 * LMS-1 — refresh must distinguish transient failures from definitive auth rejection.
 *
 * These tests assert the state-of-the-art contract and FAIL at HEAD (91c6350):
 * `performRefresh()` (src/client/auth-client.ts:811-826) catches every error and
 * destroys both tokens. Only a definitive rejection from the auth server
 * (401, or 400 `invalid_grant` per RFC 6749 §5.2) may sign the user out.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createKoraAuth, createMemoryAuthTokenStorage } from '../../src/index'
import type { AuthTokenStorage } from '../../src/index'
import { InMemoryTokenRevocationStore, TokenManager } from '../../src/server'

const SERVER = 'https://auth.example.test'

function b64url(value: unknown): string {
	return btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fakeJwt(payload: Record<string, unknown>): string {
	return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.sig`
}

function token(type: 'access' | 'refresh', expiresInSeconds: number, sub = 'user-1'): string {
	const now = Math.floor(Date.now() / 1000)
	return fakeJwt({ sub, dev: 'device-1', type, iat: now, exp: now + expiresInSeconds })
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json', ...headers },
	})
}

function html(status: number): Response {
	return new Response('<html><body>Login to WiFi</body></html>', {
		status,
		headers: { 'Content-Type': 'text/html' },
	})
}

type RefreshFailure = () => Promise<Response>

/** Transient failures: none of these says anything about refresh-token validity. */
const TRANSIENT_FAILURES: Array<[string, RefreshFailure]> = [
	[
		'fetch rejects (offline / DNS / TLS / CORS) TypeError',
		async () => {
			throw new TypeError('Failed to fetch')
		},
	],
	[
		'request aborted (AbortError, e.g. timeout or page hidden)',
		async () => {
			throw new DOMException('The operation was aborted.', 'AbortError')
		},
	],
	['HTTP 500 from auth server', async () => json(500, { error: 'Internal error' })],
	['HTTP 502 HTML from a proxy / load balancer', async () => html(502)],
	[
		'HTTP 503 with Retry-After',
		async () => json(503, { error: 'Unavailable' }, { 'Retry-After': '30' }),
	],
	['HTTP 504 gateway timeout', async () => html(504)],
	['HTTP 429 rate limited', async () => json(429, { error: 'Too many requests' })],
	['HTTP 511 captive portal (network authentication required)', async () => html(511)],
	['HTTP 200 HTML from a captive portal (lie-fi)', async () => html(200)],
]

interface Harness {
	storage: AuthTokenStorage
	auth: ReturnType<typeof createKoraAuth>
	refreshCalls: () => number
	setRefresh(handler: RefreshFailure): void
	originalRefresh: string
}

async function authenticatedSessionWithExpiredAccessToken(): Promise<Harness> {
	vi.useFakeTimers({ toFake: ['Date'] })
	vi.setSystemTime(new Date('2026-10-01T08:00:00Z'))
	const storage = createMemoryAuthTokenStorage()
	const originalRefresh = token('refresh', 90 * 24 * 3600)
	await storage.setTokens(token('access', 15 * 60), originalRefresh)

	let refreshCount = 0
	let refreshHandler: RefreshFailure = async () => json(200, {})
	const fetchFn = (async (input: RequestInfo | URL) => {
		const url = String(input)
		if (url.endsWith('/auth/me')) return json(200, { id: 'user-1', email: 'a@b.c', name: 'A' })
		if (url.endsWith('/auth/refresh')) {
			refreshCount++
			return refreshHandler()
		}
		throw new TypeError('unexpected url')
	}) as typeof fetch

	const auth = createKoraAuth({ serverUrl: SERVER, storage, fetch: fetchFn, deviceIdentity: false })
	await auth.initialize()
	expect(auth.state).toBe('authenticated')

	// 20 minutes later the 15-minute access token has expired.
	vi.setSystemTime(new Date('2026-10-01T08:20:00Z'))
	return {
		storage,
		auth,
		originalRefresh,
		refreshCalls: () => refreshCount,
		setRefresh(handler) {
			refreshHandler = handler
		},
	}
}

afterEach(() => {
	vi.useRealTimers()
})

describe('LMS-1: transient refresh failures must not destroy the session', () => {
	it.each(TRANSIENT_FAILURES)(
		'%s -> refresh token kept, still authenticated',
		async (_name, failure) => {
			const h = await authenticatedSessionWithExpiredAccessToken()
			h.setRefresh(failure)

			const result = await h.auth.getAccessToken()

			expect(result).toBeNull()
			expect(await h.storage.getRefreshToken()).toBe(h.originalRefresh)
			expect(h.auth.state).toBe('authenticated')
		},
	)

	it('control: a definitive 401 from the auth server clears tokens and signs out', async () => {
		const h = await authenticatedSessionWithExpiredAccessToken()
		h.setRefresh(async () => json(401, { error: 'Invalid or expired refresh token.' }))

		expect(await h.auth.getAccessToken()).toBeNull()
		expect(await h.storage.getRefreshToken()).toBeNull()
		expect(h.auth.state).toBe('unauthenticated')
	})

	it('repeated token requests while offline back off instead of hammering /auth/refresh', async () => {
		const h = await authenticatedSessionWithExpiredAccessToken()
		h.setRefresh(async () => {
			throw new TypeError('Failed to fetch')
		})

		// Sync reconnect loop, scope resolution, node id, user id... all call getAccessToken().
		for (let i = 0; i < 10; i++) await h.auth.getAccessToken()

		expect(await h.storage.getRefreshToken()).toBe(h.originalRefresh)
		expect(h.refreshCalls()).toBeLessThanOrEqual(2)
	})
})

describe('LMS-1: refresh must be bounded in time (lie-fi)', () => {
	it('a refresh request that never answers settles within a bounded timeout', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-10-01T08:00:00Z'))
		const storage = createMemoryAuthTokenStorage()
		const refresh = token('refresh', 90 * 24 * 3600)
		await storage.setTokens(token('access', -60), refresh)
		const hangingFetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () =>
					reject(new DOMException('aborted', 'AbortError')),
				)
			})) as typeof fetch
		const auth = createKoraAuth({
			serverUrl: SERVER,
			storage,
			fetch: hangingFetch,
			deviceIdentity: false,
		})

		let settled = false
		void auth.getAccessToken().finally(() => {
			settled = true
		})
		await vi.advanceTimersByTimeAsync(120_000)

		expect(settled).toBe(true)
		expect(await storage.getRefreshToken()).toBe(refresh)
	})
})

/**
 * Real server semantics: TokenManager rotates refresh tokens with reuse detection
 * (src/tokens/token-manager.ts:444-477) and has no reuse grace window.
 */
function realServer(): {
	manager: TokenManager
	fetchFor(opts?: { loseNextRefreshResponse?: boolean }): typeof fetch
} {
	const manager = new TokenManager({
		secret: 'x'.repeat(48),
		revocationStore: new InMemoryTokenRevocationStore(),
	})
	// Serialize server handling: a real server consumes a refresh token atomically.
	let queue = Promise.resolve()
	return {
		manager,
		fetchFor(opts = {}) {
			let lose = opts.loseNextRefreshResponse ?? false
			return (async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input)
				if (url.endsWith('/auth/me')) throw new TypeError('Failed to fetch')
				if (!url.endsWith('/auth/refresh')) throw new TypeError('unexpected url')
				const body = JSON.parse(String(init?.body)) as { refreshToken: string }
				const run = queue.then(() => manager.refreshAccessToken(body.refreshToken))
				queue = run.then(
					() => undefined,
					() => undefined,
				)
				const result = await run
				if (lose) {
					// Server committed the rotation; the response is lost on a flaky 2G link.
					lose = false
					throw new TypeError('Failed to fetch')
				}
				return result
					? json(200, { data: result })
					: json(401, { error: 'Invalid or expired refresh token.' })
			}) as typeof fetch
		},
	}
}

describe('LMS-1: rotation-safe refresh', () => {
	it('a lost refresh response does not lead to reuse-detection sign-out on the retry', async () => {
		const server = realServer()
		const issued = server.manager.issueTokens('user-1', 'device-1')
		const storage = createMemoryAuthTokenStorage()
		await storage.setTokens(token('access', -60), issued.refreshToken)
		const fetchFn = server.fetchFor({ loseNextRefreshResponse: true })
		const auth = createKoraAuth({
			serverUrl: SERVER,
			storage,
			fetch: fetchFn,
			deviceIdentity: false,
		})

		expect(await auth.getAccessToken()).toBeNull() // response lost
		const retried = await auth.getAccessToken() // connectivity back

		expect(retried).not.toBeNull()
		expect(await storage.getRefreshToken()).not.toBeNull()
	})

	it('two tabs sharing token storage refresh once, not twice (no reuse-detection logout)', async () => {
		const server = realServer()
		const issued = server.manager.issueTokens('user-1', 'device-1')
		const shared = createMemoryAuthTokenStorage()
		await shared.setTokens(token('access', -60), issued.refreshToken)
		const fetchFn = server.fetchFor()
		const tabA = createKoraAuth({
			serverUrl: SERVER,
			storage: shared,
			fetch: fetchFn,
			deviceIdentity: false,
		})
		const tabB = createKoraAuth({
			serverUrl: SERVER,
			storage: shared,
			fetch: fetchFn,
			deviceIdentity: false,
		})

		const [a, b] = await Promise.all([tabA.getAccessToken(), tabB.getAccessToken()])

		expect(a).not.toBeNull()
		expect(b).not.toBeNull()
		expect(await shared.getRefreshToken()).not.toBeNull()
	})
})
