import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { SqliteUserStore } from './sqlite-user-store'
import { DuplicateEmailError } from './user-store'

/**
 * Creates an in-memory better-sqlite3 database for testing.
 */
async function createTestStore(): Promise<SqliteUserStore> {
	const { createRequire } = await import('node:module')
	const require = createRequire(import.meta.url)
	const Database = require('better-sqlite3')
	const db = new Database(':memory:')
	return new SqliteUserStore(db)
}

describe('SqliteUserStore', () => {
	let store: SqliteUserStore

	beforeEach(async () => {
		store = await createTestStore()
	})

	describe('createUser', () => {
		test('creates a user and returns AuthUser without credentials', async () => {
			const user = await store.createUser({
				email: 'alice@example.com',
				passwordHash: 'hash123',
				salt: 'salt123',
				name: 'Alice',
			})

			expect(user.id).toBeDefined()
			expect(user.email).toBe('alice@example.com')
			expect(user.name).toBe('Alice')
			expect(user.emailVerified).toBe(false)
			expect(user.createdAt).toBeGreaterThan(0)
			expect(user).not.toHaveProperty('passwordHash')
			expect(user).not.toHaveProperty('salt')
		})

		test('normalizes email to lowercase', async () => {
			const user = await store.createUser({
				email: 'Alice@EXAMPLE.com',
				passwordHash: 'hash',
				salt: 'salt',
				name: 'Alice',
			})
			expect(user.email).toBe('alice@example.com')
		})

		test('throws DuplicateEmailError on duplicate email', async () => {
			await store.createUser({
				email: 'alice@example.com',
				passwordHash: 'hash1',
				salt: 'salt1',
				name: 'Alice',
			})

			await expect(
				store.createUser({
					email: 'alice@example.com',
					passwordHash: 'hash2',
					salt: 'salt2',
					name: 'Alice 2',
				}),
			).rejects.toThrow(DuplicateEmailError)
		})

		test('throws DuplicateEmailError case-insensitively', async () => {
			await store.createUser({
				email: 'alice@example.com',
				passwordHash: 'hash1',
				salt: 'salt1',
				name: 'Alice',
			})

			await expect(
				store.createUser({
					email: 'ALICE@example.com',
					passwordHash: 'hash2',
					salt: 'salt2',
					name: 'Alice 2',
				}),
			).rejects.toThrow(DuplicateEmailError)
		})
	})

	describe('findByEmail', () => {
		test('returns StoredUser with credentials', async () => {
			await store.createUser({
				email: 'alice@example.com',
				passwordHash: 'hash123',
				salt: 'salt123',
				name: 'Alice',
			})

			const found = await store.findByEmail('alice@example.com')
			expect(found).not.toBeNull()
			expect(found?.email).toBe('alice@example.com')
			expect(found?.passwordHash).toBe('hash123')
			expect(found?.salt).toBe('salt123')
		})

		test('is case-insensitive', async () => {
			await store.createUser({
				email: 'alice@example.com',
				passwordHash: 'hash',
				salt: 'salt',
				name: 'Alice',
			})

			const found = await store.findByEmail('ALICE@EXAMPLE.COM')
			expect(found).not.toBeNull()
			expect(found?.email).toBe('alice@example.com')
		})

		test('returns null for non-existent email', async () => {
			const found = await store.findByEmail('nobody@example.com')
			expect(found).toBeNull()
		})
	})

	describe('findById', () => {
		test('returns StoredUser by ID', async () => {
			const created = await store.createUser({
				email: 'alice@example.com',
				passwordHash: 'hash',
				salt: 'salt',
				name: 'Alice',
			})

			const found = await store.findById(created.id)
			expect(found).not.toBeNull()
			expect(found?.id).toBe(created.id)
			expect(found?.passwordHash).toBe('hash')
		})

		test('returns null for non-existent ID', async () => {
			const found = await store.findById('nonexistent')
			expect(found).toBeNull()
		})
	})

	describe('devices', () => {
		let userId: string

		beforeEach(async () => {
			const user = await store.createUser({
				email: 'alice@example.com',
				passwordHash: 'hash',
				salt: 'salt',
				name: 'Alice',
			})
			userId = user.id
		})

		test('registerDevice creates a new device', async () => {
			const device = await store.registerDevice({
				id: 'device-1',
				userId,
				publicKey: 'pk-1',
				name: 'MacBook',
			})

			expect(device.id).toBe('device-1')
			expect(device.userId).toBe(userId)
			expect(device.publicKey).toBe('pk-1')
			expect(device.name).toBe('MacBook')
			expect(device.revoked).toBe(false)
		})

		test('registerDevice is idempotent for non-revoked devices', async () => {
			const d1 = await store.registerDevice({
				id: 'device-1',
				userId,
				publicKey: 'pk-1',
				name: 'MacBook',
			})

			const d2 = await store.registerDevice({
				id: 'device-1',
				userId,
				publicKey: 'pk-2',
				name: 'Updated',
			})

			// Should return existing device unchanged
			expect(d2.publicKey).toBe('pk-1')
			expect(d2.name).toBe('MacBook')
		})

		test('registerDevice re-activates revoked device', async () => {
			await store.registerDevice({
				id: 'device-1',
				userId,
				publicKey: 'pk-1',
				name: 'MacBook',
			})

			await store.revokeDevice('device-1')

			const reactivated = await store.registerDevice({
				id: 'device-1',
				userId,
				publicKey: 'pk-2',
				name: 'MacBook Pro',
			})

			expect(reactivated.revoked).toBe(false)
			expect(reactivated.publicKey).toBe('pk-2')
			expect(reactivated.name).toBe('MacBook Pro')
		})

		test('findDevice returns device by ID', async () => {
			await store.registerDevice({
				id: 'device-1',
				userId,
				publicKey: 'pk-1',
				name: 'MacBook',
			})

			const found = await store.findDevice('device-1')
			expect(found).not.toBeNull()
			expect(found?.id).toBe('device-1')
		})

		test('findDevice returns null for non-existent device', async () => {
			const found = await store.findDevice('nonexistent')
			expect(found).toBeNull()
		})

		test('listDevices returns all devices for user', async () => {
			await store.registerDevice({ id: 'd1', userId, publicKey: 'pk1', name: 'Device 1' })
			await store.registerDevice({ id: 'd2', userId, publicKey: 'pk2', name: 'Device 2' })

			const devices = await store.listDevices(userId)
			expect(devices).toHaveLength(2)
		})

		test('listDevices returns empty array for user with no devices', async () => {
			const devices = await store.listDevices(userId)
			expect(devices).toHaveLength(0)
		})

		test('revokeDevice marks device as revoked', async () => {
			await store.registerDevice({
				id: 'device-1',
				userId,
				publicKey: 'pk-1',
				name: 'MacBook',
			})

			await store.revokeDevice('device-1')

			const found = await store.findDevice('device-1')
			expect(found?.revoked).toBe(true)
		})

		test('revokeDevice is no-op for non-existent device', async () => {
			// Should not throw
			await store.revokeDevice('nonexistent')
		})

		test('touchDevice updates lastSeenAt', async () => {
			const device = await store.registerDevice({
				id: 'device-1',
				userId,
				publicKey: 'pk-1',
				name: 'MacBook',
			})

			const before = device.lastSeenAt

			// Small delay to ensure different timestamp
			await new Promise((r) => setTimeout(r, 5))
			await store.touchDevice('device-1')

			const updated = await store.findDevice('device-1')
			expect(updated?.lastSeenAt).toBeGreaterThanOrEqual(before)
		})
	})

	describe('user mutations', () => {
		let userId: string

		beforeEach(async () => {
			const user = await store.createUser({
				email: 'alice@example.com',
				passwordHash: 'hash',
				salt: 'salt',
				name: 'Alice',
			})
			userId = user.id
		})

		test('setEmailVerified updates verification status', async () => {
			await store.setEmailVerified(userId, true)
			const user = await store.findById(userId)
			expect(user?.emailVerified).toBe(true)

			await store.setEmailVerified(userId, false)
			const user2 = await store.findById(userId)
			expect(user2?.emailVerified).toBe(false)
		})

		test('updatePassword changes hash and salt', async () => {
			await store.updatePassword(userId, 'newHash', 'newSalt')
			const user = await store.findById(userId)
			expect(user?.passwordHash).toBe('newHash')
			expect(user?.salt).toBe('newSalt')
		})

		test('update replaces all mutable fields', async () => {
			const user = await store.findById(userId)
			await store.update({
				...(user as NonNullable<typeof user>),
				email: 'newemail@example.com',
				name: 'New Name',
			})

			const updated = await store.findById(userId)
			expect(updated?.email).toBe('newemail@example.com')
			expect(updated?.name).toBe('New Name')
		})

		test('delete removes user and associated devices', async () => {
			await store.registerDevice({ id: 'd1', userId, publicKey: 'pk', name: 'Device' })

			await store.delete(userId)

			expect(await store.findById(userId)).toBeNull()
			expect(await store.findDevice('d1')).toBeNull()
		})

		test('listAll returns all users', async () => {
			await store.createUser({
				email: 'bob@example.com',
				passwordHash: 'hash2',
				salt: 'salt2',
				name: 'Bob',
			})

			const all = await store.listAll()
			expect(all).toHaveLength(2)
		})
	})
})
