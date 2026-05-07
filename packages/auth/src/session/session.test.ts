import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest'
import {
	SessionManager,
	InMemorySessionStore,
	SessionNotFoundError,
	SessionExpiredError,
	SessionLimitExceededError,
	SessionMfaRequiredError,
} from './session'
import type { Session } from './session'

describe('SessionManager', () => {
	let manager: SessionManager
	let store: InMemorySessionStore

	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-01-15T12:00:00Z'))

		store = new InMemorySessionStore()
		manager = new SessionManager({
			store,
			sessionTtlMs: 7 * 24 * 60 * 60 * 1000, // 7 days
			idleTimeoutMs: 30 * 60 * 1000, // 30 minutes
			maxSessionsPerUser: 3,
		})
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	// --- create ---

	describe('create', () => {
		test('creates a session with correct fields', async () => {
			const session = await manager.create({
				userId: 'user-1',
				deviceId: 'device-1',
				ipAddress: '192.168.1.1',
				userAgent: 'Mozilla/5.0',
			})

			expect(session.id).toBeTruthy()
			expect(session.id.length).toBe(64) // 32 bytes = 64 hex chars
			expect(session.userId).toBe('user-1')
			expect(session.deviceId).toBe('device-1')
			expect(session.ipAddress).toBe('192.168.1.1')
			expect(session.userAgent).toBe('Mozilla/5.0')
			expect(session.createdAt).toBe(Date.now())
			expect(session.lastActiveAt).toBe(Date.now())
			expect(session.mfaVerified).toBe(false)
		})

		test('sets defaults for optional fields', async () => {
			const session = await manager.create({ userId: 'user-1' })

			expect(session.deviceId).toBeNull()
			expect(session.ipAddress).toBeNull()
			expect(session.userAgent).toBeNull()
			expect(session.mfaVerified).toBe(false)
		})

		test('sets MFA verified when specified', async () => {
			const session = await manager.create({ userId: 'user-1', mfaVerified: true })
			expect(session.mfaVerified).toBe(true)
		})

		test('includes metadata', async () => {
			const session = await manager.create({
				userId: 'user-1',
				metadata: { region: 'us-east' },
			})
			expect(session.metadata).toEqual({ region: 'us-east' })
		})

		test('sets expiry based on TTL', async () => {
			const session = await manager.create({ userId: 'user-1' })
			const expectedExpiry = Date.now() + 7 * 24 * 60 * 60 * 1000
			expect(session.expiresAt).toBe(expectedExpiry)
		})

		test('enforces max sessions per user', async () => {
			await manager.create({ userId: 'user-1' })
			await manager.create({ userId: 'user-1' })
			await manager.create({ userId: 'user-1' })

			await expect(manager.create({ userId: 'user-1' })).rejects.toThrow(
				SessionLimitExceededError,
			)
		})

		test('allows new session when existing sessions are expired', async () => {
			await manager.create({ userId: 'user-1' })
			await manager.create({ userId: 'user-1' })
			await manager.create({ userId: 'user-1' })

			// Advance past session TTL
			vi.advanceTimersByTime(7 * 24 * 60 * 60 * 1000 + 1)

			// Should be allowed because existing sessions are expired
			const session = await manager.create({ userId: 'user-1' })
			expect(session).toBeTruthy()
		})

		test('does not count other users sessions against limit', async () => {
			await manager.create({ userId: 'user-1' })
			await manager.create({ userId: 'user-1' })
			await manager.create({ userId: 'user-1' })

			// Different user should still be able to create sessions
			const session = await manager.create({ userId: 'user-2' })
			expect(session).toBeTruthy()
		})

		test('generates unique session IDs', async () => {
			const s1 = await manager.create({ userId: 'user-1' })
			const s2 = await manager.create({ userId: 'user-1' })
			expect(s1.id).not.toBe(s2.id)
		})
	})

	// --- validate ---

	describe('validate', () => {
		test('returns valid session', async () => {
			const created = await manager.create({ userId: 'user-1' })
			const validated = await manager.validate(created.id)
			expect(validated.userId).toBe('user-1')
		})

		test('throws for non-existent session', async () => {
			await expect(manager.validate('nonexistent')).rejects.toThrow(SessionNotFoundError)
		})

		test('throws for expired session (absolute expiry)', async () => {
			const session = await manager.create({ userId: 'user-1' })

			// Advance past TTL
			vi.advanceTimersByTime(7 * 24 * 60 * 60 * 1000 + 1)

			await expect(manager.validate(session.id)).rejects.toThrow(SessionExpiredError)
		})

		test('throws for idle session', async () => {
			const session = await manager.create({ userId: 'user-1' })

			// Advance past idle timeout
			vi.advanceTimersByTime(30 * 60 * 1000 + 1)

			await expect(manager.validate(session.id)).rejects.toThrow(SessionExpiredError)
		})

		test('cleans up expired session from store', async () => {
			const session = await manager.create({ userId: 'user-1' })

			vi.advanceTimersByTime(7 * 24 * 60 * 60 * 1000 + 1)

			try {
				await manager.validate(session.id)
			} catch {
				// expected
			}

			// Session should be deleted from store
			const stored = await store.getById(session.id)
			expect(stored).toBeNull()
		})
	})

	// --- touch ---

	describe('touch', () => {
		test('updates lastActiveAt', async () => {
			const session = await manager.create({ userId: 'user-1' })
			const originalLastActive = session.lastActiveAt

			vi.advanceTimersByTime(5 * 60 * 1000) // 5 minutes

			const touched = await manager.touch(session.id)
			expect(touched.lastActiveAt).toBeGreaterThan(originalLastActive)
		})

		test('extends absolute expiry with sliding window', async () => {
			const session = await manager.create({ userId: 'user-1' })
			const originalExpiry = session.expiresAt

			vi.advanceTimersByTime(5 * 60 * 1000) // 5 minutes

			const touched = await manager.touch(session.id)
			expect(touched.expiresAt).toBeGreaterThan(originalExpiry)
		})

		test('does not extend expiry without sliding window', async () => {
			const noSlidingManager = new SessionManager({
				store,
				sessionTtlMs: 7 * 24 * 60 * 60 * 1000,
				idleTimeoutMs: 30 * 60 * 1000,
				slidingWindow: false,
			})

			const session = await noSlidingManager.create({ userId: 'user-1' })
			const originalExpiry = session.expiresAt

			vi.advanceTimersByTime(5 * 60 * 1000)

			const touched = await noSlidingManager.touch(session.id)
			expect(touched.expiresAt).toBe(originalExpiry)
		})

		test('throws for expired session', async () => {
			const session = await manager.create({ userId: 'user-1' })
			vi.advanceTimersByTime(31 * 60 * 1000) // past idle timeout
			await expect(manager.touch(session.id)).rejects.toThrow(SessionExpiredError)
		})

		test('prevents idle timeout when touched regularly', async () => {
			const session = await manager.create({ userId: 'user-1' })

			// Touch every 10 minutes for an hour
			for (let i = 0; i < 6; i++) {
				vi.advanceTimersByTime(10 * 60 * 1000) // 10 minutes
				await manager.touch(session.id)
			}

			// Should still be valid (touched within idle timeout)
			const valid = await manager.validate(session.id)
			expect(valid).toBeTruthy()
		})
	})

	// --- MFA ---

	describe('MFA', () => {
		test('markMfaVerified sets mfaVerified to true', async () => {
			const session = await manager.create({ userId: 'user-1' })
			expect(session.mfaVerified).toBe(false)

			const updated = await manager.markMfaVerified(session.id)
			expect(updated.mfaVerified).toBe(true)
		})

		test('requireMfa passes when verified', async () => {
			const session = await manager.create({ userId: 'user-1', mfaVerified: true })
			const result = await manager.requireMfa(session.id)
			expect(result.mfaVerified).toBe(true)
		})

		test('requireMfa throws when not verified', async () => {
			const session = await manager.create({ userId: 'user-1' })
			await expect(manager.requireMfa(session.id)).rejects.toThrow(SessionMfaRequiredError)
		})

		test('requireMfa passes after markMfaVerified', async () => {
			const session = await manager.create({ userId: 'user-1' })
			await manager.markMfaVerified(session.id)
			const result = await manager.requireMfa(session.id)
			expect(result.mfaVerified).toBe(true)
		})
	})

	// --- revoke ---

	describe('revoke', () => {
		test('deletes a session', async () => {
			const session = await manager.create({ userId: 'user-1' })
			await manager.revoke(session.id)
			await expect(manager.validate(session.id)).rejects.toThrow(SessionNotFoundError)
		})

		test('does not throw for non-existent session', async () => {
			// Revoking a non-existent session should not throw
			await manager.revoke('nonexistent')
		})
	})

	// --- revokeAll ---

	describe('revokeAll', () => {
		test('revokes all sessions for a user', async () => {
			await manager.create({ userId: 'user-1' })
			await manager.create({ userId: 'user-1' })
			await manager.create({ userId: 'user-1' })

			const count = await manager.revokeAll('user-1')
			expect(count).toBe(3)

			const sessions = await manager.listSessions('user-1')
			expect(sessions).toHaveLength(0)
		})

		test('does not affect other users', async () => {
			await manager.create({ userId: 'user-1' })
			await manager.create({ userId: 'user-2' })

			await manager.revokeAll('user-1')

			const sessions = await manager.listSessions('user-2')
			expect(sessions).toHaveLength(1)
		})
	})

	// --- revokeOthers ---

	describe('revokeOthers', () => {
		test('revokes all except the current session', async () => {
			const s1 = await manager.create({ userId: 'user-1' })
			await manager.create({ userId: 'user-1' })
			await manager.create({ userId: 'user-1' })

			const count = await manager.revokeOthers('user-1', s1.id)
			expect(count).toBe(2)

			const sessions = await manager.listSessions('user-1')
			expect(sessions).toHaveLength(1)
			expect(sessions[0]!.id).toBe(s1.id)
		})
	})

	// --- listSessions ---

	describe('listSessions', () => {
		test('returns active sessions', async () => {
			await manager.create({ userId: 'user-1', deviceId: 'd1' })
			await manager.create({ userId: 'user-1', deviceId: 'd2' })

			const sessions = await manager.listSessions('user-1')
			expect(sessions).toHaveLength(2)
		})

		test('excludes expired sessions', async () => {
			await manager.create({ userId: 'user-1' })

			vi.advanceTimersByTime(7 * 24 * 60 * 60 * 1000 + 1) // past TTL

			const sessions = await manager.listSessions('user-1')
			expect(sessions).toHaveLength(0)
		})

		test('excludes idle sessions', async () => {
			await manager.create({ userId: 'user-1' })

			vi.advanceTimersByTime(31 * 60 * 1000) // past idle timeout

			const sessions = await manager.listSessions('user-1')
			expect(sessions).toHaveLength(0)
		})

		test('returns empty array for unknown user', async () => {
			const sessions = await manager.listSessions('unknown')
			expect(sessions).toHaveLength(0)
		})
	})

	// --- cleanExpired ---

	describe('cleanExpired', () => {
		test('removes expired sessions', async () => {
			await manager.create({ userId: 'user-1' })
			await manager.create({ userId: 'user-2' })

			vi.advanceTimersByTime(7 * 24 * 60 * 60 * 1000 + 1)

			const count = await manager.cleanExpired()
			expect(count).toBe(2)
		})

		test('does not remove active sessions', async () => {
			await manager.create({ userId: 'user-1' })

			const count = await manager.cleanExpired()
			expect(count).toBe(0)
		})
	})
})

// --- InMemorySessionStore ---

describe('InMemorySessionStore', () => {
	let store: InMemorySessionStore

	beforeEach(() => {
		store = new InMemorySessionStore()
	})

	const makeSession = (overrides?: Partial<Session>): Session => ({
		id: `session-${Math.random().toString(36).slice(2)}`,
		userId: 'user-1',
		deviceId: null,
		ipAddress: null,
		userAgent: null,
		createdAt: Date.now(),
		lastActiveAt: Date.now(),
		expiresAt: Date.now() + 60000,
		mfaVerified: false,
		...overrides,
	})

	test('create and getById', async () => {
		const session = makeSession()
		await store.create(session)
		const retrieved = await store.getById(session.id)
		expect(retrieved).toEqual(session)
	})

	test('getById returns null for unknown session', async () => {
		expect(await store.getById('unknown')).toBeNull()
	})

	test('update modifies session', async () => {
		const session = makeSession()
		await store.create(session)
		session.mfaVerified = true
		await store.update(session)
		const retrieved = await store.getById(session.id)
		expect(retrieved!.mfaVerified).toBe(true)
	})

	test('delete removes session', async () => {
		const session = makeSession()
		await store.create(session)
		await store.delete(session.id)
		expect(await store.getById(session.id)).toBeNull()
	})

	test('listByUserId returns sessions sorted by lastActiveAt desc', async () => {
		const s1 = makeSession({ userId: 'user-1', lastActiveAt: 1000 })
		const s2 = makeSession({ userId: 'user-1', lastActiveAt: 3000 })
		const s3 = makeSession({ userId: 'user-1', lastActiveAt: 2000 })
		await store.create(s1)
		await store.create(s2)
		await store.create(s3)

		const sessions = await store.listByUserId('user-1')
		expect(sessions.map((s) => s.lastActiveAt)).toEqual([3000, 2000, 1000])
	})

	test('deleteAllForUser removes all sessions for user', async () => {
		await store.create(makeSession({ userId: 'user-1' }))
		await store.create(makeSession({ userId: 'user-1' }))
		await store.create(makeSession({ userId: 'user-2' }))

		const count = await store.deleteAllForUser('user-1')
		expect(count).toBe(2)
		expect(await store.listByUserId('user-1')).toHaveLength(0)
		expect(await store.listByUserId('user-2')).toHaveLength(1)
	})

	test('deleteAllExcept keeps specified session', async () => {
		const s1 = makeSession({ userId: 'user-1' })
		const s2 = makeSession({ userId: 'user-1' })
		const s3 = makeSession({ userId: 'user-1' })
		await store.create(s1)
		await store.create(s2)
		await store.create(s3)

		const count = await store.deleteAllExcept('user-1', s2.id)
		expect(count).toBe(2)
		const remaining = await store.listByUserId('user-1')
		expect(remaining).toHaveLength(1)
		expect(remaining[0]!.id).toBe(s2.id)
	})

	test('cleanExpired removes expired sessions', async () => {
		const now = Date.now()
		await store.create(makeSession({ expiresAt: now - 1000 }))
		await store.create(makeSession({ expiresAt: now + 60000 }))

		const count = await store.cleanExpired()
		expect(count).toBe(1)
	})

	test('returns copies not references', async () => {
		const session = makeSession()
		await store.create(session)

		const retrieved = await store.getById(session.id)
		retrieved!.mfaVerified = true

		// Original stored value should not be mutated
		const again = await store.getById(session.id)
		expect(again!.mfaVerified).toBe(false)
	})
})
