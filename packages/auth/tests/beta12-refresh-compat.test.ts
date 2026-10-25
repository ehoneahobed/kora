/**
 * Concurrent refresh compatibility with the beta.12 client. The beta.12 `AuthClient`
 * (vendored verbatim in fixtures/) treats ANY failed refresh, a 409 included, as a sign-out
 * and clears its tokens. Two tabs refreshing together must therefore both be answered with
 * the same rotated pair, while a replay of the old token after that still revokes the family.
 */
import { describe, expect, it } from 'vitest'
import { createKoraAuthServer } from '../src/provider/built-in/quickstart-server'
import { AuthClient, type AuthTokenStorage } from './fixtures/beta12-auth-client'

const SECRET = 'b'.repeat(64)

interface Tokens {
	accessToken: string
	refreshToken: string
}

/** An access token the beta.12 client sees as expired, so it must refresh. */
function expiredAccessToken(): string {
	const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
	return `${encode({ alg: 'HS256' })}.${encode({ sub: 'x', exp: 1 })}.sig`
}

function sharedStorage(tokens: Tokens): AuthTokenStorage & { read: () => Tokens | null } {
	let held: Tokens | null = { accessToken: expiredAccessToken(), refreshToken: tokens.refreshToken }
	return {
		getAccessToken: () => held?.accessToken ?? null,
		getRefreshToken: () => held?.refreshToken ?? null,
		setTokens: (accessToken, refreshToken) => {
			held = { accessToken, refreshToken }
		},
		clear: () => {
			held = null
		},
		read: () => held,
	}
}

async function setup() {
	const auth = createKoraAuthServer({ jwtSecret: SECRET })
	const res = await auth.handleRequest({
		method: 'POST',
		path: '/auth/signup',
		body: { email: 'tab@example.com', password: 'password-123', deviceId: 'd1' },
	})
	const tokens = (res.body as { data: { tokens: Tokens } }).data.tokens
	const statuses: number[] = []
	const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
		const path = new URL(String(url)).pathname
		const result = await auth.handleRequest({
			method: (init?.method ?? 'GET') as 'POST',
			path,
			body: init?.body ? JSON.parse(String(init.body)) : undefined,
		})
		statuses.push(result.status)
		return new Response(JSON.stringify(result.body), { status: result.status })
	}) as typeof fetch
	const tab = (storage: AuthTokenStorage) =>
		new AuthClient({ serverUrl: 'https://auth.example.test', storage, fetch: fetchFn })
	return { auth, tokens, statuses, tab }
}

describe('beta.12 client, concurrent refresh', () => {
	it.each([2, 3, 6])(
		'%i tabs refreshing the same session at once all stay signed in',
		async (n) => {
			const { tokens, statuses, tab } = await setup()
			const storage = sharedStorage(tokens)
			const results = await Promise.all(
				Array.from({ length: n }, () => tab(storage).getAccessToken()),
			)
			expect(statuses).toEqual(Array(n).fill(200))
			expect(results.every((token) => typeof token === 'string' && token.length > 0)).toBe(true)
			// One rotated pair, shared by every tab; tokens were not cleared.
			expect(new Set(results).size).toBe(1)
			expect(storage.read()?.refreshToken).not.toBe(tokens.refreshToken)
		},
	)

	it('a replay of the old refresh token after the grace replay was used still revokes the family', async () => {
		const { auth, tokens, tab } = await setup()
		const storage = sharedStorage(tokens)
		await Promise.all([tab(storage).getAccessToken(), tab(storage).getAccessToken()])
		const rotated = storage.read()
		const refresh = (refreshToken: string) =>
			auth.handleRequest({ method: 'POST', path: '/auth/refresh', body: { refreshToken } })
		// The one grace replay of a lost response is still available once ...
		expect((await refresh(tokens.refreshToken)).status).toBe(200)
		// ... and the next replay is theft: refused, and it kills the rotated successor too.
		expect((await refresh(tokens.refreshToken)).status).toBe(401)
		expect((await refresh(rotated?.refreshToken ?? '')).status).toBe(401)
	})
})
