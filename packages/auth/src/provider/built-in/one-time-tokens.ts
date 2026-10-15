/**
 * Single-use emailed tokens (email verification, password reset): what is kept for each
 * one and the stores that keep them. Only the SHA-256 of a token is stored; the token
 * itself exists in the email and nowhere else.
 */

/** A pending emailed token: who it was sent to and until when. */
export interface OneTimeToken {
	/** SHA-256 (hex) of the token. */
	tokenHash: string
	/** The user it was sent for. */
	userId: string
	/** The address it was sent to (lower-cased). It works only while the account still has it. */
	email: string
	/** When it was sent (ms since epoch). */
	createdAt: number
	/** When it stops working (ms since epoch). */
	expiresAt: number
}

/**
 * Where pending tokens of one kind are kept, with a per-user send counter. The SQLite and
 * Postgres user stores provide them in the same database as the users.
 */
export interface OneTimeTokenStore {
	/** Keep a pending token. */
	store(token: OneTimeToken): Promise<void>
	/**
	 * Remove and return the pending token with this hash (only if it belongs to `userId`,
	 * when given), atomically: of two concurrent takes of one token, only one receives it,
	 * and a take for another user leaves it in place.
	 */
	take(tokenHash: string, userId?: string): Promise<OneTimeToken | null>
	/** The pending token with this hash, without removing it. */
	get(tokenHash: string): Promise<OneTimeToken | null>
	/**
	 * Count one send for `userId` and return how many this window holds, including it.
	 * Atomic: concurrent sends each get a distinct count, so a limit on the result holds.
	 * A window lasts `windowMs` from its first send.
	 */
	countSend(userId: string, now: number, windowMs: number): Promise<number>
	/** Remove every pending token and the send count of `userId`. */
	deleteForUser(userId: string): Promise<void>
	/** Remove tokens that expired before `now`. Returns how many. */
	deleteExpired(now: number): Promise<number>
}

/** In-memory pending tokens, for development and tests. Lost on restart. */
export class InMemoryOneTimeTokenStore implements OneTimeTokenStore {
	/** Marks a store that keeps nothing across restarts (production refuses it). */
	readonly inMemory = true
	private readonly tokens = new Map<string, OneTimeToken>()
	private readonly sends = new Map<string, { windowStart: number; count: number }>()

	async store(token: OneTimeToken): Promise<void> {
		this.tokens.set(token.tokenHash, { ...token })
	}

	async take(tokenHash: string, userId?: string): Promise<OneTimeToken | null> {
		const token = this.tokens.get(tokenHash) ?? null
		if (!token || (userId !== undefined && token.userId !== userId)) return null
		this.tokens.delete(tokenHash)
		return token
	}

	async get(tokenHash: string): Promise<OneTimeToken | null> {
		const token = this.tokens.get(tokenHash)
		return token ? { ...token } : null
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

/** The tables a SQL token store uses. Internal names only: they are written into SQL. */
export interface OneTimeTokenTables {
	tokens: string
	sends: string
}

/** Verification tables (`auth_email_verifications`, `auth_email_verification_sends`). */
export const EMAIL_VERIFICATION_TABLES: OneTimeTokenTables = {
	tokens: 'auth_email_verifications',
	sends: 'auth_email_verification_sends',
}

/** Password reset tables (`auth_password_resets`, `auth_password_reset_sends`). */
export const PASSWORD_RESET_TABLES: OneTimeTokenTables = {
	tokens: 'auth_password_resets',
	sends: 'auth_password_reset_sends',
}

/** Refuses a table name that is not a plain identifier (they are interpolated into SQL). */
export function assertTableNames(tables: OneTimeTokenTables): void {
	for (const name of [tables.tokens, tables.sends]) {
		if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new TypeError(`Invalid table name "${name}"`)
	}
}

/** 32 random bytes, base64url. */
export function randomToken(): string {
	const bytes = new Uint8Array(32)
	globalThis.crypto.getRandomValues(bytes)
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** SHA-256 of `value`, hex. */
export async function sha256Hex(value: string): Promise<string> {
	const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
