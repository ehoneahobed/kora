import { beforeEach, describe, expect, test, vi } from 'vitest'
import { hashPassword, verifyPassword } from './password-hash'
import { InMemoryPasswordResetStore, PasswordResetManager } from './password-reset'
import { InMemoryUserStore } from './user-store'

describe('PasswordResetManager', () => {
	let userStore: InMemoryUserStore
	let resetStore: InMemoryPasswordResetStore
	let manager: PasswordResetManager
	let userId: string

	beforeEach(async () => {
		userStore = new InMemoryUserStore()
		resetStore = new InMemoryPasswordResetStore()

		const hashed = await hashPassword('oldPassword123')
		const user = await userStore.createUser({
			email: 'alice@example.com',
			passwordHash: hashed.hash,
			salt: hashed.salt,
			name: 'Alice',
		})
		userId = user.id

		// Development mode must be explicit since beta.13 (AUTH-7a).
		manager = new PasswordResetManager({
			userStore,
			resetStore,
			exposeTokenForDevelopment: true,
		})
	})

	// --- requestReset ---

	describe('requestReset', () => {
		// Inverted (AUTH-7a): previously a manager without onResetRequested returned
		// the reset token to whoever asked, which is an account takeover by email.
		test('never discloses the token without an explicit development opt-in', async () => {
			const error = vi.spyOn(console, 'error').mockImplementation(() => {})
			const mgr = new PasswordResetManager({ userStore, resetStore })
			const result = await mgr.requestReset('alice@example.com')
			expect(result.status).toBe(200)
			expect('data' in result.body && result.body.data.token).toBeFalsy()
			expect(error).toHaveBeenCalledWith(expect.stringContaining('onResetRequested'))
			error.mockRestore()
		})

		test('never discloses the token in production, even with the development opt-in', async () => {
			vi.stubEnv('NODE_ENV', 'production')
			const error = vi.spyOn(console, 'error').mockImplementation(() => {})
			try {
				const mgr = new PasswordResetManager({
					userStore,
					resetStore,
					exposeTokenForDevelopment: true,
				})
				const result = await mgr.requestReset('alice@example.com')
				expect('data' in result.body && result.body.data.token).toBeFalsy()
			} finally {
				error.mockRestore()
				vi.unstubAllEnvs()
			}
		})

		test('existing and unknown emails get the same message', async () => {
			const mailer = new PasswordResetManager({
				userStore,
				resetStore,
				onResetRequested: () => {},
			})
			const known = await mailer.requestReset('alice@example.com')
			const unknown = await mailer.requestReset('nobody@example.com')
			expect(known.body).toEqual(unknown.body)
		})

		test('returns 200 and generates token for existing user', async () => {
			const result = await manager.requestReset('alice@example.com')
			expect(result.status).toBe(200)
			expect('data' in result.body).toBe(true)
			if ('data' in result.body) {
				expect(result.body.data.token).toBeTruthy()
				expect(result.body.data.token?.length).toBeGreaterThan(20)
			}
		})

		test('returns 200 for non-existent email (prevents enumeration)', async () => {
			const result = await manager.requestReset('nobody@example.com')
			expect(result.status).toBe(200)
			if ('data' in result.body) {
				expect(result.body.data.token).toBeUndefined()
			}
		})

		test('normalizes email to lowercase', async () => {
			const result = await manager.requestReset('ALICE@Example.COM')
			expect(result.status).toBe(200)
			if ('data' in result.body) {
				expect(result.body.data.token).toBeTruthy()
			}
		})

		test('rate limits after max requests', async () => {
			await manager.requestReset('alice@example.com')
			await manager.requestReset('alice@example.com')
			await manager.requestReset('alice@example.com')

			// 4th request should still return 200 (prevent enumeration) but no token
			const result = await manager.requestReset('alice@example.com')
			expect(result.status).toBe(200)
			if ('data' in result.body) {
				// Token won't be generated since rate limited
				expect(result.body.data.message).toContain('If an account')
			}
		})

		test('invokes onResetRequested callback', async () => {
			const callback = vi.fn()
			const mgr = new PasswordResetManager({
				userStore,
				resetStore,
				onResetRequested: callback,
			})

			await mgr.requestReset('alice@example.com')
			expect(callback).toHaveBeenCalledTimes(1)
			expect(callback).toHaveBeenCalledWith(
				'alice@example.com',
				expect.any(String),
				expect.any(Number),
			)
		})

		test('hides token when callback is configured', async () => {
			const mgr = new PasswordResetManager({
				userStore,
				resetStore,
				onResetRequested: () => {},
			})

			const result = await mgr.requestReset('alice@example.com')
			if ('data' in result.body) {
				expect(result.body.data.token).toBeUndefined()
			}
		})
	})

	// --- resetPassword ---

	describe('resetPassword', () => {
		test('resets password with valid token', async () => {
			const reqResult = await manager.requestReset('alice@example.com')
			const token = 'data' in reqResult.body ? (reqResult.body.data.token ?? '') : ''

			const result = await manager.resetPassword(token, 'newPassword456')
			expect(result.status).toBe(200)

			// Verify new password works
			const user = await userStore.findByEmail('alice@example.com')
			expect(user).not.toBeNull()
			const isValid = await verifyPassword('newPassword456', user?.passwordHash, user?.salt)
			expect(isValid).toBe(true)

			// Verify old password no longer works
			const oldValid = await verifyPassword('oldPassword123', user?.passwordHash, user?.salt)
			expect(oldValid).toBe(false)
		})

		test('rejects already consumed token', async () => {
			const reqResult = await manager.requestReset('alice@example.com')
			const token = 'data' in reqResult.body ? (reqResult.body.data.token ?? '') : ''

			await manager.resetPassword(token, 'newPassword456')
			const result = await manager.resetPassword(token, 'anotherPassword789')
			expect(result.status).toBe(404)
		})

		test('rejects expired token', async () => {
			const mgr = new PasswordResetManager({
				userStore,
				resetStore,
				tokenTtlMs: 1, // 1ms TTL for testing
				exposeTokenForDevelopment: true,
			})

			const reqResult = await mgr.requestReset('alice@example.com')
			const token = 'data' in reqResult.body ? (reqResult.body.data.token ?? '') : ''

			// Wait for expiry
			await new Promise((r) => setTimeout(r, 10))

			const result = await mgr.resetPassword(token, 'newPassword456')
			expect(result.status).toBe(410)
		})

		test('rejects non-existent token', async () => {
			const result = await manager.resetPassword('bogus-token', 'newPassword456')
			expect(result.status).toBe(404)
		})

		test('rejects short password', async () => {
			const reqResult = await manager.requestReset('alice@example.com')
			const token = 'data' in reqResult.body ? (reqResult.body.data.token ?? '') : ''

			const result = await manager.resetPassword(token, 'short')
			expect(result.status).toBe(400)
			expect('error' in result.body && result.body.error).toContain('at least 8')
		})

		test('rejects excessively long password', async () => {
			const reqResult = await manager.requestReset('alice@example.com')
			const token = 'data' in reqResult.body ? (reqResult.body.data.token ?? '') : ''

			const result = await manager.resetPassword(token, 'a'.repeat(129))
			expect(result.status).toBe(400)
			expect('error' in result.body && result.body.error).toContain('at most 128')
		})
	})

	// --- changePassword ---

	describe('changePassword', () => {
		test('changes password when current password is correct', async () => {
			const result = await manager.changePassword(userId, 'oldPassword123', 'newPassword456')
			expect(result.status).toBe(200)

			// Verify new password works
			const user = await userStore.findByEmail('alice@example.com')
			const isValid = await verifyPassword('newPassword456', user?.passwordHash, user?.salt)
			expect(isValid).toBe(true)
		})

		test('rejects incorrect current password', async () => {
			const result = await manager.changePassword(userId, 'wrongPassword', 'newPassword456')
			expect(result.status).toBe(401)
		})

		test('rejects non-existent user', async () => {
			const result = await manager.changePassword('no-one', 'x', 'newPassword456')
			expect(result.status).toBe(404)
		})

		test('rejects short new password', async () => {
			const result = await manager.changePassword(userId, 'oldPassword123', 'short')
			expect(result.status).toBe(400)
		})

		test('rejects long new password', async () => {
			const result = await manager.changePassword(userId, 'oldPassword123', 'a'.repeat(129))
			expect(result.status).toBe(400)
		})
	})
})

// --- Credential revocation (AUTH-7b) ---

describe('PasswordResetManager revokes earlier credentials', () => {
	test('resetPassword and changePassword cut off every earlier token of the user', async () => {
		const userStore = new InMemoryUserStore()
		const hashed = await hashPassword('oldPassword123')
		const user = await userStore.createUser({
			email: 'bob@example.com',
			passwordHash: hashed.hash,
			salt: hashed.salt,
			name: 'Bob',
		})
		const changed = vi.fn()
		let mailed = ''
		const mgr = new PasswordResetManager({
			userStore,
			onResetRequested: (_email, token) => {
				mailed = token
			},
			onPasswordChanged: changed,
		})
		const revocations = userStore.getTokenRevocationStore()

		await mgr.requestReset('bob@example.com')
		const before = Date.now()
		expect((await mgr.resetPassword(mailed, 'brandNewPass1')).status).toBe(200)
		const cutoff = await revocations.getUserRevokedBefore(user.id)
		expect(cutoff).not.toBeNull()
		expect(cutoff as number).toBeGreaterThanOrEqual(before)
		expect(changed).toHaveBeenCalledWith(user.id)

		expect((await mgr.changePassword(user.id, 'brandNewPass1', 'anotherPass12')).status).toBe(200)
		expect(changed).toHaveBeenCalledTimes(2)
	})

	test('a reset token can be redeemed by only one of two concurrent resets', async () => {
		const userStore = new InMemoryUserStore()
		const hashed = await hashPassword('oldPassword123')
		await userStore.createUser({
			email: 'carol@example.com',
			passwordHash: hashed.hash,
			salt: hashed.salt,
			name: 'Carol',
		})
		let mailed = ''
		const mgr = new PasswordResetManager({
			userStore,
			onResetRequested: (_email, token) => {
				mailed = token
			},
		})
		await mgr.requestReset('carol@example.com')
		const results = await Promise.all([
			mgr.resetPassword(mailed, 'firstNewPass1'),
			mgr.resetPassword(mailed, 'secondNewPass1'),
		])
		expect(results.filter((r) => r.status === 200)).toHaveLength(1)
	})
})

// --- InMemoryPasswordResetStore ---

describe('InMemoryPasswordResetStore', () => {
	let store: InMemoryPasswordResetStore

	beforeEach(() => {
		store = new InMemoryPasswordResetStore()
	})

	test('stores and retrieves a token', async () => {
		const token = {
			token: 'abc',
			userId: 'u1',
			email: 'a@b.com',
			createdAt: Date.now(),
			expiresAt: Date.now() + 60000,
			consumed: false,
		}
		await store.store(token)
		expect(await store.get('abc')).toEqual(token)
	})

	test('returns null for non-existent token', async () => {
		expect(await store.get('nope')).toBeNull()
	})

	test('consumes a token', async () => {
		const token = {
			token: 'abc',
			userId: 'u1',
			email: 'a@b.com',
			createdAt: Date.now(),
			expiresAt: Date.now() + 60000,
			consumed: false,
		}
		await store.store(token)
		await store.consume('abc')
		const fetched = await store.get('abc')
		expect(fetched?.consumed).toBe(true)
	})

	test('counts active tokens for email', async () => {
		const now = Date.now()
		await store.store({
			token: 'a',
			userId: 'u1',
			email: 'a@b.com',
			createdAt: now,
			expiresAt: now + 60000,
			consumed: false,
		})
		await store.store({
			token: 'b',
			userId: 'u1',
			email: 'a@b.com',
			createdAt: now,
			expiresAt: now + 60000,
			consumed: false,
		})
		await store.store({
			token: 'c',
			userId: 'u1',
			email: 'a@b.com',
			createdAt: now,
			expiresAt: now + 60000,
			consumed: true,
		})

		expect(await store.countActiveForEmail('a@b.com')).toBe(2)
	})

	test('cleanExpired removes expired tokens', async () => {
		const past = Date.now() - 1000
		await store.store({
			token: 'a',
			userId: 'u1',
			email: 'a@b.com',
			createdAt: past,
			expiresAt: past,
			consumed: false,
		})
		await store.store({
			token: 'b',
			userId: 'u1',
			email: 'a@b.com',
			createdAt: Date.now(),
			expiresAt: Date.now() + 60000,
			consumed: false,
		})

		const count = await store.cleanExpired()
		expect(count).toBe(1)
		expect(await store.get('a')).toBeNull()
		expect(await store.get('b')).not.toBeNull()
	})
})
