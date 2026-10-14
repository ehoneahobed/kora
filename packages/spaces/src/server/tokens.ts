import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** Invitation ids: `inv_` and 32 hex characters. */
const INVITATION_ID = /^inv_[0-9a-f]{32}$/
/** The random part of a token: 32 bytes, base64url. */
const TOKEN_SECRET = /^[A-Za-z0-9_-]{43}$/

/** Lower-cased and trimmed, so `Ann@Example.com ` and `ann@example.com` are one invitee. */
export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase()
}

/** A plausible address (one `@`, a dot in the domain, no spaces, at most 254 characters). */
export function isEmail(email: string): boolean {
	return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function sha256Hex(value: string): string {
	return createHash('sha256').update(value).digest('hex')
}

/**
 * The invitation id of `email` in `space`. Deterministic, so inviting the same address
 * again updates (re-sends) the pending invitation instead of adding a second one.
 */
export function invitationIdFor(spaceKey: string, email: string): string {
	return `inv_${sha256Hex(`${spaceKey}\u0000${email}`).slice(0, 32)}`
}

/** The id of the secret row that holds an invitation's token hash and inviter authority. */
export function secretIdFor(invitationId: string): string {
	return `sec_${invitationId.slice(4)}`
}

/**
 * A new invitation token: the invitation id and 32 random bytes. Only its SHA-256 is
 * stored; the token itself travels in the email (in a URL fragment) and nowhere else.
 */
export function newInvitationToken(invitationId: string): string {
	return `${invitationId}.${randomBytes(32).toString('base64url')}`
}

/** The stored form of a token. */
export function hashToken(token: string): string {
	return sha256Hex(token)
}

/** The invitation id a well-formed token names, or null. */
export function invitationIdOfToken(token: unknown): string | null {
	if (typeof token !== 'string' || token.length > 128) return null
	const dot = token.indexOf('.')
	if (dot === -1) return null
	const id = token.slice(0, dot)
	const secret = token.slice(dot + 1)
	return INVITATION_ID.test(id) && TOKEN_SECRET.test(secret) ? id : null
}

/** Constant-time comparison of a presented token with a stored hash. */
export function tokenMatches(token: string, storedHash: unknown): boolean {
	if (typeof storedHash !== 'string' || storedHash.length !== 64) return false
	const presented = Buffer.from(hashToken(token), 'hex')
	const stored = Buffer.from(storedHash, 'hex')
	return presented.length === stored.length && timingSafeEqual(presented, stored)
}

/** `jane@example.com` as `j***@example.com`: enough to recognize, not to harvest. */
export function emailHint(email: string): string {
	const at = email.lastIndexOf('@')
	if (at <= 0) return '***'
	return `${email[0]}***${email.slice(at)}`
}
