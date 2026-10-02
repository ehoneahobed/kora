/**
 * AUTH-12 repro: createKoraAuthServer() hard-wires InMemoryTokenRevocationStore.
 * A revoked (signed-out) refresh token becomes valid again after a process
 * restart, and revocations are not shared between instances, even when the
 * user store is persistent. Asserts CORRECT behavior, so it FAILS today.
 */
import { describe, expect, test } from 'vitest'
import { createKoraAuthServer } from '../../src/provider/built-in/quickstart-server'
import { InMemoryUserStore } from '../../src/provider/built-in/user-store'

const SECRET = 'p'.repeat(64)

describe('AUTH-12: in-memory revocation store in the quickstart server', () => {
	test('a signed-out refresh token stays revoked across restart / other instance', async () => {
		// Persistent user DB shared by both "processes".
		const userStore = new InMemoryUserStore()
		const before = createKoraAuthServer({ jwtSecret: SECRET, userStore })
		const signup = (
			await before.handleRequest({
				method: 'POST',
				path: '/auth/signup',
				body: { email: 'u@example.com', password: 'password-123', deviceId: 'd1' },
			})
		).body as { data: { tokens: { accessToken: string; refreshToken: string } } }
		const { accessToken, refreshToken } = signup.data.tokens
		await before.handleRequest({
			method: 'POST',
			path: '/auth/signout',
			headers: { authorization: `Bearer ${accessToken}` },
			body: { refreshToken },
		})

		// Restart (or a second replica behind the load balancer).
		const after = createKoraAuthServer({ jwtSecret: SECRET, userStore })
		const res = await after.handleRequest({
			method: 'POST',
			path: '/auth/refresh',
			body: { refreshToken },
		})
		expect.soft(res.status).toBe(401)
		expect(await after.auth.authenticate(accessToken)).toBeNull()
	})
})
