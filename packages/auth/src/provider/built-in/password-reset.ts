import { KoraError } from '@korajs/core'
import {
	InMemoryOneTimeTokenStore,
	type OneTimeToken,
	type OneTimeTokenStore,
	randomToken,
	sha256Hex,
} from './one-time-tokens'
import { hashPassword, verifyPassword } from './password-hash'
import type { UserStore } from './user-store'

// ============================================================================
// Types
// ============================================================================

/** A pending password reset (see {@link OneTimeToken}). */
export type PasswordResetToken = OneTimeToken

/**
 * Where pending resets are kept. The SQLite and Postgres user stores provide one
 * (`getPasswordResetStore()`) in the same database as the users.
 */
export type PasswordResetStore = OneTimeTokenStore

/** What the app's `send` receives: everything needed to email the reset link. */
export interface PasswordResetMessage {
	/** The account's address. Send the link only there. */
	to: string
	/** The reset link (`url(token)`). */
	url: string
	userId: string
	expiresAt: number
}

/** Configuration of password reset (`createKoraAuthServer({ passwordReset })`). */
export interface PasswordResetConfig {
	/** Send the reset email (your mailer). */
	send(message: PasswordResetMessage): Promise<void> | void
	/**
	 * The link for a token. Put the token in the URL fragment
	 * (`https://app.example.com/reset-password#<token>`): fragments are never sent to
	 * servers or in `Referer` headers. The page calls `authClient.resetPassword(token, password)`.
	 */
	url(token: string): string
	/** How long a link works (default 1 hour). */
	tokenTtlMs?: number
	/** Reset emails per account per hour (default 3). Requests beyond it send nothing. */
	maxPerHour?: number
	/** Where pending resets are kept (default: the user store's own, else in memory). */
	store?: PasswordResetStore
	/**
	 * Called after a password is reset or changed, to end the user's sessions.
	 * `createKoraAuthServer` sets it (ending live sync sessions too); without it, the
	 * user store's revocation store is used.
	 */
	onPasswordChanged?(userId: string): Promise<void> | void
}

/** What {@link PasswordResetManager.request} did. Never tell the requester. */
export type PasswordResetRequestOutcome =
	| 'sent'
	| 'invalid-email'
	| 'unknown-email'
	| 'rate-limited'
	| 'delivery-failed'

/** Outcome of {@link PasswordResetManager.reset}. */
export type PasswordResetResult =
	| { ok: true; userId: string }
	| {
			ok: false
			code:
				| 'RESET_TOKEN_INVALID'
				| 'RESET_TOKEN_EXPIRED'
				| 'PASSWORD_TOO_SHORT'
				| 'PASSWORD_TOO_LONG'
	  }

/** Outcome of {@link PasswordResetManager.change}. */
export type PasswordChangeResult =
	| { ok: true }
	| {
			ok: false
			code:
				| 'CURRENT_PASSWORD_INCORRECT'
				| 'PASSWORD_TOO_SHORT'
				| 'PASSWORD_TOO_LONG'
				| 'USER_NOT_FOUND'
				| 'SESSION_ENDED'
	  }

// ============================================================================
// InMemoryPasswordResetStore
// ============================================================================

/** In-memory pending resets, for development and tests. Lost on restart. */
export class InMemoryPasswordResetStore extends InMemoryOneTimeTokenStore {}

// ============================================================================
// PasswordResetManager
// ============================================================================

const DEFAULT_TOKEN_TTL_MS = 60 * 60 * 1000
const DEFAULT_MAX_PER_HOUR = 3
const HOUR_MS = 60 * 60 * 1000
/** Same bounds as sign-up. */
const MIN_PASSWORD_LENGTH = 8
const MAX_PASSWORD_LENGTH = 128

/**
 * Password reset and change. `createKoraAuthServer({ passwordReset })` builds one and
 * serves its routes; use the class directly only with custom routes.
 *
 * A reset link is single-use, expires (1 hour by default), works only while the account
 * still has the address it was sent to, and ends every session of the account when used.
 * Requesting one never reveals whether an account exists.
 *
 * @example
 * ```typescript
 * const resets = new PasswordResetManager(userStore, {
 *   url: (token) => `https://app.example.com/reset-password#${token}`,
 *   send: ({ to, url }) => mailer.send({ to, subject: 'Reset your password', text: url }),
 * })
 * void resets.request(email) // answer the requester the same way whatever happens
 * await resets.reset(tokenFromLink, newPassword)
 * ```
 */
export class PasswordResetManager {
	private readonly store: PasswordResetStore
	private readonly tokenTtlMs: number
	private readonly maxPerHour: number

	constructor(
		private readonly userStore: UserStore,
		private readonly config: PasswordResetConfig,
	) {
		// The address and the password can change while a reset runs: the password is
		// written only over what the reset found, in one step; and the link proves the inbox,
		// so the address is marked verified only while it is still the one it was sent to.
		if (
			typeof userStore.updatePasswordIf !== 'function' ||
			typeof userStore.markEmailVerifiedIfEmail !== 'function'
		) {
			throw new KoraError(
				'Password reset needs a UserStore with updatePasswordIf(userId, condition, hash, salt) ' +
					'and markEmailVerifiedIfEmail(userId, email), each one atomic conditional update. ' +
					'The built-in memory, SQLite and Postgres stores have them.',
				'PASSWORD_RESET_STORE_UNSUPPORTED',
			)
		}
		this.store =
			config.store ?? userStore.getPasswordResetStore?.() ?? new InMemoryPasswordResetStore()
		this.tokenTtlMs = config.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS
		this.maxPerHour = config.maxPerHour ?? DEFAULT_MAX_PER_HOUR
	}

	/** The store in use (for the production in-memory check). */
	get resetStore(): PasswordResetStore {
		return this.store
	}

	/**
	 * Email a reset link to the account with this address, if there is one. Whatever the
	 * outcome, the requester must get the same answer at the same time: run it without
	 * waiting for it (the built-in route does), and never return the outcome.
	 */
	async request(email: unknown): Promise<PasswordResetRequestOutcome> {
		if (typeof email !== 'string') return 'invalid-email'
		const address = email.trim().toLowerCase()
		if (address.length < 3 || address.length > 254 || !address.includes('@')) return 'invalid-email'
		const user = await this.userStore.findByEmail(address)
		if (!user) return 'unknown-email'
		const now = Date.now()
		// Counted atomically before anything is sent: a flood of requests sends at most
		// `maxPerHour` emails to the account.
		if ((await this.store.countSend(user.id, now, HOUR_MS)) > this.maxPerHour) return 'rate-limited'
		// Expired links are kept one more lifetime, so opening one says it expired.
		await this.store.deleteExpired(now - this.tokenTtlMs)
		const token = randomToken()
		const tokenHash = await sha256Hex(token)
		const to = user.email.toLowerCase()
		const expiresAt = now + this.tokenTtlMs
		await this.store.store({ tokenHash, userId: user.id, email: to, createdAt: now, expiresAt })
		try {
			await this.config.send({ to, url: this.config.url(token), userId: user.id, expiresAt })
		} catch (error) {
			// The link was never delivered: it must not stay usable.
			await this.store.take(tokenHash)
			console.error(
				'[kora] sending the password reset email failed:',
				error instanceof Error ? error.message : String(error),
			)
			return 'delivery-failed'
		}
		return 'sent'
	}

	/**
	 * Set a new password with the token from a reset link. The link works once, until it
	 * expires, and only while the account still has the address it was sent to. On success
	 * every other reset link of the account stops working, the address counts as verified
	 * (the link proved the inbox) and every session of the account ends.
	 */
	async reset(token: unknown, newPassword: unknown): Promise<PasswordResetResult> {
		// Checked before the link is used, so a rejected password leaves it working.
		const invalid = passwordProblem(newPassword)
		if (invalid) return { ok: false, code: invalid }
		if (typeof token !== 'string' || token.length < 20 || token.length > 128) {
			return { ok: false, code: 'RESET_TOKEN_INVALID' }
		}
		const now = Date.now()
		await this.store.deleteExpired(now - this.tokenTtlMs)
		const pending = await this.store.take(await sha256Hex(token))
		if (!pending) return { ok: false, code: 'RESET_TOKEN_INVALID' }
		if (pending.expiresAt <= now) return { ok: false, code: 'RESET_TOKEN_EXPIRED' }
		// Written only over the password the account has now: a change or another reset that
		// lands while this one hashes wins, and this one reports the link as used.
		const user = await this.userStore.findById(pending.userId)
		if (!user) return { ok: false, code: 'RESET_TOKEN_INVALID' }
		const hashed = await hashPassword(newPassword as string)
		const set = this.userStore.updatePasswordIf
		if (
			!set ||
			!(await set.call(
				this.userStore,
				pending.userId,
				{ email: pending.email, passwordHash: user.passwordHash },
				hashed.hash,
				hashed.salt,
			))
		) {
			// The account is gone, its address changed, or its password changed meanwhile.
			return { ok: false, code: 'RESET_TOKEN_INVALID' }
		}
		await this.store.deleteForUser(pending.userId)
		await this.userStore.markEmailVerifiedIfEmail?.(pending.userId, pending.email)
		await this.endSessions(pending.userId)
		return { ok: true, userId: pending.userId }
	}

	/**
	 * Change the password of a signed-in user who knows the current one. Pending reset
	 * links stop working and every session of the account ends; the built-in route then
	 * signs the calling device in again.
	 */
	async change(
		userId: string,
		currentPassword: unknown,
		newPassword: unknown,
		stillAuthorized?: () => Promise<boolean>,
	): Promise<PasswordChangeResult> {
		const changed = await changeUserPassword(
			this.userStore,
			userId,
			currentPassword,
			newPassword,
			stillAuthorized,
		)
		if (!changed.ok) return changed
		await this.passwordChanged(userId)
		return changed
	}

	/**
	 * After a password changed outside this manager: pending reset links stop working (one
	 * sent before the change must not undo it) and every session of the account ends.
	 */
	async passwordChanged(userId: string): Promise<void> {
		await this.store.deleteForUser(userId)
		await this.endSessions(userId)
	}

	/** Every credential issued before now stops working (AUTH-7b). */
	private async endSessions(userId: string): Promise<void> {
		if (this.config.onPasswordChanged) {
			await this.config.onPasswordChanged(userId)
			return
		}
		const revocations = this.userStore.getTokenRevocationStore?.()
		if (revocations) {
			await revocations.revokeAllForUser(userId, Date.now())
			return
		}
		console.warn(
			'[kora] Password changed but earlier sessions could not be ended: the user store has no ' +
				'getTokenRevocationStore() and no onPasswordChanged hook is configured.',
		)
	}
}

/**
 * Replace the password of `userId` after checking the current one. Only the password
 * changes: ending sessions and reset links is the caller's (see
 * {@link PasswordResetManager.change}).
 *
 * @throws KoraError `PASSWORD_CHANGE_STORE_UNSUPPORTED` when the store has no
 *   `updatePasswordIf` (the built-in stores have it)
 */
export async function changeUserPassword(
	userStore: UserStore,
	userId: string,
	currentPassword: unknown,
	newPassword: unknown,
	stillAuthorized?: () => Promise<boolean>,
): Promise<PasswordChangeResult> {
	const set = userStore.updatePasswordIf
	if (typeof set !== 'function') {
		throw new KoraError(
			'Changing a password needs a UserStore with updatePasswordIf(userId, condition, hash, salt), ' +
				'so a change never overwrites a password set meanwhile. The built-in stores have it.',
			'PASSWORD_CHANGE_STORE_UNSUPPORTED',
		)
	}
	const invalid = passwordProblem(newPassword)
	if (invalid) return { ok: false, code: invalid }
	const user = await userStore.findById(userId)
	if (!user) return { ok: false, code: 'USER_NOT_FOUND' }
	if (
		typeof currentPassword !== 'string' ||
		!user.passwordHash ||
		!(await verifyPassword(currentPassword, user.passwordHash, user.salt))
	) {
		return { ok: false, code: 'CURRENT_PASSWORD_INCORRECT' }
	}
	const hashed = await hashPassword(newPassword as string)
	// Both KDFs above are slow: a session revoked meanwhile changes nothing. Checked right
	// before the write, which is the last step.
	if (stillAuthorized && !(await stillAuthorized())) return { ok: false, code: 'SESSION_ENDED' }
	// Only over the password just checked: a reset or another change that landed meanwhile wins.
	const updated = await set.call(
		userStore,
		userId,
		{ passwordHash: user.passwordHash },
		hashed.hash,
		hashed.salt,
	)
	if (!updated) return { ok: false, code: 'CURRENT_PASSWORD_INCORRECT' }
	return { ok: true }
}

/** Why `password` is not acceptable (the sign-up bounds), or null. */
export function passwordProblem(
	password: unknown,
): 'PASSWORD_TOO_SHORT' | 'PASSWORD_TOO_LONG' | null {
	if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
		return 'PASSWORD_TOO_SHORT'
	}
	return password.length > MAX_PASSWORD_LENGTH ? 'PASSWORD_TOO_LONG' : null
}
