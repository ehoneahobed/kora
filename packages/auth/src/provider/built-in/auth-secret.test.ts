import { afterEach, describe, expect, it, vi } from 'vitest'
import { authSecretFromEnv, createKoraAuthServer } from './quickstart-server'

vi.mock('./password-hash', () => import('./password-hash.test-double'))

const OLD = 'o'.repeat(64)
const NEW = 'n'.repeat(64)

describe('authSecretFromEnv', () => {
	it('signs with KORA_AUTH_SECRET and still accepts the previous ones', () => {
		expect(authSecretFromEnv({ KORA_AUTH_SECRET: NEW })).toBe(NEW)
		expect(
			authSecretFromEnv({ KORA_AUTH_SECRET: NEW, KORA_AUTH_SECRET_PREVIOUS: ` ${OLD} , ,${NEW}` }),
		).toEqual([NEW, OLD])
		expect(
			authSecretFromEnv({ KORA_AUTH_SECRET: '  ', KORA_AUTH_SECRET_PREVIOUS: OLD }),
		).toBeUndefined()
		expect(authSecretFromEnv({ KORA_AUTH_SECRET: `${NEW}\n` })).toBe(`${NEW}\n`)
	})
})

describe('changing the sign-in secret', () => {
	afterEach(() => vi.unstubAllEnvs())

	it('keeps someone signed in under the old secret, and signs new sessions with the new one', async () => {
		vi.stubEnv('KORA_AUTH_SECRET', OLD)
		const before = createKoraAuthServer({ allowInMemory: true })
		const signUp = await before.handleRequest({
			method: 'POST',
			path: '/auth/signup',
			body: { email: 'a@example.com', password: 'password123', name: 'A' },
			ip: '127.0.0.1',
		})
		const tokens = (
			signUp.body as { data: { tokens: { accessToken: string; refreshToken: string } } }
		).data.tokens
		vi.stubEnv('KORA_AUTH_SECRET', NEW)
		vi.stubEnv('KORA_AUTH_SECRET_PREVIOUS', OLD)
		// The same stores, as after a restart on the new settings.
		const after = createKoraAuthServer({
			allowInMemory: true,
			userStore: before.userStore,
			revocationStore: before.tokenManager.getRevocationStore() ?? undefined,
		})
		const me = await after.handleRequest({
			method: 'GET',
			path: '/auth/me',
			headers: { authorization: `Bearer ${tokens.accessToken}` },
			ip: '127.0.0.1',
		})
		expect(me.status).toBe(200)
		const refreshed = await after.handleRequest({
			method: 'POST',
			path: '/auth/refresh',
			body: { refreshToken: tokens.refreshToken },
			ip: '127.0.0.1',
		})
		expect(refreshed.status).toBe(200)
		// Without the previous secret, the old session is gone: what this setting prevents.
		vi.stubEnv('KORA_AUTH_SECRET_PREVIOUS', '')
		const without = createKoraAuthServer({ allowInMemory: true, userStore: before.userStore })
		expect(
			(
				await without.handleRequest({
					method: 'GET',
					path: '/auth/me',
					headers: { authorization: `Bearer ${tokens.accessToken}` },
					ip: '127.0.0.1',
				})
			).status,
		).toBe(401)
	})
})
