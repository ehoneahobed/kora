import { KoraError } from '@korajs/core'
import type { UserStore } from './user-store'

// ============================================================================
// Types
// ============================================================================

/**
 * A pending verification: who it was sent to and until when. Only the SHA-256 of the
 * token is stored; the token itself exists in the email and nowhere else.
 */
export interface EmailVerificationToken {
	/** SHA-256 (hex) of the token. */
	tokenHash: string
	/** The user it was sent for. */
	userId: string
	/** The address it was sent to (lower-cased). It verifies only while the account still has it. */
	email: string
	/** When it was sent (ms since epoch). */
	createdAt: number
	/** When it stops working (ms since epoch). */
	expiresAt: number
}

/**
 * Where pending verifications are kept. The SQLite and Postgres user stores provide one
 * (`getEmailVerificationStore()`) in the same database as the users.
 */
export interface EmailVerificationStore {
	/** Keep a pending verification. */
	store(token: EmailVerificationToken): Promise<void>
	/**
	 * Remove and return the pending verification with this hash, atomically: of two
	 * concurrent takes of one token, only one receives it.
	 */
	take(tokenHash: string): Promise<EmailVerificationToken | null>
	/**
	 * Count one send for `userId` and return how many this window holds, including it.
	 * Atomic: concurrent sends each get a distinct count, so a limit on the result holds.
	 * A window lasts `windowMs` from its first send.
	 */
	countSend(userId: string, now: number, windowMs: number): Promise<number>
	/** Remove every pending verification and the send count of `userId`. */
	deleteForUser(userId: string): Promise<void>
	/** Remove verifications that expired before `now`. Returns how many. */
	deleteExpired(now: number): Promise<number>
}

/** What the app's `send` receives: everything needed to email the verification link. */
export interface EmailVerificationMessage {
	/** The address to send to. Send the link only there. */
	to: string
	/** The verification link (`url(token)`). */
	url: string
	userId: string
	expiresAt: number
	/** `signup`: sent when the account was created; `request`: the user asked for it. */
	reason: 'signup' | 'request'
}

/** Configuration of email verification (`createKoraAuthServer({ emailVerification })`). */
export interface EmailVerificationConfig {
	/** Send the verification email (your mailer). */
	send(message: EmailVerificationMessage): Promise<void> | void
	/**
	 * The link for a token. Put the token in the URL fragment
	 * (`https://app.example.com/verify-email#<token>`): fragments are never sent to servers
	 * or in `Referer` headers. The page calls `authClient.verifyEmail(token)`.
	 */
	url(token: string): string
	/** Send a verification email when an account is created with a password (default true). */
	sendOnSignUp?: boolean
	/** How long a link works (default 24 hours). */
	tokenTtlMs?: number
	/** Verification emails per user per hour (default 3). */
	maxPerHour?: number
	/** Where pending verifications are kept (default: the user store's own, else in memory). */
	store?: EmailVerificationStore
}

/** Outcome of {@link EmailVerificationManager.verify}. */
export type EmailVerificationResult =
	| { ok: true; userId: string; email: string }
	| {
			ok: false
			code:
				| 'VERIFICATION_TOKEN_INVALID'
				| 'VERIFICATION_TOKEN_EXPIRED'
				| 'VERIFICATION_WRONG_ACCOUNT'
	  }

/** Outcome of {@link EmailVerificationManager.send}. */
export type EmailVerificationSendResult =
	| { ok: true; alreadyVerified: boolean }
	| { ok: false; code: 'USER_NOT_FOUND' | 'VERIFICATION_RATE_LIMITED' | 'EMAIL_DELIVERY_FAILED' }

// ============================================================================
// Errors
// ============================================================================

export class EmailVerificationError extends KoraError {
	constructor(message: string, code: string, context?: Record<string, unknown>) {
		super(message, code, context)
		this.name = 'EmailVerificationError'
	}
}

// ============================================================================
// InMemoryEmailVerificationStore
// ============================================================================

/** In-memory pending verifications, for development and tests. Lost on restart. */
export class InMemoryEmailVerificationStore implements EmailVerificationStore {
	/** Marks a store that keeps nothing across restarts (production refuses it). */
	readonly inMemory = true
	private readonly tokens = new Map<string, EmailVerificationToken>()
	private readonly sends = new Map<string, { windowStart: number; count: number }>()

	async store(token: EmailVerificationToken): Promise<void> {
		this.tokens.set(token.tokenHash, { ...token })
	}

	async take(tokenHash: string): Promise<EmailVerificationToken | null> {
		const token = this.tokens.get(tokenHash) ?? null
		this.tokens.delete(tokenHash)
		return token
	}

	async countSend(userId: string, now: number, windowMs: number): Promise<number> {
		const current = this.sends.get(userId)
		if (!current || current.windowStart <= now - windowMs) {
			this.sends.set(userId, { windowStart: now, count: 1 })
			return 1
		}
		current.count += 1
		return current.count
	}

	async deleteForUser(userId: string): Promise<void> {
		for (const [hash, token] of this.tokens) if (token.userId === userId) this.tokens.delete(hash)
		this.sends.delete(userId)
	}

	async deleteExpired(now: number): Promise<number> {
		let count = 0
		for (const [hash, token] of this.tokens) {
			if (token.expiresAt <= now) {
				this.tokens.delete(hash)
				count += 1
			}
		}
		return count
	}
}

// ============================================================================
// EmailVerificationManager
// ============================================================================

const DEFAULT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_MAX_PER_HOUR = 3
const HOUR_MS = 60 * 60 * 1000

/**
 * Email verification: sends a single-use link to the account's address and marks the
 * address verified when the link is opened. `createKoraAuthServer({ emailVerification })`
 * builds one and serves its routes; use the class directly only with custom routes.
 *
 * A link verifies the address it was sent to, and only while the account still has
 * that address. It must be opened signed in to that account: otherwise someone who
 * registered your address (and holds its password) could get you to verify their
 * account just by clicking the email their sign-up sent you.
 *
 * @example
 * ```typescript
 * const verification = new EmailVerificationManager(userStore, {
 *   url: (token) => `https://app.example.com/verify-email#${token}`,
 *   send: ({ to, url }) => mailer.send({ to, subject: 'Verify your email', text: url }),
 * })
 * await verification.send(userId, 'request')
 * await verification.verify(tokenFromLink, signedInUserId)
 * ```
 */
export class EmailVerificationManager {
	private readonly store: EmailVerificationStore
	private readonly tokenTtlMs: number
	private readonly maxPerHour: number

	constructor(
		private readonly userStore: UserStore,
		private readonly config: EmailVerificationConfig,
	) {
		this.store =
			config.store ??
			userStore.getEmailVerificationStore?.() ??
			new InMemoryEmailVerificationStore()
		this.tokenTtlMs = config.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS
		this.maxPerHour = config.maxPerHour ?? DEFAULT_MAX_PER_HOUR
	}

	/** The store in use (for the production in-memory check). */
	get verificationStore(): EmailVerificationStore {
		return this.store
	}

	/** True when verification emails go out at sign-up. */
	get sendsOnSignUp(): boolean {
		return this.config.sendOnSignUp !== false
	}

	/**
	 * Send a verification link to the user's current address. An address already
	 * verified gets nothing (`alreadyVerified`). A delivery failure is returned, not
	 * swallowed: the user can ask again.
	 */
	async send(
		userId: string,
		reason: EmailVerificationMessage['reason'],
	): Promise<EmailVerificationSendResult> {
		const user = await this.userStore.findById(userId)
		if (!user) return { ok: false, code: 'USER_NOT_FOUND' }
		if (user.emailVerified) return { ok: true, alreadyVerified: true }
		const now = Date.now()
		// Counted atomically before anything is sent: concurrent requests cannot each pass.
		if ((await this.store.countSend(userId, now, HOUR_MS)) > this.maxPerHour) {
			return { ok: false, code: 'VERIFICATION_RATE_LIMITED' }
		}
		await this.store.deleteExpired(now)
		const token = randomToken()
		const tokenHash = await sha256Hex(token)
		const email = user.email.toLowerCase()
		const expiresAt = now + this.tokenTtlMs
		await this.store.store({ tokenHash, userId, email, createdAt: now, expiresAt })
		try {
			await this.config.send({ to: email, url: this.config.url(token), userId, expiresAt, reason })
		} catch (error) {
			// The link was never delivered: it must not stay usable.
			await this.store.take(tokenHash)
			console.error(
				'[kora] sending the verification email failed:',
				error instanceof Error ? error.message : String(error),
			)
			return { ok: false, code: 'EMAIL_DELIVERY_FAILED' }
		}
		return { ok: true, alreadyVerified: false }
	}

	/**
	 * Verify the address a link was sent to, for the signed-in user `userId`. The link
	 * works only for the account it was sent for (`VERIFICATION_WRONG_ACCOUNT` otherwise,
	 * and the link keeps working for its account). Unknown, used and malformed tokens all
	 * answer `VERIFICATION_TOKEN_INVALID`.
	 */
	async verify(token: unknown, userId: string): Promise<EmailVerificationResult> {
		if (typeof token !== 'string' || token.length < 20 || token.length > 128) {
			return { ok: false, code: 'VERIFICATION_TOKEN_INVALID' }
		}
		const now = Date.now()
		await this.store.deleteExpired(now - this.tokenTtlMs)
		const pending = await this.store.take(await sha256Hex(token))
		if (!pending) return { ok: false, code: 'VERIFICATION_TOKEN_INVALID' }
		if (pending.expiresAt <= now) return { ok: false, code: 'VERIFICATION_TOKEN_EXPIRED' }
		if (pending.userId !== userId) {
			// Not this account's link: put it back for its owner.
			await this.store.store(pending)
			return { ok: false, code: 'VERIFICATION_WRONG_ACCOUNT' }
		}
		// The link proves the inbox it was sent to: it verifies nothing once the account's
		// address is another one. Checked and written in one step where the store can.
		const marked = this.userStore.markEmailVerifiedIfEmail
			? await this.userStore.markEmailVerifiedIfEmail(userId, pending.email)
			: await this.markByReadThenWrite(userId, pending.email)
		if (!marked) return { ok: false, code: 'VERIFICATION_TOKEN_INVALID' }
		await this.store.deleteForUser(userId)
		return { ok: true, userId, email: pending.email }
	}

	/** Fallback for user stores without `markEmailVerifiedIfEmail`. */
	private async markByReadThenWrite(userId: string, email: string): Promise<boolean> {
		const user = await this.userStore.findById(userId)
		if (!user || user.email.toLowerCase() !== email) return false
		await this.userStore.setEmailVerified(userId, true)
		return true
	}
}

// ============================================================================
// Helpers
// ============================================================================

/** 32 random bytes, base64url. */
function randomToken(): string {
	const bytes = new Uint8Array(32)
	globalThis.crypto.getRandomValues(bytes)
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** SHA-256 of `value`, hex. */
async function sha256Hex(value: string): Promise<string> {
	const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
