/**
 * LMS-2 — cold start while offline must restore the stored session (degraded/offline mode).
 *
 * FAILS at HEAD (91c6350): `initialize()` (src/client/auth-client.ts:411-424) clears
 * both tokens whenever the refresh attempt does not return a token, and the sync
 * binding (src/client/auth-sync.ts:114-130, 166-178) derives readiness and the
 * local-store user id from `getAccessToken()`, which is null whenever the access
 * token is expired and the network is unreachable.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createKoraAuth, createKoraAuthSync, createMemoryAuthTokenStorage } from '../../src/index'

const SERVER = 'https://auth.example.test'

function b64url(value: unknown): string {
	return btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function token(type: 'access' | 'refresh', expiresInSeconds: number, sub = 'user-1'): string {
	const now = Math.floor(Date.now() / 1000)
	const payload = { sub, dev: 'device-1', type, iat: now, exp: now + expiresInSeconds }
	return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.sig`
}

const offlineFetch = (async () => {
	throw new TypeError('Failed to fetch')
}) as unknown as typeof fetch

const captivePortalFetch = (async () =>
	new Response('<html>Login to WiFi</html>', {
		status: 200,
		headers: { 'Content-Type': 'text/html' },
	})) as unknown as typeof fetch

async function coldStart(fetchFn: typeof fetch, refreshTtlSeconds = 90 * 24 * 3600) {
	const storage = createMemoryAuthTokenStorage()
	const refresh = token('refresh', refreshTtlSeconds)
	// Access token expired yesterday (app was closed overnight).
	await storage.setTokens(token('access', -24 * 3600), refresh)
	let currentFetch = fetchFn
	const auth = createKoraAuth({
		serverUrl: SERVER,
		storage,
		fetch: ((...args: Parameters<typeof fetch>) => currentFetch(...args)) as typeof fetch,
		deviceIdentity: false,
	})
	await auth.initialize()
	return {
		auth,
		storage,
		refresh,
		goOnline(next: typeof fetch) {
			currentFetch = next
		},
	}
}

afterEach(() => {
	vi.useRealTimers()
})

describe('LMS-2: offline cold start restores the stored session', () => {
	it('offline (fetch rejects): authenticated as the stored user, tokens preserved', async () => {
		const { auth, storage, refresh } = await coldStart(offlineFetch)

		expect(auth.state).toBe('authenticated')
		expect(auth.currentUser?.id).toBe('user-1')
		expect(await storage.getRefreshToken()).toBe(refresh)
	})

	it('captive portal (HTTP 200 HTML): authenticated as the stored user, tokens preserved', async () => {
		const { auth, storage, refresh } = await coldStart(captivePortalFetch)

		expect(auth.state).toBe('authenticated')
		expect(await storage.getRefreshToken()).toBe(refresh)
	})

	it('when connectivity returns, the preserved refresh token silently renews the session', async () => {
		const h = await coldStart(offlineFetch)
		h.goOnline((async (input: RequestInfo | URL) => {
			const url = String(input)
			if (url.endsWith('/auth/refresh')) {
				return new Response(
					JSON.stringify({ data: { accessToken: token('access', 900), refreshToken: token('refresh', 90 * 86400) } }),
					{ status: 200, headers: { 'Content-Type': 'application/json' } },
				)
			}
			return new Response(JSON.stringify({ id: 'user-1', email: 'a@b.c', name: 'A' }), { status: 200 })
		}) as typeof fetch)

		expect(await h.auth.getAccessToken()).not.toBeNull()
		expect(h.auth.state).toBe('authenticated')
	})

	it('sync binding reports the stored user so AuthBoundKoraProvider mounts the local database offline', async () => {
		const { auth } = await coldStart(offlineFetch)
		const binding = createKoraAuthSync({ authClient: auth })

		const state = await binding.resolveSyncState?.()

		// The local DB must open for the stored user even though no fresh token can be minted.
		// (Whether sync may open a transport is a separate question; the identity is known.)
		expect(state?.state).toBe('authenticated')
		expect(state && 'userId' in state ? state.userId : undefined).toBe('user-1')
	})

	it('namespaceByAuthUser resolves the stored user id offline (not the "signed-out" database)', async () => {
		const { auth } = await coldStart(offlineFetch)
		const binding = createKoraAuthSync({ authClient: auth })

		expect(await binding.resolveUserId?.()).toBe('user-1')
	})
})

describe('LMS-2: guards (must keep passing)', () => {
	it('expired refresh token offline -> unauthenticated (no indefinite offline session)', async () => {
		const { auth } = await coldStart(offlineFetch, -60)
		expect(auth.state).toBe('unauthenticated')
	})

	it('definitive 401 at cold start -> unauthenticated and tokens cleared', async () => {
		const { auth, storage } = await coldStart((async () =>
			new Response(JSON.stringify({ error: 'Invalid or expired refresh token.' }), {
				status: 401,
				headers: { 'Content-Type': 'application/json' },
			})) as unknown as typeof fetch)
		expect(auth.state).toBe('unauthenticated')
		expect(await storage.getRefreshToken()).toBeNull()
	})
})
