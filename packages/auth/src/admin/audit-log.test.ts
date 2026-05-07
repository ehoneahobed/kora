import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest'
import {
	AuditLogger,
	InMemoryAuditLogStore,
} from './audit-log'
import type { AuditEntry } from './audit-log'

describe('AuditLogger', () => {
	let logger: AuditLogger
	let store: InMemoryAuditLogStore

	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-01-15T12:00:00Z'))
		store = new InMemoryAuditLogStore()
		logger = new AuditLogger({ store })
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	// --- log ---

	describe('log', () => {
		test('creates an audit entry', async () => {
			const entry = await logger.log({
				action: 'user.signin',
				actorId: 'user-1',
				actorType: 'user',
				success: true,
				ipAddress: '192.168.1.1',
				userAgent: 'Mozilla/5.0',
			})

			expect(entry.id).toBeTruthy()
			expect(entry.action).toBe('user.signin')
			expect(entry.actorId).toBe('user-1')
			expect(entry.actorType).toBe('user')
			expect(entry.success).toBe(true)
			expect(entry.ipAddress).toBe('192.168.1.1')
			expect(entry.timestamp).toBe(Date.now())
		})

		test('sets default values', async () => {
			const entry = await logger.log({
				action: 'user.signup',
				actorId: 'user-1',
			})

			expect(entry.actorType).toBe('user')
			expect(entry.targetId).toBeNull()
			expect(entry.targetType).toBeNull()
			expect(entry.ipAddress).toBeNull()
			expect(entry.userAgent).toBeNull()
			expect(entry.success).toBe(true)
			expect(entry.errorMessage).toBeNull()
		})

		test('records failure with error message', async () => {
			const entry = await logger.log({
				action: 'user.signin',
				actorId: 'anonymous',
				actorType: 'system',
				targetId: 'user-1',
				targetType: 'user',
				success: false,
				errorMessage: 'Invalid credentials',
			})

			expect(entry.success).toBe(false)
			expect(entry.errorMessage).toBe('Invalid credentials')
		})

		test('includes metadata', async () => {
			const entry = await logger.log({
				action: 'org.member_role_change',
				actorId: 'admin-1',
				actorType: 'admin',
				targetId: 'user-2',
				metadata: { oldRole: 'member', newRole: 'admin', orgId: 'org-1' },
			})

			expect(entry.metadata).toEqual({ oldRole: 'member', newRole: 'admin', orgId: 'org-1' })
		})

		test('generates unique IDs', async () => {
			const e1 = await logger.log({ action: 'user.signin', actorId: 'u1' })
			const e2 = await logger.log({ action: 'user.signin', actorId: 'u1' })
			expect(e1.id).not.toBe(e2.id)
		})
	})

	// --- query ---

	describe('query', () => {
		async function seedEntries(): Promise<void> {
			vi.setSystemTime(new Date('2026-01-15T10:00:00Z'))
			await logger.log({ action: 'user.signup', actorId: 'user-1', targetId: 'user-1' })

			vi.setSystemTime(new Date('2026-01-15T10:05:00Z'))
			await logger.log({ action: 'user.signin', actorId: 'user-1', success: true })

			vi.setSystemTime(new Date('2026-01-15T10:10:00Z'))
			await logger.log({ action: 'user.signin', actorId: 'user-2', success: false, errorMessage: 'Invalid password', targetId: 'user-2' })

			vi.setSystemTime(new Date('2026-01-15T10:15:00Z'))
			await logger.log({ action: 'session.create', actorId: 'user-1' })

			vi.setSystemTime(new Date('2026-01-15T10:20:00Z'))
			await logger.log({ action: 'mfa.enable', actorId: 'user-1' })
		}

		test('returns all entries by default', async () => {
			await seedEntries()
			const entries = await logger.query({})
			expect(entries).toHaveLength(5)
		})

		test('returns entries in reverse chronological order', async () => {
			await seedEntries()
			const entries = await logger.query({})
			for (let i = 1; i < entries.length; i++) {
				expect(entries[i]!.timestamp).toBeLessThanOrEqual(entries[i - 1]!.timestamp)
			}
		})

		test('filters by actorId', async () => {
			await seedEntries()
			const entries = await logger.query({ actorId: 'user-1' })
			expect(entries).toHaveLength(4) // signup, signin, session, mfa
			for (const e of entries) {
				expect(e.actorId).toBe('user-1')
			}
		})

		test('filters by targetId', async () => {
			await seedEntries()
			const entries = await logger.query({ targetId: 'user-2' })
			expect(entries).toHaveLength(1)
			expect(entries[0]!.actorId).toBe('user-2')
		})

		test('filters by actions', async () => {
			await seedEntries()
			const entries = await logger.query({ actions: ['user.signin'] })
			expect(entries).toHaveLength(2)
		})

		test('filters by success', async () => {
			await seedEntries()
			const failures = await logger.query({ success: false })
			expect(failures).toHaveLength(1)
			expect(failures[0]!.actorId).toBe('user-2')
		})

		test('filters by time range', async () => {
			await seedEntries()
			const start = new Date('2026-01-15T10:05:00Z').getTime()
			const end = new Date('2026-01-15T10:15:00Z').getTime()
			const entries = await logger.query({ startTime: start, endTime: end })
			expect(entries).toHaveLength(3)
		})

		test('supports pagination with limit and offset', async () => {
			await seedEntries()
			const page1 = await logger.query({ limit: 2, offset: 0 })
			const page2 = await logger.query({ limit: 2, offset: 2 })

			expect(page1).toHaveLength(2)
			expect(page2).toHaveLength(2)
			expect(page1[0]!.id).not.toBe(page2[0]!.id)
		})

		test('combines filters', async () => {
			await seedEntries()
			const entries = await logger.query({
				actorId: 'user-1',
				actions: ['user.signin'],
				success: true,
			})
			expect(entries).toHaveLength(1)
		})
	})

	// --- count ---

	describe('count', () => {
		test('counts matching entries', async () => {
			await logger.log({ action: 'user.signin', actorId: 'u1', success: true })
			await logger.log({ action: 'user.signin', actorId: 'u1', success: false })
			await logger.log({ action: 'user.signin', actorId: 'u2', success: true })

			expect(await logger.count({})).toBe(3)
			expect(await logger.count({ actorId: 'u1' })).toBe(2)
			expect(await logger.count({ success: false })).toBe(1)
		})
	})

	// --- purge ---

	describe('purge', () => {
		test('purges entries based on retention', async () => {
			const retentionLogger = new AuditLogger({ store, retentionDays: 30 })

			vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
			await retentionLogger.log({ action: 'user.signin', actorId: 'u1' })

			vi.setSystemTime(new Date('2026-02-15T00:00:00Z'))
			await retentionLogger.log({ action: 'user.signin', actorId: 'u2' })

			const purged = await retentionLogger.purge()
			expect(purged).toBe(1)

			const remaining = await retentionLogger.query({})
			expect(remaining).toHaveLength(1)
			expect(remaining[0]!.actorId).toBe('u2')
		})

		test('does nothing without retention policy', async () => {
			await logger.log({ action: 'user.signin', actorId: 'u1' })
			const purged = await logger.purge()
			expect(purged).toBe(0)
		})
	})

	// --- getUserActivity ---

	describe('getUserActivity', () => {
		test('returns activity for a specific user', async () => {
			await logger.log({ action: 'user.signin', actorId: 'u1' })
			await logger.log({ action: 'user.signin', actorId: 'u2' })
			await logger.log({ action: 'session.create', actorId: 'u1' })

			const activity = await logger.getUserActivity('u1')
			expect(activity).toHaveLength(2)
		})

		test('respects limit', async () => {
			for (let i = 0; i < 10; i++) {
				await logger.log({ action: 'user.signin', actorId: 'u1' })
			}

			const activity = await logger.getUserActivity('u1', 3)
			expect(activity).toHaveLength(3)
		})
	})

	// --- getFailedLogins ---

	describe('getFailedLogins', () => {
		test('returns failed login attempts within window', async () => {
			vi.setSystemTime(new Date('2026-01-15T10:00:00Z'))
			await logger.log({
				action: 'user.signin',
				actorId: 'anonymous',
				targetId: 'u1',
				success: false,
			})

			vi.setSystemTime(new Date('2026-01-15T10:05:00Z'))
			await logger.log({
				action: 'user.signin',
				actorId: 'anonymous',
				targetId: 'u1',
				success: false,
			})

			vi.setSystemTime(new Date('2026-01-15T10:10:00Z'))
			// Query for failures in the last 15 minutes
			const failures = await logger.getFailedLogins('u1', 15 * 60 * 1000)
			expect(failures).toHaveLength(2)
		})

		test('excludes failures outside window', async () => {
			vi.setSystemTime(new Date('2026-01-15T09:00:00Z'))
			await logger.log({
				action: 'user.signin',
				actorId: 'anonymous',
				targetId: 'u1',
				success: false,
			})

			vi.setSystemTime(new Date('2026-01-15T10:10:00Z'))
			const failures = await logger.getFailedLogins('u1', 15 * 60 * 1000)
			expect(failures).toHaveLength(0)
		})
	})
})

// --- InMemoryAuditLogStore ---

describe('InMemoryAuditLogStore', () => {
	let store: InMemoryAuditLogStore

	beforeEach(() => {
		store = new InMemoryAuditLogStore()
	})

	const makeEntry = (overrides?: Partial<AuditEntry>): AuditEntry => ({
		id: `entry-${Math.random().toString(36).slice(2)}`,
		timestamp: Date.now(),
		action: 'user.signin',
		actorId: 'user-1',
		actorType: 'user',
		targetId: null,
		targetType: null,
		ipAddress: null,
		userAgent: null,
		success: true,
		errorMessage: null,
		...overrides,
	})

	test('append and query', async () => {
		await store.append(makeEntry())
		const results = await store.query({})
		expect(results).toHaveLength(1)
	})

	test('returns copies not references', async () => {
		const entry = makeEntry()
		await store.append(entry)
		const [retrieved] = await store.query({})
		retrieved!.actorId = 'mutated'

		const [again] = await store.query({})
		expect(again!.actorId).toBe('user-1')
	})

	test('purgeOlderThan removes old entries', async () => {
		await store.append(makeEntry({ timestamp: 1000 }))
		await store.append(makeEntry({ timestamp: 2000 }))
		await store.append(makeEntry({ timestamp: 3000 }))

		const purged = await store.purgeOlderThan(2000)
		expect(purged).toBe(1)

		const remaining = await store.query({})
		expect(remaining).toHaveLength(2)
	})

	test('count returns correct count', async () => {
		await store.append(makeEntry({ actorId: 'u1' }))
		await store.append(makeEntry({ actorId: 'u1' }))
		await store.append(makeEntry({ actorId: 'u2' }))

		expect(await store.count({})).toBe(3)
		expect(await store.count({ actorId: 'u1' })).toBe(2)
	})
})
