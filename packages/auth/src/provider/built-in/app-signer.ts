import { createHmac, timingSafeEqual } from 'node:crypto'
import { KoraError } from '@korajs/core'

/**
 * Signs small values an app hands out and reads back later: share links, invitation links,
 * unsubscribe links, short-lived grants. Created from the same secret as sign-in (usually
 * `authSecretFromEnv()`), so changing that secret keeps working: values are signed with the
 * current secret and accepted when signed with any earlier one still listed.
 */
export interface AppSigner {
	/**
	 * Signs a JSON value. The value is readable by whoever holds the token (it is signed, not
	 * encrypted), so put identifiers in it, never secrets.
	 */
	sign(value: unknown, options?: AppSignOptions): string
	/**
	 * The signed value, or null when the token was not made by this signer for this purpose, was
	 * changed, or has expired. Never throws for a bad token: anything a visitor sends is untrusted.
	 */
	verify<T = unknown>(token: string, options?: AppVerifyOptions): T | null
}

export interface AppSignOptions {
	/** The token stops verifying after this many seconds. */
	readonly expiresInSeconds?: number
	/** Milliseconds since the epoch; defaults to now. For tests. */
	readonly now?: number
}

export interface AppVerifyOptions {
	/** Milliseconds since the epoch; defaults to now. For tests. */
	readonly now?: number
}

/** Thrown at creation or signing for a mistake in the app's code, never for a visitor's token. */
export class AppSignerError extends KoraError {
	constructor(message: string) {
		super(message, 'APP_SIGNER_INVALID')
		this.name = 'AppSignerError'
	}
}

const PURPOSE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
/** Tokens travel in URLs; past this, something other than a small value is being signed. */
const MAX_TOKEN_LENGTH = 8192

/**
 * Creates a signer for one purpose. Each purpose gets its own key, derived from the secret, so a
 * token made for one purpose (say `share-link`) is refused by another (say `invite`), and none
 * of them is ever accepted as a session.
 *
 * @param secret - The sign-in secret, or a list whose first entry is current and the rest still
 *   accepted. `authSecretFromEnv()` returns exactly this.
 * @param purpose - A short name for what the tokens are for, such as `share-link`.
 *
 * @example
 * ```typescript
 * import { authSecretFromEnv, createAppSigner } from '@korajs/auth/server'
 *
 * const shareLinks = createAppSigner(authSecretFromEnv() ?? 'dev-secret', 'share-link')
 * const token = shareLinks.sign({ documentId }, { expiresInSeconds: 7 * 24 * 3600 })
 * const grant = shareLinks.verify<{ documentId: string }>(token) // null when forged or expired
 * ```
 */
export function createAppSigner(secret: string | readonly string[], purpose: string): AppSigner {
	const secrets = (typeof secret === 'string' ? [secret] : [...secret]).filter(
		(entry) => typeof entry === 'string' && entry.length > 0,
	)
	if (secrets.length === 0)
		throw new AppSignerError('createAppSigner needs a secret: pass authSecretFromEnv().')
	if (!PURPOSE.test(purpose)) {
		throw new AppSignerError(
			`createAppSigner purpose "${purpose}" must be 1-64 letters, digits, dots, colons, dashes or underscores.`,
		)
	}
	const keys = secrets.map((entry) =>
		createHmac('sha256', entry).update(`kora-app-signer:v1:${purpose}`).digest(),
	)
	const mac = (key: Buffer, body: string): Buffer => createHmac('sha256', key).update(body).digest()

	return {
		sign(value, options = {}) {
			const now = options.now ?? Date.now()
			const expiresIn = options.expiresInSeconds
			if (expiresIn !== undefined && !(Number.isFinite(expiresIn) && expiresIn > 0)) {
				throw new AppSignerError('expiresInSeconds must be a positive number of seconds.')
			}
			let json: string | undefined
			try {
				json = JSON.stringify({
					v: value,
					...(expiresIn === undefined ? {} : { e: now + expiresIn * 1000 }),
				})
			} catch {
				json = undefined
			}
			if (json === undefined || value === undefined)
				throw new AppSignerError('Only JSON values can be signed.')
			const body = Buffer.from(json).toString('base64url')
			const [current] = keys
			if (!current)
				throw new AppSignerError('createAppSigner needs a secret: pass authSecretFromEnv().')
			const token = `${body}.${mac(current, body).toString('base64url')}`
			if (token.length > MAX_TOKEN_LENGTH)
				throw new AppSignerError('The signed value is too large for a link; sign an id instead.')
			return token
		},
		verify<T>(token: string, options: AppVerifyOptions = {}): T | null {
			if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) return null
			const dot = token.indexOf('.')
			if (dot <= 0 || dot !== token.lastIndexOf('.')) return null
			const body = token.slice(0, dot)
			const given = Buffer.from(token.slice(dot + 1), 'base64url')
			// Every key is checked, so how long this takes doesn't tell which secret signed it.
			let matched = false
			for (const key of keys) {
				const expected = mac(key, body)
				if (given.length === expected.length && timingSafeEqual(given, expected)) matched = true
			}
			if (!matched) return null
			let payload: unknown
			try {
				payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
			} catch {
				return null
			}
			if (typeof payload !== 'object' || payload === null || !('v' in payload)) return null
			const expiresAt = (payload as { e?: unknown }).e
			if (
				expiresAt !== undefined &&
				(typeof expiresAt !== 'number' || expiresAt <= (options.now ?? Date.now()))
			)
				return null
			return (payload as { v: T }).v
		},
	}
}
