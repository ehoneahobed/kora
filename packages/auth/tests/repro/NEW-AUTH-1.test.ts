/**
 * NEW-AUTH-1 repro: device revocation in the token revocation store is permanent
 * and keyed by a reusable device id, and reuse detection fires on an ordinary
 * retried refresh (response lost on a flaky network). The legitimate user then
 * re-authenticates with the password on the same device (stable deviceId from
 * the default device identity provider) and still can never sync again.
 * Asserts CORRECT behavior, so it FAILS today.
 */
import { describe, expect, test } from 'vitest'
import { createKoraAuthServer } from '../../src/provider/built-in/quickstart-server'

type SignResp = { data: { tokens: { accessToken: string; refreshToken: string } } }

describe('NEW-AUTH-1: permanent device ban after reuse detection / revocation', () => {
	test('fresh password sign-in on the same device restores sync access', async () => {
		const auth = createKoraAuthServer({ jwtSecret: 'n'.repeat(64) })
		const s = (await auth.handleRequest({
			method: 'POST',
			path: '/auth/signup',
			body: { email: 'u@example.com', password: 'password-123', deviceId: 'phone' },
		})).body as SignResp
		const rt = s.data.tokens.refreshToken

		// Refresh succeeds server-side but the response is lost; client retries with the same token.
		await auth.handleRequest({ method: 'POST', path: '/auth/refresh', body: { refreshToken: rt } })
		await auth.handleRequest({ method: 'POST', path: '/auth/refresh', body: { refreshToken: rt } })

		// User signs in again with their password from the same physical device.
		const again = await auth.handleRequest({
			method: 'POST',
			path: '/auth/signin',
			body: { email: 'u@example.com', password: 'password-123', deviceId: 'phone' },
		})
		expect(again.status).toBe(200)
		const token = (again.body as SignResp).data.tokens.accessToken
		expect(await auth.auth.authenticate(token)).not.toBeNull()
	})
})
