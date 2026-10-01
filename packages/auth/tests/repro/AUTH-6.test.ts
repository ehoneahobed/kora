/**
 * AUTH-6 repro: refresh-token rotation is check-then-revoke (not atomic), so two
 * concurrent /auth/refresh calls with the same refresh token both succeed and
 * mint two independent token families, defeating reuse detection.
 * Asserts CORRECT behavior, so it FAILS today.
 */
import { describe, expect, test } from 'vitest'
import { createKoraAuthServer } from '../../src/provider/built-in/quickstart-server'

describe('AUTH-6: concurrent refresh with one refresh token', () => {
	test('at most one of N concurrent refreshes with the same token succeeds', async () => {
		const auth = createKoraAuthServer({ jwtSecret: 'r'.repeat(64) })
		const signup = (
			await auth.handleRequest({
				method: 'POST',
				path: '/auth/signup',
				body: { email: 'u@example.com', password: 'password-123', deviceId: 'd1' },
			})
		).body as { data: { tokens: { refreshToken: string } } }
		const rt = signup.data.tokens.refreshToken

		const results = await Promise.all(
			Array.from({ length: 5 }, () =>
				auth.handleRequest({ method: 'POST', path: '/auth/refresh', body: { refreshToken: rt } }),
			),
		)
		const ok = results.filter((r) => r.status === 200).length
		expect(ok).toBeLessThanOrEqual(1)
	})
})
