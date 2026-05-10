import { describe, expect, it, vi } from 'vitest'
import { createKoraAuthServer } from './quickstart-server'

const TEST_SECRET = 'a'.repeat(64)

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
})
