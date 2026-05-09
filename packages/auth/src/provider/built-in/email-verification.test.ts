import { beforeEach, describe, expect, test, vi } from 'vitest'
import { EmailVerificationManager, InMemoryEmailVerificationStore } from './email-verification'
import { hashPassword } from './password-hash'
import { InMemoryUserStore } from './user-store'

describe('EmailVerificationManager', () => {
	let userStore: InMemoryUserStore
	let verificationStore: InMemoryEmailVerificationStore
	let manager: EmailVerificationManager
	let userId: string

	beforeEach(async () => {
		userStore = new InMemoryUserStore()
		verificationStore = new InMemoryEmailVerificationStore()

		const hashed = await hashPassword('password123')
		const user = await userStore.createUser({
			email: 'alice@example.com',
			passwordHash: hashed.hash,
			salt: hashed.salt,
			name: 'Alice',
		})
		userId = user.id

		manager = new EmailVerificationManager({
			userStore,
			verificationStore,
		})
	})

	// --- sendVerification ---

	describe('sendVerification', () => {
		test('generates a verification token', async () => {
			const result = await manager.sendVerification(userId, 'alice@example.com')
			expect(result.status).toBe(200)
			if ('data' in result.body) {
				expect(result.body.data.token).toBeTruthy()
				expect(result.body.data.token?.length).toBeGreaterThan(20)
			}
		})

		test('normalizes email', async () => {
			const result = await manager.sendVerification(userId, '  ALICE@Example.COM  ')
			expect(result.status).toBe(200)
		})

		test('rate limits after max requests', async () => {
			await manager.sendVerification(userId, 'alice@example.com')
			await manager.sendVerification(userId, 'alice@example.com')
			await manager.sendVerification(userId, 'alice@example.com')

			const result = await manager.sendVerification(userId, 'alice@example.com')
			expect(result.status).toBe(429)
		})

		test('invokes onVerificationRequired callback', async () => {
			const callback = vi.fn()
			const mgr = new EmailVerificationManager({
				userStore,
				verificationStore,
				onVerificationRequired: callback,
			})

			await mgr.sendVerification(userId, 'alice@example.com')
			expect(callback).toHaveBeenCalledTimes(1)
			expect(callback).toHaveBeenCalledWith(
				'alice@example.com',
				expect.any(String),
				expect.any(Number),
			)
		})

		test('hides token when callback is configured', async () => {
			const mgr = new EmailVerificationManager({
				userStore,
				verificationStore,
				onVerificationRequired: () => {},
			})

			const result = await mgr.sendVerification(userId, 'alice@example.com')
			if ('data' in result.body) {
				expect(result.body.data.token).toBeUndefined()
			}
		})
	})

	// --- verifyEmail ---

	describe('verifyEmail', () => {
		test('verifies email with valid token', async () => {
			const sendResult = await manager.sendVerification(userId, 'alice@example.com')
			const token = 'data' in sendResult.body ? (sendResult.body.data.token ?? '') : ''

			const result = await manager.verifyEmail(token)
			expect(result.status).toBe(200)
			if ('data' in result.body) {
				expect(result.body.data.userId).toBe(userId)
				expect(result.body.data.email).toBe('alice@example.com')
			}

			// Check that user is now verified
			const user = await userStore.findById(userId)
			expect(user?.emailVerified).toBe(true)
		})

		test('rejects already consumed token', async () => {
			const sendResult = await manager.sendVerification(userId, 'alice@example.com')
			const token = 'data' in sendResult.body ? (sendResult.body.data.token ?? '') : ''

			await manager.verifyEmail(token)
			const result = await manager.verifyEmail(token)
			expect(result.status).toBe(404)
		})

		test('rejects expired token', async () => {
			const mgr = new EmailVerificationManager({
				userStore,
				verificationStore,
				tokenTtlMs: 1,
			})

			const sendResult = await mgr.sendVerification(userId, 'alice@example.com')
			const token = 'data' in sendResult.body ? (sendResult.body.data.token ?? '') : ''

			await new Promise((r) => setTimeout(r, 10))

			const result = await mgr.verifyEmail(token)
			expect(result.status).toBe(410)
		})

		test('rejects non-existent token', async () => {
			const result = await manager.verifyEmail('bogus')
			expect(result.status).toBe(404)
		})
	})

	// --- resendVerification ---

	describe('resendVerification', () => {
		test('resends verification for existing user', async () => {
			const result = await manager.resendVerification(userId)
			expect(result.status).toBe(200)
		})

		test('returns 404 for non-existent user', async () => {
			const result = await manager.resendVerification('nonexistent')
			expect(result.status).toBe(404)
		})
	})
})

// --- InMemoryEmailVerificationStore ---

describe('InMemoryEmailVerificationStore', () => {
	let store: InMemoryEmailVerificationStore

	beforeEach(() => {
		store = new InMemoryEmailVerificationStore()
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
		await store.store({
			token: 'abc',
			userId: 'u1',
			email: 'a@b.com',
			createdAt: Date.now(),
			expiresAt: Date.now() + 60000,
			consumed: false,
		})
		await store.consume('abc')
		const fetched = await store.get('abc')
		expect(fetched?.consumed).toBe(true)
	})

	test('counts active tokens for user', async () => {
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
		await store.store({
			token: 'd',
			userId: 'u2',
			email: 'b@b.com',
			createdAt: now,
			expiresAt: now + 60000,
			consumed: false,
		})

		expect(await store.countActiveForUser('u1')).toBe(2)
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
