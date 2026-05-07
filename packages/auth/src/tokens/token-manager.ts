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
 * Configuration for the server-side TokenManager.
 */
export interface TokenManagerConfig {
	/** Secret key for signing JWTs (HMAC-SHA256) */
	secret: string

	/** Access token lifetime in milliseconds (default: 15 minutes) */
	accessTokenLifetime?: number

	/** Refresh token lifetime in milliseconds (default: 90 days) */
	refreshTokenLifetime?: number

	/** Device credential lifetime in milliseconds (default: 90 days) */
	deviceCredentialLifetime?: number
}

/**
 * Server-side token manager responsible for issuing, refreshing, and validating
 * Kora authentication tokens.
 *
 * Uses HMAC-SHA256 signed JWTs. Supports three token types:
 * - **Access tokens**: Short-lived tokens for API authorization (default: 15 min)
 * - **Refresh tokens**: Longer-lived tokens for obtaining new access tokens (default: 90 days)
 * - **Device credentials**: Long-lived credentials bound to a device key pair (default: 90 days)
 *
 * @example
 * ```typescript
 * const tokenManager = new TokenManager({ secret: 'my-signing-secret' })
 *
 * // Issue all tokens at once
 * const tokens = tokenManager.issueTokens('user-123', 'device-456')
 *
 * // Validate an access token
 * const payload = tokenManager.validateToken(tokens.accessToken)
 *
 * // Refresh when the access token expires
 * const newTokens = tokenManager.refreshAccessToken(tokens.refreshToken)
 * ```
 */
export class TokenManager {
	private readonly secret: string
	private readonly accessTokenLifetime: number
	private readonly refreshTokenLifetime: number
	private readonly deviceCredentialLifetime: number

	constructor(config: TokenManagerConfig) {
		this.secret = config.secret
		this.accessTokenLifetime = config.accessTokenLifetime ?? DEFAULT_ACCESS_TOKEN_LIFETIME
		this.refreshTokenLifetime = config.refreshTokenLifetime ?? DEFAULT_REFRESH_TOKEN_LIFETIME
		this.deviceCredentialLifetime =
			config.deviceCredentialLifetime ?? DEFAULT_DEVICE_CREDENTIAL_LIFETIME
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
			sub: userId,
			dev: deviceId,
			type: 'access',
			iat: nowSeconds,
			exp: nowSeconds + Math.floor(this.accessTokenLifetime / 1000),
		}
		return encodeJwt(payload as unknown as Record<string, unknown>, this.secret)
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
			sub: userId,
			dev: deviceId,
			type: 'refresh',
			iat: nowSeconds,
			exp: nowSeconds + Math.floor(this.refreshTokenLifetime / 1000),
		}
		return encodeJwt(payload as unknown as Record<string, unknown>, this.secret)
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
			sub: userId,
			dev: deviceId,
			type: 'device_credential',
			iat: nowSeconds,
			exp: nowSeconds + lifetimeSeconds,
			dpk: publicKeyThumbprint,
			mustCheckinBy: nowSeconds + lifetimeSeconds,
		}
		return encodeJwt(payload as unknown as Record<string, unknown>, this.secret)
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
	 * Verifies the HMAC-SHA256 signature and checks that the token has not expired.
	 * Returns null (rather than throwing) for invalid or expired tokens, so callers
	 * can handle authentication failure without try/catch.
	 *
	 * @param token - The JWT string to validate
	 * @returns The decoded {@link TokenPayload} if valid, or null if the token is
	 *   invalid, expired, or missing required claims
	 */
	validateToken(token: string): TokenPayload | null {
		const decoded = verifyJwt(token, this.secret)
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
			sub: decoded['sub'] as string,
			dev: decoded['dev'] as string,
			type,
			iat: decoded['iat'] as number,
			exp: decoded['exp'] as number,
		}
	}

	/**
	 * Refresh an access token using a valid refresh token.
	 *
	 * Implements **refresh token rotation**: a new refresh token is issued alongside
	 * the new access token, and the old refresh token should be considered consumed.
	 * This limits the window of vulnerability if a refresh token is compromised.
	 *
	 * Returns null if the provided token is invalid, expired, or not a refresh token.
	 *
	 * @param refreshToken - The refresh token JWT string
	 * @returns A new access/refresh token pair, or null if the refresh token is invalid
	 */
	refreshAccessToken(
		refreshToken: string,
	): { accessToken: string; refreshToken: string } | null {
		const payload = this.validateToken(refreshToken)

		if (payload === null) {
			return null
		}

		// Only refresh tokens can be used for token refresh.
		// Accepting access tokens or device credentials here would be a security hole.
		if (payload.type !== 'refresh') {
			return null
		}

		return {
			accessToken: this.issueAccessToken(payload.sub, payload.dev),
			refreshToken: this.issueRefreshToken(payload.sub, payload.dev),
		}
	}
}
