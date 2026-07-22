import { describe, expect, it, vi } from 'vitest'
import type { OAuthProviderConfig } from '../oauth/oauth-types'
import { createKoraAuthServer } from './quickstart-server'

const TEST_SECRET = 'a'.repeat(64)
const TEST_PROVIDER: OAuthProviderConfig = {
	providerId: 'test',
	clientId: 'client-id',
	clientSecret: 'client-secret',
	authorizationUrl: 'https://provider.example/authorize',
	tokenUrl: 'https://provider.example/token',
	userInfoUrl: 'https://provider.example/userinfo',
	scopes: ['openid', 'email', 'profile'],
	redirectUri: 'http://localhost/auth/oauth/test/callback',
}

interface AuthData {
	user: { id: string; email: string; emailVerified: boolean }
	tokens: { accessToken: string; refreshToken: string; deviceCredential: string }
	identity: { provider: string; providerUserId: string; userId: string }
}

describe('createKoraAuthServer', () => {
	it('handles the default auth HTTP routes', async () => {
		const auth = createKoraAuthServer({ jwtSecret: TEST_SECRET })

		const signUp = await auth.handleRequest({
			method: 'POST',
			path: '/auth/signup',
			body: {
				email: 'alice@example.com',
				password: 'password123',
				name: 'Alice',
			},
			ip: '127.0.0.1',
		})

		expect(signUp.status).toBe(201)
		expect('data' in signUp.body).toBe(true)
		if (!('data' in signUp.body)) return

		const me = await auth.handleRequest({
			method: 'GET',
			path: '/auth/me',
			headers: {
				authorization: `Bearer ${signUp.body.data.tokens.accessToken}`,
			},
		})

		expect(me.status).toBe(200)
		expect('data' in me.body).toBe(true)
		if ('data' in me.body) {
			expect(me.body.data.email).toBe('alice@example.com')
		}
	})

	it('exposes sync auth provider', async () => {
		const auth = createKoraAuthServer({ jwtSecret: TEST_SECRET })
		const signUp = await auth.handleRequest({
			method: 'POST',
			path: '/auth/signup',
			body: {
				email: 'alice@example.com',
				password: 'password123',
			},
		})
		if (!('data' in signUp.body)) return

		const context = await auth.auth.authenticate(signUp.body.data.tokens.accessToken)
		expect(context?.userId).toBe(signUp.body.data.user.id)
	})

	it('does not match routes outside the configured auth prefix', async () => {
		const auth = createKoraAuthServer({ jwtSecret: TEST_SECRET })

		const result = await auth.handleRequest({
			method: 'POST',
			path: '/authentication/signup',
			body: {
				email: 'alice@example.com',
				password: 'password123',
			},
		})

		expect(result.status).toBe(404)
	})

	it('requires an explicit secret in production', () => {
		vi.stubEnv('NODE_ENV', 'production')
		vi.stubEnv('KORA_AUTH_SECRET', '')

		expect(() => createKoraAuthServer()).toThrow(/jwtSecret/)

		vi.unstubAllEnvs()
	})

	it('warns when falling back to an ephemeral secret outside production', () => {
		vi.stubEnv('NODE_ENV', 'development')
		vi.stubEnv('KORA_AUTH_SECRET', '')
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

		createKoraAuthServer()

		expect(warn).toHaveBeenCalledWith(expect.stringContaining('ephemeral random secret'))

		warn.mockRestore()
		vi.unstubAllEnvs()
	})

	it('does not warn about ephemeral secrets when a secret is provided', () => {
		vi.stubEnv('NODE_ENV', 'development')
		vi.stubEnv('KORA_AUTH_SECRET', '')
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

		createKoraAuthServer({ jwtSecret: TEST_SECRET })

		expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('ephemeral random secret'))

		warn.mockRestore()
		vi.unstubAllEnvs()
	})

	it('creates users and linked identities through OAuth callbacks', async () => {
		const fetch = createOAuthFetch({
			id: 'provider-user-1',
			email: 'alice@example.com',
			email_verified: true,
			name: 'Alice',
		})
		const auth = createKoraAuthServer({
			jwtSecret: TEST_SECRET,
			oauth: { providers: [TEST_PROVIDER], fetch },
		})

		const start = await auth.handleRequest({
			method: 'GET',
			path: '/auth/oauth/test',
			query: { deviceId: 'desktop-1' },
		})
		expect(start.status).toBe(200)
		if (!('data' in start.body)) return

		const callback = await auth.handleRequest({
			method: 'POST',
			path: '/auth/oauth/test/callback',
			body: {
				code: 'code-1',
				state: start.body.data.state,
				deviceId: 'desktop-1',
				devicePublicKey: 'public-key',
			},
		})

		expect(callback.status).toBe(200)
		expect('data' in callback.body).toBe(true)
		if (!('data' in callback.body)) return
		const data = callback.body.data as AuthData
		expect(data.user.email).toBe('alice@example.com')
		expect(data.user.emailVerified).toBe(true)
		expect(data.identity).toMatchObject({
			provider: 'test',
			providerUserId: 'provider-user-1',
			userId: data.user.id,
		})

		const token = await auth.tokenManager.validateToken(data.tokens.accessToken)
		expect(token?.dev).toBe('desktop-1')
	})

	it('uses authorization-start device metadata for browser OAuth callbacks', async () => {
		const fetch = createOAuthFetch({
			id: 'provider-user-1',
			email: 'alice@example.com',
			email_verified: true,
			name: 'Alice',
		})
		const auth = createKoraAuthServer({
			jwtSecret: TEST_SECRET,
			oauth: { providers: [TEST_PROVIDER], fetch, allowUnlinkLastIdentity: true },
		})

		const start = await auth.handleRequest({
			method: 'GET',
			path: '/auth/oauth/test',
			query: { deviceId: 'browser-device', devicePublicKey: 'browser-public-key' },
		})
		if (!('data' in start.body)) return

		const callback = await auth.handleRequest({
			method: 'GET',
			path: '/auth/oauth/test/callback',
			query: {
				code: 'code-1',
				state: start.body.data.state,
			},
		})

		expect(callback.status).toBe(200)
		if (!('data' in callback.body)) return
		const data = callback.body.data as AuthData
		const token = await auth.tokenManager.validateToken(data.tokens.accessToken)
		expect(token?.dev).toBe('browser-device')
		await expect(auth.userStore.findDevice('browser-device')).resolves.toMatchObject({
			publicKey: 'browser-public-key',
		})
	})

	it('returns a structured error for unconfigured OAuth providers', async () => {
		const auth = createKoraAuthServer({
			jwtSecret: TEST_SECRET,
			oauth: { providers: [TEST_PROVIDER] },
		})

		const result = await auth.handleRequest({
			method: 'GET',
			path: '/auth/oauth/missing',
		})

		expect(result.status).toBe(404)
		if ('error' in result.body) {
			expect(result.body.error).toMatch(/not configured/i)
		}
	})

	it('signs into the same user when the OAuth identity is already linked', async () => {
		const fetch = createOAuthFetch({
			id: 'provider-user-1',
			email: 'alice@example.com',
			email_verified: true,
			name: 'Alice',
		})
		const auth = createKoraAuthServer({
			jwtSecret: TEST_SECRET,
			oauth: { providers: [TEST_PROVIDER], fetch },
		})

		const first = await completeOAuth(auth)
		const second = await completeOAuth(auth)

		expect(first.user.id).toBe(second.user.id)
		expect(fetch).toHaveBeenCalledTimes(4)
	})

	it('does not auto-link an existing email unless explicitly configured', async () => {
		const fetch = createOAuthFetch({
			id: 'provider-user-1',
			email: 'alice@example.com',
			email_verified: true,
			name: 'Alice',
		})
		const auth = createKoraAuthServer({
			jwtSecret: TEST_SECRET,
			oauth: { providers: [TEST_PROVIDER], fetch },
		})

		await auth.handleRequest({
			method: 'POST',
			path: '/auth/signup',
			body: {
				email: 'alice@example.com',
				password: 'password123',
				name: 'Alice',
			},
		})

		const result = await completeOAuthResponse(auth)
		expect(result.status).toBe(409)
		if ('error' in result.body) {
			expect(result.body.error).toMatch(/not linked/i)
		}
	})

	it('can explicitly auto-link an existing user by verified OAuth email', async () => {
		const fetch = createOAuthFetch({
			id: 'provider-user-1',
			email: 'alice@example.com',
			email_verified: true,
			name: 'Alice',
		})
		const auth = createKoraAuthServer({
			jwtSecret: TEST_SECRET,
			oauth: { providers: [TEST_PROVIDER], fetch, autoLinkVerifiedEmail: true },
		})

		const signUp = await auth.handleRequest({
			method: 'POST',
			path: '/auth/signup',
			body: {
				email: 'alice@example.com',
				password: 'password123',
				name: 'Alice',
			},
		})
		if (!('data' in signUp.body)) return
		await auth.userStore.setEmailVerified(signUp.body.data.user.id, true)

		const result = await completeOAuth(auth)
		expect(result.user.id).toBe(signUp.body.data.user.id)
	})

	it('lists, links, and unlinks OAuth identities for an authenticated user', async () => {
		const fetch = createOAuthFetch({
			id: 'provider-user-1',
			email: 'alice@example.com',
			email_verified: true,
			name: 'Alice',
		})
		const auth = createKoraAuthServer({
			jwtSecret: TEST_SECRET,
			oauth: { providers: [TEST_PROVIDER], fetch, allowUnlinkLastIdentity: true },
		})
		const signIn = await completeOAuth(auth)

		const list = await auth.handleRequest({
			method: 'GET',
			path: '/auth/oauth/links',
			headers: { authorization: `Bearer ${signIn.tokens.accessToken}` },
		})
		expect(list.status).toBe(200)
		if (!('data' in list.body)) return
		expect(list.body.data).toHaveLength(1)

		const remove = await auth.handleRequest({
			method: 'DELETE',
			path: '/auth/oauth/test/link',
			headers: { authorization: `Bearer ${signIn.tokens.accessToken}` },
		})
		expect(remove.status).toBe(200)

		const emptyList = await auth.handleRequest({
			method: 'GET',
			path: '/auth/oauth/links',
			headers: { authorization: `Bearer ${signIn.tokens.accessToken}` },
		})
		expect(emptyList.status).toBe(200)
		if ('data' in emptyList.body) {
			expect(emptyList.body.data).toEqual([])
		}
	})

	it('prevents unlinking the last OAuth identity by default', async () => {
		const fetch = createOAuthFetch({
			id: 'provider-user-1',
			email: 'alice@example.com',
			email_verified: true,
			name: 'Alice',
		})
		const auth = createKoraAuthServer({
			jwtSecret: TEST_SECRET,
			oauth: { providers: [TEST_PROVIDER], fetch },
		})
		const signIn = await completeOAuth(auth)

		const remove = await auth.handleRequest({
			method: 'DELETE',
			path: '/auth/oauth/test/link',
			headers: { authorization: `Bearer ${signIn.tokens.accessToken}` },
		})

		expect(remove.status).toBe(409)
		if ('error' in remove.body) {
			expect(remove.body.error).toMatch(/last OAuth identity/)
		}
	})
})

function createOAuthFetch(profile: Record<string, unknown>): typeof fetch {
	return vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input)
		if (url === TEST_PROVIDER.tokenUrl) {
			return new Response(
				JSON.stringify({
					access_token: 'provider-access-token',
					token_type: 'Bearer',
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			)
		}
		if (url === TEST_PROVIDER.userInfoUrl) {
			return new Response(JSON.stringify(profile), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			})
		}
		return new Response('not found', { status: 404 })
	}) as unknown as typeof fetch
}

async function completeOAuth(auth: ReturnType<typeof createKoraAuthServer>): Promise<AuthData> {
	const result = await completeOAuthResponse(auth)
	expect(result.status).toBe(200)
	if (!('data' in result.body)) {
		throw new Error('Expected OAuth response data')
	}
	return result.body.data as AuthData
}

async function completeOAuthResponse(
	auth: ReturnType<typeof createKoraAuthServer>,
): ReturnType<ReturnType<typeof createKoraAuthServer>['handleRequest']> {
	const start = await auth.handleRequest({
		method: 'GET',
		path: '/auth/oauth/test',
	})
	if (!('data' in start.body)) return start
	return auth.handleRequest({
		method: 'GET',
		path: '/auth/oauth/test/callback',
		query: {
			code: 'code-1',
			state: start.body.data.state,
		},
	})
}
