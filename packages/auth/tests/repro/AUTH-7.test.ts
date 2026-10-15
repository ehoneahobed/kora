/**
 * AUTH-7 repro:
 *  (a) The reset token reached the requester in the HTTP response (PasswordResetManager
 *      without `onResetRequested`) => anyone who knows an email could take over the
 *      account. Since beta.15 the token only ever goes to the configured mailer.
 *  (b) Resetting the password does not revoke existing refresh/access tokens, so
 *      the attacker's stolen session survives the victim's password reset.
 * Asserts CORRECT behavior, so it FAILS today.
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { PasswordResetManager } from '../../src/provider/built-in/password-reset'
import { createKoraAuthServer } from '../../src/provider/built-in/quickstart-server'

const ENV = process.env.NODE_ENV
afterEach(() => {
	process.env.NODE_ENV = ENV
})

async function victim() {
	// allowInMemory: since beta.13 createKoraAuthServer refuses in-memory stores under
	// NODE_ENV=production (AUTH-12). This repro is about reset-token disclosure, not
	// storage, so it opts in explicitly to keep exercising the same code path.
	const auth = createKoraAuthServer({ jwtSecret: 'w'.repeat(64), allowInMemory: true })
	const s = (
		await auth.handleRequest({
			method: 'POST',
			path: '/auth/signup',
			body: { email: 'victim@example.com', password: 'password-123', deviceId: 'd1' },
		})
	).body as { data: { tokens: { accessToken: string; refreshToken: string } } }
	return { auth, tokens: s.data.tokens }
}

describe('AUTH-7: password reset', () => {
	test('(a) the reset token is never disclosed to the requester', async () => {
		process.env.NODE_ENV = 'production'
		const mailed: string[] = []
		// The built-in route: the only place the token goes is the mailer.
		const auth = createKoraAuthServer({
			jwtSecret: 'w'.repeat(64),
			allowInMemory: true,
			passwordReset: {
				url: (token) => `https://app.test/reset#${token}`,
				send: ({ url }) => {
					mailed.push(url.slice(url.indexOf('#') + 1))
				},
			},
		})
		await auth.handleRequest({
			method: 'POST',
			path: '/auth/signup',
			body: { email: 'victim@example.com', password: 'password-123', deviceId: 'd1' },
		})
		const res = await auth.handleRequest({
			method: 'POST',
			path: '/auth/password/forgot',
			body: { email: 'victim@example.com' },
		})
		await vi.waitFor(() => expect(mailed).toHaveLength(1))
		expect(JSON.stringify(res)).not.toContain(mailed[0])
		expect(res.body).toEqual({ data: { requested: true } })
	})

	test('(b) completing a reset revokes previously issued sessions', async () => {
		const { auth, tokens } = await victim()
		let mailed = ''
		const mgr = new PasswordResetManager(auth.userStore, {
			url: (token) => `#${token}`,
			send: ({ url }) => {
				mailed = url.slice(1)
			},
		})
		await mgr.request('victim@example.com')
		expect((await mgr.reset(mailed, 'brand-new-pass-1')).ok).toBe(true)

		const refresh = await auth.handleRequest({
			method: 'POST',
			path: '/auth/refresh',
			body: { refreshToken: tokens.refreshToken },
		})
		expect.soft(refresh.status).toBe(401)
		expect(await auth.auth.authenticate(tokens.accessToken)).toBeNull()
	})
})
