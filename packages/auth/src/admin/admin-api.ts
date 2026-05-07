import { KoraError } from '@korajs/core'
import type { AuthUser, StoredUser, UserStore } from '../provider/built-in/user-store'
import type { Session, SessionStore } from '../session/session'
import type { AuditLogger, AuditAction } from './audit-log'

// ============================================================================
// Admin API Types
// ============================================================================

/**
 * Configuration for the Admin API.
 */
export interface AdminApiConfig {
	/** User store for managing users */
	userStore: UserStore
	/** Session store for managing sessions (optional) */
	sessionStore?: SessionStore
	/** Audit logger (optional) */
	auditLogger?: AuditLogger
}

/**
 * Paginated result set.
 */
export interface PaginatedResult<T> {
	data: T[]
	total: number
	limit: number
	offset: number
}

/**
 * User list query parameters.
 */
export interface UserListQuery {
	/** Search by email (substring match) */
	email?: string
	/** Filter by email verified status */
	emailVerified?: boolean
	/** Maximum number of results */
	limit?: number
	/** Offset for pagination */
	offset?: number
}

/**
 * Admin-level user update (different from self-update).
 */
export interface AdminUserUpdate {
	/** Update display name */
	name?: string
	/** Set email verified status */
	emailVerified?: boolean
	/** Update email (admin override) */
	email?: string
}

// ============================================================================
// Errors
// ============================================================================

export class AdminApiError extends KoraError {
	constructor(message: string, code: string, context?: Record<string, unknown>) {
		super(message, code, context)
		this.name = 'AdminApiError'
	}
}

export class AdminUserNotFoundError extends AdminApiError {
	constructor(userId: string) {
		super(`User "${userId}" not found.`, 'ADMIN_USER_NOT_FOUND', { userId })
	}
}

export class AdminUnauthorizedError extends AdminApiError {
	constructor() {
		super('Admin privileges required.', 'ADMIN_UNAUTHORIZED')
	}
}

// ============================================================================
// AdminApi
// ============================================================================

/**
 * Administrative API for managing users, sessions, and system configuration.
 *
 * Provides elevated operations that should only be accessible to administrators.
 * All operations are audit-logged when an AuditLogger is configured.
 *
 * @example
 * ```typescript
 * const admin = new AdminApi({
 *   userStore: myUserStore,
 *   sessionStore: mySessionStore,
 *   auditLogger: myAuditLogger,
 * })
 *
 * // List users
 * const { data, total } = await admin.listUsers({ limit: 20 })
 *
 * // Suspend a user (revokes all sessions)
 * await admin.suspendUser('admin-user-id', 'target-user-id', 'Policy violation')
 * ```
 */
export class AdminApi {
	private readonly userStore: UserStore
	private readonly sessionStore: SessionStore | null
	private readonly auditLogger: AuditLogger | null

	constructor(config: AdminApiConfig) {
		this.userStore = config.userStore
		this.sessionStore = config.sessionStore ?? null
		this.auditLogger = config.auditLogger ?? null
	}

	/**
	 * Get a user by ID with full details.
	 */
	async getUser(adminId: string, userId: string): Promise<AuthUser> {
		const user = await this.userStore.findById(userId)
		if (!user) {
			throw new AdminUserNotFoundError(userId)
		}

		await this.audit('admin.user_lookup', adminId, userId, 'user')

		return toAuthUser(user)
	}

	/**
	 * List users with optional filtering and pagination.
	 */
	async listUsers(query: UserListQuery = {}): Promise<PaginatedResult<AuthUser>> {
		const limit = query.limit ?? 50
		const offset = query.offset ?? 0

		// Get all users (InMemoryUserStore doesn't have a list method, so we use findByEmail with patterns)
		// For now, we expose a listing helper
		const allUsers = await this.userStore.listAll()

		let filtered = allUsers

		if (query.email) {
			const searchEmail = query.email.toLowerCase()
			filtered = filtered.filter((u) => u.email.toLowerCase().includes(searchEmail))
		}

		if (query.emailVerified !== undefined) {
			filtered = filtered.filter((u) => u.emailVerified === query.emailVerified)
		}

		const total = filtered.length
		const data = filtered.slice(offset, offset + limit).map(toAuthUser)

		return { data, total, limit, offset }
	}

	/**
	 * Update a user's profile (admin-level).
	 */
	async updateUser(adminId: string, userId: string, updates: AdminUserUpdate): Promise<AuthUser> {
		const user = await this.userStore.findById(userId)
		if (!user) {
			throw new AdminUserNotFoundError(userId)
		}

		if (updates.name !== undefined) {
			user.name = updates.name
		}
		if (updates.emailVerified !== undefined) {
			user.emailVerified = updates.emailVerified
		}
		if (updates.email !== undefined) {
			user.email = updates.email.toLowerCase().trim()
		}

		await this.userStore.update(user)

		await this.audit('user.update', adminId, userId, 'user', { updates })

		return toAuthUser(user)
	}

	/**
	 * Delete a user and all associated sessions.
	 */
	async deleteUser(adminId: string, userId: string): Promise<void> {
		const user = await this.userStore.findById(userId)
		if (!user) {
			throw new AdminUserNotFoundError(userId)
		}

		// Revoke all sessions first
		if (this.sessionStore) {
			await this.sessionStore.deleteAllForUser(userId)
		}

		await this.userStore.delete(userId)

		await this.audit('user.delete', adminId, userId, 'user')
	}

	/**
	 * Get all active sessions for a user.
	 */
	async getUserSessions(userId: string): Promise<Session[]> {
		if (!this.sessionStore) return []
		return this.sessionStore.listByUserId(userId)
	}

	/**
	 * Revoke all sessions for a user.
	 */
	async revokeUserSessions(adminId: string, userId: string): Promise<number> {
		if (!this.sessionStore) return 0

		const count = await this.sessionStore.deleteAllForUser(userId)

		await this.audit('session.revoke_all', adminId, userId, 'user', { sessionsRevoked: count })

		return count
	}

	/**
	 * Revoke a specific session.
	 */
	async revokeSession(adminId: string, sessionId: string): Promise<void> {
		if (!this.sessionStore) return

		await this.sessionStore.delete(sessionId)

		await this.audit('session.revoke', adminId, sessionId, 'session')
	}

	/**
	 * Get system statistics.
	 */
	async getStats(): Promise<{
		totalUsers: number
		verifiedUsers: number
		unverifiedUsers: number
	}> {
		const allUsers = await this.userStore.listAll()
		const verified = allUsers.filter((u) => u.emailVerified).length

		return {
			totalUsers: allUsers.length,
			verifiedUsers: verified,
			unverifiedUsers: allUsers.length - verified,
		}
	}

	// --- Private ---

	private async audit(
		action: AuditAction,
		actorId: string,
		targetId: string,
		targetType: string,
		metadata?: Record<string, unknown>,
	): Promise<void> {
		if (!this.auditLogger) return
		await this.auditLogger.log({
			action,
			actorId,
			actorType: 'admin',
			targetId,
			targetType,
			metadata,
		})
	}
}

// ============================================================================
// Helpers
// ============================================================================

function toAuthUser(stored: StoredUser): AuthUser {
	return {
		id: stored.id,
		email: stored.email,
		name: stored.name,
		emailVerified: stored.emailVerified,
		createdAt: stored.createdAt,
	}
}
