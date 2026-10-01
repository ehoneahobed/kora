/**
 * AUTH-7 repro:
 *  (a) PasswordResetManager without `onResetRequested` returns the reset token in
 *      the HTTP response to whoever asked (no NODE_ENV guard) => anyone who knows
 *      an email can take over the account.
 *  (b) Resetting the password does not revoke existing refresh/access tokens, so
 *      the attacker's stolen session survives the victim's password reset.
 * Asserts CORRECT behavior, so it FAILS today.
 */
import { afterEach, describe, expect, test } from 'vitest'
import { PasswordResetManager } from '../../src/provider/built-in/password-reset'
import { createKoraAuthServer } from '../../src/provider/built-in/quickstart-server'

const ENV = process.env.NODE_ENV
afterEach(() => {
	process.env.NODE_ENV = ENV
})

async function victim() {
	const auth = createKoraAuthServer({ jwtSecret: 'w'.repeat(64) })
	const s = (await auth.handleRequest({
		method: 'POST',
		path: '/auth/signup',
		body: { email: 'victim@example.com', password: 'password-123', deviceId: 'd1' },
	})).body as { data: { tokens: { accessToken: string; refreshToken: string } } }
	return { auth, tokens: s.data.tokens }
}

describe('AUTH-7: password reset', () => {
	test('(a) reset token is never disclosed to the requester (production, no callback configured)', async () => {
		process.env.NODE_ENV = 'production'
		const { auth } = await victim()
		const mgr = new PasswordResetManager({ userStore: auth.userStore })
		const res = await mgr.requestReset('victim@example.com')
		const token = (res.body as { data?: { token?: string } }).data?.token
		expect.soft(token).toBeUndefined()
		if (token) {
			const takeover = await mgr.resetPassword(token, 'attacker-pass-1')
			expect(takeover.status).not.toBe(200)
		}
	})

	test('(b) completing a reset revokes previously issued sessions', async () => {
		const { auth, tokens } = await victim()
		let mailed = ''
		const mgr = new PasswordResetManager({
			userStore: auth.userStore,
			onResetRequested: (_e, t) => {
				mailed = t
			},
		})
		await mgr.requestReset('victim@example.com')
		expect((await mgr.resetPassword(mailed, 'brand-new-pass-1')).status).toBe(200)

		const refresh = await auth.handleRequest({
			method: 'POST',
			path: '/auth/refresh',
			body: { refreshToken: tokens.refreshToken },
		})
		expect.soft(refresh.status).toBe(401)
		expect(await auth.auth.authenticate(tokens.accessToken)).toBeNull()
	})
})
