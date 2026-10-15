import { KoraError } from '@korajs/core'
import {
	InMemoryOneTimeTokenStore,
	type OneTimeToken,
	type OneTimeTokenStore,
	randomToken,
	sha256Hex,
} from './one-time-tokens'
import type { UserStore } from './user-store'

// ============================================================================
// Types
// ============================================================================

/** A pending verification (see {@link OneTimeToken}). */
export type EmailVerificationToken = OneTimeToken

/**
 * Where pending verifications are kept. The SQLite and Postgres user stores provide one
 * (`getEmailVerificationStore()`) in the same database as the users.
 */
export type EmailVerificationStore = OneTimeTokenStore

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
export class InMemoryEmailVerificationStore extends InMemoryOneTimeTokenStore {}

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
		// A read-then-write could mark a just-changed address verified with a link sent to
		// the old one, so verification needs the store's one-step conditional update.
		if (typeof userStore.markEmailVerifiedIfEmail !== 'function') {
			throw new EmailVerificationError(
				'Email verification needs a UserStore with markEmailVerifiedIfEmail(userId, email): ' +
					'mark the user verified only if their address is still `email`, in one atomic step. ' +
					'The built-in memory, SQLite and Postgres stores have it.',
				'EMAIL_VERIFICATION_STORE_UNSUPPORTED',
			)
		}
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
		// Expired links are kept one more lifetime, so opening one says it expired.
		await this.store.deleteExpired(now - this.tokenTtlMs)
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
	 * works only for the account it was sent for (`VERIFICATION_WRONG_ACCOUNT` otherwise;
	 * the link is left untouched for its account). Unknown, used and malformed tokens all
	 * answer `VERIFICATION_TOKEN_INVALID`.
	 */
	async verify(token: unknown, userId: string): Promise<EmailVerificationResult> {
		// Without the signed-in user nothing is verified, and the link is left untouched.
		if (typeof userId !== 'string' || userId.length === 0) {
			return { ok: false, code: 'VERIFICATION_WRONG_ACCOUNT' }
		}
		if (typeof token !== 'string' || token.length < 20 || token.length > 128) {
			return { ok: false, code: 'VERIFICATION_TOKEN_INVALID' }
		}
		const now = Date.now()
		await this.store.deleteExpired(now - this.tokenTtlMs)
		const tokenHash = await sha256Hex(token)
		// Taken only for this account: another account's link stays where it is, usable
		// by its owner at every moment.
		const pending = await this.store.take(tokenHash, userId)
		if (!pending) {
			const other = await this.store.get(tokenHash)
			return other && other.expiresAt > now
				? { ok: false, code: 'VERIFICATION_WRONG_ACCOUNT' }
				: { ok: false, code: other ? 'VERIFICATION_TOKEN_EXPIRED' : 'VERIFICATION_TOKEN_INVALID' }
		}
		if (pending.expiresAt <= now) return { ok: false, code: 'VERIFICATION_TOKEN_EXPIRED' }
		// The link proves the inbox it was sent to: it verifies nothing once the account's
		// address is another one. Checked and written in one step where the store can.
		const mark = this.userStore.markEmailVerifiedIfEmail
		if (!mark || !(await mark.call(this.userStore, userId, pending.email)))
			return { ok: false, code: 'VERIFICATION_TOKEN_INVALID' }
		await this.store.deleteForUser(userId)
		return { ok: true, userId, email: pending.email }
	}
}
