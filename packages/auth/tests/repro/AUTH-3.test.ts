/**
 * AUTH-3 repro: OAuth `state` is a server-side nonce that is not bound to the
 * initiating browser/user or to the flow purpose. A state minted by an
 * unauthenticated sign-in request (attacker) is accepted by the authenticated
 * /link endpoint called with the VICTIM's token (e.g. victim opens the attacker's
 * callback URL on an app page that completes linking). The attacker's provider
 * identity becomes linked to the victim's Kora account; the attacker then signs
 * in as the victim with OAuth.
 * Asserts CORRECT behavior, so it FAILS today.
 */
import { describe, expect, test } from 'vitest'
import { createKoraAuthServer } from '../../src/provider/built-in/quickstart-server'
import type { OAuthProviderConfig } from '../../src/provider/oauth/oauth-types'

const provider: OAuthProviderConfig = {
	providerId: 'acme',
	clientId: 'cid',
	clientSecret: 'secret',
	authorizationUrl: 'https://idp.example/authorize',
	tokenUrl: 'https://idp.example/token',
	userInfoUrl: 'https://idp.example/userinfo',
	scopes: ['openid', 'email'],
	redirectUri: 'https://app.example/auth/oauth/acme/callback',
}

// Fake IdP: the authorization code encodes which IdP account authorized.
const idpFetch = (async (url: string, init?: RequestInit) => {
	if (url === provider.tokenUrl) {
		const code = new URLSearchParams(String(init?.body)).get('code') ?? ''
		return new Response(JSON.stringify({ access_token: `at:${code.split(':')[0]}` }), {
			status: 200,
		})
	}
	const who = String((init?.headers as Record<string, string>).Authorization).replace(
		'Bearer at:',
		'',
	)
	return new Response(
		JSON.stringify({ sub: `idp-${who}`, email: `${who}@idp.example`, email_verified: true }),
		{ status: 200 },
	)
}) as unknown as typeof fetch

describe('AUTH-3: OAuth state not bound to initiator/purpose', () => {
	test('attacker-minted sign-in state cannot be redeemed on the victim /link endpoint', async () => {
		const auth = createKoraAuthServer({
			jwtSecret: 'o'.repeat(64),
			oauth: { providers: [provider], fetch: idpFetch },
		})
		const alice = (
			await auth.handleRequest({
				method: 'POST',
				path: '/auth/signup',
				body: { email: 'alice@example.com', password: 'password-123' },
			})
		).body as { data: { user: { id: string }; tokens: { accessToken: string } } }

		// 1. Mallory (no Kora session) starts a sign-in flow and authorizes with HER IdP account.
		const start = (await auth.handleRequest({ method: 'GET', path: '/auth/oauth/acme' })).body as {
			data: { state: string }
		}
		const mallorysCode = 'mallory:code-1'

		// 2. Victim's authenticated app completes "linking" with the attacker's code+state.
		const link = await auth.handleRequest({
			method: 'POST',
			path: '/auth/oauth/acme/link',
			headers: { authorization: `Bearer ${alice.data.tokens.accessToken}` },
			body: { code: mallorysCode, state: start.data.state },
		})
		expect.soft(link.status).toBeGreaterThanOrEqual(400)

		// 3. Mallory signs in with her IdP account.
		const s2 = (await auth.handleRequest({ method: 'GET', path: '/auth/oauth/acme' })).body as {
			data: { state: string }
		}
		const login = await auth.handleRequest({
			method: 'POST',
			path: '/auth/oauth/acme/callback',
			body: { code: 'mallory:code-2', state: s2.data.state },
		})
		const loggedInAs = (login.body as { data?: { user: { id: string } } }).data?.user.id
		expect(loggedInAs).not.toBe(alice.data.user.id)
	})
})
