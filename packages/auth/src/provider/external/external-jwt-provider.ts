import { KoraError } from '@korajs/core'
import { verifyJwt, decodeJwt, isExpired } from '../../tokens/jwt'
import type {
	AuthProviderAdapter,
	SignUpParams,
	SignInParams,
} from '../adapter'
import type { AuthUser } from '../built-in/user-store'
import type { AuthDevice } from '../built-in/user-store'
import type { AuthTokens } from '../../types'

// ============================================================================
// Error classes
// ============================================================================

/**
 * Thrown when an operation is not supported by external auth providers.
 *
 * External providers delegate user management to the third-party service
 * (Clerk, Auth0, Supabase, etc.). Operations like sign-up and sign-in must
 * be performed through the external provider's SDK or UI, not through Kora.
 */
export class ExternalAuthOperationNotSupportedError extends KoraError {
	constructor(operation: string, provider: string) {
		super(
			`The "${operation}" operation is not supported by the external auth provider "${provider}". ` +
			`Perform this operation through your external auth provider's SDK or dashboard instead.`,
			'AUTH_EXTERNAL_OPERATION_NOT_SUPPORTED',
			{ operation, provider },
		)
		this.name = 'ExternalAuthOperationNotSupportedError'
	}
}

/**
 * Thrown when an external JWT token fails validation.
 */
export class ExternalTokenValidationError extends KoraError {
	constructor(reason: string, context?: Record<string, unknown>) {
		super(
			`External token validation failed: ${reason}`,
			'AUTH_EXTERNAL_TOKEN_INVALID',
			context,
		)
		this.name = 'ExternalTokenValidationError'
	}
}

// ============================================================================
// Configuration
// ============================================================================

/**
 * Default claim mapping for external JWT tokens.
 * Maps standard JWT claims to Kora's expected user format.
 */
function defaultMapClaims(claims: Record<string, unknown>): ExternalUserInfo {
	const sub = claims['sub']
	if (typeof sub !== 'string' || sub.length === 0) {
		throw new ExternalTokenValidationError(
			'JWT is missing a valid "sub" (subject) claim. The "sub" claim must be a non-empty string identifying the user.',
			{ availableClaims: Object.keys(claims) },
		)
	}

	return {
		userId: sub,
		email: typeof claims['email'] === 'string' ? claims['email'] : undefined,
		name: typeof claims['name'] === 'string' ? claims['name'] : undefined,
		metadata: undefined,
	}
}

/**
 * User information extracted from an external JWT token.
 * Returned by the claims mapping function.
 */
export interface ExternalUserInfo {
	/** Unique user identifier from the external provider */
	userId: string
	/** User's email address, if available in the token claims */
	email?: string
	/** User's display name, if available in the token claims */
	name?: string
	/** Additional metadata from the token claims */
	metadata?: Record<string, unknown>
}

/**
 * Configuration for the external JWT authentication provider.
 *
 * Supports two validation modes:
 * 1. **HMAC secret** (`jwtSecret`): For providers that sign tokens with a shared
 *    secret (e.g., Supabase). Uses HS256 verification via the existing `verifyJwt` utility.
 * 2. **Custom validator** (`validateToken`): For providers that use asymmetric keys
 *    (RS256, ES256) or require custom validation logic (e.g., Clerk with JWKS rotation).
 *    The developer provides their own validation function.
 *
 * At least one of `jwtSecret` or `validateToken` must be provided.
 *
 * @example
 * ```typescript
 * // With a shared secret (e.g., Supabase)
 * const provider = new ExternalJwtProvider({
 *   providerName: 'supabase',
 *   jwtSecret: process.env.SUPABASE_JWT_SECRET,
 * })
 *
 * // With a custom validator (e.g., Clerk JWKS)
 * const provider = new ExternalJwtProvider({
 *   providerName: 'clerk',
 *   validateToken: async (token) => {
 *     const claims = await clerkClient.verifyToken(token)
 *     return claims ? { sub: claims.sub, ...claims } : null
 *   },
 * })
 * ```
 */
export interface ExternalJwtProviderConfig {
	/**
	 * Human-readable name of the external auth provider.
	 * Used in error messages and DevTools for identification.
	 * @example 'clerk', 'auth0', 'supabase', 'firebase'
	 */
	providerName: string

	/**
	 * Shared secret for HS256 JWT verification.
	 * Used when the external provider signs tokens with HMAC-SHA256.
	 * Mutually exclusive with `validateToken` (if both are provided,
	 * `validateToken` takes precedence).
	 */
	jwtSecret?: string

	/**
	 * Custom token validator function.
	 * When provided, this is used instead of HS256 HMAC verification.
	 * Receives the raw JWT string and must return the decoded claims
	 * (with at least a `sub` field) or null if the token is invalid.
	 *
	 * Use this for providers that use asymmetric signing (RS256, ES256)
	 * or require JWKS-based key rotation.
	 *
	 * @param token - The raw JWT string to validate
	 * @returns The decoded claims object with at least a `sub` field, or null if invalid
	 */
	validateToken?: (token: string) => Promise<{ sub: string; [key: string]: unknown } | null>

	/**
	 * Map external JWT claims to Kora's expected user format.
	 *
	 * The default mapping extracts:
	 * - `sub` -> `userId` (required)
	 * - `email` -> `email` (optional)
	 * - `name` -> `name` (optional)
	 *
	 * Override this to extract custom claims from your provider's tokens.
	 *
	 * @param claims - The decoded JWT claims object
	 * @returns Kora-compatible user information
	 *
	 * @example
	 * ```typescript
	 * mapClaims: (claims) => ({
	 *   userId: claims.sub as string,
	 *   email: claims.email_address as string,
	 *   name: `${claims.first_name} ${claims.last_name}`,
	 *   metadata: { org: claims.org_id },
	 * })
	 * ```
	 */
	mapClaims?: (claims: Record<string, unknown>) => ExternalUserInfo
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Authentication provider adapter for external JWT issuers.
 *
 * This adapter validates JWTs issued by third-party auth services (Clerk, Auth0,
 * Supabase, Firebase, or any custom JWT issuer) and maps their claims to Kora's
 * internal auth context. It bridges external identity providers with Kora's
 * sync authentication layer.
 *
 * **How it works:**
 * 1. The client authenticates with the external provider and receives a JWT
 * 2. The client passes this JWT to Kora's sync server
 * 3. This adapter validates the JWT and extracts user identity
 * 4. Kora uses the extracted identity for sync authorization
 *
 * **What it does NOT do:**
 * - Sign up or sign in users (that happens through the external provider)
 * - Issue or refresh tokens (that is the external provider's responsibility)
 * - Manage devices (external providers handle their own device tracking)
 *
 * @example
 * ```typescript
 * import { ExternalJwtProvider } from '@korajs/auth/server'
 *
 * const auth = new ExternalJwtProvider({
 *   providerName: 'clerk',
 *   validateToken: async (token) => {
 *     // Use Clerk's SDK or JWKS endpoint to verify
 *     return verifiedClaims
 *   },
 * })
 *
 * // Use with Kora sync server
 * const result = await auth.validateAccessToken('eyJhbG...')
 * if (result) {
 *   console.log('User:', result.userId)
 * }
 * ```
 */
export class ExternalJwtProvider implements AuthProviderAdapter {
	private readonly providerName: string
	private readonly jwtSecret: string | undefined
	private readonly customValidateToken:
		| ((token: string) => Promise<{ sub: string; [key: string]: unknown } | null>)
		| undefined
	private readonly mapClaims: (claims: Record<string, unknown>) => ExternalUserInfo

	constructor(config: ExternalJwtProviderConfig) {
		if (config.validateToken === undefined && config.jwtSecret === undefined) {
			throw new ExternalTokenValidationError(
				'ExternalJwtProvider requires either a "jwtSecret" for HS256 verification ' +
				'or a custom "validateToken" function. Provide at least one.',
				{ providerName: config.providerName },
			)
		}

		this.providerName = config.providerName
		this.jwtSecret = config.jwtSecret
		this.customValidateToken = config.validateToken
		this.mapClaims = config.mapClaims ?? defaultMapClaims
	}

	/**
	 * Not supported for external providers.
	 *
	 * User registration must be performed through the external auth provider's
	 * SDK or UI. Kora does not manage user accounts for external providers.
	 *
	 * @throws {ExternalAuthOperationNotSupportedError} Always
	 */
	async signUp(_params: SignUpParams): Promise<{ user: AuthUser; tokens: AuthTokens }> {
		throw new ExternalAuthOperationNotSupportedError('signUp', this.providerName)
	}

	/**
	 * Not supported for external providers.
	 *
	 * User authentication must be performed through the external auth provider's
	 * SDK or UI. Kora does not manage credentials for external providers.
	 *
	 * @throws {ExternalAuthOperationNotSupportedError} Always
	 */
	async signIn(_params: SignInParams): Promise<{ user: AuthUser; tokens: AuthTokens }> {
		throw new ExternalAuthOperationNotSupportedError('signIn', this.providerName)
	}

	/**
	 * Not supported for external providers.
	 *
	 * Token refresh must be performed through the external auth provider's SDK.
	 * Kora does not manage token lifecycle for external providers.
	 *
	 * @throws {ExternalAuthOperationNotSupportedError} Always
	 */
	async refreshTokens(_refreshToken: string): Promise<AuthTokens> {
		throw new ExternalAuthOperationNotSupportedError('refreshTokens', this.providerName)
	}

	/**
	 * Validate an access token from the external auth provider.
	 *
	 * Uses either the custom `validateToken` function or HS256 HMAC verification
	 * (depending on configuration) to validate the JWT. On success, maps the claims
	 * to Kora's expected format and returns the user ID and device ID.
	 *
	 * The device ID for external providers is derived from the user ID with a
	 * "external-" prefix, since external providers typically don't use Kora's
	 * device identity system.
	 *
	 * @param token - The JWT access token issued by the external provider
	 * @returns User ID and device ID if the token is valid, or null if invalid/expired
	 */
	async validateAccessToken(
		token: string,
	): Promise<{ userId: string; deviceId: string } | null> {
		const claims = await this.extractClaims(token)
		if (claims === null) {
			return null
		}

		let userInfo: ExternalUserInfo
		try {
			userInfo = this.mapClaims(claims)
		} catch {
			return null
		}

		if (typeof userInfo.userId !== 'string' || userInfo.userId.length === 0) {
			return null
		}

		// External providers don't use Kora's device identity system.
		// Derive a stable device ID from the user ID so sync authorization works.
		const deviceId = `external-${this.providerName}-${userInfo.userId}`

		return { userId: userInfo.userId, deviceId }
	}

	/**
	 * Not supported for external providers.
	 *
	 * User lookup must be performed through the external auth provider's API.
	 *
	 * @throws {ExternalAuthOperationNotSupportedError} Always
	 */
	async getUser(_userId: string): Promise<AuthUser | null> {
		throw new ExternalAuthOperationNotSupportedError('getUser', this.providerName)
	}

	/**
	 * Not supported for external providers.
	 *
	 * Device revocation must be managed through the external auth provider
	 * or by revoking the user's tokens at the provider level.
	 *
	 * @throws {ExternalAuthOperationNotSupportedError} Always
	 */
	async revokeDevice(_accessToken: string, _deviceId: string): Promise<void> {
		throw new ExternalAuthOperationNotSupportedError('revokeDevice', this.providerName)
	}

	/**
	 * Not supported for external providers.
	 *
	 * Device listing must be performed through the external auth provider's API.
	 *
	 * @throws {ExternalAuthOperationNotSupportedError} Always
	 */
	async listDevices(_accessToken: string): Promise<AuthDevice[]> {
		throw new ExternalAuthOperationNotSupportedError('listDevices', this.providerName)
	}

	/**
	 * Creates a sync server auth provider compatible with `@korajs/server`.
	 *
	 * Returns an object with an `authenticate` method that validates the external
	 * JWT and returns a Kora-compatible auth context. Use this to wire the external
	 * auth provider into KoraSyncServer.
	 *
	 * @returns An object with an `authenticate` method for KoraSyncServer's `auth` config
	 *
	 * @example
	 * ```typescript
	 * const externalAuth = new ExternalJwtProvider({ ... })
	 * const syncServer = new KoraSyncServer({
	 *   store,
	 *   auth: externalAuth.toSyncAuthProvider(),
	 * })
	 * ```
	 */
	toSyncAuthProvider(): {
		authenticate(token: string): Promise<{
			userId: string
			scopes?: Record<string, Record<string, unknown>>
			metadata?: Record<string, unknown>
		} | null>
	} {
		return {
			authenticate: async (token: string) => {
				const claims = await this.extractClaims(token)
				if (claims === null) {
					return null
				}

				let userInfo: ExternalUserInfo
				try {
					userInfo = this.mapClaims(claims)
				} catch {
					return null
				}

				if (typeof userInfo.userId !== 'string' || userInfo.userId.length === 0) {
					return null
				}

				return {
					userId: userInfo.userId,
					metadata: {
						provider: this.providerName,
						email: userInfo.email,
						name: userInfo.name,
						...userInfo.metadata,
					},
				}
			},
		}
	}

	/**
	 * Extract and validate claims from a JWT token.
	 *
	 * Uses the custom validator if configured, otherwise falls back to
	 * HS256 HMAC verification with the configured secret.
	 *
	 * @param token - The raw JWT string
	 * @returns The decoded claims object, or null if the token is invalid
	 */
	private async extractClaims(token: string): Promise<Record<string, unknown> | null> {
		// Custom validator takes precedence
		if (this.customValidateToken !== undefined) {
			try {
				const result = await this.customValidateToken(token)
				if (result === null) {
					return null
				}
				return result as Record<string, unknown>
			} catch {
				return null
			}
		}

		// Fall back to HS256 HMAC verification
		if (this.jwtSecret !== undefined) {
			const claims = verifyJwt(token, this.jwtSecret)
			if (claims === null) {
				return null
			}

			// Check expiration if the token has an exp claim
			if (isExpired(claims as { exp?: number })) {
				return null
			}

			return claims
		}

		// Should not reach here due to constructor validation, but handle defensively
		return null
	}
}
