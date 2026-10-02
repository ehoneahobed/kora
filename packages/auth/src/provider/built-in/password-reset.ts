import { KoraError } from '@korajs/core'
import { hashPassword } from './password-hash'
import type { UserStore } from './user-store'

// ============================================================================
// Types
// ============================================================================

/**
 * A pending password reset request.
 */
export interface PasswordResetToken {
	/** Cryptographically random single-use token */
	token: string
	/** User ID the token was generated for */
	userId: string
	/** Email the reset was requested for */
	email: string
	/** When the token was created (ms since epoch) */
	createdAt: number
	/** When the token expires (ms since epoch) */
	expiresAt: number
	/** Whether the token has been consumed */
	consumed: boolean
}

/**
 * Persistence interface for password reset tokens.
 */
export interface PasswordResetStore {
	/** Store a reset token. */
	store(token: PasswordResetToken): Promise<void>

	/** Look up a token. Returns null if not found. */
	get(token: string): Promise<PasswordResetToken | null>

	/**
	 * Mark a token as consumed. Should be atomic and return `true` only for the
	 * call that consumed a not-yet-consumed token; `false` makes the reset fail
	 * as already used. Returning nothing is accepted for older stores.
	 */
	consume(token: string): Promise<boolean | undefined>

	/** Count active (non-consumed, non-expired) tokens for an email. */
	countActiveForEmail(email: string): Promise<number>

	/** Remove expired tokens. */
	cleanExpired(): Promise<number>
}

/**
 * Configuration for the password reset flow.
 */
export interface PasswordResetConfig {
	/** User store for looking up users and updating passwords */
	userStore: UserStore
	/** Store for reset tokens. Defaults to InMemoryPasswordResetStore. */
	resetStore?: PasswordResetStore
	/** Token TTL in milliseconds. Defaults to 1 hour. */
	tokenTtlMs?: number
	/** Max reset requests per email in the TTL window. Defaults to 3. */
	maxRequestsPerEmail?: number
	/**
	 * Callback invoked when a reset is requested. The developer must implement
	 * email sending: the token must only ever reach the account's mailbox.
	 */
	onResetRequested?: (email: string, token: string, expiresAt: number) => void | Promise<void>
	/**
	 * Development only: also return the reset token in the `requestReset`
	 * response when no `onResetRequested` callback is configured. Ignored when
	 * `NODE_ENV=production`; the token is never disclosed to the requester there.
	 * @default false
	 */
	exposeTokenForDevelopment?: boolean
	/**
	 * Called after a password is reset or changed, once every earlier credential
	 * of the user has been revoked. Use it to end live sessions (for example
	 * `authServer.revokeAllForUser` when the user store has no revocation store).
	 */
	onPasswordChanged?: (userId: string) => void | Promise<void>
}

// ============================================================================
// Errors
// ============================================================================

export class PasswordResetError extends KoraError {
	constructor(message: string, code: string, context?: Record<string, unknown>) {
		super(message, code, context)
		this.name = 'PasswordResetError'
	}
}

export class ResetTokenExpiredError extends PasswordResetError {
	constructor() {
		super('Password reset token has expired.', 'RESET_TOKEN_EXPIRED')
	}
}

export class ResetTokenNotFoundError extends PasswordResetError {
	constructor() {
		super('Password reset token not found or already used.', 'RESET_TOKEN_NOT_FOUND')
	}
}

export class ResetRateLimitedError extends PasswordResetError {
	constructor() {
		super('Too many password reset requests. Please try again later.', 'RESET_RATE_LIMITED')
	}
}

// ============================================================================
// InMemoryPasswordResetStore
// ============================================================================

export class InMemoryPasswordResetStore implements PasswordResetStore {
	private tokens = new Map<string, PasswordResetToken>()

	async store(token: PasswordResetToken): Promise<void> {
		this.tokens.set(token.token, token)
	}

	async get(token: string): Promise<PasswordResetToken | null> {
		return this.tokens.get(token) ?? null
	}

	async consume(token: string): Promise<boolean> {
		const entry = this.tokens.get(token)
		if (!entry || entry.consumed) return false
		this.tokens.set(token, { ...entry, consumed: true })
		return true
	}

	async countActiveForEmail(email: string): Promise<number> {
		const now = Date.now()
		let count = 0
		for (const token of this.tokens.values()) {
			if (token.email === email && !token.consumed && now < token.expiresAt) {
				count++
			}
		}
		return count
	}

	async cleanExpired(): Promise<number> {
		const now = Date.now()
		let count = 0
		for (const [key, token] of this.tokens) {
			if (now > token.expiresAt) {
				this.tokens.delete(key)
				count++
			}
		}
		return count
	}
}

// ============================================================================
// PasswordResetManager
// ============================================================================

/** Default TTL: 1 hour */
const DEFAULT_TOKEN_TTL_MS = 60 * 60 * 1000

/** Default max requests per email per TTL window */
const DEFAULT_MAX_REQUESTS = 3

/** Minimum password length (same as auth-routes) */
const MIN_PASSWORD_LENGTH = 8

/** Maximum password length (same as auth-routes) */
const MAX_PASSWORD_LENGTH = 128

/**
 * Manages the password reset flow.
 *
 * @example
 * ```typescript
 * const resetManager = new PasswordResetManager({
 *   userStore,
 *   onResetRequested: async (email, token, expiresAt) => {
 *     await sendEmail(email, `Reset link: https://app.com/reset?token=${token}`)
 *   },
 * })
 *
 * // Request reset (always returns 200 to prevent email enumeration)
 * const response = await resetManager.requestReset('user@example.com')
 *
 * // Consume token and set new password
 * const response = await resetManager.resetPassword(token, 'newPassword123')
 * ```
 */
export class PasswordResetManager {
	private readonly userStore: UserStore
	private readonly resetStore: PasswordResetStore
	private readonly tokenTtlMs: number
	private readonly maxRequestsPerEmail: number
	private readonly onResetRequested?: (
		email: string,
		token: string,
		expiresAt: number,
	) => void | Promise<void>
	private readonly exposeTokenForDevelopment: boolean
	private readonly onPasswordChanged?: (userId: string) => void | Promise<void>
	private warnedNoDelivery = false

	constructor(config: PasswordResetConfig) {
		this.userStore = config.userStore
		this.resetStore = config.resetStore ?? new InMemoryPasswordResetStore()
		this.tokenTtlMs = config.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS
		this.maxRequestsPerEmail = config.maxRequestsPerEmail ?? DEFAULT_MAX_REQUESTS
		this.onResetRequested = config.onResetRequested
		this.exposeTokenForDevelopment = config.exposeTokenForDevelopment === true && !isProduction()
		this.onPasswordChanged = config.onPasswordChanged
	}

	/**
	 * Request a password reset for an email.
	 * Always returns the same success response to prevent email enumeration.
	 *
	 * The token is delivered only through `onResetRequested`. It is returned in
	 * the response only with `exposeTokenForDevelopment: true` outside production.
	 */
	async requestReset(email: string): Promise<{
		status: number
		body: { data: { message: string; token?: string } } | { error: string }
	}> {
		const normalizedEmail = email.toLowerCase().trim()

		// Always return 200 to prevent email enumeration
		const successResponse = {
			status: 200,
			body: {
				data: {
					message: 'If an account with that email exists, a password reset link has been sent.',
				},
			} as { data: { message: string; token?: string } },
		}

		// Look up user
		const user = await this.userStore.findByEmail(normalizedEmail)
		if (!user) {
			return successResponse
		}

		// Rate limit
		const activeCount = await this.resetStore.countActiveForEmail(normalizedEmail)
		if (activeCount >= this.maxRequestsPerEmail) {
			return successResponse // Still 200 to prevent enumeration
		}

		// Generate token
		const token = generateSecureToken()
		const now = Date.now()
		const resetToken: PasswordResetToken = {
			token,
			userId: user.id,
			email: normalizedEmail,
			createdAt: now,
			expiresAt: now + this.tokenTtlMs,
			consumed: false,
		}

		await this.resetStore.store(resetToken)

		// Invoke callback
		if (this.onResetRequested) {
			try {
				await this.onResetRequested(normalizedEmail, token, resetToken.expiresAt)
			} catch {
				// Don't fail the request if callback errors
			}
		}

		if (!this.onResetRequested) {
			if (this.exposeTokenForDevelopment) {
				// Same message as the normal path so the response shape does not reveal
				// whether the account exists; only the extra token field differs.
				successResponse.body = { data: { ...successResponse.body.data, token } }
			} else if (!this.warnedNoDelivery) {
				this.warnedNoDelivery = true
				console.error(
					'[kora] PasswordResetManager has no onResetRequested callback, so reset tokens are not delivered to anyone. ' +
						'Configure onResetRequested to email the token (or exposeTokenForDevelopment: true for local development).',
				)
			}
		}

		return successResponse
	}

	/**
	 * Consume a reset token and set a new password.
	 */
	async resetPassword(
		token: string,
		newPassword: string,
	): Promise<{ status: number; body: { data: { message: string } } | { error: string } }> {
		// Validate password
		if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LENGTH) {
			return {
				status: 400,
				body: { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` },
			}
		}
		if (newPassword.length > MAX_PASSWORD_LENGTH) {
			return {
				status: 400,
				body: { error: `Password must be at most ${MAX_PASSWORD_LENGTH} characters.` },
			}
		}

		const resetToken = await this.resetStore.get(token)
		if (!resetToken || resetToken.consumed) {
			return { status: 404, body: { error: 'Password reset token not found or already used.' } }
		}

		if (Date.now() > resetToken.expiresAt) {
			await this.resetStore.consume(token)
			return { status: 410, body: { error: 'Password reset token has expired.' } }
		}

		// Consume token atomically: only one concurrent reset may use it.
		const consumed = await this.resetStore.consume(token)
		if (consumed === false) {
			return { status: 404, body: { error: 'Password reset token not found or already used.' } }
		}

		// Update password
		const hashed = await hashPassword(newPassword)
		await this.userStore.updatePassword(resetToken.userId, hashed.hash, hashed.salt)
		await this.revokeEarlierCredentials(resetToken.userId)

		return { status: 200, body: { data: { message: 'Password has been reset successfully.' } } }
	}

	/**
	 * Change password for an authenticated user (requires current password verification).
	 */
	async changePassword(
		userId: string,
		currentPassword: string,
		newPassword: string,
	): Promise<{ status: number; body: { data: { message: string } } | { error: string } }> {
		// Validate new password
		if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LENGTH) {
			return {
				status: 400,
				body: { error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters.` },
			}
		}
		if (newPassword.length > MAX_PASSWORD_LENGTH) {
			return {
				status: 400,
				body: { error: `New password must be at most ${MAX_PASSWORD_LENGTH} characters.` },
			}
		}

		const user = await this.userStore.findById(userId)
		if (!user) {
			return { status: 404, body: { error: 'User not found.' } }
		}

		// Verify current password
		const { verifyPassword } = await import('./password-hash')
		const isValid = await verifyPassword(currentPassword, user.passwordHash, user.salt)
		if (!isValid) {
			return { status: 401, body: { error: 'Current password is incorrect.' } }
		}

		// Update password
		const hashed = await hashPassword(newPassword)
		await this.userStore.updatePassword(userId, hashed.hash, hashed.salt)
		await this.revokeEarlierCredentials(userId)

		return { status: 200, body: { data: { message: 'Password changed successfully.' } } }
	}

	/**
	 * A password change kills every earlier credential (AUTH-7b): every access
	 * and refresh token issued before now is rejected on every path.
	 */
	private async revokeEarlierCredentials(userId: string): Promise<void> {
		const revocations = this.userStore.getTokenRevocationStore?.()
		if (revocations) {
			await revocations.revokeAllForUser(userId, Date.now())
		}
		if (this.onPasswordChanged) {
			await this.onPasswordChanged(userId)
		}
		if (!revocations && !this.onPasswordChanged) {
			console.warn(
				'[kora] Password changed but earlier sessions could not be revoked: the user store has no ' +
					'getTokenRevocationStore() and no onPasswordChanged hook is configured.',
			)
		}
	}
}

function isProduction(): boolean {
	return typeof process !== 'undefined' && process.env.NODE_ENV === 'production'
}

// ============================================================================
// Helpers
// ============================================================================

function generateSecureToken(): string {
	const bytes = new Uint8Array(32)
	globalThis.crypto.getRandomValues(bytes)
	let binary = ''
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i] as number)
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
