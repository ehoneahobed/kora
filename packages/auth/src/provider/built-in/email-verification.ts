import { KoraError } from '@korajs/core'
import type { InMemoryUserStore } from './user-store'

// ============================================================================
// Types
// ============================================================================

/**
 * A pending email verification token.
 */
export interface EmailVerificationToken {
	/** Cryptographically random single-use token */
	token: string
	/** User ID the token was generated for */
	userId: string
	/** Email being verified */
	email: string
	/** When the token was created (ms since epoch) */
	createdAt: number
	/** When the token expires (ms since epoch) */
	expiresAt: number
	/** Whether the token has been consumed */
	consumed: boolean
}

/**
 * Persistence interface for email verification tokens.
 */
export interface EmailVerificationStore {
	/** Store a verification token. */
	store(token: EmailVerificationToken): Promise<void>

	/** Look up a token. Returns null if not found. */
	get(token: string): Promise<EmailVerificationToken | null>

	/** Mark a token as consumed. */
	consume(token: string): Promise<void>

	/** Count active (non-consumed, non-expired) tokens for a user. */
	countActiveForUser(userId: string): Promise<number>

	/** Remove expired tokens. */
	cleanExpired(): Promise<number>
}

/**
 * Configuration for the email verification flow.
 */
export interface EmailVerificationConfig {
	/** User store for looking up users */
	userStore: InMemoryUserStore
	/** Store for verification tokens. Defaults to InMemoryEmailVerificationStore. */
	verificationStore?: EmailVerificationStore
	/** Token TTL in milliseconds. Defaults to 24 hours. */
	tokenTtlMs?: number
	/** Max verification requests per user per TTL window. Defaults to 3. */
	maxRequestsPerUser?: number
	/**
	 * Callback invoked when a verification email should be sent.
	 * The developer must implement email sending.
	 * If not provided, the token is returned in the route response (development mode).
	 */
	onVerificationRequired?: (email: string, token: string, expiresAt: number) => void | Promise<void>
}

// ============================================================================
// Errors
// ============================================================================

export class EmailVerificationError extends KoraError {
	constructor(message: string, code: string, context?: Record<string, unknown>) {
		super(message, code, context)
		this.name = 'EmailVerificationError'
	}
}

export class VerificationTokenExpiredError extends EmailVerificationError {
	constructor() {
		super('Email verification token has expired.', 'VERIFICATION_TOKEN_EXPIRED')
	}
}

export class VerificationTokenNotFoundError extends EmailVerificationError {
	constructor() {
		super('Email verification token not found or already used.', 'VERIFICATION_TOKEN_NOT_FOUND')
	}
}

// ============================================================================
// InMemoryEmailVerificationStore
// ============================================================================

export class InMemoryEmailVerificationStore implements EmailVerificationStore {
	private tokens = new Map<string, EmailVerificationToken>()

	async store(token: EmailVerificationToken): Promise<void> {
		this.tokens.set(token.token, token)
	}

	async get(token: string): Promise<EmailVerificationToken | null> {
		return this.tokens.get(token) ?? null
	}

	async consume(token: string): Promise<void> {
		const entry = this.tokens.get(token)
		if (entry) {
			this.tokens.set(token, { ...entry, consumed: true })
		}
	}

	async countActiveForUser(userId: string): Promise<number> {
		const now = Date.now()
		let count = 0
		for (const token of this.tokens.values()) {
			if (token.userId === userId && !token.consumed && now < token.expiresAt) {
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
// EmailVerificationManager
// ============================================================================

/** Default TTL: 24 hours */
const DEFAULT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000

/** Default max requests per user per TTL window */
const DEFAULT_MAX_REQUESTS = 3

/**
 * Manages the email verification flow.
 *
 * @example
 * ```typescript
 * const verifier = new EmailVerificationManager({
 *   userStore,
 *   onVerificationRequired: async (email, token, expiresAt) => {
 *     await sendEmail(email, `Verify: https://app.com/verify?token=${token}`)
 *   },
 * })
 *
 * // Send verification email
 * await verifier.sendVerification('user-1', 'user@example.com')
 *
 * // Verify email
 * await verifier.verifyEmail(token)
 * ```
 */
export class EmailVerificationManager {
	private readonly userStore: InMemoryUserStore
	private readonly verificationStore: EmailVerificationStore
	private readonly tokenTtlMs: number
	private readonly maxRequestsPerUser: number
	private readonly onVerificationRequired?: (email: string, token: string, expiresAt: number) => void | Promise<void>

	constructor(config: EmailVerificationConfig) {
		this.userStore = config.userStore
		this.verificationStore = config.verificationStore ?? new InMemoryEmailVerificationStore()
		this.tokenTtlMs = config.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS
		this.maxRequestsPerUser = config.maxRequestsPerUser ?? DEFAULT_MAX_REQUESTS
		this.onVerificationRequired = config.onVerificationRequired
	}

	/**
	 * Send a verification email for a user.
	 * Rate-limited to prevent abuse.
	 */
	async sendVerification(
		userId: string,
		email: string,
	): Promise<{ status: number; body: { data: { message: string; token?: string } } | { error: string } }> {
		const normalizedEmail = email.toLowerCase().trim()

		// Rate limit
		const activeCount = await this.verificationStore.countActiveForUser(userId)
		if (activeCount >= this.maxRequestsPerUser) {
			return { status: 429, body: { error: 'Too many verification requests. Please try again later.' } }
		}

		// Generate token
		const token = generateSecureToken()
		const now = Date.now()
		const verificationToken: EmailVerificationToken = {
			token,
			userId,
			email: normalizedEmail,
			createdAt: now,
			expiresAt: now + this.tokenTtlMs,
			consumed: false,
		}

		await this.verificationStore.store(verificationToken)

		// Invoke callback
		if (this.onVerificationRequired) {
			try {
				await this.onVerificationRequired(normalizedEmail, token, verificationToken.expiresAt)
			} catch {
				// Don't fail if callback errors
			}
		}

		// In development mode (no callback), return the token
		const responseData: { message: string; token?: string } = {
			message: 'Verification email sent.',
		}
		if (!this.onVerificationRequired) {
			responseData.token = token
		}

		return { status: 200, body: { data: responseData } }
	}

	/**
	 * Verify an email using a verification token.
	 */
	async verifyEmail(
		token: string,
	): Promise<{ status: number; body: { data: { message: string; userId: string; email: string } } | { error: string } }> {
		const verificationToken = await this.verificationStore.get(token)
		if (!verificationToken || verificationToken.consumed) {
			return { status: 404, body: { error: 'Verification token not found or already used.' } }
		}

		if (Date.now() > verificationToken.expiresAt) {
			await this.verificationStore.consume(token)
			return { status: 410, body: { error: 'Verification token has expired.' } }
		}

		// Consume token
		await this.verificationStore.consume(token)

		// Mark user's email as verified
		await this.userStore.setEmailVerified(verificationToken.userId, true)

		return {
			status: 200,
			body: {
				data: {
					message: 'Email verified successfully.',
					userId: verificationToken.userId,
					email: verificationToken.email,
				},
			},
		}
	}

	/**
	 * Resend verification email for a user.
	 * Delegates to sendVerification with rate limiting.
	 */
	async resendVerification(
		userId: string,
	): Promise<{ status: number; body: { data: { message: string; token?: string } } | { error: string } }> {
		const user = await this.userStore.findById(userId)
		if (!user) {
			return { status: 404, body: { error: 'User not found.' } }
		}

		return this.sendVerification(userId, user.email)
	}
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
