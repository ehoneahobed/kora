import { beforeEach, describe, expect, test } from 'vitest'
import { InMemoryUserStore } from '../provider/built-in/user-store'
import { InMemorySessionStore } from '../session/session'
import type { Session } from '../session/session'
import { AdminApi, AdminUserNotFoundError } from './admin-api'
import { AuditLogger, InMemoryAuditLogStore } from './audit-log'

async function createTestUser(
	store: InMemoryUserStore,
	email: string,
	name = 'Test User',
): Promise<string> {
	const user = await store.createUser({
		email,
		passwordHash: 'hash',
		salt: 'salt',
		name,
	})
	return user.id
}

describe('AdminApi', () => {
	let admin: AdminApi
	let userStore: InMemoryUserStore
	let sessionStore: InMemorySessionStore
	let auditStore: InMemoryAuditLogStore
	let auditLogger: AuditLogger

	beforeEach(() => {
		userStore = new InMemoryUserStore()
		sessionStore = new InMemorySessionStore()
		auditStore = new InMemoryAuditLogStore()
		auditLogger = new AuditLogger({ store: auditStore })

		admin = new AdminApi({
			userStore,
			sessionStore,
			auditLogger,
		})
	})

	// --- getUser ---

	describe('getUser', () => {
		test('returns user by ID', async () => {
			const userId = await createTestUser(userStore, 'alice@example.com', 'Alice')
			const user = await admin.getUser('admin-1', userId)

			expect(user.id).toBe(userId)
			expect(user.email).toBe('alice@example.com')
			expect(user.name).toBe('Alice')
		})

		test('does not include password hash', async () => {
			const userId = await createTestUser(userStore, 'alice@example.com')
			const user = await admin.getUser('admin-1', userId)

			expect(user).not.toHaveProperty('passwordHash')
			expect(user).not.toHaveProperty('salt')
		})

		test('throws for non-existent user', async () => {
			await expect(admin.getUser('admin-1', 'nonexistent')).rejects.toThrow(AdminUserNotFoundError)
		})

		test('creates audit log entry', async () => {
			const userId = await createTestUser(userStore, 'alice@example.com')
			await admin.getUser('admin-1', userId)

			const entries = await auditLogger.query({ actions: ['admin.user_lookup'] })
			expect(entries).toHaveLength(1)
			expect(entries[0]?.actorId).toBe('admin-1')
			expect(entries[0]?.targetId).toBe(userId)
		})
	})

	// --- listUsers ---

	describe('listUsers', () => {
		test('lists all users', async () => {
			await createTestUser(userStore, 'alice@example.com', 'Alice')
			await createTestUser(userStore, 'bob@example.com', 'Bob')

			const result = await admin.listUsers()
			expect(result.data).toHaveLength(2)
			expect(result.total).toBe(2)
		})

		test('filters by email substring', async () => {
			await createTestUser(userStore, 'alice@example.com')
			await createTestUser(userStore, 'bob@company.com')

			const result = await admin.listUsers({ email: 'example' })
			expect(result.data).toHaveLength(1)
			expect(result.data[0]?.email).toBe('alice@example.com')
		})

		test('filters by email verified', async () => {
			const userId = await createTestUser(userStore, 'alice@example.com')
			await createTestUser(userStore, 'bob@example.com')
			await userStore.setEmailVerified(userId, true)

			const verified = await admin.listUsers({ emailVerified: true })
			expect(verified.data).toHaveLength(1)
			expect(verified.data[0]?.email).toBe('alice@example.com')

			const unverified = await admin.listUsers({ emailVerified: false })
			expect(unverified.data).toHaveLength(1)
			expect(unverified.data[0]?.email).toBe('bob@example.com')
		})

		test('paginates results', async () => {
			for (let i = 0; i < 5; i++) {
				await createTestUser(userStore, `user${i}@example.com`)
			}

			const page1 = await admin.listUsers({ limit: 2, offset: 0 })
			expect(page1.data).toHaveLength(2)
			expect(page1.total).toBe(5)

			const page2 = await admin.listUsers({ limit: 2, offset: 2 })
			expect(page2.data).toHaveLength(2)

			const page3 = await admin.listUsers({ limit: 2, offset: 4 })
			expect(page3.data).toHaveLength(1)
		})

		test('returns empty result for no matches', async () => {
			const result = await admin.listUsers()
			expect(result.data).toHaveLength(0)
			expect(result.total).toBe(0)
		})
	})

	// --- updateUser ---

	describe('updateUser', () => {
		test('updates user name', async () => {
			const userId = await createTestUser(userStore, 'alice@example.com', 'Alice')
			const updated = await admin.updateUser('admin-1', userId, { name: 'Alice Smith' })

			expect(updated.name).toBe('Alice Smith')
		})

		test('updates email verified', async () => {
			const userId = await createTestUser(userStore, 'alice@example.com')
			const updated = await admin.updateUser('admin-1', userId, { emailVerified: true })

			expect(updated.emailVerified).toBe(true)
		})

		test('updates email', async () => {
			const userId = await createTestUser(userStore, 'alice@example.com')
			const updated = await admin.updateUser('admin-1', userId, { email: 'alice@newdomain.com' })

			expect(updated.email).toBe('alice@newdomain.com')
		})

		test('throws for non-existent user', async () => {
			await expect(admin.updateUser('admin-1', 'nonexistent', { name: 'X' })).rejects.toThrow(
				AdminUserNotFoundError,
			)
		})

		test('creates audit log entry', async () => {
			const userId = await createTestUser(userStore, 'alice@example.com')
			await admin.updateUser('admin-1', userId, { name: 'Updated' })

			const entries = await auditLogger.query({ actions: ['user.update'] })
			expect(entries).toHaveLength(1)
			expect(entries[0]?.metadata).toEqual({ updates: { name: 'Updated' } })
		})
	})

	// --- deleteUser ---

	describe('deleteUser', () => {
		test('deletes user', async () => {
			const userId = await createTestUser(userStore, 'alice@example.com')
			await admin.deleteUser('admin-1', userId)

			const user = await userStore.findById(userId)
			expect(user).toBeNull()
		})

		test('revokes all sessions on delete', async () => {
			const userId = await createTestUser(userStore, 'alice@example.com')

			const session: Session = {
				id: 'sess-1',
				userId,
				deviceId: null,
				ipAddress: null,
				userAgent: null,
				createdAt: Date.now(),
				lastActiveAt: Date.now(),
				expiresAt: Date.now() + 60000,
				mfaVerified: false,
			}
			await sessionStore.create(session)

			await admin.deleteUser('admin-1', userId)

			const sessions = await sessionStore.listByUserId(userId)
			expect(sessions).toHaveLength(0)
		})

		test('throws for non-existent user', async () => {
			await expect(admin.deleteUser('admin-1', 'nonexistent')).rejects.toThrow(
				AdminUserNotFoundError,
			)
		})

		test('creates audit log entry', async () => {
			const userId = await createTestUser(userStore, 'alice@example.com')
			await admin.deleteUser('admin-1', userId)

			const entries = await auditLogger.query({ actions: ['user.delete'] })
			expect(entries).toHaveLength(1)
		})
	})

	// --- getUserSessions ---

	describe('getUserSessions', () => {
		test('returns sessions for a user', async () => {
			const userId = await createTestUser(userStore, 'alice@example.com')

			await sessionStore.create({
				id: 'sess-1',
				userId,
				deviceId: null,
				ipAddress: null,
				userAgent: null,
				createdAt: Date.now(),
				lastActiveAt: Date.now(),
				expiresAt: Date.now() + 60000,
				mfaVerified: false,
			})

			const sessions = await admin.getUserSessions(userId)
			expect(sessions).toHaveLength(1)
		})

		test('returns empty when no session store configured', async () => {
			const adminNoSessions = new AdminApi({ userStore })
			const sessions = await adminNoSessions.getUserSessions('user-1')
			expect(sessions).toHaveLength(0)
		})
	})

	// --- revokeUserSessions ---

	describe('revokeUserSessions', () => {
		test('revokes all sessions for a user', async () => {
			const userId = await createTestUser(userStore, 'alice@example.com')

			await sessionStore.create({
				id: 'sess-1',
				userId,
				deviceId: null,
				ipAddress: null,
				userAgent: null,
				createdAt: Date.now(),
				lastActiveAt: Date.now(),
				expiresAt: Date.now() + 60000,
				mfaVerified: false,
			})
			await sessionStore.create({
				id: 'sess-2',
				userId,
				deviceId: null,
				ipAddress: null,
				userAgent: null,
				createdAt: Date.now(),
				lastActiveAt: Date.now(),
				expiresAt: Date.now() + 60000,
				mfaVerified: false,
			})

			const count = await admin.revokeUserSessions('admin-1', userId)
			expect(count).toBe(2)
		})

		test('creates audit entry', async () => {
			const userId = await createTestUser(userStore, 'alice@example.com')
			await admin.revokeUserSessions('admin-1', userId)

			const entries = await auditLogger.query({ actions: ['session.revoke_all'] })
			expect(entries).toHaveLength(1)
		})
	})

	// --- getStats ---

	describe('getStats', () => {
		test('returns correct statistics', async () => {
			const u1 = await createTestUser(userStore, 'alice@example.com')
			await createTestUser(userStore, 'bob@example.com')
			await createTestUser(userStore, 'carol@example.com')

			await userStore.setEmailVerified(u1, true)

			const stats = await admin.getStats()
			expect(stats.totalUsers).toBe(3)
			expect(stats.verifiedUsers).toBe(1)
			expect(stats.unverifiedUsers).toBe(2)
		})

		test('returns zeros when no users', async () => {
			const stats = await admin.getStats()
			expect(stats.totalUsers).toBe(0)
		})
	})
})

// --- Webhooks concept test ---

describe('AdminApi without optional dependencies', () => {
	test('works without session store', async () => {
		const userStore = new InMemoryUserStore()
		const admin = new AdminApi({ userStore })

		const userId = await createTestUser(userStore, 'alice@example.com')
		const user = await admin.getUser('admin', userId)
		expect(user.email).toBe('alice@example.com')
	})

	test('works without audit logger', async () => {
		const userStore = new InMemoryUserStore()
		const admin = new AdminApi({ userStore })

		const userId = await createTestUser(userStore, 'alice@example.com')
		// Should not throw even without audit logger
		await admin.deleteUser('admin', userId)
	})
})
