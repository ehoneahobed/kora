import { KoraError } from '@korajs/core'

// ============================================================================
// Session Types
// ============================================================================

/**
 * A user session with metadata.
 */
export interface Session {
	/** Unique session ID */
	id: string
	/** User ID */
	userId: string
	/** Device ID (if available) */
	deviceId: string | null
	/** IP address of the client (for display, not for security decisions) */
	ipAddress: string | null
	/** User agent string */
	userAgent: string | null
	/** When the session was created */
	createdAt: number
	/** When the session was last active */
	lastActiveAt: number
	/** When the session expires (absolute expiry) */
	expiresAt: number
	/** Whether MFA has been completed for this session */
	mfaVerified: boolean
	/** Custom metadata */
	metadata?: Record<string, unknown>
}

/**
 * Configuration for the session manager.
 */
export interface SessionManagerConfig {
	/** Session store implementation */
	store: SessionStore
	/** Session TTL in milliseconds. Default: 7 days */
	sessionTtlMs?: number
	/** Idle timeout in milliseconds. Default: 30 minutes */
	idleTimeoutMs?: number
	/** Maximum concurrent sessions per user. Default: 10 */
	maxSessionsPerUser?: number
	/** Whether to extend session on activity. Default: true */
	slidingWindow?: boolean
}

/**
 * Parameters for creating a new session.
 */
export interface CreateSessionParams {
	userId: string
	deviceId?: string
	ipAddress?: string
	userAgent?: string
	mfaVerified?: boolean
	metadata?: Record<string, unknown>
}

/**
 * Store for session data.
 */
export interface SessionStore {
	/** Create a new session */
	create(session: Session): Promise<void>
	/** Get a session by ID */
	getById(sessionId: string): Promise<Session | null>
	/** Update a session */
	update(session: Session): Promise<void>
	/** Delete a session */
	delete(sessionId: string): Promise<void>
	/** Get all sessions for a user */
	listByUserId(userId: string): Promise<Session[]>
	/** Delete all sessions for a user */
	deleteAllForUser(userId: string): Promise<number>
	/** Delete all sessions for a user except one */
	deleteAllExcept(userId: string, keepSessionId: string): Promise<number>
	/** Clean up expired sessions */
	cleanExpired(): Promise<number>
}

// ============================================================================
// Errors
// ============================================================================

export class SessionError extends KoraError {
	constructor(message: string, code: string, context?: Record<string, unknown>) {
		super(message, code, context)
		this.name = 'SessionError'
	}
}

export class SessionNotFoundError extends SessionError {
	constructor(sessionId: string) {
		super('Session not found or expired.', 'SESSION_NOT_FOUND', { sessionId })
	}
}

export class SessionExpiredError extends SessionError {
	constructor(sessionId: string) {
		super('Session has expired.', 'SESSION_EXPIRED', { sessionId })
	}
}

export class SessionLimitExceededError extends SessionError {
	constructor(userId: string, limit: number) {
		super(
			`Maximum concurrent sessions (${limit}) reached. Revoke an existing session first.`,
			'SESSION_LIMIT_EXCEEDED',
			{ userId, limit },
		)
	}
}

export class SessionMfaRequiredError extends SessionError {
	constructor(sessionId: string) {
		super('MFA verification is required for this session.', 'SESSION_MFA_REQUIRED', { sessionId })
	}
}

// ============================================================================
// InMemorySessionStore
// ============================================================================

/**
 * In-memory session store for development and testing.
 */
export class InMemorySessionStore implements SessionStore {
	private readonly sessions = new Map<string, Session>()

	async create(session: Session): Promise<void> {
		this.sessions.set(session.id, { ...session })
	}

	async getById(sessionId: string): Promise<Session | null> {
		const session = this.sessions.get(sessionId)
		return session ? { ...session } : null
	}

	async update(session: Session): Promise<void> {
		this.sessions.set(session.id, { ...session })
	}

	async delete(sessionId: string): Promise<void> {
		this.sessions.delete(sessionId)
	}

	async listByUserId(userId: string): Promise<Session[]> {
		const results: Session[] = []
		for (const session of this.sessions.values()) {
			if (session.userId === userId) {
				results.push({ ...session })
			}
		}
		return results.sort((a, b) => b.lastActiveAt - a.lastActiveAt)
	}

	async deleteAllForUser(userId: string): Promise<number> {
		let count = 0
		for (const [id, session] of this.sessions) {
			if (session.userId === userId) {
				this.sessions.delete(id)
				count++
			}
		}
		return count
	}

	async deleteAllExcept(userId: string, keepSessionId: string): Promise<number> {
		let count = 0
		for (const [id, session] of this.sessions) {
			if (session.userId === userId && id !== keepSessionId) {
				this.sessions.delete(id)
				count++
			}
		}
		return count
	}

	async cleanExpired(): Promise<number> {
		const now = Date.now()
		let count = 0
		for (const [id, session] of this.sessions) {
			if (now > session.expiresAt) {
				this.sessions.delete(id)
				count++
			}
		}
		return count
	}
}

// ============================================================================
// SessionManager
// ============================================================================

const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000 // 30 minutes
const DEFAULT_MAX_SESSIONS = 10

/**
 * Manages user sessions with support for:
 * - Session creation, validation, and revocation
 * - Sliding window expiry (extends on activity)
 * - Idle timeout detection
 * - Max concurrent sessions per user
 * - MFA verification tracking
 * - "Sign out everywhere" support
 *
 * @example
 * ```typescript
 * const sessions = new SessionManager({
 *   store: new InMemorySessionStore(),
 *   sessionTtlMs: 7 * 24 * 60 * 60 * 1000, // 7 days
 *   idleTimeoutMs: 30 * 60 * 1000, // 30 minutes
 *   maxSessionsPerUser: 5,
 * })
 *
 * // Create session on login
 * const session = await sessions.create({
 *   userId: 'user-123',
 *   ipAddress: '192.168.1.1',
 *   userAgent: 'Mozilla/5.0...',
 * })
 *
 * // Validate session on each request
 * const valid = await sessions.validate(session.id)
 *
 * // Touch session to extend idle timeout
 * await sessions.touch(session.id)
 * ```
 */
export class SessionManager {
	private readonly store: SessionStore
	private readonly sessionTtlMs: number
	private readonly idleTimeoutMs: number
	private readonly maxSessionsPerUser: number
	private readonly slidingWindow: boolean

	constructor(config: SessionManagerConfig) {
		this.store = config.store
		this.sessionTtlMs = config.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS
		this.idleTimeoutMs = config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
		this.maxSessionsPerUser = config.maxSessionsPerUser ?? DEFAULT_MAX_SESSIONS
		this.slidingWindow = config.slidingWindow ?? true
	}

	/**
	 * Create a new session for a user.
	 * Enforces the maximum concurrent sessions limit.
	 */
	async create(params: CreateSessionParams): Promise<Session> {
		// Enforce max sessions
		const existing = await this.store.listByUserId(params.userId)
		const activeSessions = existing.filter((s) => Date.now() <= s.expiresAt)

		if (activeSessions.length >= this.maxSessionsPerUser) {
			throw new SessionLimitExceededError(params.userId, this.maxSessionsPerUser)
		}

		const now = Date.now()
		const session: Session = {
			id: generateSessionId(),
			userId: params.userId,
			deviceId: params.deviceId ?? null,
			ipAddress: params.ipAddress ?? null,
			userAgent: params.userAgent ?? null,
			createdAt: now,
			lastActiveAt: now,
			expiresAt: now + this.sessionTtlMs,
			mfaVerified: params.mfaVerified ?? false,
			metadata: params.metadata,
		}

		await this.store.create(session)
		return session
	}

	/**
	 * Validate a session.
	 * Returns the session if valid, throws if not found or expired.
	 */
	async validate(sessionId: string): Promise<Session> {
		const session = await this.store.getById(sessionId)
		if (!session) {
			throw new SessionNotFoundError(sessionId)
		}

		const now = Date.now()

		// Check absolute expiry
		if (now > session.expiresAt) {
			await this.store.delete(sessionId)
			throw new SessionExpiredError(sessionId)
		}

		// Check idle timeout
		if (now - session.lastActiveAt > this.idleTimeoutMs) {
			await this.store.delete(sessionId)
			throw new SessionExpiredError(sessionId)
		}

		return session
	}

	/**
	 * Touch a session to update its last activity time.
	 * If sliding window is enabled, also extends the absolute expiry.
	 */
	async touch(sessionId: string): Promise<Session> {
		const session = await this.validate(sessionId)
		const now = Date.now()

		session.lastActiveAt = now

		if (this.slidingWindow) {
			session.expiresAt = now + this.sessionTtlMs
		}

		await this.store.update(session)
		return session
	}

	/**
	 * Mark a session as MFA-verified.
	 */
	async markMfaVerified(sessionId: string): Promise<Session> {
		const session = await this.validate(sessionId)
		session.mfaVerified = true
		await this.store.update(session)
		return session
	}

	/**
	 * Require MFA verification on a session.
	 * Throws SessionMfaRequiredError if MFA is not verified.
	 */
	async requireMfa(sessionId: string): Promise<Session> {
		const session = await this.validate(sessionId)
		if (!session.mfaVerified) {
			throw new SessionMfaRequiredError(sessionId)
		}
		return session
	}

	/**
	 * Revoke (delete) a session.
	 */
	async revoke(sessionId: string): Promise<void> {
		await this.store.delete(sessionId)
	}

	/**
	 * Revoke all sessions for a user (sign out everywhere).
	 * Returns the number of sessions revoked.
	 */
	async revokeAll(userId: string): Promise<number> {
		return this.store.deleteAllForUser(userId)
	}

	/**
	 * Revoke all sessions for a user except the current one.
	 * Returns the number of sessions revoked.
	 */
	async revokeOthers(userId: string, currentSessionId: string): Promise<number> {
		return this.store.deleteAllExcept(userId, currentSessionId)
	}

	/**
	 * List all active sessions for a user.
	 */
	async listSessions(userId: string): Promise<Session[]> {
		const sessions = await this.store.listByUserId(userId)
		const now = Date.now()
		// Filter out expired sessions
		return sessions.filter((s) => now <= s.expiresAt && now - s.lastActiveAt <= this.idleTimeoutMs)
	}

	/**
	 * Clean up expired sessions.
	 * Returns the number of sessions cleaned.
	 */
	async cleanExpired(): Promise<number> {
		return this.store.cleanExpired()
	}
}

// ============================================================================
// Helpers
// ============================================================================

function generateSessionId(): string {
	const bytes = new Uint8Array(32)
	globalThis.crypto.getRandomValues(bytes)
	let hex = ''
	for (let i = 0; i < bytes.length; i++) {
		hex += bytes[i]?.toString(16).padStart(2, '0')
	}
	return hex
}
