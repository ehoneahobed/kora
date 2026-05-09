import { randomBytes } from 'node:crypto'
import { computePublicKeyThumbprint, verifyChallenge } from '../../device/device-identity'
import type { TokenManager } from '../../tokens/token-manager'
import type { AuthTokens } from '../../types'
import { hashPassword, verifyPassword } from './password-hash'
import type { AuthDevice, AuthUser, UserStore } from './user-store'

// ============================================================================
// Challenge Store
// ============================================================================

/**
 * Interface for server-side challenge storage.
 *
 * Challenges must be stored server-side with expiry and single-use semantics
 * to prevent replay attacks on device verification.
 */
export interface ChallengeStore {
	/**
	 * Store a challenge for later verification.
	 * @param challenge - The challenge string
	 * @param deviceId - The device this challenge is intended for
	 * @param expiresAt - Timestamp (ms since epoch) when this challenge expires
	 */
	store(challenge: string, deviceId: string, expiresAt: number): Promise<void>

	/**
	 * Consume a challenge (single-use). Returns the associated device ID if the
	 * challenge is valid and not expired, or null if it doesn't exist, has expired,
	 * or was already consumed.
	 */
	consume(challenge: string): Promise<{ deviceId: string } | null>
}

/**
 * In-memory challenge store with expiry and single-use semantics.
 * Suitable for development and testing. Use Redis or a database in production.
 */
export class InMemoryChallengeStore implements ChallengeStore {
	private readonly challenges = new Map<string, { deviceId: string; expiresAt: number }>()

	async store(challenge: string, deviceId: string, expiresAt: number): Promise<void> {
		this.challenges.set(challenge, { deviceId, expiresAt })
	}

	async consume(challenge: string): Promise<{ deviceId: string } | null> {
		const entry = this.challenges.get(challenge)
		if (entry === undefined) {
			return null
		}

		// Always delete (single-use)
		this.challenges.delete(challenge)

		// Check expiry
		if (Date.now() > entry.expiresAt) {
			return null
		}

		return { deviceId: entry.deviceId }
	}

	/**
	 * Remove expired challenges to prevent unbounded memory growth.
	 */
	cleanup(): void {
		const now = Date.now()
		for (const [challenge, entry] of this.challenges) {
			if (now > entry.expiresAt) {
				this.challenges.delete(challenge)
			}
		}
	}
}

// ============================================================================
// Rate Limiter
// ============================================================================

/**
 * Interface for rate limiting auth endpoints.
 *
 * Rate limiting is critical for preventing brute-force password guessing
 * and credential stuffing attacks.
 */
export interface RateLimiter {
	/**
	 * Check if an action is allowed for the given key.
	 * @param key - Rate limit key (e.g., IP address, email, or composite key)
	 * @returns true if the action is allowed, false if rate limited
	 */
	isAllowed(key: string): Promise<boolean>

	/**
	 * Record that an action was performed for the given key.
	 * Call this after each authentication attempt.
	 */
	record(key: string): Promise<void>

	/**
	 * Reset the rate limit for a key (e.g., after a successful login).
	 */
	reset(key: string): Promise<void>
}

/**
 * In-memory sliding window rate limiter.
 * Suitable for development and single-server deployments.
 * Use Redis-based rate limiting for multi-server production deployments.
 */
export class InMemoryRateLimiter implements RateLimiter {
	private readonly attempts = new Map<string, number[]>()
	private readonly maxAttempts: number
	private readonly windowMs: number

	/**
	 * @param maxAttempts - Maximum number of attempts within the time window (default: 10)
	 * @param windowMs - Time window in milliseconds (default: 60,000 = 1 minute)
	 */
	constructor(maxAttempts = 10, windowMs = 60_000) {
		this.maxAttempts = maxAttempts
		this.windowMs = windowMs
	}

	async isAllowed(key: string): Promise<boolean> {
		const now = Date.now()
		const attempts = this.attempts.get(key) ?? []
		const recentAttempts = attempts.filter((t) => now - t < this.windowMs)
		return recentAttempts.length < this.maxAttempts
	}

	async record(key: string): Promise<void> {
		const now = Date.now()
		const attempts = this.attempts.get(key) ?? []
		// Keep only recent attempts to bound memory
		const recentAttempts = attempts.filter((t) => now - t < this.windowMs)
		recentAttempts.push(now)
		this.attempts.set(key, recentAttempts)
	}

	async reset(key: string): Promise<void> {
		this.attempts.delete(key)
	}
}

// ============================================================================
// Auth Routes Configuration
// ============================================================================

/**
 * Configuration for building the built-in auth routes.
 */
export interface AuthRoutesConfig {
	/** The user/device store backing the auth routes */
	userStore: UserStore
	/** The token manager for issuing and validating JWTs */
	tokenManager: TokenManager
	/**
	 * Optional challenge store for device verification.
	 * Required for secure device proof-of-possession verification.
	 * If not provided, an in-memory store is created automatically.
	 */
	challengeStore?: ChallengeStore
	/**
	 * Optional rate limiter for authentication endpoints.
	 * If not provided, an in-memory rate limiter is created with defaults
	 * (10 attempts per minute).
	 */
	rateLimiter?: RateLimiter
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

/** Maximum password length to prevent hash-DoS attacks via extremely long passwords. */
const MAX_PASSWORD_LENGTH = 128

/** Maximum length for user/device name fields. */
const MAX_NAME_LENGTH = 200

/** Challenge validity window in milliseconds (60 seconds). */
const CHALLENGE_TTL_MS = 60_000

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
 * Sanitize and limit a name string.
 * Trims whitespace, enforces max length, and strips control characters.
 */
function sanitizeName(name: string): string {
	// Strip ASCII control characters (0x00-0x1F, 0x7F)
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally stripping ASCII control characters for sanitization
	const cleaned = name.replace(/[\x00-\x1f\x7f]/g, '')
	const trimmed = cleaned.trim()
	if (trimmed.length > MAX_NAME_LENGTH) {
		return trimmed.slice(0, MAX_NAME_LENGTH)
	}
	return trimmed
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
 * Security features:
 * - Rate limiting on sign-in/sign-up to prevent brute-force attacks
 * - Server-side challenge store for device verification (single-use, time-limited)
 * - Token revocation on sign-out and device revocation
 * - Input sanitization on all name fields
 * - Maximum password length to prevent hash-DoS
 *
 * @example
 * ```typescript
 * const routes = new BuiltInAuthRoutes({
 *   userStore: new InMemoryUserStore(),
 *   tokenManager: new TokenManager({ secret: TokenManager.generateSecret() }),
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
	private readonly userStore: UserStore
	private readonly tokenManager: TokenManager
	private readonly challengeStore: ChallengeStore
	private readonly rateLimiter: RateLimiter

	constructor(config: AuthRoutesConfig) {
		this.userStore = config.userStore
		this.tokenManager = config.tokenManager
		this.challengeStore = config.challengeStore ?? new InMemoryChallengeStore()
		this.rateLimiter = config.rateLimiter ?? new InMemoryRateLimiter()
	}

	/**
	 * Handle user sign-up (POST /auth/signup).
	 *
	 * Validates email format and password length, hashes the password,
	 * creates the user, optionally registers a device, and issues tokens.
	 *
	 * @param body - Sign-up request body
	 * @param body.email - The user's email address
	 * @param body.password - The plaintext password (8-128 characters)
	 * @param body.name - Optional display name (defaults to email local part)
	 * @param body.deviceId - Optional device ID to register
	 * @param body.devicePublicKey - Optional device public key (base64url)
	 * @param clientIp - Optional client IP for rate limiting
	 * @returns Auth response with the created user and tokens, or an error
	 */
	async handleSignUp(
		body: {
			email: string
			password: string
			name?: string
			deviceId?: string
			devicePublicKey?: string
		},
		clientIp?: string,
	): Promise<AuthRouteResponse<{ user: AuthUser; tokens: AuthTokens }>> {
		// Rate limiting
		const rateLimitKey = clientIp ?? 'global'
		if (!(await this.rateLimiter.isAllowed(rateLimitKey))) {
			return {
				status: 429,
				body: { error: 'Too many requests. Please try again later.' },
			}
		}
		await this.rateLimiter.record(rateLimitKey)

		// Validate email format
		if (!isValidEmail(body.email)) {
			return {
				status: 400,
				body: {
					error:
						'Invalid email address. Please provide a valid email in the format user@domain.com.',
				},
			}
		}

		// Validate password length (min and max)
		if (body.password.length < MIN_PASSWORD_LENGTH) {
			return {
				status: 400,
				body: {
					error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`,
				},
			}
		}

		if (body.password.length > MAX_PASSWORD_LENGTH) {
			return {
				status: 400,
				body: {
					error: `Password must be at most ${MAX_PASSWORD_LENGTH} characters long.`,
				},
			}
		}

		// Hash the password
		const { hash, salt } = await hashPassword(body.password)

		// Sanitize the display name
		const rawName = body.name ?? body.email.split('@')[0] ?? body.email
		const name = sanitizeName(rawName)

		// Create the user — may throw DuplicateEmailError
		let user: AuthUser
		try {
			user = await this.userStore.createUser({
				email: body.email,
				passwordHash: hash,
				salt,
				name,
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

		// Always register a device — use provided info or create a basic record
		await this.userStore.registerDevice({
			id: deviceId,
			userId: user.id,
			publicKey: body.devicePublicKey ?? '',
			name: body.deviceId ? 'Primary Device' : 'Browser',
		})

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
	 * @param clientIp - Optional client IP for rate limiting
	 * @returns Auth response with the user and tokens, or an error
	 */
	async handleSignIn(
		body: {
			email: string
			password: string
			deviceId?: string
			devicePublicKey?: string
		},
		clientIp?: string,
	): Promise<AuthRouteResponse<{ user: AuthUser; tokens: AuthTokens }>> {
		// Rate limiting (use email + IP composite key for per-account protection)
		const rateLimitKey = clientIp
			? `signin:${body.email.toLowerCase()}:${clientIp}`
			: `signin:${body.email.toLowerCase()}`

		if (!(await this.rateLimiter.isAllowed(rateLimitKey))) {
			return {
				status: 429,
				body: { error: 'Too many sign-in attempts. Please try again later.' },
			}
		}
		await this.rateLimiter.record(rateLimitKey)

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

		// Successful login — reset rate limit for this key
		await this.rateLimiter.reset(rateLimitKey)

		// Use provided deviceId or generate a placeholder
		const deviceId = body.deviceId ?? `device-${storedUser.id}`

		// Always register a device — use provided info or create a basic record
		await this.userStore.registerDevice({
			id: deviceId,
			userId: storedUser.id,
			publicKey: body.devicePublicKey ?? '',
			name: body.deviceId ? 'Device' : 'Browser',
		})

		const tokens = this.tokenManager.issueTokens(storedUser.id, deviceId)

		const user: AuthUser = {
			id: storedUser.id,
			email: storedUser.email,
			name: storedUser.name,
			emailVerified: storedUser.emailVerified,
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
	 * (refresh token rotation with reuse detection). The old refresh token
	 * is marked as consumed in the revocation store.
	 *
	 * @param body - Refresh request body
	 * @param body.refreshToken - The current refresh token
	 * @returns Auth response with new tokens, or an error
	 */
	async handleRefresh(body: {
		refreshToken: string
	}): Promise<AuthRouteResponse<AuthTokens>> {
		const result = await this.tokenManager.refreshAccessToken(body.refreshToken)

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
	 * Handle sign-out (POST /auth/signout).
	 *
	 * Validates the access token and revokes the current refresh token
	 * (if a revocation store is configured). This ensures that stolen
	 * refresh tokens cannot be used after the user signs out.
	 *
	 * @param accessToken - The JWT access token (without "Bearer " prefix)
	 * @param body - Sign-out request body
	 * @param body.refreshToken - The current refresh token to revoke
	 * @returns Auth response with success flag, or an error
	 */
	async handleSignOut(
		accessToken: string,
		body: { refreshToken?: string },
	): Promise<AuthRouteResponse<{ success: boolean }>> {
		const payload = this.tokenManager.validateToken(accessToken)
		if (payload === null || payload.type !== 'access') {
			return {
				status: 401,
				body: { error: 'Invalid or expired access token.' },
			}
		}

		// Revoke the access token itself
		await this.tokenManager.revokeToken(payload.jti, payload.exp)

		// Revoke the refresh token if provided
		if (body.refreshToken) {
			const refreshPayload = this.tokenManager.validateToken(body.refreshToken)
			if (refreshPayload !== null && refreshPayload.type === 'refresh') {
				await this.tokenManager.revokeToken(refreshPayload.jti, refreshPayload.exp)
			}
		}

		return {
			status: 200,
			body: { data: { success: true } },
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
			emailVerified: storedUser.emailVerified,
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
	async handleListDevices(accessToken: string): Promise<AuthRouteResponse<AuthDevice[]>> {
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
	 * Validates the access token, revokes the specified device, and invalidates
	 * all tokens issued to that device. Only the device's owner can revoke it.
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

		// Invalidate all tokens for this device
		await this.tokenManager.revokeDeviceTokens(deviceId)

		return {
			status: 200,
			body: { data: { success: true } },
		}
	}

	/**
	 * Handle device registration (POST /auth/device/register).
	 *
	 * Requires a valid access token. Registers a new device for the authenticated
	 * user and issues a device credential token bound to the device's public key.
	 *
	 * @param accessToken - The JWT access token (without "Bearer " prefix)
	 * @param body - Device registration request body
	 * @param body.deviceId - Unique identifier for the device
	 * @param body.publicKey - The device's public key as a JWK JSON string
	 * @param body.name - Human-readable device name (e.g., "Chrome on MacBook")
	 * @returns Auth response with the registered device and device credential, or an error
	 */
	async handleDeviceRegister(
		accessToken: string,
		body: {
			deviceId: string
			publicKey: string
			name: string
		},
	): Promise<AuthRouteResponse<{ device: AuthDevice; deviceCredential: string }>> {
		const payload = this.tokenManager.validateToken(accessToken)
		if (payload === null || payload.type !== 'access') {
			return {
				status: 401,
				body: { error: 'Invalid or expired access token.' },
			}
		}

		// Sanitize the device name
		const deviceName = sanitizeName(body.name)
		if (deviceName.length === 0) {
			return {
				status: 400,
				body: { error: 'Device name must not be empty.' },
			}
		}

		// Parse the JWK JSON string into a JsonWebKey object
		let publicKeyJwk: JsonWebKey
		try {
			publicKeyJwk = JSON.parse(body.publicKey) as JsonWebKey
		} catch {
			return {
				status: 400,
				body: { error: 'Invalid public key format. Expected a JSON-encoded JWK string.' },
			}
		}

		// Compute the SHA-256 thumbprint of the public key for binding to the credential
		let thumbprint: string
		try {
			thumbprint = await computePublicKeyThumbprint(publicKeyJwk)
		} catch {
			return {
				status: 400,
				body: {
					error: 'Failed to compute public key thumbprint. Ensure the key is a valid EC P-256 JWK.',
				},
			}
		}

		// Register the device in the user store
		const device = await this.userStore.registerDevice({
			id: body.deviceId,
			userId: payload.sub,
			publicKey: body.publicKey,
			name: deviceName,
		})

		// Issue a device credential token bound to the public key thumbprint
		const deviceCredential = this.tokenManager.issueDeviceCredential(
			payload.sub,
			body.deviceId,
			thumbprint,
		)

		return {
			status: 201,
			body: { data: { device, deviceCredential } },
		}
	}

	/**
	 * Generate a challenge for device proof-of-possession verification.
	 *
	 * Creates a cryptographically random challenge, stores it server-side with
	 * a 60-second TTL and the target device ID, and returns the challenge string.
	 * The client signs this challenge with its private key and submits it via
	 * {@link handleDeviceVerify}.
	 *
	 * @param accessToken - The JWT access token (without "Bearer " prefix)
	 * @param deviceId - The device this challenge is intended for
	 * @returns Auth response with the challenge string, or an error
	 */
	async handleDeviceChallenge(
		accessToken: string,
		deviceId: string,
	): Promise<AuthRouteResponse<{ challenge: string }>> {
		const payload = this.tokenManager.validateToken(accessToken)
		if (payload === null || payload.type !== 'access') {
			return {
				status: 401,
				body: { error: 'Invalid or expired access token.' },
			}
		}

		// Verify the device exists and belongs to this user
		const device = await this.userStore.findDevice(deviceId)
		if (device === null || device.userId !== payload.sub) {
			return {
				status: 404,
				body: { error: 'Device not found.' },
			}
		}

		if (device.revoked) {
			return {
				status: 403,
				body: { error: 'Device has been revoked.' },
			}
		}

		const challenge = randomBytes(32).toString('hex')
		const expiresAt = Date.now() + CHALLENGE_TTL_MS

		await this.challengeStore.store(challenge, deviceId, expiresAt)

		return {
			status: 200,
			body: { data: { challenge } },
		}
	}

	/**
	 * Handle device proof-of-possession verification (POST /auth/device/verify).
	 *
	 * Verifies that the device holds the private key corresponding to its registered
	 * public key by checking a signed challenge. The challenge must have been previously
	 * issued via {@link handleDeviceChallenge} and is single-use.
	 *
	 * On success, issues fresh tokens for the device.
	 *
	 * @param body - Device verification request body
	 * @param body.deviceId - The ID of the device to verify
	 * @param body.challenge - The challenge string (from handleDeviceChallenge)
	 * @param body.signature - The base64url-encoded ECDSA signature of the challenge
	 * @returns Auth response with fresh tokens on success, or an error
	 */
	async handleDeviceVerify(body: {
		deviceId: string
		challenge: string
		signature: string
	}): Promise<AuthRouteResponse<{ tokens: AuthTokens }>> {
		// Consume the challenge (single-use, time-limited)
		const challengeEntry = await this.challengeStore.consume(body.challenge)
		if (challengeEntry === null) {
			return {
				status: 401,
				body: { error: 'Invalid or expired challenge. Request a new challenge and try again.' },
			}
		}

		// Verify the challenge was issued for this device
		if (challengeEntry.deviceId !== body.deviceId) {
			return {
				status: 401,
				body: { error: 'Challenge was not issued for this device.' },
			}
		}

		// Look up the device in the store
		const device = await this.userStore.findDevice(body.deviceId)
		if (device === null) {
			return {
				status: 404,
				body: { error: 'Device not found.' },
			}
		}

		// Revoked devices cannot verify
		if (device.revoked) {
			return {
				status: 403,
				body: { error: 'Device has been revoked and cannot authenticate.' },
			}
		}

		// Parse the stored public key JWK
		let publicKeyJwk: JsonWebKey
		try {
			publicKeyJwk = JSON.parse(device.publicKey) as JsonWebKey
		} catch {
			return {
				status: 500,
				body: { error: 'Device has an invalid stored public key.' },
			}
		}

		// Verify the signature against the challenge using the device's public key
		let isValid: boolean
		try {
			isValid = await verifyChallenge(publicKeyJwk, body.challenge, body.signature)
		} catch {
			return {
				status: 400,
				body: {
					error:
						'Signature verification failed. The signature or public key format may be invalid.',
				},
			}
		}

		if (!isValid) {
			return {
				status: 401,
				body: { error: 'Invalid signature. Proof-of-possession verification failed.' },
			}
		}

		// Compute thumbprint for the device credential
		let thumbprint: string
		try {
			thumbprint = await computePublicKeyThumbprint(publicKeyJwk)
		} catch {
			return {
				status: 500,
				body: { error: 'Failed to compute public key thumbprint.' },
			}
		}

		// Issue fresh tokens for this device
		const tokens = this.tokenManager.issueTokens(device.userId, device.id, thumbprint)

		return {
			status: 200,
			body: { data: { tokens } },
		}
	}

	/**
	 * Generates a random challenge string for proof-of-possession verification.
	 *
	 * **Deprecated:** Use {@link handleDeviceChallenge} instead, which stores
	 * the challenge server-side with expiry and single-use semantics.
	 *
	 * @returns A 64-character hex string (32 random bytes)
	 */
	static generateChallenge(): string {
		return randomBytes(32).toString('hex')
	}

	/**
	 * Creates a sync server auth provider compatible with `@korajs/server`.
	 *
	 * The returned object implements the `AuthProvider` interface from
	 * `@korajs/server`, validating access tokens and returning an auth
	 * context containing the user ID and device metadata. This bridges
	 * the built-in auth system with the sync server's authentication layer.
	 *
	 * Also checks device revocation status during authentication, ensuring
	 * that revoked devices are rejected even if their tokens haven't expired.
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

				// Check device revocation status
				const device = await userStore.findDevice(payload.dev)
				if (device?.revoked) {
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
