/**
 * AUTH-8 repro: after POST /auth/signout the (revoked) access token is still
 * accepted by HTTP routes because they use validateToken() which ignores the
 * revocation store. Asserts CORRECT behavior, so it FAILS today.
 */
import { describe, expect, test } from 'vitest'
import { createKoraAuthServer } from '../../src/provider/built-in/quickstart-server'

describe('AUTH-8: sign-out does not invalidate the access token on HTTP routes', () => {
	test('/auth/me and /auth/devices reject the access token after sign-out', async () => {
		const auth = createKoraAuthServer({ jwtSecret: 's'.repeat(64) })
		const signup = (await auth.handleRequest({
			method: 'POST',
			path: '/auth/signup',
			body: { email: 'u@example.com', password: 'password-123', deviceId: 'd1' },
		})).body as { data: { tokens: { accessToken: string; refreshToken: string } } }
		const { accessToken, refreshToken } = signup.data.tokens
		const headers = { authorization: `Bearer ${accessToken}` }

		const out = await auth.handleRequest({ method: 'POST', path: '/auth/signout', headers, body: { refreshToken } })
		expect(out.status).toBe(200)

		// Sync path correctly rejects it (validateTokenWithRevocation)...
		expect(await auth.auth.authenticate(accessToken)).toBeNull()
		// ...but HTTP routes do not.
		const me = await auth.handleRequest({ method: 'GET', path: '/auth/me', headers })
		expect.soft(me.status).toBe(401)
		const devices = await auth.handleRequest({ method: 'GET', path: '/auth/devices', headers })
		expect(devices.status).toBe(401)
	})
})
