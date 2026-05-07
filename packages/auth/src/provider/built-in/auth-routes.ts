import type { AuthTokens } from '../../types'
import { TokenManager } from '../../tokens/token-manager'
import { hashPassword, verifyPassword } from './password-hash'
import {
	InMemoryUserStore,
	type AuthUser,
	type AuthDevice,
} from './user-store'

/**
 * Configuration for building the built-in auth routes.
 */
export interface AuthRoutesConfig {
	/** The user/device store backing the auth routes */
	userStore: InMemoryUserStore
	/** The token manager for issuing and validating JWTs */
	tokenManager: TokenManager
}

/**
 * Response envelope returned by all auth route handlers.
 *
 * Successful responses include a `data` field; failures include an `error` string.
 * The `status` field maps directly to an HTTP status code.
 */
export interface AuthRouteResponse<T> {
	/** HTTP status code */
	status: number
	/** Either the success payload or an error message */
	body: { data: T } | { error: string }
}

/** Minimum password length enforced at sign-up. */
const MIN_PASSWORD_LENGTH = 8

/**
 * Simple email format validation.
 * Checks for the presence of exactly one @ with non-empty local and domain parts,
 * and at least one dot in the domain. This is intentionally lenient — real email
 * validation happens by sending a confirmation email, not by regex.
 */
function isValidEmail(email: string): boolean {
	if (email.length === 0 || email.length > 254) {
		return false
	}
	const atIndex = email.indexOf('@')
	if (atIndex < 1) {
		return false
	}
	const domain = email.slice(atIndex + 1)
	if (domain.length === 0 || !domain.includes('.')) {
		return false
	}
	// No double-@ or spaces
	if (email.indexOf('@', atIndex + 1) !== -1) {
		return false
	}
	if (email.includes(' ')) {
		return false
	}
	return true
}

/**
 * HTTP route handlers for the built-in Kora auth provider.
 *
 * These are framework-agnostic functions that accept parsed request bodies and return
 * structured responses. The server package is responsible for wiring them into its
 * HTTP server (e.g., mapping `POST /auth/signup` to `handleSignUp`).
 *
 * All handlers follow the same pattern:
 * - Validate input
 * - Perform the operation
 * - Return `{ status, body: { data } }` on success
 * - Return `{ status, body: { error } }` on failure
 *
 * @example
 * ```typescript
 * const routes = new BuiltInAuthRoutes({
 *   userStore: new InMemoryUserStore(),
 *   tokenManager: new TokenManager({ secret: 'my-secret' }),
 * })
 *
 * // Wire into an HTTP server:
 * app.post('/auth/signup', async (req, res) => {
 *   const result = await routes.handleSignUp(req.body)
 *   res.status(result.status).json(result.body)
 * })
 * ```
 */
export class BuiltInAuthRoutes {
	private readonly userStore: InMemoryUserStore
	private readonly tokenManager: TokenManager

	constructor(config: AuthRoutesConfig) {
		this.userStore = config.userStore
		this.tokenManager = config.tokenManager
	}

	/**
	 * Handle user sign-up (POST /auth/signup).
	 *
	 * Validates email format and password length, hashes the password,
	 * creates the user, optionally registers a device, and issues tokens.
	 *
	 * @param body - Sign-up request body
	 * @param body.email - The user's email address
	 * @param body.password - The plaintext password (min 8 characters)
	 * @param body.name - Optional display name (defaults to email local part)
	 * @param body.deviceId - Optional device ID to register
	 * @param body.devicePublicKey - Optional device public key (base64url)
	 * @returns Auth response with the created user and tokens, or an error
	 */
	async handleSignUp(body: {
		email: string
		password: string
		name?: string
		deviceId?: string
		devicePublicKey?: string
	}): Promise<AuthRouteResponse<{ user: AuthUser; tokens: AuthTokens }>> {
		// Validate email format
		if (!isValidEmail(body.email)) {
			return {
				status: 400,
				body: {
					error: 'Invalid email address. Please provide a valid email in the format user@domain.com.',
				},
			}
		}

		// Validate password length
		if (body.password.length < MIN_PASSWORD_LENGTH) {
			return {
				status: 400,
				body: {
					error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`,
				},
			}
		}

		// Hash the password
		const { hash, salt } = await hashPassword(body.password)

		// Create the user — may throw DuplicateEmailError
		let user: AuthUser
		try {
			user = await this.userStore.createUser({
				email: body.email,
				passwordHash: hash,
				salt,
				name: body.name ?? body.email.split('@')[0] ?? body.email,
			})
		} catch (err: unknown) {
			if (err instanceof Error && err.name === 'DuplicateEmailError') {
				return {
					status: 409,
					body: { error: 'An account with this email already exists.' },
				}
			}
			throw err
		}

		// Use provided deviceId or generate a placeholder
		const deviceId = body.deviceId ?? `device-${user.id}`

		// Register device if device info was provided
		if (body.deviceId !== undefined && body.devicePublicKey !== undefined) {
			await this.userStore.registerDevice({
				id: body.deviceId,
				userId: user.id,
				publicKey: body.devicePublicKey,
				name: 'Primary Device',
			})
		}

		// Issue tokens
		const tokens = this.tokenManager.issueTokens(user.id, deviceId)

		return {
			status: 201,
			body: { data: { user, tokens } },
		}
	}

	/**
	 * Handle user sign-in (POST /auth/signin).
	 *
	 * Looks up the user by email, verifies the password, optionally registers
	 * a new device, and issues tokens.
	 *
	 * @param body - Sign-in request body
	 * @param body.email - The user's email address
	 * @param body.password - The plaintext password
	 * @param body.deviceId - Optional device ID to register
	 * @param body.devicePublicKey - Optional device public key (base64url)
	 * @returns Auth response with the user and tokens, or an error
	 */
	async handleSignIn(body: {
		email: string
		password: string
		deviceId?: string
		devicePublicKey?: string
	}): Promise<AuthRouteResponse<{ user: AuthUser; tokens: AuthTokens }>> {
		const storedUser = await this.userStore.findByEmail(body.email)
		if (storedUser === null) {
			return {
				status: 401,
				body: { error: 'Invalid email or password.' },
			}
		}

		const passwordValid = await verifyPassword(
			body.password,
			storedUser.passwordHash,
			storedUser.salt,
		)
		if (!passwordValid) {
			return {
				status: 401,
				body: { error: 'Invalid email or password.' },
			}
		}

		// Use provided deviceId or generate a placeholder
		const deviceId = body.deviceId ?? `device-${storedUser.id}`

		// Register device if device info was provided
		if (body.deviceId !== undefined && body.devicePublicKey !== undefined) {
			await this.userStore.registerDevice({
				id: body.deviceId,
				userId: storedUser.id,
				publicKey: body.devicePublicKey,
				name: 'Device',
			})
		}

		const tokens = this.tokenManager.issueTokens(storedUser.id, deviceId)

		const user: AuthUser = {
			id: storedUser.id,
			email: storedUser.email,
			name: storedUser.name,
			createdAt: storedUser.createdAt,
		}

		return {
			status: 200,
			body: { data: { user, tokens } },
		}
	}

	/**
	 * Handle token refresh (POST /auth/refresh).
	 *
	 * Validates the provided refresh token and issues a new token pair
	 * (refresh token rotation). The old refresh token should be considered
	 * consumed after this call.
	 *
	 * @param body - Refresh request body
	 * @param body.refreshToken - The current refresh token
	 * @returns Auth response with new tokens, or an error
	 */
	async handleRefresh(body: {
		refreshToken: string
	}): Promise<AuthRouteResponse<AuthTokens>> {
		const result = this.tokenManager.refreshAccessToken(body.refreshToken)

		if (result === null) {
			return {
				status: 401,
				body: { error: 'Invalid or expired refresh token.' },
			}
		}

		return {
			status: 200,
			body: { data: result },
		}
	}

	/**
	 * Handle get-current-user (GET /auth/me).
	 *
	 * Validates the access token and returns the authenticated user's profile.
	 *
	 * @param accessToken - The JWT access token (without "Bearer " prefix)
	 * @returns Auth response with the user profile, or an error
	 */
	async handleGetMe(accessToken: string): Promise<AuthRouteResponse<AuthUser>> {
		const payload = this.tokenManager.validateToken(accessToken)
		if (payload === null || payload.type !== 'access') {
			return {
				status: 401,
				body: { error: 'Invalid or expired access token.' },
			}
		}

		const storedUser = await this.userStore.findById(payload.sub)
		if (storedUser === null) {
			return {
				status: 404,
				body: { error: 'User not found.' },
			}
		}

		const user: AuthUser = {
			id: storedUser.id,
			email: storedUser.email,
			name: storedUser.name,
			createdAt: storedUser.createdAt,
		}

		return {
			status: 200,
			body: { data: user },
		}
	}

	/**
	 * Handle list-devices (GET /auth/devices).
	 *
	 * Validates the access token and returns all devices registered for the user.
	 *
	 * @param accessToken - The JWT access token (without "Bearer " prefix)
	 * @returns Auth response with the device list, or an error
	 */
	async handleListDevices(
		accessToken: string,
	): Promise<AuthRouteResponse<AuthDevice[]>> {
		const payload = this.tokenManager.validateToken(accessToken)
		if (payload === null || payload.type !== 'access') {
			return {
				status: 401,
				body: { error: 'Invalid or expired access token.' },
			}
		}

		const devices = await this.userStore.listDevices(payload.sub)

		return {
			status: 200,
			body: { data: devices },
		}
	}

	/**
	 * Handle device revocation (DELETE /auth/device/:id).
	 *
	 * Validates the access token and revokes the specified device.
	 * Only the device's owner can revoke it.
	 *
	 * @param accessToken - The JWT access token (without "Bearer " prefix)
	 * @param deviceId - The ID of the device to revoke
	 * @returns Auth response with success flag, or an error
	 */
	async handleRevokeDevice(
		accessToken: string,
		deviceId: string,
	): Promise<AuthRouteResponse<{ success: boolean }>> {
		const payload = this.tokenManager.validateToken(accessToken)
		if (payload === null || payload.type !== 'access') {
			return {
				status: 401,
				body: { error: 'Invalid or expired access token.' },
			}
		}

		// Verify the device belongs to the authenticated user
		const device = await this.userStore.findDevice(deviceId)
		if (device === null) {
			return {
				status: 404,
				body: { error: 'Device not found.' },
			}
		}

		if (device.userId !== payload.sub) {
			return {
				status: 403,
				body: { error: 'You can only revoke your own devices.' },
			}
		}

		await this.userStore.revokeDevice(deviceId)

		return {
			status: 200,
			body: { data: { success: true } },
		}
	}

	/**
	 * Creates a sync server auth provider compatible with `@korajs/server`.
	 *
	 * The returned object implements the `AuthProvider` interface from
	 * `@korajs/server`, validating access tokens and returning an auth
	 * context containing the user ID and device metadata. This bridges
	 * the built-in auth system with the sync server's authentication layer.
	 *
	 * @returns An object with an `authenticate` method suitable for KoraSyncServer's `auth` config
	 *
	 * @example
	 * ```typescript
	 * const routes = new BuiltInAuthRoutes({ userStore, tokenManager })
	 * const syncServer = new KoraSyncServer({
	 *   store,
	 *   auth: routes.toSyncAuthProvider(),
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
		const tokenManager = this.tokenManager
		const userStore = this.userStore

		return {
			async authenticate(token: string) {
				const payload = tokenManager.validateToken(token)
				if (payload === null || payload.type !== 'access') {
					return null
				}

				// Verify the user still exists
				const user = await userStore.findById(payload.sub)
				if (user === null) {
					return null
				}

				// Touch the device to update last-seen timestamp
				await userStore.touchDevice(payload.dev)

				return {
					userId: payload.sub,
					metadata: {
						deviceId: payload.dev,
						email: user.email,
						name: user.name,
					},
				}
			},
		}
	}
}
