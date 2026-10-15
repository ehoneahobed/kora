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
				binding: (start.body.data as { binding: string }).binding,
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

	// Inverted (AUTH-3/AUTH-5): the device id used to be taken from OAuth state
	// metadata, which comes from the query string of whoever started the flow.
	// A GET callback now gets a fresh server-assigned device id; clients that own a
	// device identity POST it to the callback instead.
	it('never takes the device id from authorization-start metadata', async () => {
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
			headers: { cookie: bindingCookie(start) },
			query: {
				code: 'code-1',
				state: start.body.data.state,
			},
		})

		expect(callback.status).toBe(200)
		if (!('data' in callback.body)) return
		const data = callback.body.data as AuthData
		const token = await auth.tokenManager.validateToken(data.tokens.accessToken)
		expect(token?.dev).not.toBe('browser-device')
		expect(token?.dev).toMatch(/^dev-/)
		await expect(auth.userStore.findDevice('browser-device')).resolves.toBeNull()
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

	it('does not auto-link a local account that never verified the address', async () => {
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
		// Someone registered the address with a password and never proved it.
		await auth.handleRequest({
			method: 'POST',
			path: '/auth/signup',
			body: { email: 'alice@example.com', password: 'password123', name: 'Squatter' },
		})
		const result = await completeOAuthResponse(auth)
		expect(result.status).toBe(409)
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
		headers: { cookie: bindingCookie(start) },
		query: {
			code: 'code-1',
			state: start.body.data.state,
		},
	})
}

/** The `kora_oauth_binding=...` pair a browser would send back from the start response. */
function bindingCookie(start: { headers?: Record<string, string> }): string {
	return (start.headers?.['Set-Cookie'] ?? '').split(';')[0] ?? ''
}

describe('OAuth flow binding (AUTH-3)', () => {
	const profile = { id: 'idp-1', email: 'mallory@example.com', email_verified: true, name: 'M' }

	it('sets an HttpOnly, SameSite binding cookie scoped to the OAuth routes', async () => {
		const auth = createKoraAuthServer({
			jwtSecret: TEST_SECRET,
			oauth: { providers: [TEST_PROVIDER], fetch: createOAuthFetch(profile) },
		})
		const start = await auth.handleRequest({ method: 'GET', path: '/auth/oauth/test' })
		const cookie = start.headers?.['Set-Cookie'] ?? ''
		expect(cookie).toMatch(/^kora_oauth_binding=[A-Za-z0-9_-]{20,};/)
		expect(cookie).toContain('HttpOnly')
		expect(cookie).toContain('SameSite=Lax')
		expect(cookie).toContain('Path=/auth/oauth')
	})

	it('refuses a callback that does not carry the initiating client binding (login CSRF)', async () => {
		const auth = createKoraAuthServer({
			jwtSecret: TEST_SECRET,
			oauth: { providers: [TEST_PROVIDER], fetch: createOAuthFetch(profile) },
		})
		const start = await auth.handleRequest({ method: 'GET', path: '/auth/oauth/test' })
		if (!('data' in start.body)) throw new Error('no state')
		const victim = await auth.handleRequest({
			method: 'GET',
			path: '/auth/oauth/test/callback',
			headers: { cookie: 'kora_oauth_binding=victims-own-binding' },
			query: { code: 'attacker-code', state: start.body.data.state },
		})
		expect(victim.status).toBe(400)
	})

	it('links only through an authenticated link/start bound to the same user', async () => {
		const auth = createKoraAuthServer({
			jwtSecret: TEST_SECRET,
			oauth: { providers: [TEST_PROVIDER], fetch: createOAuthFetch(profile) },
		})
		const alice = await auth.handleRequest({
			method: 'POST',
			path: '/auth/signup',
			body: { email: 'alice@example.com', password: 'password-123' },
		})
		const bob = await auth.handleRequest({
			method: 'POST',
			path: '/auth/signup',
			body: { email: 'bob@example.com', password: 'password-123' },
		})
		const aliceToken = (alice.body as { data: { tokens: { accessToken: string } } }).data.tokens
			.accessToken
		const bobToken = (bob.body as { data: { tokens: { accessToken: string } } }).data.tokens
			.accessToken

		const unauthenticated = await auth.handleRequest({
			method: 'POST',
			path: '/auth/oauth/test/link/start',
		})
		expect(unauthenticated.status).toBe(401)

		const start = await auth.handleRequest({
			method: 'POST',
			path: '/auth/oauth/test/link/start',
			headers: { authorization: `Bearer ${bobToken}` },
		})
		const flow = (start.body as { data: { state: string; binding: string } }).data

		// Bob's link state cannot be redeemed by Alice, even with the binding.
		const stolen = await auth.handleRequest({
			method: 'POST',
			path: '/auth/oauth/test/link',
			headers: { authorization: `Bearer ${aliceToken}` },
			body: { code: 'c', state: flow.state, binding: flow.binding },
		})
		expect(stolen.status).toBe(400)

		const start2 = await auth.handleRequest({
			method: 'POST',
			path: '/auth/oauth/test/link/start',
			headers: { authorization: `Bearer ${bobToken}` },
		})
		const flow2 = (start2.body as { data: { state: string; binding: string } }).data
		const linked = await auth.handleRequest({
			method: 'POST',
			path: '/auth/oauth/test/link',
			headers: { authorization: `Bearer ${bobToken}` },
			body: { code: 'c', state: flow2.state, binding: flow2.binding },
		})
		expect(linked.status).toBe(201)
	})
})

describe('createKoraAuthServer email verification', () => {
	function serverWithVerification(sendOnSignUp?: boolean) {
		const sent: Array<{ to: string; url: string; reason: string }> = []
		const auth = createKoraAuthServer({
			jwtSecret: TEST_SECRET,
			emailVerification: {
				url: (token) => `https://app.test/verify-email#${token}`,
				send: (message) => {
					sent.push(message)
				},
				...(sendOnSignUp === undefined ? {} : { sendOnSignUp }),
			},
		})
		const signUp = async (email: string) => {
			const response = await auth.handleRequest({
				method: 'POST',
				path: '/auth/signup',
				body: { email, password: 'password123', name: 'U' },
				ip: '127.0.0.1',
			})
			if (!('data' in response.body)) throw new Error('signup failed')
			return (response.body.data as AuthData).tokens.accessToken
		}
		const me = async (accessToken: string) => {
			const response = await auth.handleRequest({
				method: 'GET',
				path: '/auth/me',
				headers: { authorization: `Bearer ${accessToken}` },
			})
			return 'data' in response.body ? (response.body.data as { emailVerified: boolean }) : null
		}
		const tokenOf = (index: number) => {
			const url = sent[index]?.url ?? ''
			return url.slice(url.indexOf('#') + 1)
		}
		return { auth, sent, signUp, me, tokenOf }
	}

	it('sends a link at sign-up; the account opens it signed in to verify the address', async () => {
		const { auth, sent, signUp, me, tokenOf } = serverWithVerification()
		const accessToken = await signUp('ann@example.com')
		await vi.waitFor(() =>
			expect(sent).toEqual([expect.objectContaining({ to: 'ann@example.com', reason: 'signup' })]),
		)
		expect((await me(accessToken))?.emailVerified).toBe(false)
		const verify = (bearer: string | null) =>
			auth.handleRequest({
				method: 'POST',
				path: '/auth/email/verify',
				body: { token: tokenOf(0) },
				...(bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {}),
			})
		// Without a session (someone clicking the email who is not signed in to it): nothing.
		expect((await verify(null)).status).toBe(401)
		expect((await me(accessToken))?.emailVerified).toBe(false)
		expect((await verify(accessToken)).status).toBe(200)
		expect((await me(accessToken))?.emailVerified).toBe(true)
		expect(await verify(accessToken)).toMatchObject({
			status: 404,
			body: { code: 'VERIFICATION_TOKEN_INVALID' },
		})
	})

	it('a link opened while signed in to another account verifies nothing and keeps working', async () => {
		const { auth, signUp, me, tokenOf } = serverWithVerification()
		const victim = await signUp('victim@example.com')
		const other = await signUp('other@example.com')
		const verify = (bearer: string) =>
			auth.handleRequest({
				method: 'POST',
				path: '/auth/email/verify',
				body: { token: tokenOf(0) },
				headers: { authorization: `Bearer ${bearer}` },
			})
		await vi.waitFor(() => expect(tokenOf(0)).not.toBe(''))
		expect(await verify(other)).toMatchObject({
			status: 403,
			body: { code: 'VERIFICATION_WRONG_ACCOUNT' },
		})
		expect((await me(other))?.emailVerified).toBe(false)
		expect((await verify(victim)).status).toBe(200)
	})

	it('sign-up answers even when the verification email cannot be prepared', async () => {
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
		const auth = createKoraAuthServer({
			jwtSecret: TEST_SECRET,
			emailVerification: {
				url: (token) => token,
				send: () => {},
				store: {
					store: async () => {
						throw new Error('db down')
					},
					take: async () => null,
					get: async () => null,
					countSend: async () => 1,
					deleteForUser: async () => {},
					deleteExpired: async () => 0,
				},
			},
		})
		const response = await auth.handleRequest({
			method: 'POST',
			path: '/auth/signup',
			body: { email: 'z@example.com', password: 'password123', name: 'Z' },
			ip: '127.0.0.1',
		})
		expect(response.status).toBe(201)
		await vi.waitFor(() => expect(errors).toHaveBeenCalled())
		errors.mockRestore()
	})

	it('sends on request when signed in, and not at sign-up when turned off', async () => {
		const { auth, sent, signUp } = serverWithVerification(false)
		const accessToken = await signUp('bob@example.com')
		expect(sent).toHaveLength(0)
		const anonymous = await auth.handleRequest({
			method: 'POST',
			path: '/auth/email/send-verification',
		})
		expect(anonymous.status).toBe(401)
		const requested = await auth.handleRequest({
			method: 'POST',
			path: '/auth/email/send-verification',
			headers: { authorization: `Bearer ${accessToken}` },
		})
		expect(requested).toMatchObject({
			status: 200,
			body: { data: { sent: true, alreadyVerified: false } },
		})
		expect(sent).toEqual([expect.objectContaining({ to: 'bob@example.com', reason: 'request' })])
	})

	it('serves no verification routes unless configured', async () => {
		const auth = createKoraAuthServer({ jwtSecret: TEST_SECRET })
		const response = await auth.handleRequest({
			method: 'POST',
			path: '/auth/email/verify',
			body: { token: 'x'.repeat(43) },
		})
		expect(response.status).toBe(404)
		expect(auth.emailVerification).toBeUndefined()
	})

	it('refuses an in-memory verification store in production', () => {
		vi.stubEnv('NODE_ENV', 'production')
		try {
			const users = {
				getTokenRevocationStore: () => ({}),
				markEmailVerifiedIfEmail: async () => true,
			}
			expect(() =>
				createKoraAuthServer({
					jwtSecret: TEST_SECRET,
					userStore: Object.assign(Object.create(null), users) as never,
					emailVerification: { url: (t) => t, send: () => {} },
				}),
			).toThrow(/emailVerificationStore/)
		} finally {
			vi.unstubAllEnvs()
		}
	})
})

describe('createKoraAuthServer password reset and change', () => {
	function serverWithReset(configured = true) {
		const sent: Array<{ to: string; url: string }> = []
		const auth = createKoraAuthServer({
			jwtSecret: TEST_SECRET,
			...(configured
				? {
						passwordReset: {
							url: (token: string) => `https://app.test/reset-password#${token}`,
							send: (message: { to: string; url: string }) => {
								sent.push(message)
							},
						},
					}
				: {}),
		})
		const post = (path: string, body: Record<string, unknown>, bearer?: string, ip = '10.0.0.1') =>
			auth.handleRequest({
				method: 'POST',
				path,
				body,
				ip,
				...(bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {}),
			})
		const signUp = async (email: string) => {
			const response = await post('/auth/signup', { email, password: 'password123', name: 'U' })
			if (!('data' in response.body)) throw new Error('signup failed')
			return response.body.data as AuthData
		}
		const signIn = (email: string, password: string) => post('/auth/signin', { email, password })
		const me = (accessToken: string) =>
			auth.handleRequest({
				method: 'GET',
				path: '/auth/me',
				headers: { authorization: `Bearer ${accessToken}` },
			})
		const tokenOf = (index: number) => {
			const url = sent[index]?.url ?? ''
			return url.slice(url.indexOf('#') + 1)
		}
		return { auth, sent, post, signUp, signIn, me, tokenOf }
	}

	it('forgot answers the same for every address; the link resets the password and ends every session', async () => {
		const { sent, post, signUp, signIn, me, tokenOf } = serverWithReset()
		const session = await signUp('ann@example.com')
		const known = await post('/auth/password/forgot', { email: 'ann@example.com' })
		const unknown = await post('/auth/password/forgot', { email: 'nobody@example.com' })
		expect(known).toEqual(unknown)
		expect(known).toMatchObject({ status: 200, body: { data: { requested: true } } })
		await vi.waitFor(() => expect(sent).toHaveLength(1))
		expect(sent[0]?.to).toBe('ann@example.com')

		expect(
			await post('/auth/password/reset', { token: tokenOf(0), password: 'brand-new-pass' }),
		).toMatchObject({
			status: 200,
			body: { data: { reset: true } },
		})
		expect((await me(session.tokens.accessToken)).status).toBe(401)
		expect((await signIn('ann@example.com', 'password123')).status).toBe(401)
		expect((await signIn('ann@example.com', 'brand-new-pass')).status).toBe(200)
		expect(
			await post('/auth/password/reset', { token: tokenOf(0), password: 'again-pass' }),
		).toMatchObject({
			status: 404,
			body: { code: 'RESET_TOKEN_INVALID' },
		})
	})

	it('change needs the current password; this device gets new tokens and every other session ends', async () => {
		const { post, signUp, signIn, me } = serverWithReset()
		const first = await signUp('bob@example.com')
		const other = await signIn('bob@example.com', 'password123')
		if (!('data' in other.body)) throw new Error('signin failed')
		const otherTokens = (other.body.data as AuthData).tokens

		expect(
			await post(
				'/auth/password/change',
				{ currentPassword: 'wrong-pass', newPassword: 'brand-new-pass' },
				first.tokens.accessToken,
			),
		).toMatchObject({ status: 403, body: { code: 'CURRENT_PASSWORD_INCORRECT' } })
		expect(
			(
				await post('/auth/password/change', {
					currentPassword: 'password123',
					newPassword: 'brand-new-pass',
				})
			).status,
		).toBe(401)

		const changed = await post(
			'/auth/password/change',
			{ currentPassword: 'password123', newPassword: 'brand-new-pass' },
			first.tokens.accessToken,
		)
		expect(changed.status).toBe(200)
		const renewed = (changed.body as { data: AuthData }).data.tokens
		expect((await me(renewed.accessToken)).status).toBe(200)
		expect((await me(first.tokens.accessToken)).status).toBe(401)
		expect((await me(otherTokens.accessToken)).status).toBe(401)
		expect((await post('/auth/refresh', { refreshToken: otherTokens.refreshToken })).status).toBe(
			401,
		)
		expect((await post('/auth/refresh', { refreshToken: renewed.refreshToken })).status).toBe(200)
		expect((await signIn('bob@example.com', 'brand-new-pass')).status).toBe(200)
	})

	it('change works without passwordReset; forgot and reset are not served then', async () => {
		const { post, signUp } = serverWithReset(false)
		const session = await signUp('cat@example.com')
		expect((await post('/auth/password/forgot', { email: 'cat@example.com' })).status).toBe(404)
		expect(
			(await post('/auth/password/reset', { token: 'x'.repeat(43), password: 'brand-new-pass' }))
				.status,
		).toBe(404)
		const changed = await post(
			'/auth/password/change',
			{ currentPassword: 'password123', newPassword: 'brand-new-pass' },
			session.tokens.accessToken,
		)
		expect(changed.status).toBe(200)
	})

	it('guessing the current password is rate-limited', async () => {
		const { post, signUp } = serverWithReset()
		const session = await signUp('dan@example.com')
		const statuses: number[] = []
		for (let i = 0; i < 12; i++) {
			statuses.push(
				(
					await post(
						'/auth/password/change',
						{ currentPassword: `guess-${i}-xx`, newPassword: 'brand-new-pass' },
						session.tokens.accessToken,
					)
				).status,
			)
		}
		expect(statuses).toContain(429)
		expect(statuses.filter((s) => s === 403).length).toBeLessThanOrEqual(10)
	})

	it('background work is handed to the request’s waitUntil', async () => {
		const { auth, sent, signUp } = serverWithReset()
		await signUp('eve@example.com')
		const kept: Array<Promise<unknown>> = []
		await auth.handleRequest({
			method: 'POST',
			path: '/auth/password/forgot',
			body: { email: 'eve@example.com' },
			ip: '10.0.0.9',
			waitUntil: (work) => {
				kept.push(work)
			},
		})
		expect(kept).toHaveLength(1)
		await Promise.all(kept)
		expect(sent).toHaveLength(1)
	})

	it('without a client IP, forgot is not limited as one shared address', async () => {
		const { auth } = serverWithReset()
		const statuses: number[] = []
		for (let i = 0; i < 15; i++) {
			const response = await auth.handleRequest({
				method: 'POST',
				path: '/auth/password/forgot',
				body: { email: `n${i}@example.com` },
			})
			statuses.push(response.status)
		}
		expect(new Set(statuses)).toEqual(new Set([200]))
	})

	it('refuses an in-memory reset store in production', () => {
		vi.stubEnv('NODE_ENV', 'production')
		try {
			const users = { getTokenRevocationStore: () => ({}), updatePasswordIf: async () => true }
			expect(() =>
				createKoraAuthServer({
					jwtSecret: TEST_SECRET,
					userStore: Object.assign(Object.create(null), users) as never,
					passwordReset: { url: (t) => t, send: () => {} },
				}),
			).toThrow(/passwordResetStore/)
		} finally {
			vi.unstubAllEnvs()
		}
	})
})
