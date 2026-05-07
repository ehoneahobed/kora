import { KoraError } from '@korajs/core'

// ============================================================================
// Audit Log Types
// ============================================================================

/**
 * Actions that can be audited.
 */
const AUDIT_ACTIONS = [
	// Auth
	'user.signup',
	'user.signin',
	'user.signout',
	'user.token_refresh',
	'user.password_change',
	'user.password_reset_request',
	'user.password_reset',
	'user.email_verify',
	// MFA
	'mfa.enable',
	'mfa.verify_setup',
	'mfa.verify',
	'mfa.recovery_used',
	'mfa.recovery_regenerate',
	'mfa.disable',
	// Session
	'session.create',
	'session.revoke',
	'session.revoke_all',
	'session.expired',
	// OAuth
	'oauth.authorize',
	'oauth.callback',
	'oauth.link',
	'oauth.unlink',
	// User management
	'user.create',
	'user.update',
	'user.delete',
	'user.suspend',
	'user.unsuspend',
	// Org management
	'org.create',
	'org.update',
	'org.delete',
	'org.member_add',
	'org.member_remove',
	'org.member_role_change',
	'org.ownership_transfer',
	'org.invitation_create',
	'org.invitation_accept',
	'org.invitation_revoke',
	// Admin
	'admin.user_lookup',
	'admin.impersonate',
	'admin.config_change',
] as const

export type AuditAction = (typeof AUDIT_ACTIONS)[number]

/**
 * An audit log entry.
 */
export interface AuditEntry {
	/** Unique entry ID */
	id: string
	/** When this event occurred */
	timestamp: number
	/** The action that was performed */
	action: AuditAction
	/** Who performed the action (user ID, "system", or "anonymous") */
	actorId: string
	/** The type of actor */
	actorType: 'user' | 'admin' | 'system'
	/** The target of the action (e.g., user ID, org ID, session ID) */
	targetId: string | null
	/** The type of target */
	targetType: string | null
	/** IP address of the actor */
	ipAddress: string | null
	/** User agent */
	userAgent: string | null
	/** Whether the action succeeded */
	success: boolean
	/** Error message if the action failed */
	errorMessage: string | null
	/** Additional structured context */
	metadata?: Record<string, unknown>
}

/**
 * Query parameters for searching audit logs.
 */
export interface AuditLogQuery {
	/** Filter by actor ID */
	actorId?: string
	/** Filter by target ID */
	targetId?: string
	/** Filter by action(s) */
	actions?: AuditAction[]
	/** Filter by success/failure */
	success?: boolean
	/** Start time (inclusive) */
	startTime?: number
	/** End time (inclusive) */
	endTime?: number
	/** Maximum number of entries to return */
	limit?: number
	/** Offset for pagination */
	offset?: number
}

/**
 * Store for audit log entries.
 */
export interface AuditLogStore {
	/** Append an audit entry */
	append(entry: AuditEntry): Promise<void>
	/** Query audit entries */
	query(params: AuditLogQuery): Promise<AuditEntry[]>
	/** Count matching entries */
	count(params: AuditLogQuery): Promise<number>
	/** Delete entries older than a given timestamp */
	purgeOlderThan(timestamp: number): Promise<number>
}

// ============================================================================
// Errors
// ============================================================================

export class AuditLogError extends KoraError {
	constructor(message: string, code: string, context?: Record<string, unknown>) {
		super(message, code, context)
		this.name = 'AuditLogError'
	}
}

// ============================================================================
// InMemoryAuditLogStore
// ============================================================================

/**
 * In-memory audit log store for development and testing.
 */
export class InMemoryAuditLogStore implements AuditLogStore {
	private readonly entries: AuditEntry[] = []

	async append(entry: AuditEntry): Promise<void> {
		this.entries.push({ ...entry })
	}

	async query(params: AuditLogQuery): Promise<AuditEntry[]> {
		let results = this.filterEntries(params)

		// Sort by timestamp descending (newest first)
		results.sort((a, b) => b.timestamp - a.timestamp)

		// Pagination
		const offset = params.offset ?? 0
		const limit = params.limit ?? 100
		results = results.slice(offset, offset + limit)

		return results.map((e) => ({ ...e }))
	}

	async count(params: AuditLogQuery): Promise<number> {
		return this.filterEntries(params).length
	}

	async purgeOlderThan(timestamp: number): Promise<number> {
		const initialLength = this.entries.length
		let writeIndex = 0
		for (let i = 0; i < this.entries.length; i++) {
			if (this.entries[i]!.timestamp >= timestamp) {
				this.entries[writeIndex] = this.entries[i]!
				writeIndex++
			}
		}
		this.entries.length = writeIndex
		return initialLength - writeIndex
	}

	private filterEntries(params: AuditLogQuery): AuditEntry[] {
		return this.entries.filter((e) => {
			if (params.actorId !== undefined && e.actorId !== params.actorId) return false
			if (params.targetId !== undefined && e.targetId !== params.targetId) return false
			if (params.actions !== undefined && !params.actions.includes(e.action)) return false
			if (params.success !== undefined && e.success !== params.success) return false
			if (params.startTime !== undefined && e.timestamp < params.startTime) return false
			if (params.endTime !== undefined && e.timestamp > params.endTime) return false
			return true
		})
	}
}

// ============================================================================
// AuditLogger
// ============================================================================

/**
 * Structured audit logger for authentication events.
 *
 * Records all security-relevant actions for compliance and debugging.
 * Designed to be plugged into the auth system at key decision points.
 *
 * @example
 * ```typescript
 * const auditLog = new AuditLogger({
 *   store: new InMemoryAuditLogStore(),
 * })
 *
 * await auditLog.log({
 *   action: 'user.signin',
 *   actorId: 'user-123',
 *   actorType: 'user',
 *   success: true,
 *   ipAddress: '192.168.1.1',
 * })
 *
 * const entries = await auditLog.query({ actorId: 'user-123', limit: 50 })
 * ```
 */
export class AuditLogger {
	private readonly store: AuditLogStore
	private readonly retentionMs: number | null

	constructor(config: { store: AuditLogStore; retentionDays?: number }) {
		this.store = config.store
		this.retentionMs = config.retentionDays
			? config.retentionDays * 24 * 60 * 60 * 1000
			: null
	}

	/**
	 * Log an audit event.
	 */
	async log(params: {
		action: AuditAction
		actorId: string
		actorType?: 'user' | 'admin' | 'system'
		targetId?: string
		targetType?: string
		ipAddress?: string
		userAgent?: string
		success?: boolean
		errorMessage?: string
		metadata?: Record<string, unknown>
	}): Promise<AuditEntry> {
		const entry: AuditEntry = {
			id: generateAuditId(),
			timestamp: Date.now(),
			action: params.action,
			actorId: params.actorId,
			actorType: params.actorType ?? 'user',
			targetId: params.targetId ?? null,
			targetType: params.targetType ?? null,
			ipAddress: params.ipAddress ?? null,
			userAgent: params.userAgent ?? null,
			success: params.success ?? true,
			errorMessage: params.errorMessage ?? null,
			metadata: params.metadata,
		}

		await this.store.append(entry)
		return entry
	}

	/**
	 * Query audit log entries.
	 */
	async query(params: AuditLogQuery): Promise<AuditEntry[]> {
		return this.store.query(params)
	}

	/**
	 * Count matching audit entries.
	 */
	async count(params: AuditLogQuery): Promise<number> {
		return this.store.count(params)
	}

	/**
	 * Purge old entries based on retention policy.
	 * Returns the number of entries purged.
	 */
	async purge(): Promise<number> {
		if (this.retentionMs === null) return 0
		const cutoff = Date.now() - this.retentionMs
		return this.store.purgeOlderThan(cutoff)
	}

	/**
	 * Get recent activity for a user.
	 */
	async getUserActivity(userId: string, limit: number = 50): Promise<AuditEntry[]> {
		return this.store.query({ actorId: userId, limit })
	}

	/**
	 * Get failed login attempts for a user within a time window.
	 */
	async getFailedLogins(userId: string, windowMs: number): Promise<AuditEntry[]> {
		return this.store.query({
			targetId: userId,
			actions: ['user.signin'],
			success: false,
			startTime: Date.now() - windowMs,
		})
	}
}

// ============================================================================
// Helpers
// ============================================================================

function generateAuditId(): string {
	const bytes = new Uint8Array(16)
	globalThis.crypto.getRandomValues(bytes)
	let hex = ''
	for (let i = 0; i < bytes.length; i++) {
		hex += bytes[i]!.toString(16).padStart(2, '0')
	}
	return hex
}
