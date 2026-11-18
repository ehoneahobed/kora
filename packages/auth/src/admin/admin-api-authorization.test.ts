import { describe, expect, test } from 'vitest'
import { InMemoryUserStore } from '../provider/built-in/user-store'
import { InMemorySessionStore } from '../session/session'
import { AdminApi, AdminApiError, AdminUnauthorizedError } from './admin-api'
import { AuditLogger, InMemoryAuditLogStore } from './audit-log'

/**
 * Every AdminApi method acts for an admin: with `isAdmin` configured, reading the user list,
 * a user's sessions or the user counts is refused to anyone else, and each read is audited.
 * Revoking a user's sessions or deleting a user never silently leaves their tokens valid.
 */
async function setup(options: { revocation?: boolean } = {}) {
	const userStore = new InMemoryUserStore()
	if (options.revocation === false) {
		// A custom user store without a token revocation store.
		;(userStore as { getTokenRevocationStore?: unknown }).getTokenRevocationStore = undefined
	}
	const sessionStore = new InMemorySessionStore()
	const auditLogger = new AuditLogger({ store: new InMemoryAuditLogStore() })
	const admin = new AdminApi({
		userStore,
		sessionStore,
		auditLogger,
		isAdmin: (id) => id === 'admin-1',
	})
	const alice = await userStore.createUser({
		email: 'alice@example.com',
		passwordHash: 'hash',
		salt: 'salt',
		name: 'Alice',
	})
	return { admin, userStore, sessionStore, auditLogger, aliceId: alice.id }
}

describe('AdminApi read methods are for admins only', () => {
	test('listUsers refuses a non-admin and audits an admin', async () => {
		const { admin, auditLogger } = await setup()
		await expect(admin.listUsers('intruder', {})).rejects.toThrow(AdminUnauthorizedError)
		const result = await admin.listUsers('admin-1', { limit: 10 })
		expect(result.data.map((u) => u.email)).toEqual(['alice@example.com'])
		const entries = await auditLogger.query({ actions: ['admin.user_list'] })
		expect(entries.map((e) => e.actorId)).toEqual(['admin-1'])
	})

	test('getUserSessions refuses a non-admin and audits an admin', async () => {
		const { admin, auditLogger, aliceId } = await setup()
		await expect(admin.getUserSessions('intruder', aliceId)).rejects.toThrow(AdminUnauthorizedError)
		expect(await admin.getUserSessions('admin-1', aliceId)).toEqual([])
		const entries = await auditLogger.query({ actions: ['admin.session_list'] })
		expect(entries.map((e) => [e.actorId, e.targetId])).toEqual([['admin-1', aliceId]])
	})

	test('getStats refuses a non-admin and audits an admin', async () => {
		const { admin, auditLogger } = await setup()
		await expect(admin.getStats('intruder')).rejects.toThrow(AdminUnauthorizedError)
		expect(await admin.getStats('admin-1')).toMatchObject({ totalUsers: 1 })
		const entries = await auditLogger.query({ actions: ['admin.stats'] })
		expect(entries.map((e) => e.actorId)).toEqual(['admin-1'])
	})
})

describe('AdminApi never silently leaves credentials valid', () => {
	test('revokeUserSessions without any way to revoke tokens throws before deleting anything', async () => {
		const { admin, sessionStore, aliceId } = await setup({ revocation: false })
		await sessionStore.create({
			id: 's1',
			userId: aliceId,
			createdAt: Date.now(),
			expiresAt: Date.now() + 60_000,
		} as Parameters<InMemorySessionStore['create']>[0])
		await expect(admin.revokeUserSessions('admin-1', aliceId)).rejects.toMatchObject({
			code: 'ADMIN_REVOCATION_UNAVAILABLE',
		})
		expect(await sessionStore.listByUserId(aliceId)).toHaveLength(1)
	})

	test('deleteUser without any way to revoke tokens throws before deleting the user', async () => {
		const { admin, userStore, aliceId } = await setup({ revocation: false })
		const error = await admin.deleteUser('admin-1', aliceId).catch((e: unknown) => e)
		expect(error).toBeInstanceOf(AdminApiError)
		expect(error).toMatchObject({ code: 'ADMIN_REVOCATION_UNAVAILABLE' })
		expect(await userStore.findById(aliceId)).not.toBeNull()
	})

	test('a configured revokeAllForUser is enough without a revocation store', async () => {
		const userStore = new InMemoryUserStore()
		;(userStore as { getTokenRevocationStore?: unknown }).getTokenRevocationStore = undefined
		const revoked: string[] = []
		const admin = new AdminApi({
			userStore,
			revokeAllForUser: async (userId) => {
				revoked.push(userId)
			},
		})
		const bob = await userStore.createUser({
			email: 'bob@example.com',
			passwordHash: 'h',
			salt: 's',
		})
		await admin.deleteUser('admin-1', bob.id)
		expect(revoked).toEqual([bob.id])
	})
})
