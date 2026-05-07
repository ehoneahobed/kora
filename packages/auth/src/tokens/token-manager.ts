import { randomBytes, randomUUID } from 'node:crypto'
import type {
	AuthTokens,
	DeviceCredentialPayload,
	TokenPayload,
} from '../types'
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
 * Interface for server-side token revocation storage.
 *
 * Implementing this interface allows the TokenManager to:
 * - Revoke individual tokens by their `jti`
 * - Detect refresh token reuse (potential theft indicator)
 * - Invalidate all tokens for a specific device on revocation
 *
 * The in-memory implementation ({@link InMemoryTokenRevocationStore}) is suitable
 * for development. Production deployments should use a persistent store (Redis, database).
 */
export interface TokenRevocationStore {
	/**
	 * Check whether a token has been revoked.
	 * @param jti - The JWT ID to check
	 * @returns true if the token has been revoked
	 */
	isRevoked(jti: string): Promise<boolean>

	/**
	 * Revoke a specific token by its JWT ID.
	 * @param jti - The JWT ID to revoke
	 * @param expiresAt - The token's original expiration time (seconds since epoch).
	 *   The store may use this to auto-purge expired revocations.
	 */
	revoke(jti: string, expiresAt: number): Promise<void>

	/**
	 * Revoke all tokens associated with a specific device.
	 * Called when a device is revoked to invalidate all its tokens.
	 * @param deviceId - The device ID whose tokens should be revoked
	 */
	revokeAllForDevice(deviceId: string): Promise<void>
}

/**
 * In-memory token revocation store.
 *
 * Suitable for development and testing. Revoked tokens are stored in a Set
 * and automatically cleaned up when they would have expired naturally.
 *
 * **Not suitable for production**: revocations are lost on server restart
 * and not shared across server instances. Use a Redis or database-backed
 * store in production.
 */
export class InMemoryTokenRevocationStore implements TokenRevocationStore {
	private readonly revokedTokens = new Map<string, number>()
	private readonly revokedDevices = new Set<string>()

	async isRevoked(jti: string): Promise<boolean> {
		return this.revokedTokens.has(jti)
	}

	async revoke(jti: string, expiresAt: number): Promise<void> {
		this.revokedTokens.set(jti, expiresAt)
	}

	async revokeAllForDevice(deviceId: string): Promise<void> {
		this.revokedDevices.add(deviceId)
	}

	/**
	 * Check if a device has been revoked.
	 */
	isDeviceRevoked(deviceId: string): boolean {
		return this.revokedDevices.has(deviceId)
	}

	/**
	 * Remove expired revocations to prevent unbounded memory growth.
	 * Call periodically (e.g., every hour) in long-running servers.
	 */
	cleanup(): void {
		const nowSeconds = Math.floor(Date.now() / 1000)
		for (const [jti, expiresAt] of this.revokedTokens) {
			if (nowSeconds > expiresAt) {
				this.revokedTokens.delete(jti)
			}
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
	 * This allows graceful rotation: add the new secret at index 0, then remove
	 * the old secret after all tokens signed with it have expired.
	 */
	secret: string | string[]

	/** Access token lifetime in milliseconds (default: 15 minutes) */
	accessTokenLifetime?: number

	/** Refresh token lifetime in milliseconds (default: 90 days) */
	refreshTokenLifetime?: number

	/** Device credential lifetime in milliseconds (default: 90 days) */
	deviceCredentialLifetime?: number

	/**
	 * Optional token revocation store. When provided, enables:
	 * - Individual token revocation via `revokeToken()`
	 * - Refresh token reuse detection (consumed tokens are tracked)
	 * - Device-level token invalidation via `revokeDeviceTokens()`
	 *
	 * Without a revocation store, tokens are valid until they expire.
	 */
	revocationStore?: TokenRevocationStore
}

/**
 * Server-side token manager responsible for issuing, refreshing, and validating
 * Kora authentication tokens.
 *
 * Uses HMAC-SHA256 signed JWTs with unique `jti` identifiers for every token.
 * Supports key rotation (multiple secrets), token revocation, and refresh token
 * reuse detection.
 *
 * @example
 * ```typescript
 * const tokenManager = new TokenManager({
 *   secret: TokenManager.generateSecret(),
 *   revocationStore: new InMemoryTokenRevocationStore(),
 * })
 *
 * // Issue all tokens at once
 * const tokens = tokenManager.issueTokens('user-123', 'device-456')
 *
 * // Validate an access token
 * const payload = tokenManager.validateToken(tokens.accessToken)
 *
 * // Refresh when the access token expires
 * const newTokens = await tokenManager.refreshAccessToken(tokens.refreshToken)
 * ```
 */
export class TokenManager {
	/** All signing/verification secrets (index 0 = current signing key) */
	private readonly secrets: string[]
	private readonly accessTokenLifetime: number
	private readonly refreshTokenLifetime: number
	private readonly deviceCredentialLifetime: number
	private readonly revocationStore: TokenRevocationStore | undefined

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
	}

	/**
	 * Generate a cryptographically random secret suitable for HMAC-SHA256 signing.
	 *
	 * Returns a 64-character hex string (32 bytes / 256 bits of entropy).
	 * Store this securely (environment variable, secrets manager) — never in source code.
	 *
	 * @returns A random 256-bit hex-encoded secret
	 */
	static generateSecret(): string {
		return randomBytes(32).toString('hex')
	}

	/**
	 * Issue a signed JWT access token.
	 *
	 * Access tokens are short-lived (default 15 minutes) and used to authorize
	 * API requests. When expired, use {@link refreshAccessToken} with a valid
	 * refresh token to obtain a new one.
	 *
	 * @param userId - The subject (user ID) to encode in the token
	 * @param deviceId - The device ID of the requesting device
	 * @returns A signed JWT string with type 'access'
	 */
	issueAccessToken(userId: string, deviceId: string): string {
		const nowSeconds = Math.floor(Date.now() / 1000)
		const payload: TokenPayload = {
			jti: randomUUID(),
			sub: userId,
			dev: deviceId,
			type: 'access',
			iat: nowSeconds,
			exp: nowSeconds + Math.floor(this.accessTokenLifetime / 1000),
		}
		return encodeJwt(payload as unknown as Record<string, unknown>, this.secrets[0] as string)
	}

	/**
	 * Issue a signed JWT refresh token.
	 *
	 * Refresh tokens are longer-lived (default 90 days) and used exclusively
	 * to obtain new access tokens via {@link refreshAccessToken}. They should
	 * be stored securely and never sent to resource APIs.
	 *
	 * @param userId - The subject (user ID) to encode in the token
	 * @param deviceId - The device ID of the requesting device
	 * @returns A signed JWT string with type 'refresh'
	 */
	issueRefreshToken(userId: string, deviceId: string): string {
		const nowSeconds = Math.floor(Date.now() / 1000)
		const payload: TokenPayload = {
			jti: randomUUID(),
			sub: userId,
			dev: deviceId,
			type: 'refresh',
			iat: nowSeconds,
			exp: nowSeconds + Math.floor(this.refreshTokenLifetime / 1000),
		}
		return encodeJwt(payload as unknown as Record<string, unknown>, this.secrets[0] as string)
	}

	/**
	 * Issue a signed device credential token.
	 *
	 * Device credentials are long-lived tokens bound to a device's public key.
	 * They include a `mustCheckinBy` deadline; if the device does not check in
	 * before this deadline, the credential should be treated as revoked.
	 *
	 * @param userId - The subject (user ID) to encode in the token
	 * @param deviceId - The device ID of the requesting device
	 * @param publicKeyThumbprint - SHA-256 thumbprint of the device's public key
	 * @returns A signed JWT string with type 'device_credential'
	 */
	issueDeviceCredential(
		userId: string,
		deviceId: string,
		publicKeyThumbprint: string,
	): string {
		const nowSeconds = Math.floor(Date.now() / 1000)
		const lifetimeSeconds = Math.floor(this.deviceCredentialLifetime / 1000)
		const payload: DeviceCredentialPayload = {
			jti: randomUUID(),
			sub: userId,
			dev: deviceId,
			type: 'device_credential',
			iat: nowSeconds,
			exp: nowSeconds + lifetimeSeconds,
			dpk: publicKeyThumbprint,
			mustCheckinBy: nowSeconds + lifetimeSeconds,
		}
		return encodeJwt(payload as unknown as Record<string, unknown>, this.secrets[0] as string)
	}

	/**
	 * Issue a complete set of authentication tokens.
	 *
	 * Always issues an access token and refresh token. If a `publicKeyThumbprint`
	 * is provided, also issues a device credential.
	 *
	 * @param userId - The subject (user ID) to encode in the tokens
	 * @param deviceId - The device ID of the requesting device
	 * @param publicKeyThumbprint - Optional SHA-256 thumbprint of the device's public key.
	 *   When provided, a device credential is included in the returned tokens.
	 * @returns An {@link AuthTokens} object containing the issued tokens
	 */
	issueTokens(
		userId: string,
		deviceId: string,
		publicKeyThumbprint?: string,
	): AuthTokens {
		const tokens: AuthTokens = {
			accessToken: this.issueAccessToken(userId, deviceId),
			refreshToken: this.issueRefreshToken(userId, deviceId),
		}

		if (publicKeyThumbprint !== undefined) {
			tokens.deviceCredential = this.issueDeviceCredential(
				userId,
				deviceId,
				publicKeyThumbprint,
			)
		}

		return tokens
	}

	/**
	 * Validate and decode a token.
	 *
	 * Verifies the HMAC-SHA256 signature (trying all configured secrets for key rotation),
	 * checks that the token has not expired, and validates all required claims.
	 * Returns null (rather than throwing) for invalid or expired tokens, so callers
	 * can handle authentication failure without try/catch.
	 *
	 * @param token - The JWT string to validate
	 * @returns The decoded {@link TokenPayload} if valid, or null if the token is
	 *   invalid, expired, or missing required claims
	 */
	validateToken(token: string): TokenPayload | null {
		// Try verification with each secret (supports key rotation)
		let decoded: Record<string, unknown> | null = null
		for (const secret of this.secrets) {
			decoded = verifyJwt(token, secret)
			if (decoded !== null) {
				break
			}
		}

		if (decoded === null) {
			return null
		}

		// verifyJwt validates the signature but not expiration;
		// check the exp claim separately
		if (isExpired(decoded as { exp?: number })) {
			return null
		}

		// Validate that all required base claims are present and correctly typed
		if (
			typeof decoded['jti'] !== 'string' ||
			typeof decoded['sub'] !== 'string' ||
			typeof decoded['dev'] !== 'string' ||
			typeof decoded['type'] !== 'string' ||
			typeof decoded['iat'] !== 'number' ||
			typeof decoded['exp'] !== 'number'
		) {
			return null
		}

		const type = decoded['type']
		if (type !== 'access' && type !== 'refresh' && type !== 'device_credential') {
			return null
		}

		return {
			jti: decoded['jti'] as string,
			sub: decoded['sub'] as string,
			dev: decoded['dev'] as string,
			type,
			iat: decoded['iat'] as number,
			exp: decoded['exp'] as number,
		}
	}

	/**
	 * Validate a token and check it against the revocation store.
	 *
	 * Like {@link validateToken}, but also checks whether the token's `jti` has been
	 * revoked. Requires a revocation store to be configured.
	 *
	 * @param token - The JWT string to validate
	 * @returns The decoded {@link TokenPayload} if valid and not revoked, or null otherwise
	 */
	async validateTokenWithRevocation(token: string): Promise<TokenPayload | null> {
		const payload = this.validateToken(token)
		if (payload === null) {
			return null
		}

		if (this.revocationStore) {
			const revoked = await this.revocationStore.isRevoked(payload.jti)
			if (revoked) {
				return null
			}
		}

		return payload
	}

	/**
	 * Revoke a specific token by its JWT ID.
	 *
	 * Requires a revocation store to be configured. After revocation, the token
	 * will be rejected by {@link validateTokenWithRevocation}.
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
	 * Revoke all tokens for a specific device.
	 *
	 * Called when a device is revoked to ensure all its existing tokens
	 * (access, refresh, and device credentials) are invalidated.
	 *
	 * @param deviceId - The device ID whose tokens should be revoked
	 */
	async revokeDeviceTokens(deviceId: string): Promise<void> {
		if (this.revocationStore) {
			await this.revocationStore.revokeAllForDevice(deviceId)
		}
	}

	/**
	 * Refresh an access token using a valid refresh token.
	 *
	 * Implements **refresh token rotation with reuse detection**: a new refresh token
	 * is issued alongside the new access token. The old refresh token's `jti` is
	 * recorded in the revocation store (if configured). If a previously consumed
	 * refresh token is presented again, it indicates potential token theft.
	 *
	 * Returns null if the provided token is invalid, expired, or not a refresh token.
	 *
	 * @param refreshToken - The refresh token JWT string
	 * @returns A new access/refresh token pair, or null if the refresh token is invalid
	 */
	async refreshAccessToken(
		refreshToken: string,
	): Promise<{ accessToken: string; refreshToken: string } | null> {
		const payload = this.validateToken(refreshToken)

		if (payload === null) {
			return null
		}

		// Only refresh tokens can be used for token refresh.
		// Accepting access tokens or device credentials here would be a security hole.
		if (payload.type !== 'refresh') {
			return null
		}

		// Check revocation store for replay detection
		if (this.revocationStore) {
			const wasRevoked = await this.revocationStore.isRevoked(payload.jti)
			if (wasRevoked) {
				// This refresh token was already consumed. This is a potential token theft.
				// Revoke all tokens for this device as a safety measure.
				await this.revocationStore.revokeAllForDevice(payload.dev)
				return null
			}

			// Mark this refresh token as consumed (revoked)
			await this.revocationStore.revoke(payload.jti, payload.exp)
		}

		return {
			accessToken: this.issueAccessToken(payload.sub, payload.dev),
			refreshToken: this.issueRefreshToken(payload.sub, payload.dev),
		}
	}
}
