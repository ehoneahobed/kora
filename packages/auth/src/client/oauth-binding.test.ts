import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthClient } from './auth-client'
import { createMemoryAuthTokenStorage } from './storage'

function json(body: unknown): Response {
	return new Response(JSON.stringify({ data: body }), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	})
}

afterEach(() => {
	vi.unstubAllGlobals()
})

describe('AuthClient OAuth flow binding (AUTH-3)', () => {
	it('keeps the binding of the flow it started and presents it with the callback', async () => {
		const session = new Map<string, string>()
		vi.stubGlobal('sessionStorage', {
			getItem: (k: string) => session.get(k) ?? null,
			setItem: (k: string, v: string) => session.set(k, v),
			removeItem: (k: string) => session.delete(k),
		})
		const bodies: unknown[] = []
		const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input)
			if (url.includes('/callback')) {
				bodies.push(JSON.parse(String(init?.body)))
				return json({
					user: { id: 'u1', email: 'a@b.c', name: null },
					tokens: { accessToken: 'a.b.c', refreshToken: 'd.e.f' },
					identity: {},
				})
			}
			return json({ url: 'https://idp/authorize', state: 'st-1', binding: 'bind-1' })
		})
		const client = new AuthClient({
			serverUrl: 'https://auth.example',
			storage: createMemoryAuthTokenStorage(),
			fetch: fetchFn as unknown as typeof fetch,
		})
		await client.signInWithOAuth('google', { redirect: false })
		// After a full-page redirect the in-memory copy is gone; session storage survives.
		expect(session.get('kora_oauth_binding:st-1')).toBe('bind-1')

		await client.completeOAuthSignIn('google', { code: 'c', state: 'st-1' })
		expect(bodies[0]).toMatchObject({ code: 'c', state: 'st-1', binding: 'bind-1' })
		expect(session.has('kora_oauth_binding:st-1')).toBe(false)

		// A crafted callback (someone else's state) carries no binding at all.
		await client.completeOAuthSignIn('google', { code: 'evil', state: 'attacker-state' })
		expect(bodies[1]).not.toHaveProperty('binding')
	})
})
