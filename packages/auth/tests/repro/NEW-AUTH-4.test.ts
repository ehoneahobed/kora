/**
 * NEW-AUTH-4 repro: restoreSession() treated a 401 from /auth/me as "offline" and
 * stayed authenticated from the JWT, so a revoked session (signed out elsewhere,
 * device revoked, password reset) kept running locally with its tokens.
 * A 401 carrying a Kora JSON error is definitive; a proxy/captive-portal answer
 * or a network failure is not.
 * Written when W2 started (plan §4 W0 acceptance checks); fails at beta.12.
 */
import { describe, expect, it } from 'vitest'
import { createKoraAuth, createMemoryAuthTokenStorage } from '../../src/index'

const SERVER = 'https://auth.example.test'

function b64url(value: unknown): string {
	return btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function token(type: 'access' | 'refresh', expiresInSeconds: number): string {
	const now = Math.floor(Date.now() / 1000)
	const payload = { sub: 'user-1', dev: 'device-1', type, iat: now, exp: now + expiresInSeconds }
	return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.sig`
}

async function coldStart(me: () => Promise<Response>) {
	const storage = createMemoryAuthTokenStorage()
	await storage.setTokens(token('access', 900), token('refresh', 90 * 86400))
	const fetchFn = (async (input: RequestInfo | URL) => {
		if (String(input).endsWith('/auth/me')) return me()
		throw new TypeError('unexpected url')
	}) as typeof fetch
	const auth = createKoraAuth({ serverUrl: SERVER, storage, fetch: fetchFn, deviceIdentity: false })
	await auth.initialize()
	return { auth, storage }
}

describe('NEW-AUTH-4: restoreSession and a definitive 401 from /auth/me', () => {
	it('a Kora 401 from /auth/me ends the session and clears the tokens', async () => {
		const { auth, storage } = await coldStart(
			async () =>
				new Response(
					JSON.stringify({
						error: 'Invalid or expired access token.',
						code: 'ACCESS_TOKEN_INVALID',
					}),
					{ status: 401, headers: { 'Content-Type': 'application/json' } },
				),
		)
		expect(auth.state).toBe('unauthenticated')
		expect(await storage.getRefreshToken()).toBeNull()
	})

	it('guard: a 401 HTML page from a captive portal keeps the session (offline)', async () => {
		const { auth, storage } = await coldStart(
			async () => new Response('<html>Sign in to Wi-Fi</html>', { status: 401 }),
		)
		expect(auth.state).toBe('authenticated')
		expect(await storage.getRefreshToken()).not.toBeNull()
	})

	it('guard: a network failure keeps the session (offline)', async () => {
		const { auth } = await coldStart(async () => {
			throw new TypeError('Failed to fetch')
		})
		expect(auth.state).toBe('authenticated')
		expect(auth.currentUser?.id).toBe('user-1')
	})
})
