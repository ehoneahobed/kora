import { randomBytes, randomUUID } from 'node:crypto'
import { computePublicKeyThumbprint, verifyChallenge } from '../../device/device-identity'
import type { TokenManager } from '../../tokens/token-manager'
import type { AuthTokens, TokenPayload } from '../../types'
import { hashPassword, verifyPassword } from './password-hash'
import {
	type SyncAuthProvider,
	type SyncScopeOptions,
	type VerifiedSyncClaims,
	resolveSyncGrant,
} from './sync-scopes'
import {
	type AuthDevice,
	type AuthUser,
	DeviceOwnershipError,
	type StoredUser,
	type UserStore,
} from './user-store'

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
	/**
	 * Called after credentials are revoked (sign-out, device revocation, user-wide
	 * revocation). `createKoraAuthServer().bindSyncServer()` uses it to end live
	 * sync sessions (AUTH-11).
	 */
	onRevoke?: (event: AuthRevocationEvent) => void | Promise<void>
	/**
	 * Second-factor verifier (a `TotpManager` fits). When configured, users with
	 * MFA enabled get `{ mfaRequired, mfaToken }` from sign-in instead of tokens,
	 * and only `POST /auth/mfa/verify` issues their session (AUTH-10).
	 */
	mfa?: MfaVerifier
}

/** Second-factor checks used at sign-in. `TotpManager` implements this. */
export interface MfaVerifier {
	isEnabled(userId: string): Promise<boolean>
	verify(userId: string, code: string): Promise<boolean>
	verifyRecoveryCode?(userId: string, recoveryCode: string): Promise<boolean>
}

/** Sign-in result for a user who still has to pass the second factor. */
export interface MfaChallenge {
	mfaRequired: true
	/** Short-lived token accepted only by `POST /auth/mfa/verify`. */
	mfaToken: string
}

/** Successful primary authentication: a session, or an MFA challenge. */
export type SignInResult = { user: AuthUser; tokens: AuthTokens } | MfaChallenge

/**
 * Describes credentials that were just revoked, so live sessions holding them
 * (for example open sync connections) can be terminated.
 */
export type AuthRevocationEvent =
	| { kind: 'device'; userId: string; deviceId: string }
	| { kind: 'user'; userId: string }
	| { kind: 'session'; userId: string; deviceId: string; family: string | null }

/** Result of {@link BuiltInAuthRoutes.authenticateAccess}. */
export interface AuthenticatedAccess {
	/** Verified access-token payload. */
	payload: TokenPayload
	/** The token's user, as stored. */
	user: StoredUser
	/** The token's device record (null when the token was minted without one). */
	device: AuthDevice | null
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
	/**
	 * Either the success payload or an error message. `code` is a stable,
	 * machine-readable Kora error code; clients use it to tell a definitive
	 * rejection from a proxy or captive-portal response.
	 */
	body: { data: T } | { error: string; code?: string }
	/** Optional response headers (for example `Retry-After`). */
	headers?: Record<string, string>
}

/** 401 returned for any unusable access token. */
function invalidAccessToken(): AuthRouteResponse<never> {
	return {
		status: 401,
		body: { error: 'Invalid or expired access token.', code: 'ACCESS_TOKEN_INVALID' },
	}
}

/** Server-assigned default device id: random per sign-in, never derived from the user. */
function generateDeviceId(): string {
	return `dev-${randomUUID()}`
}

function deviceConflict(): AuthRouteResponse<never> {
	return {
		status: 409,
		body: {
			error:
				'This device id is registered to another account. Use a device id generated for this install.',
			code: 'DEVICE_OWNERSHIP_CONFLICT',
		},
	}
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
	// Bodies come from JSON.parse'd network input, not a type-checked call
	// site: a missing or malformed `email` field means this runs with
	// `undefined` at runtime despite the `string` type, and `.length` would
	// throw, crashing the request (and, since httpRoutes handlers aren't
	// wrapped in a try/catch further up, potentially the whole process).
	if (typeof email !== 'string' || email.length === 0 || email.length > 254) {
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
	// Same reasoning as isValidEmail: `name` can come straight from a request
	// body field (handleDeviceRegister's `body.name`), which is untyped at
	// runtime, so guard before calling .replace on something that isn't
	// actually a string.
	if (typeof name !== 'string') {
		return ''
	}
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
	private readonly revokeListeners = new Set<(event: AuthRevocationEvent) => void | Promise<void>>()
	/** Lazily computed hash used to equalize sign-in timing for unknown emails. */
	private dummyCredential: Promise<{ hash: string; salt: string }> | null = null
	private readonly mfa: MfaVerifier | undefined

	constructor(config: AuthRoutesConfig) {
		this.userStore = config.userStore
		this.tokenManager = config.tokenManager
		this.challengeStore = config.challengeStore ?? new InMemoryChallengeStore()
		this.rateLimiter = config.rateLimiter ?? new InMemoryRateLimiter()
		if (config.onRevoke) this.revokeListeners.add(config.onRevoke)
		this.mfa = config.mfa
	}

	/**
	 * Finish a successful primary authentication (password, OAuth): issue a
	 * session, or an MFA challenge when the user is enrolled in MFA. No
	 * full-privilege token is ever issued to an MFA user without a fresh second
	 * factor.
	 *
	 * @param user - The authenticated user
	 * @param deviceId - The (already registered) device
	 * @param amr - Methods satisfied so far (for example `['pwd']`)
	 */
	async completePrimaryAuthentication(
		user: AuthUser,
		deviceId: string,
		amr: string[],
	): Promise<AuthRouteResponse<SignInResult>> {
		if (this.mfa && (await this.mfa.isEnabled(user.id))) {
			return {
				status: 200,
				body: {
					data: {
						mfaRequired: true,
						mfaToken: this.tokenManager.issueMfaPendingToken(user.id, deviceId, amr),
					},
				},
			}
		}
		const tokens = this.tokenManager.issueTokens(user.id, deviceId, undefined, { amr })
		return { status: 200, body: { data: { user, tokens } } }
	}

	/**
	 * Handle the second factor (POST /auth/mfa/verify).
	 *
	 * Exchanges an `mfa_pending` token plus a TOTP code (or recovery code) for a
	 * session whose tokens carry `amr` including `otp` (or `rcv`). The pending
	 * token is redeemed once; a wrong code can be retried until it expires.
	 */
	async handleMfaVerify(body: {
		mfaToken?: unknown
		code?: unknown
		recoveryCode?: unknown
	}): Promise<AuthRouteResponse<{ user: AuthUser; tokens: AuthTokens }>> {
		const invalidToken: AuthRouteResponse<never> = {
			status: 401,
			body: { error: 'Invalid or expired MFA session. Sign in again.', code: 'MFA_TOKEN_INVALID' },
		}
		if (!this.mfa || typeof body?.mfaToken !== 'string') return invalidToken
		const pending = await this.tokenManager.verifyMfaPendingToken(body.mfaToken)
		if (!pending) return invalidToken

		const storedUser = await this.userStore.findById(pending.sub)
		const device = await this.userStore.findDevice(pending.dev)
		if (!storedUser || (device && (device.revoked || device.userId !== pending.sub))) {
			return invalidToken
		}

		let method: 'otp' | 'rcv' | null = null
		if (typeof body.code === 'string' && (await this.mfa.verify(pending.sub, body.code))) {
			method = 'otp'
		} else if (
			typeof body.recoveryCode === 'string' &&
			this.mfa.verifyRecoveryCode &&
			(await this.mfa.verifyRecoveryCode(pending.sub, body.recoveryCode))
		) {
			method = 'rcv'
		}
		if (method === null) {
			return { status: 401, body: { error: 'Invalid MFA code.', code: 'MFA_CODE_INVALID' } }
		}
		if (!(await this.tokenManager.redeemMfaPendingToken(pending))) return invalidToken

		const tokens = this.tokenManager.issueTokens(pending.sub, pending.dev, undefined, {
			amr: [...new Set([...pending.amr, method])],
		})
		const user: AuthUser = {
			id: storedUser.id,
			email: storedUser.email,
			name: storedUser.name,
			emailVerified: storedUser.emailVerified,
			createdAt: storedUser.createdAt,
		}
		return { status: 200, body: { data: { user, tokens } } }
	}

	/**
	 * Subscribe to credential revocations (sign-out, device revocation,
	 * user-wide revocation).
	 *
	 * @param listener - Called after each revocation is persisted
	 * @returns An unsubscribe function
	 */
	onRevoke(listener: (event: AuthRevocationEvent) => void | Promise<void>): () => void {
		this.revokeListeners.add(listener)
		return () => {
			this.revokeListeners.delete(listener)
		}
	}

	/**
	 * Authenticate an access token for any request-authorization path.
	 *
	 * The single check used by every HTTP route and by the sync provider: it
	 * verifies signature and expiry, the token's own revocation, its family, the
	 * device cut-off, the per-user cut-off, that the user still exists, and that
	 * the device record is neither revoked nor owned by someone else.
	 *
	 * @param token - Raw access token (without "Bearer ")
	 * @returns The verified access, or null when the token must be rejected
	 */
	async authenticateAccess(token: string): Promise<AuthenticatedAccess | null> {
		if (typeof token !== 'string' || token.length === 0) return null
		const payload = await this.tokenManager.validateTokenWithRevocation(token)
		if (payload === null || payload.type !== 'access') return null
		const user = await this.userStore.findById(payload.sub)
		if (user === null) return null
		const device = await this.userStore.findDevice(payload.dev)
		if (device && (device.revoked || device.userId !== payload.sub)) return null
		return { payload, user, device }
	}

	/**
	 * Revoke every credential a user holds (password reset or change, admin
	 * session revocation, account deletion) and notify revocation listeners.
	 *
	 * @param userId - The user whose sessions end now
	 */
	async revokeAllForUser(userId: string): Promise<void> {
		await this.tokenManager.revokeAllForUser(userId)
		await this.emitRevoke({ kind: 'user', userId })
	}

	private async emitRevoke(event: AuthRevocationEvent): Promise<void> {
		for (const listener of this.revokeListeners) {
			try {
				await listener(event)
			} catch (error) {
				// A failing listener (for example a sync server that is shutting down)
				// must not undo or block the revocation itself, but it must be visible.
				console.error('[kora] auth revocation listener failed', error)
			}
		}
	}

	/**
	 * Register the device for a successful primary authentication, refusing ids
	 * owned by another user.
	 */
	private async registerSignInDevice(params: {
		userId: string
		deviceId: string | undefined
		publicKey: string | undefined
		named: string
	}): Promise<string | AuthRouteResponse<never>> {
		const deviceId =
			typeof params.deviceId === 'string' && params.deviceId.length > 0
				? params.deviceId
				: generateDeviceId()
		try {
			await this.userStore.registerDevice({
				id: deviceId,
				userId: params.userId,
				publicKey: params.publicKey ?? '',
				name: params.named,
			})
		} catch (error) {
			if (error instanceof DeviceOwnershipError) return deviceConflict()
			throw error
		}
		return deviceId
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

		// Validate password length (min and max). Same runtime-untyped-body
		// reasoning as the email check above: a missing password must not crash
		// this length check.
		if (typeof body.password !== 'string' || body.password.length < MIN_PASSWORD_LENGTH) {
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

		// A client-chosen id must be owned by this user; without one the server
		// assigns a random id (never `device-${userId}`, which every browser of the
		// user would share).
		const deviceId = await this.registerSignInDevice({
			userId: user.id,
			deviceId: body.deviceId,
			publicKey: body.devicePublicKey,
			named: body.deviceId ? 'Primary Device' : 'Browser',
		})
		if (typeof deviceId !== 'string') return deviceId

		// Issue tokens
		const tokens = this.tokenManager.issueTokens(user.id, deviceId, undefined, { amr: ['pwd'] })

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
	): Promise<AuthRouteResponse<SignInResult>> {
		// Request bodies are untyped at runtime (JSON.parse'd network input, not
		// a checked call site), so a missing/malformed `email` or `password`
		// field reaches here as `undefined` despite the `string` type. Reject it
		// before it's used, rather than crashing on `.toLowerCase()` below.
		if (typeof body.email !== 'string' || typeof body.password !== 'string') {
			return {
				status: 400,
				body: { error: 'Email and password are required.' },
			}
		}

		// Two independent limits (AUTH-9): one per account, so rotating source IPs
		// cannot buy unlimited guesses against one user, and one per client IP, so
		// one client cannot spray many accounts. The IP must come from a trusted
		// source (the socket, or a configured proxy hop), never a raw header.
		const accountKey = `signin:account:${body.email.trim().toLowerCase()}`
		const ipKey = clientIp ? `signin:ip:${clientIp}` : null
		if (
			!(await this.rateLimiter.isAllowed(accountKey)) ||
			(ipKey !== null && !(await this.rateLimiter.isAllowed(ipKey)))
		) {
			return {
				status: 429,
				body: {
					error: 'Too many sign-in attempts. Please try again later.',
					code: 'RATE_LIMITED',
				},
				headers: { 'Retry-After': '60' },
			}
		}
		await this.rateLimiter.record(accountKey)
		if (ipKey !== null) await this.rateLimiter.record(ipKey)

		const storedUser = await this.userStore.findByEmail(body.email)
		// Always run the password KDF, against a fixed dummy credential when the
		// account does not exist, so response time does not reveal registration.
		const credential = storedUser
			? { hash: storedUser.passwordHash, salt: storedUser.salt }
			: await this.getDummyCredential()
		const passwordValid = await verifyPassword(body.password, credential.hash, credential.salt)
		if (storedUser === null || !passwordValid) {
			return {
				status: 401,
				body: { error: 'Invalid email or password.', code: 'INVALID_CREDENTIALS' },
			}
		}

		// Successful login: clear this account's failure budget only.
		await this.rateLimiter.reset(accountKey)

		const deviceId = await this.registerSignInDevice({
			userId: storedUser.id,
			deviceId: body.deviceId,
			publicKey: body.devicePublicKey,
			named: body.deviceId ? 'Device' : 'Browser',
		})
		if (typeof deviceId !== 'string') return deviceId

		const user: AuthUser = {
			id: storedUser.id,
			email: storedUser.email,
			name: storedUser.name,
			emailVerified: storedUser.emailVerified,
			createdAt: storedUser.createdAt,
		}

		return this.completePrimaryAuthentication(user, deviceId, ['pwd'])
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
		const rejected: AuthRouteResponse<never> = {
			status: 401,
			body: { error: 'Invalid or expired refresh token.', code: 'REFRESH_TOKEN_INVALID' },
		}
		const refreshToken = body?.refreshToken
		const presented =
			typeof refreshToken === 'string' ? this.tokenManager.validateToken(refreshToken) : null
		if (presented === null || presented.type !== 'refresh') {
			return rejected
		}

		// The device and the user must still be in good standing (AUTH-2): a revoked
		// device keeps no refresh rights, whatever the revocation store says.
		const user = await this.userStore.findById(presented.sub)
		const device = await this.userStore.findDevice(presented.dev)
		if (user === null || (device && (device.revoked || device.userId !== presented.sub))) {
			return rejected
		}

		const result = await this.tokenManager.rotateRefreshToken(refreshToken as string)
		if (!result.ok) {
			if (result.reason === 'in_progress') {
				// A duplicate of a rotation still running on this instance: transient.
				return {
					status: 409,
					body: { error: 'A refresh with this token is in progress.', code: 'REFRESH_IN_PROGRESS' },
					headers: { 'Retry-After': '1' },
				}
			}
			return rejected
		}

		return {
			status: 200,
			body: { data: result.tokens },
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
		const access = await this.authenticateAccess(accessToken)
		if (access === null) {
			return invalidAccessToken()
		}
		const { payload } = access

		// Revoke the access token itself
		await this.tokenManager.revokeToken(payload.jti, payload.exp)

		// Revoke the refresh token if provided, and its whole family, so a successor
		// minted by a just-completed rotation (or its grace replay) dies with it.
		let refreshExp = payload.exp
		if (body?.refreshToken) {
			const refreshPayload = this.tokenManager.validateToken(body.refreshToken)
			if (
				refreshPayload !== null &&
				refreshPayload.type === 'refresh' &&
				refreshPayload.sub === payload.sub
			) {
				await this.tokenManager.revokeToken(refreshPayload.jti, refreshPayload.exp)
				refreshExp = Math.max(refreshExp, refreshPayload.exp)
				if (refreshPayload.fam) {
					await this.tokenManager.revokeFamily(refreshPayload.fam, refreshPayload.exp)
				}
			}
		}
		if (payload.fam) {
			await this.tokenManager.revokeFamily(payload.fam, refreshExp)
		}
		await this.emitRevoke({
			kind: 'session',
			userId: payload.sub,
			deviceId: payload.dev,
			family: payload.fam ?? null,
		})

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
		const access = await this.authenticateAccess(accessToken)
		if (access === null) {
			return invalidAccessToken()
		}
		const storedUser = access.user

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
		const access = await this.authenticateAccess(accessToken)
		if (access === null) {
			return invalidAccessToken()
		}

		const devices = await this.userStore.listDevices(access.payload.sub)

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
		const access = await this.authenticateAccess(accessToken)
		if (access === null) {
			return invalidAccessToken()
		}
		const { payload } = access

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

		// Invalidate every token issued to this device so far. A later sign-in on
		// the same device issues fresh tokens that are accepted (NEW-AUTH-1).
		await this.tokenManager.revokeDeviceTokens(deviceId)
		await this.emitRevoke({ kind: 'device', userId: payload.sub, deviceId })

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
		const access = await this.authenticateAccess(accessToken)
		if (access === null) {
			return invalidAccessToken()
		}
		const { payload } = access

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

		// Register the device in the user store (refused if another user owns the id)
		let device: AuthDevice
		try {
			device = await this.userStore.registerDevice({
				id: body.deviceId,
				userId: payload.sub,
				publicKey: body.publicKey,
				name: deviceName,
			})
		} catch (error) {
			if (error instanceof DeviceOwnershipError) return deviceConflict()
			throw error
		}

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
		const access = await this.authenticateAccess(accessToken)
		if (access === null) {
			return invalidAccessToken()
		}
		const { payload } = access

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

	private getDummyCredential(): Promise<{ hash: string; salt: string }> {
		if (!this.dummyCredential) {
			this.dummyCredential = hashPassword(randomUUID())
		}
		return this.dummyCredential
	}

	/**
	 * Creates a sync server auth provider compatible with `@korajs/server`.
	 *
	 * The returned object implements the `AuthProvider` interface from
	 * `@korajs/server`, validating access tokens and returning an auth
	 * context containing the user ID, device metadata and a SERVER-DERIVED
	 * scope grant. The client handshake can only narrow that grant (AUTH-1).
	 *
	 * By default the grant binds every schema-scoped collection from
	 * `{ userId: <verified sub> }`. Collections scoped by any other key (for
	 * example `orgId`) are denied until `scopeValues` or `resolveScopes`
	 * supplies it; they are never widened to "every tenant".
	 *
	 * Also checks device revocation status during authentication, ensuring
	 * that revoked devices are rejected even if their tokens haven't expired.
	 *
	 * @param options - Optional server-side scope derivation
	 * @returns An object with an `authenticate` method suitable for KoraSyncServer's `auth` config
	 *
	 * @example
	 * ```typescript
	 * const routes = new BuiltInAuthRoutes({ userStore, tokenManager })
	 * const syncServer = new KoraSyncServer({
	 *   store,
	 *   auth: routes.toSyncAuthProvider({
	 *     scopeValues: async ({ userId }) => ({ orgId: await orgOf(userId) }),
	 *   }),
	 * })
	 * ```
	 */
	toSyncAuthProvider(options: SyncScopeOptions = {}): SyncAuthProvider {
		return {
			authenticate: async (token: string) => {
				const authenticated = await this.authenticateAccess(token)
				if (!authenticated) {
					return null
				}
				const { user, payload } = authenticated

				// Touch the device to update last-seen timestamp
				await this.userStore.touchDevice(payload.dev)

				const claims: VerifiedSyncClaims = {
					userId: payload.sub,
					deviceId: payload.dev,
					email: user.email,
					name: user.name,
				}
				const scopes = await resolveSyncGrant(claims, options)

				return {
					userId: payload.sub,
					scopes,
					expiresAt: payload.exp * 1000,
					metadata: {
						deviceId: payload.dev,
						email: user.email,
						name: user.name,
					},
				}
			},
			onRevoke: (listener) =>
				this.onRevoke((event) =>
					listener(
						event.kind === 'user'
							? { userId: event.userId }
							: { userId: event.userId, deviceId: event.deviceId },
					),
				),
		}
	}
}
