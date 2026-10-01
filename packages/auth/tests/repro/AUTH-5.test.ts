/**
 * AUTH-5 repro: deviceId is client-chosen and not bound to the user. Mallory
 * signs in with Alice's deviceId; registerDevice() returns Alice's device record,
 * and Mallory receives tokens whose `dev` claim is Alice's device. Mallory then
 * replays her own refresh token to trip reuse detection, which revokes the device
 * id globally and locks Alice's device out of sync.
 * Asserts CORRECT behavior, so it FAILS today.
 */
import { describe, expect, test } from 'vitest'
import { createKoraAuthServer } from '../../src/provider/built-in/quickstart-server'
import { decodeJwt } from '../../src/tokens/jwt'

type SignResp = { data: { user: { id: string }; tokens: { accessToken: string; refreshToken: string } } }

describe('AUTH-5: client-chosen deviceId', () => {
	test('another user cannot obtain tokens for, or revoke, a device id owned by someone else', async () => {
		const auth = createKoraAuthServer({ jwtSecret: 'q'.repeat(64) })
		const alice = (await auth.handleRequest({
			method: 'POST',
			path: '/auth/signup',
			body: { email: 'alice@example.com', password: 'password-123', deviceId: 'alice-laptop' },
		})).body as SignResp
		expect(await auth.auth.authenticate(alice.data.tokens.accessToken)).not.toBeNull()

		// Mallory learns the id (it is the sync node id on every op Alice writes).
		await auth.handleRequest({
			method: 'POST',
			path: '/auth/signup',
			body: { email: 'mallory@example.com', password: 'password-123' },
		})
		const m = await auth.handleRequest({
			method: 'POST',
			path: '/auth/signin',
			body: { email: 'mallory@example.com', password: 'password-123', deviceId: 'alice-laptop' },
		})
		// Correct: reject (409/403) or at least never mint a token bound to Alice's device.
		if (m.status === 200) {
			const claims = decodeJwt((m.body as SignResp).data.tokens.accessToken) as { dev?: string } | null
			expect.soft(claims?.dev).not.toBe('alice-laptop')

			// Reuse-detection trip: refresh once, then replay the consumed token.
			const rt = (m.body as SignResp).data.tokens.refreshToken
			await auth.handleRequest({ method: 'POST', path: '/auth/refresh', body: { refreshToken: rt } })
			await auth.handleRequest({ method: 'POST', path: '/auth/refresh', body: { refreshToken: rt } })
		}

		// Alice's device must be unaffected by anything Mallory did.
		expect(await auth.auth.authenticate(alice.data.tokens.accessToken)).not.toBeNull()
	})
})
