/**
 * AUTH-2 repro: revoking a device (DELETE /auth/device/:id) does not stop that
 * device's existing refresh token from minting new tokens, and the HTTP routes
 * accept access tokens of a revoked device because they call validateToken()
 * (no revocation check). Asserts CORRECT behavior, so it FAILS today.
 */
import { describe, expect, test } from 'vitest'
import { createKoraAuthServer } from '../../src/provider/built-in/quickstart-server'

const SECRET = 'y'.repeat(64)

function bearer(token: string) {
	return { authorization: `Bearer ${token}` }
}

describe('AUTH-2: revoked device keeps working', () => {
	test('refresh token of a revoked device must be rejected; its access token must not pass HTTP routes', async () => {
		const auth = createKoraAuthServer({ jwtSecret: SECRET })
		// Laptop (later stolen) and phone, both signed in by the same user.
		const laptop = (await auth.handleRequest({
			method: 'POST',
			path: '/auth/signup',
			body: { email: 'u@example.com', password: 'password-123', deviceId: 'laptop' },
		})).body as { data: { tokens: { accessToken: string; refreshToken: string } } }
		const phone = (await auth.handleRequest({
			method: 'POST',
			path: '/auth/signin',
			body: { email: 'u@example.com', password: 'password-123', deviceId: 'phone' },
		})).body as { data: { tokens: { accessToken: string } } }

		// User revokes the stolen laptop from the phone.
		const revoke = await auth.handleRequest({
			method: 'DELETE',
			path: '/auth/device/laptop',
			headers: bearer(phone.data.tokens.accessToken),
		})
		expect(revoke.status).toBe(200)

		// Thief keeps using the laptop's refresh token.
		const refreshed = await auth.handleRequest({
			method: 'POST',
			path: '/auth/refresh',
			body: { refreshToken: laptop.data.tokens.refreshToken },
		})
		expect.soft(refreshed.status).toBe(401)

		// The laptop's pre-revocation access token on HTTP routes.
		const me = await auth.handleRequest({
			method: 'GET',
			path: '/auth/me',
			headers: bearer(laptop.data.tokens.accessToken),
		})
		expect.soft(me.status).toBe(401)

		const devices = await auth.handleRequest({
			method: 'GET',
			path: '/auth/devices',
			headers: bearer(laptop.data.tokens.accessToken),
		})
		expect.soft(devices.status).toBe(401)

		// Worst case: the revoked laptop revokes the owner's remaining device.
		const counter = await auth.handleRequest({
			method: 'DELETE',
			path: '/auth/device/phone',
			headers: bearer(laptop.data.tokens.accessToken),
		})
		expect(counter.status).toBe(401)
	})
})
