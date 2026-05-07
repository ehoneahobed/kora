import type { AuthTokens } from '../types'
import type { TokenManager } from '../tokens/token-manager'
import type { AuthUser, AuthDevice } from './built-in/user-store'
import type { InMemoryUserStore } from './built-in/user-store'
import { BuiltInAuthRoutes, type AuthRoutesConfig } from './built-in/auth-routes'

/**
 * Parameters for signing up a new user.
 */
export interface SignUpParams {
	/** The user's email address */
	email: string
	/** The plaintext password */
	password: string
	/** Optional display name */
	name?: string
	/** Optional device ID to register with the account */
	deviceId?: string
	/** Optional device public key (base64url) */
	devicePublicKey?: string
}

/**
 * Parameters for signing in an existing user.
 */
export interface SignInParams {
	/** The user's email address */
	email: string
	/** The plaintext password */
	password: string
	/** Optional device ID to register or associate */
	deviceId?: string
	/** Optional device public key (base64url) */
	devicePublicKey?: string
}

/**
 * Abstraction for authentication providers.
 *
 * This interface allows swapping between the built-in email/password provider
 * and external providers (OAuth, SAML, custom) without changing application code.
 * Every provider must support the same core operations: sign up, sign in,
 * token refresh, token validation, user lookup, and device management.
 *
 * @example
 * ```typescript
 * // Use the built-in provider
 * const provider: AuthProviderAdapter = new BuiltInProvider({
 *   userStore: new InMemoryUserStore(),
 *   tokenManager: new TokenManager({ secret: 'my-secret' }),
 * })
 *
 * const { user, tokens } = await provider.signUp({
 *   email: 'alice@example.com',
 *   password: 'secure-password-123',
 * })
 * ```
 */
export interface AuthProviderAdapter {
	/**
	 * Create a new user account and issue authentication tokens.
	 *
	 * @param params - Sign-up parameters including email, password, and optional device info
	 * @returns The created user and tokens
	 * @throws If the email is already registered or input validation fails
	 */
	signUp(params: SignUpParams): Promise<{ user: AuthUser; tokens: AuthTokens }>

	/**
	 * Authenticate an existing user and issue tokens.
	 *
	 * @param params - Sign-in parameters including email and password
	 * @returns The authenticated user and tokens
	 * @throws If the credentials are invalid
	 */
	signIn(params: SignInParams): Promise<{ user: AuthUser; tokens: AuthTokens }>

	/**
	 * Exchange a refresh token for new tokens (rotation).
	 *
	 * @param refreshToken - The current refresh token
	 * @returns A new token pair
	 * @throws If the refresh token is invalid or expired
	 */
	refreshTokens(refreshToken: string): Promise<AuthTokens>

	/**
	 * Validate an access token and extract identity claims.
	 *
	 * @param token - The JWT access token
	 * @returns User ID and device ID if valid, or null if invalid/expired
	 */
	validateAccessToken(token: string): Promise<{ userId: string; deviceId: string } | null>

	/**
	 * Look up a user by ID.
	 *
	 * @param userId - The user's ID
	 * @returns The user profile, or null if not found
	 */
	getUser(userId: string): Promise<AuthUser | null>

	/**
	 * Revoke a device. Requires a valid access token for authorization.
	 *
	 * @param accessToken - The caller's access token
	 * @param deviceId - The ID of the device to revoke
	 * @throws If the token is invalid or the device does not belong to the caller
	 */
	revokeDevice(accessToken: string, deviceId: string): Promise<void>

	/**
	 * List all devices for the authenticated user.
	 *
	 * @param accessToken - The caller's access token
	 * @returns Array of device records
	 * @throws If the token is invalid
	 */
	listDevices(accessToken: string): Promise<AuthDevice[]>
}

/**
 * Error thrown by provider adapter methods when an operation fails.
 * Wraps the HTTP-style status and error message from route handlers
 * into an exception for use in the adapter pattern.
 */
export class AuthProviderError extends Error {
	/** HTTP-style status code */
	readonly status: number

	constructor(message: string, status: number) {
		super(message)
		this.name = 'AuthProviderError'
		this.status = status
	}
}

/**
 * Built-in authentication provider implementing email/password authentication.
 *
 * Wraps {@link BuiltInAuthRoutes} in the {@link AuthProviderAdapter} interface,
 * converting HTTP-style responses into direct return values and exceptions.
 * This is the default provider shipped with Kora and is suitable for
 * applications that want simple email/password auth without external services.
 *
 * @example
 * ```typescript
 * import { BuiltInProvider } from '@korajs/auth'
 * import { InMemoryUserStore } from '@korajs/auth'
 * import { TokenManager } from '@korajs/auth'
 *
 * const provider = new BuiltInProvider({
 *   userStore: new InMemoryUserStore(),
 *   tokenManager: new TokenManager({ secret: process.env.AUTH_SECRET }),
 * })
 *
 * const { user, tokens } = await provider.signUp({
 *   email: 'alice@example.com',
 *   password: 'strong-password-123',
 *   name: 'Alice',
 * })
 * ```
 */
export class BuiltInProvider implements AuthProviderAdapter {
	private readonly routes: BuiltInAuthRoutes
	private readonly tokenManager: TokenManager
	private readonly userStore: InMemoryUserStore

	constructor(config: AuthRoutesConfig) {
		this.routes = new BuiltInAuthRoutes(config)
		this.tokenManager = config.tokenManager
		this.userStore = config.userStore
	}

	/** @inheritdoc */
	async signUp(params: SignUpParams): Promise<{ user: AuthUser; tokens: AuthTokens }> {
		const result = await this.routes.handleSignUp(params)
		if ('error' in result.body) {
			throw new AuthProviderError(result.body.error, result.status)
		}
		return result.body.data
	}

	/** @inheritdoc */
	async signIn(params: SignInParams): Promise<{ user: AuthUser; tokens: AuthTokens }> {
		const result = await this.routes.handleSignIn(params)
		if ('error' in result.body) {
			throw new AuthProviderError(result.body.error, result.status)
		}
		return result.body.data
	}

	/** @inheritdoc */
	async refreshTokens(refreshToken: string): Promise<AuthTokens> {
		const result = await this.routes.handleRefresh({ refreshToken })
		if ('error' in result.body) {
			throw new AuthProviderError(result.body.error, result.status)
		}
		return result.body.data
	}

	/** @inheritdoc */
	async validateAccessToken(
		token: string,
	): Promise<{ userId: string; deviceId: string } | null> {
		const payload = this.tokenManager.validateToken(token)
		if (payload === null || payload.type !== 'access') {
			return null
		}
		return { userId: payload.sub, deviceId: payload.dev }
	}

	/** @inheritdoc */
	async getUser(userId: string): Promise<AuthUser | null> {
		const stored = await this.userStore.findById(userId)
		if (stored === null) {
			return null
		}
		return {
			id: stored.id,
			email: stored.email,
			name: stored.name,
			emailVerified: stored.emailVerified,
			createdAt: stored.createdAt,
		}
	}

	/** @inheritdoc */
	async revokeDevice(accessToken: string, deviceId: string): Promise<void> {
		const result = await this.routes.handleRevokeDevice(accessToken, deviceId)
		if ('error' in result.body) {
			throw new AuthProviderError(result.body.error, result.status)
		}
	}

	/** @inheritdoc */
	async listDevices(accessToken: string): Promise<AuthDevice[]> {
		const result = await this.routes.handleListDevices(accessToken)
		if ('error' in result.body) {
			throw new AuthProviderError(result.body.error, result.status)
		}
		return result.body.data
	}
}
