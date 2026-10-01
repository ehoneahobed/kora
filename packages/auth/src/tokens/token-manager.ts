import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import type { AuthTokens, DeviceCredentialPayload, TokenPayload } from '../types'
import {
	DEFAULT_ACCESS_TOKEN_LIFETIME,
	DEFAULT_DEVICE_CREDENTIAL_LIFETIME,
	DEFAULT_REFRESH_TOKEN_LIFETIME,
} from '../types'
import { encodeJwt, isExpired, verifyJwt } from './jwt'

/**
 * Minimum HMAC secret length in bytes. A 256-bit key provides full security
 * for HMAC-SHA256 (NIST SP 800-107). Shorter keys weaken the MAC and are
 * vulnerable to brute-force attacks.
 */
const MIN_SECRET_LENGTH = 32

/**
 * Default window during which a just-rotated refresh token may be presented
 * once more and receive the SAME successor pair (NEW-AUTH-3). Covers a rotation
 * response lost on a flaky network without opening a long replay window.
 */
export const DEFAULT_REFRESH_REUSE_GRACE_MS = 30_000

/** Result of an atomic {@link TokenRevocationStore.consume}. */
export interface ConsumeResult {
	/** True only for the single call that consumed the id first. */
	firstUse: boolean
	/** When the id was first consumed (milliseconds since epoch). */
	consumedAt: number
}

/**
 * Interface for server-side token revocation storage.
 *
 * Implementing this interface allows the TokenManager to:
 * - Revoke individual tokens (and token families) by id
 * - Rotate refresh tokens atomically (each refresh token mints at most one successor)
 * - Invalidate every credential a device or a user obtained before a point in time
 *
 * Shipped implementations: {@link InMemoryTokenRevocationStore} (development),
 * `SqliteTokenRevocationStore` and `PostgresTokenRevocationStore`. The SQLite and
 * Postgres user stores expose one sharing their database through
 * `getTokenRevocationStore()`, which `createKoraAuthServer` uses by default.
 */
export interface TokenRevocationStore {
	/**
	 * Check whether a token (or token family, keyed `family:<id>`) has been revoked.
	 * @param jti - The JWT ID (or family key) to check
	 */
	isRevoked(jti: string): Promise<boolean>

	/**
	 * Revoke a specific token (or token family) by id.
	 * @param jti - The JWT ID (or family key) to revoke
	 * @param expiresAt - Expiry in seconds since epoch; the store may purge after it
	 */
	revoke(jti: string, expiresAt: number): Promise<void>

	/**
	 * Atomically mark an id as consumed (test-and-set). Exactly one concurrent
	 * caller observes `firstUse: true`, on every instance sharing the store.
	 * @param jti - The id to consume
	 * @param expiresAt - Expiry in seconds since epoch; the store may purge after it
	 */
	consume(jti: string, expiresAt: number): Promise<ConsumeResult>

	/** Whether an id has been consumed (read-only; never consumes). */
	isConsumed(jti: string): Promise<boolean>

	/**
	 * Reject every token for a device issued at or before `before` (ms). Later
	 * tokens (a fresh sign-in on the same device) stay valid. Monotonic: a
	 * smaller `before` never lowers an existing cut-off.
	 */
	revokeAllForDevice(deviceId: string, before?: number): Promise<void>

	/** Cut-off (ms) recorded by {@link revokeAllForDevice}, or null. */
	getDeviceRevokedBefore(deviceId: string): Promise<number | null>

	/**
	 * Reject every token for a user issued at or before `before` (ms). Used by
	 * password reset and change, admin session revocation and user deletion.
	 */
	revokeAllForUser(userId: string, before?: number): Promise<void>

	/** Cut-off (ms) recorded by {@link revokeAllForUser}, or null. */
	getUserRevokedBefore(userId: string): Promise<number | null>
}

/**
 * In-memory token revocation store.
 *
 * Suitable for development and testing. Revocations are lost on restart and not
 * shared across instances, so `createKoraAuthServer` refuses it in production
 * unless `allowInMemory: true` is set.
 */
export class InMemoryTokenRevocationStore implements TokenRevocationStore {
	private readonly revokedTokens = new Map<string, number>()
	private readonly consumed = new Map<string, { consumedAt: number; expiresAt: number }>()
	private readonly deviceCutoffs = new Map<string, number>()
	private readonly userCutoffs = new Map<string, number>()

	async isRevoked(jti: string): Promise<boolean> {
		return this.revokedTokens.has(jti)
	}

	async revoke(jti: string, expiresAt: number): Promise<void> {
		this.revokedTokens.set(jti, expiresAt)
	}

	async consume(jti: string, expiresAt: number): Promise<ConsumeResult> {
		// Single-threaded: the check and the set happen in one synchronous step.
		const existing = this.consumed.get(jti)
		if (existing) return { firstUse: false, consumedAt: existing.consumedAt }
		const consumedAt = Date.now()
		this.consumed.set(jti, { consumedAt, expiresAt })
		return { firstUse: true, consumedAt }
	}

	async isConsumed(jti: string): Promise<boolean> {
		return this.consumed.has(jti)
	}

	async revokeAllForDevice(deviceId: string, before: number = Date.now()): Promise<void> {
		this.deviceCutoffs.set(deviceId, Math.max(this.deviceCutoffs.get(deviceId) ?? 0, before))
	}

	async getDeviceRevokedBefore(deviceId: string): Promise<number | null> {
		return this.deviceCutoffs.get(deviceId) ?? null
	}

	async revokeAllForUser(userId: string, before: number = Date.now()): Promise<void> {
		this.userCutoffs.set(userId, Math.max(this.userCutoffs.get(userId) ?? 0, before))
	}

	async getUserRevokedBefore(userId: string): Promise<number | null> {
		return this.userCutoffs.get(userId) ?? null
	}

	/**
	 * Remove expired revocations to prevent unbounded memory growth.
	 * Call periodically (e.g., every hour) in long-running servers.
	 */
	cleanup(): void {
		const nowSeconds = Math.floor(Date.now() / 1000)
		for (const [jti, expiresAt] of this.revokedTokens) {
			if (nowSeconds > expiresAt) this.revokedTokens.delete(jti)
		}
		for (const [jti, entry] of this.consumed) {
			if (nowSeconds > entry.expiresAt) this.consumed.delete(jti)
		}
	}
}

/**
 * Configuration for the server-side TokenManager.
 */
export interface TokenManagerConfig {
	/**
	 * Secret key for signing JWTs (HMAC-SHA256).
	 *
	 * Must be at least 32 characters (256 bits). Use {@link TokenManager.generateSecret}
	 * to create a cryptographically random secret.
	 *
	 * For key rotation, provide an array of secrets. The first secret is used for
	 * signing new tokens; all secrets are tried during verification (newest first).
	 */
	secret: string | string[]

	/** Access token lifetime in milliseconds (default: 15 minutes) */
	accessTokenLifetime?: number

	/** Refresh token lifetime in milliseconds (default: 90 days) */
	refreshTokenLifetime?: number

	/** Device credential lifetime in milliseconds (default: 90 days) */
	deviceCredentialLifetime?: number

	/**
	 * Optional token revocation store. When provided, enables revocation,
	 * atomic refresh rotation with reuse detection, and device/user cut-offs.
	 * Without a revocation store, tokens are valid until they expire.
	 */
	revocationStore?: TokenRevocationStore

	/**
	 * Window (ms) during which a just-rotated refresh token is accepted ONCE more
	 * and returns the same successor pair. Set 0 to disable. Default 30 seconds.
	 */
	refreshReuseGraceMs?: number
}

/** Options for minting a token set. */
export interface IssueTokenOptions {
	/** Refresh-token family to continue. A new family is started when omitted. */
	family?: string
	/** Authentication methods (RFC 8176) to record, for example `['pwd', 'otp']`. */
	amr?: string[]
}

/** Why a refresh was refused. */
export type RefreshFailureReason =
	| 'invalid'
	| 'revoked'
	| 'reused'
	| 'in_progress'
	| 'device_revoked'
	| 'user_revoked'

/** Outcome of {@link TokenManager.rotateRefreshToken}. */
export type RefreshResult =
	| {
			ok: true
			tokens: { accessToken: string; refreshToken: string }
			/** The verified payload of the refresh token that was presented. */
			payload: TokenPayload
			/** True when this was the one grace replay of a just-rotated token. */
			replayed: boolean
	  }
	| { ok: false; reason: RefreshFailureReason }

/**
 * Server-side token manager responsible for issuing, refreshing, and validating
 * Kora authentication tokens.
 *
 * Uses HMAC-SHA256 signed JWTs with unique `jti` identifiers for every token.
 * Supports key rotation (multiple secrets), token revocation, token families and
 * atomic, rotation-safe refresh.
 *
 * @example
 * ```typescript
 * const tokenManager = new TokenManager({
 *   secret: TokenManager.generateSecret(),
 *   revocationStore: new InMemoryTokenRevocationStore(),
 * })
 *
 * const tokens = tokenManager.issueTokens('user-123', 'device-456')
 * const payload = await tokenManager.validateTokenWithRevocation(tokens.accessToken)
 * const next = await tokenManager.rotateRefreshToken(tokens.refreshToken)
 * ```
 */
export class TokenManager {
	/** All signing/verification secrets (index 0 = current signing key) */
	private readonly secrets: string[]
	private readonly accessTokenLifetime: number
	private readonly refreshTokenLifetime: number
	private readonly deviceCredentialLifetime: number
	private readonly revocationStore: TokenRevocationStore | undefined
	private readonly refreshReuseGraceMs: number
	/** Refresh jtis whose rotation is executing on this instance right now. */
	private readonly rotating = new Set<string>()

	constructor(config: TokenManagerConfig) {
		const secrets = Array.isArray(config.secret) ? config.secret : [config.secret]

		if (secrets.length === 0) {
			throw new Error('TokenManager requires at least one secret.')
		}

		for (const secret of secrets) {
			if (secret.length < MIN_SECRET_LENGTH) {
				throw new Error(
					`JWT secret must be at least ${MIN_SECRET_LENGTH} characters (256 bits) for HMAC-SHA256 security. ` +
						`Received ${secret.length} characters. Use TokenManager.generateSecret() to generate a secure secret.`,
				)
			}
		}

		this.secrets = secrets
		this.accessTokenLifetime = config.accessTokenLifetime ?? DEFAULT_ACCESS_TOKEN_LIFETIME
		this.refreshTokenLifetime = config.refreshTokenLifetime ?? DEFAULT_REFRESH_TOKEN_LIFETIME
		this.deviceCredentialLifetime =
			config.deviceCredentialLifetime ?? DEFAULT_DEVICE_CREDENTIAL_LIFETIME
		this.revocationStore = config.revocationStore
		this.refreshReuseGraceMs = config.refreshReuseGraceMs ?? DEFAULT_REFRESH_REUSE_GRACE_MS
	}

	/**
	 * Generate a cryptographically random secret suitable for HMAC-SHA256 signing.
	 *
	 * @returns A random 256-bit hex-encoded secret
	 */
	static generateSecret(): string {
		return randomBytes(32).toString('hex')
	}

	/** The revocation store this manager enforces, if any. */
	getRevocationStore(): TokenRevocationStore | undefined {
		return this.revocationStore
	}

	/**
	 * Issue a signed JWT access token.
	 *
	 * @param userId - The subject (user ID) to encode in the token
	 * @param deviceId - The device ID of the requesting device
	 * @param options - Family and authentication methods to record
	 * @returns A signed JWT string with type 'access'
	 */
	issueAccessToken(userId: string, deviceId: string, options: IssueTokenOptions = {}): string {
		const nowMs = Date.now()
		return this.sign(
			this.basePayload({
				jti: randomUUID(),
				sub: userId,
				dev: deviceId,
				type: 'access',
				iatMs: nowMs,
				lifetimeMs: this.accessTokenLifetime,
				family: options.family,
				amr: options.amr,
			}),
		)
	}

	/**
	 * Issue a signed JWT refresh token.
	 *
	 * @param userId - The subject (user ID) to encode in the token
	 * @param deviceId - The device ID of the requesting device
	 * @param options - Family and authentication methods to record
	 * @returns A signed JWT string with type 'refresh'
	 */
	issueRefreshToken(userId: string, deviceId: string, options: IssueTokenOptions = {}): string {
		const nowMs = Date.now()
		return this.sign(
			this.basePayload({
				jti: randomUUID(),
				sub: userId,
				dev: deviceId,
				type: 'refresh',
				iatMs: nowMs,
				lifetimeMs: this.refreshTokenLifetime,
				family: options.family ?? randomUUID(),
				amr: options.amr,
			}),
		)
	}

	/**
	 * Issue a signed device credential token bound to a device's public key.
	 *
	 * @param userId - The subject (user ID) to encode in the token
	 * @param deviceId - The device ID of the requesting device
	 * @param publicKeyThumbprint - SHA-256 thumbprint of the device's public key
	 * @returns A signed JWT string with type 'device_credential'
	 */
	issueDeviceCredential(userId: string, deviceId: string, publicKeyThumbprint: string): string {
		const nowMs = Date.now()
		const nowSeconds = Math.floor(nowMs / 1000)
		const lifetimeSeconds = Math.floor(this.deviceCredentialLifetime / 1000)
		const payload: DeviceCredentialPayload = {
			jti: randomUUID(),
			sub: userId,
			dev: deviceId,
			type: 'device_credential',
			iat: nowSeconds,
			exp: nowSeconds + lifetimeSeconds,
			iatMs: nowMs,
			dpk: publicKeyThumbprint,
			mustCheckinBy: nowSeconds + lifetimeSeconds,
		}
		return encodeJwt(payload as unknown as Record<string, unknown>, this.secrets[0] as string)
	}

	/**
	 * Issue a complete set of authentication tokens for a new session. The access
	 * and refresh token share a fresh family id.
	 *
	 * @param userId - The subject (user ID) to encode in the tokens
	 * @param deviceId - The device ID of the requesting device
	 * @param publicKeyThumbprint - Optional device key thumbprint; adds a device credential
	 * @param options - Authentication methods to record
	 * @returns An {@link AuthTokens} object containing the issued tokens
	 */
	issueTokens(
		userId: string,
		deviceId: string,
		publicKeyThumbprint?: string,
		options: Omit<IssueTokenOptions, 'family'> = {},
	): AuthTokens {
		const family = randomUUID()
		const tokens: AuthTokens = {
			accessToken: this.issueAccessToken(userId, deviceId, { family, amr: options.amr }),
			refreshToken: this.issueRefreshToken(userId, deviceId, { family, amr: options.amr }),
		}

		if (publicKeyThumbprint !== undefined) {
			tokens.deviceCredential = this.issueDeviceCredential(userId, deviceId, publicKeyThumbprint)
		}

		return tokens
	}

	/**
	 * Validate and decode a token's signature, expiry and claims.
	 *
	 * This does NOT consult revocation. Every request-authorization path must use
	 * {@link validateTokenWithRevocation} (or `BuiltInAuthRoutes.authenticateAccess`).
	 *
	 * @param token - The JWT string to validate
	 * @returns The decoded {@link TokenPayload}, or null if invalid or expired
	 */
	validateToken(token: string): TokenPayload | null {
		const decoded = this.verifySignature(token)
		if (decoded === null) {
			return null
		}

		// verifyJwt validates the signature but not expiration; a token without a
		// numeric exp is rejected by the claim check below.
		if (isExpired(decoded as { exp?: number })) {
			return null
		}

		if (
			typeof decoded.jti !== 'string' ||
			typeof decoded.sub !== 'string' ||
			typeof decoded.dev !== 'string' ||
			typeof decoded.type !== 'string' ||
			typeof decoded.iat !== 'number' ||
			typeof decoded.exp !== 'number'
		) {
			return null
		}

		const type = decoded.type
		if (type !== 'access' && type !== 'refresh' && type !== 'device_credential') {
			return null
		}

		const payload: TokenPayload = {
			jti: decoded.jti,
			sub: decoded.sub,
			dev: decoded.dev,
			type,
			iat: decoded.iat,
			exp: decoded.exp,
		}
		if (typeof decoded.fam === 'string') payload.fam = decoded.fam
		if (typeof decoded.iatMs === 'number') payload.iatMs = decoded.iatMs
		if (Array.isArray(decoded.amr) && decoded.amr.every((m) => typeof m === 'string')) {
			payload.amr = decoded.amr as string[]
		}
		return payload
	}

	/**
	 * Validate a token and check every revocation primitive: the token's own
	 * `jti`, its family, the device cut-off and the per-user cut-off.
	 *
	 * @param token - The JWT string to validate
	 * @returns The decoded {@link TokenPayload} if valid and not revoked, or null otherwise
	 */
	async validateTokenWithRevocation(token: string): Promise<TokenPayload | null> {
		const payload = this.validateToken(token)
		if (payload === null) {
			return null
		}
		return (await this.revocationReason(payload)) === null ? payload : null
	}

	/**
	 * Why an otherwise valid token is no longer accepted, or null when it is.
	 */
	async revocationReason(
		payload: TokenPayload,
	): Promise<'revoked' | 'device_revoked' | 'user_revoked' | null> {
		const store = this.revocationStore
		if (!store) return null
		if (await store.isRevoked(payload.jti)) return 'revoked'
		if (payload.fam && (await store.isRevoked(familyKey(payload.fam)))) return 'revoked'
		const issuedAt = issuedAtMs(payload)
		const deviceCutoff = await store.getDeviceRevokedBefore(payload.dev)
		if (deviceCutoff !== null && issuedAt <= deviceCutoff) return 'device_revoked'
		const userCutoff = await store.getUserRevokedBefore(payload.sub)
		if (userCutoff !== null && issuedAt <= userCutoff) return 'user_revoked'
		return null
	}

	/**
	 * Revoke a specific token by its JWT ID.
	 *
	 * @param jti - The JWT ID of the token to revoke
	 * @param expiresAt - The token's expiration time (seconds since epoch)
	 */
	async revokeToken(jti: string, expiresAt: number): Promise<void> {
		if (this.revocationStore) {
			await this.revocationStore.revoke(jti, expiresAt)
		}
	}

	/**
	 * Revoke a whole refresh-token family (one sign-in and all its rotations,
	 * including the access tokens minted along the way).
	 *
	 * @param family - The family id (`fam` claim)
	 * @param expiresAt - Latest expiry of any token in the family (seconds since epoch)
	 */
	async revokeFamily(family: string, expiresAt: number): Promise<void> {
		if (this.revocationStore) {
			await this.revocationStore.revoke(familyKey(family), expiresAt)
		}
	}

	/**
	 * Revoke every token issued to a device up to now. A later sign-in on the
	 * same device issues tokens that are accepted again.
	 *
	 * @param deviceId - The device ID whose tokens should be revoked
	 */
	async revokeDeviceTokens(deviceId: string): Promise<void> {
		if (this.revocationStore) {
			await this.revocationStore.revokeAllForDevice(deviceId, Date.now())
		}
	}

	/**
	 * Revoke every token issued to a user up to now (password reset or change,
	 * admin session revocation, account deletion).
	 *
	 * @param userId - The user whose credentials should be revoked
	 */
	async revokeAllForUser(userId: string): Promise<void> {
		if (this.revocationStore) {
			await this.revocationStore.revokeAllForUser(userId, Date.now())
		}
	}

	/**
	 * Rotate a refresh token: atomically consume it and mint its successor pair.
	 *
	 * - Each refresh `jti` mints at most one successor family member (AUTH-6).
	 * - A concurrent duplicate on this instance gets `in_progress` (retry later).
	 * - Within the grace window, presenting a just-rotated token ONCE more returns
	 *   the SAME successor pair, so a response lost on the wire does not sign the
	 *   user out (NEW-AUTH-3).
	 * - Any other reuse revokes the token FAMILY, never the device (NEW-AUTH-1).
	 *
	 * @param refreshToken - The refresh token JWT string
	 * @returns The successor pair, or the reason the refresh was refused
	 */
	async rotateRefreshToken(refreshToken: string): Promise<RefreshResult> {
		const payload = this.validateToken(refreshToken)
		if (payload === null || payload.type !== 'refresh') {
			return { ok: false, reason: 'invalid' }
		}
		// Checked and set before the first await, so a same-instance duplicate
		// that arrives while this rotation is still running is told to retry
		// instead of being mistaken for a replay.
		if (this.rotating.has(payload.jti)) {
			return { ok: false, reason: 'in_progress' }
		}
		this.rotating.add(payload.jti)
		try {
			return await this.rotate(payload)
		} finally {
			this.rotating.delete(payload.jti)
		}
	}

	/**
	 * Refresh an access token using a valid refresh token.
	 *
	 * Convenience wrapper over {@link rotateRefreshToken} that collapses every
	 * failure to null. HTTP handlers should use `rotateRefreshToken` so they can
	 * tell a client to retry (`in_progress`) instead of signing it out.
	 *
	 * @param refreshToken - The refresh token JWT string
	 * @returns A new access/refresh token pair, or null if the refresh was refused
	 */
	async refreshAccessToken(
		refreshToken: string,
	): Promise<{ accessToken: string; refreshToken: string } | null> {
		const result = await this.rotateRefreshToken(refreshToken)
		return result.ok ? result.tokens : null
	}

	private async rotate(payload: TokenPayload): Promise<RefreshResult> {
		const store = this.revocationStore
		const successor = (consumedAt: number): { accessToken: string; refreshToken: string } =>
			this.successorTokens(payload, consumedAt)
		if (!store) {
			return { ok: true, tokens: successor(Date.now()), payload, replayed: false }
		}

		const reason = await this.revocationReason(payload)
		if (reason !== null) {
			return { ok: false, reason }
		}

		const consumed = await store.consume(payload.jti, payload.exp)
		if (consumed.firstUse) {
			return { ok: true, tokens: successor(consumed.consumedAt), payload, replayed: false }
		}

		const family = payload.fam ?? payload.jti
		const withinGrace =
			this.refreshReuseGraceMs > 0 && Date.now() - consumed.consumedAt <= this.refreshReuseGraceMs
		if (withinGrace) {
			const successorRefreshJti = this.deriveJti('refresh', payload.jti)
			// Once the client has used the successor it clearly received it, so a
			// replay of the parent can no longer be a lost response.
			const successorSpent =
				(await store.isRevoked(successorRefreshJti)) ||
				(await store.isConsumed(successorRefreshJti))
			const grace = await store.consume(graceKey(payload.jti), payload.exp)
			if (grace.firstUse && !successorSpent) {
				return { ok: true, tokens: successor(consumed.consumedAt), payload, replayed: true }
			}
		}

		// A consumed token presented again outside the one grace replay: treat the
		// family as compromised. Other sign-ins on the same device are unaffected.
		await this.revokeFamily(family, payload.exp)
		return { ok: false, reason: 'reused' }
	}

	/**
	 * Deterministically mint the successor pair of a refresh token. The jtis and
	 * issue time derive from the consumed token and its consumption time, so a
	 * grace replay re-signs byte-identical tokens without storing them.
	 */
	private successorTokens(
		payload: TokenPayload,
		consumedAtMs: number,
	): { accessToken: string; refreshToken: string } {
		const family = payload.fam ?? payload.jti
		return {
			accessToken: this.sign(
				this.basePayload({
					jti: this.deriveJti('access', payload.jti),
					sub: payload.sub,
					dev: payload.dev,
					type: 'access',
					iatMs: consumedAtMs,
					lifetimeMs: this.accessTokenLifetime,
					family,
					amr: payload.amr,
				}),
			),
			refreshToken: this.sign(
				this.basePayload({
					jti: this.deriveJti('refresh', payload.jti),
					sub: payload.sub,
					dev: payload.dev,
					type: 'refresh',
					iatMs: consumedAtMs,
					lifetimeMs: this.refreshTokenLifetime,
					family,
					amr: payload.amr,
				}),
			),
		}
	}

	private deriveJti(kind: 'access' | 'refresh', parentJti: string): string {
		const digest = createHmac('sha256', this.secrets[0] as string)
			.update(`kora-rotation:${kind}:${parentJti}`)
			.digest('hex')
		// Format as a UUID-shaped string so stores sized for UUIDs keep working.
		return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`
	}

	private basePayload(input: {
		jti: string
		sub: string
		dev: string
		type: 'access' | 'refresh'
		iatMs: number
		lifetimeMs: number
		family?: string
		amr?: string[]
	}): TokenPayload {
		const iat = Math.floor(input.iatMs / 1000)
		// Field order is fixed so a deterministic re-issue is byte-identical.
		const payload: TokenPayload = {
			jti: input.jti,
			sub: input.sub,
			dev: input.dev,
			type: input.type,
			iat,
			exp: iat + Math.floor(input.lifetimeMs / 1000),
			iatMs: input.iatMs,
		}
		if (input.family) payload.fam = input.family
		if (input.amr && input.amr.length > 0) payload.amr = [...input.amr]
		return payload
	}

	private sign(payload: TokenPayload): string {
		return encodeJwt(payload as unknown as Record<string, unknown>, this.secrets[0] as string)
	}

	private verifySignature(token: string): Record<string, unknown> | null {
		for (const secret of this.secrets) {
			const decoded = verifyJwt(token, secret)
			if (decoded !== null) return decoded
		}
		return null
	}
}

function familyKey(family: string): string {
	return `family:${family}`
}

function graceKey(jti: string): string {
	return `grace:${jti}`
}

/**
 * Issue time in ms. Tokens minted before beta.13 only carry second-resolution
 * `iat`; treat them as issued at the START of that second so a revocation made
 * later within the same second still covers them (fail closed).
 */
function issuedAtMs(payload: TokenPayload): number {
	return payload.iatMs ?? payload.iat * 1000
}
