import { KoraError } from '@korajs/core'
import type { AuthDeviceIdentityProvider } from './device-session'

// ---------------------------------------------------------------------------
// Auth-specific error
// ---------------------------------------------------------------------------

/**
 * Thrown when an authentication operation fails.
 * Includes a machine-readable code and optional context for debugging.
 */
export class AuthError extends KoraError {
	constructor(message: string, code: string, context?: Record<string, unknown>) {
		super(message, code, context)
		this.name = 'AuthError'
	}
}

/**
 * Thrown by sign-in when the account requires a second factor (AUTH-10).
 * Complete it with {@link AuthClient.verifyMfa} using {@link mfaToken}.
 */
export class MfaRequiredError extends AuthError {
	constructor(public readonly mfaToken: string) {
		super('A second factor is required to finish signing in.', 'AUTH_MFA_REQUIRED')
		this.name = 'MfaRequiredError'
	}
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Possible authentication states for the client.
 * - 'loading': Initial state while restoring tokens from storage
 * - 'authenticated': A session exists. It may be fresh or offline; see
 *   {@link AuthClient.session} for the freshness of its credentials.
 * - 'unauthenticated': No session exists (never signed in, signed out, or the
 *   auth server definitively rejected the session)
 */
export type AuthState = 'loading' | 'authenticated' | 'unauthenticated'

/**
 * Freshness of an authenticated session.
 * - 'fresh': the last refresh or profile request reached the auth server
 * - 'offline': authenticated-offline. The identity is known from stored
 *   credentials, but no fresh access token can be minted right now (network,
 *   timeout, 5xx, captive portal...). Local data stays available; sync waits.
 * - 'locked': offline for longer than `maxOfflineGraceMs`, or the device clock
 *   moved backwards. The UI should lock; local data is never wiped.
 */
export type AuthSessionStatus = 'fresh' | 'offline' | 'locked'

/**
 * The identity of the stored session, independent of token freshness.
 */
export interface AuthClientSession {
	/** User id (`sub` of the stored credentials). */
	userId: string
	/** Device id (`dev` of the stored credentials), when known. */
	deviceId: string | null
	/** Freshness of the credentials. */
	status: AuthSessionStatus
	/** Last successful contact with the auth server (ms since epoch). */
	lastServerContactAt: number
}

/**
 * Authenticated user information.
 */
export interface AuthUser {
	/** Unique user identifier */
	id: string

	/** User email address */
	email: string

	/** Display name (may be absent if user did not provide one) */
	name: string | null
}

export interface LinkedOAuthAccount {
	id: string
	userId: string
	provider: string
	providerUserId: string
	email: string | null
	linkedAt: number
}

export interface OAuthAuthorizationResult {
	url: string
	state: string
	/**
	 * Client binding for this flow (AUTH-3). The client keeps it (session storage
	 * on the web, memory on native) and presents it with the callback; a callback
	 * carrying someone else's code and state is then refused.
	 */
	binding?: string
}

export interface OAuthAuthorizationOptions {
	/**
	 * Redirect the current browser window to the provider after creating the URL.
	 * Defaults to true when `window.location.assign` is available.
	 */
	redirect?: boolean
	/**
	 * Optional app-specific return path stored in OAuth state metadata.
	 */
	returnTo?: string
	/**
	 * Optional extra metadata stored in OAuth state. Use this for app handoff data.
	 */
	metadata?: Record<string, unknown>
	deviceId?: string
	devicePublicKey?: string
}

export interface OAuthCallbackParams {
	code: string
	state: string
	/** Flow binding; looked up from the started flow when omitted. */
	binding?: string
	deviceId?: string
	devicePublicKey?: string
}

/**
 * Configuration for the AuthClient.
 */
export interface AuthClientConfig {
	/** Base URL of the auth server (e.g. 'http://localhost:3001') */
	serverUrl: string

	/** Storage key prefix for tokens. Defaults to 'kora_auth' */
	storageKey?: string

	/**
	 * Optional token storage adapter.
	 *
	 * Use this for runtimes where localStorage is not the right place for
	 * credentials, such as React Native/Expo SecureStore, iOS Keychain,
	 * Android Keystore, or a Tauri secure storage plugin.
	 */
	storage?: AuthTokenStorage

	/**
	 * Optional fetch implementation. Defaults to globalThis.fetch.
	 * Useful for tests, SSR adapters, and mobile runtimes with a custom fetch.
	 */
	fetch?: typeof fetch

	/**
	 * Optional local device identity provider.
	 *
	 * When configured, sign-up and sign-in automatically include stable
	 * `deviceId` and `devicePublicKey` fields unless the caller provides them.
	 */
	deviceIdentity?: AuthDeviceIdentityProvider

	/**
	 * Timeout for every auth request, in milliseconds. A request that has not
	 * answered by then is aborted and treated as a transient failure.
	 * @default 20000
	 */
	requestTimeoutMs?: number

	/**
	 * How long a session may stay authenticated-offline (no successful contact
	 * with the auth server) before it is `locked`. Locking never wipes local data
	 * or tokens; it only tells the UI to ask the user to reconnect.
	 * Defaults to no limit beyond the refresh token's own expiry.
	 */
	maxOfflineGraceMs?: number

	/**
	 * Backoff between refresh attempts after transient failures. The first retry
	 * after a failure is immediate (it recovers a response lost on the wire);
	 * later ones back off exponentially with jitter, honouring `Retry-After`.
	 */
	refreshBackoff?: { baseDelayMs?: number; maxDelayMs?: number }
}

type MaybePromise<T> = T | Promise<T>

/**
 * Token pair returned by the auth server on sign-up, sign-in, and refresh.
 */
interface AuthTokensResponse {
	accessToken: string
	refreshToken: string
}

/**
 * Sign-up and sign-in responses include user data alongside tokens.
 */
interface AuthSignInResponse {
	user: { id: string; email: string; name: string | null }
	tokens: AuthTokensResponse
}

interface OAuthSignInResponse extends AuthSignInResponse {
	identity: LinkedOAuthAccount
}

interface MfaChallengeResponse {
	mfaRequired: true
	mfaToken: string
}

/**
 * User profile returned by the /auth/me endpoint.
 */
interface UserProfileResponse {
	id: string
	email: string
	name: string | null
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Number of seconds before actual expiry at which we consider a token expired. */
const EXPIRY_BUFFER_SECONDS = 30

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000
const DEFAULT_BACKOFF_BASE_MS = 2_000
const DEFAULT_BACKOFF_MAX_MS = 5 * 60_000

/**
 * Tolerated backwards clock movement before a session is treated as tampered.
 * Matches the server's own skew allowance order of magnitude.
 */
const CLOCK_ROLLBACK_TOLERANCE_MS = 5 * 60_000

/**
 * Decode the payload portion of a JWT without verifying the signature.
 * Client-side only -- verification is the server's responsibility.
 *
 * Returns null if the token is malformed.
 */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
	const parts = token.split('.')
	if (parts.length !== 3) {
		return null
	}

	try {
		// Base64url -> standard base64
		const base64 = (parts[1] as string).replace(/-/g, '+').replace(/_/g, '/')
		const json = atob(base64)
		const parsed: unknown = JSON.parse(json)
		return isRecord(parsed) ? parsed : null
	} catch {
		return null
	}
}

/**
 * Returns true if the JWT's `exp` claim is in the past (with a small buffer).
 * If the token cannot be decoded, returns true (treat as expired).
 */
function isTokenExpired(token: string, bufferSeconds = EXPIRY_BUFFER_SECONDS): boolean {
	const payload = decodeJwtPayload(token)
	if (!payload || typeof payload.exp !== 'number') {
		return true
	}
	const nowSeconds = Math.floor(Date.now() / 1000)
	return payload.exp <= nowSeconds + bufferSeconds
}

/** Issue time of a token in ms, from `iatMs` or `iat`. */
function tokenIssuedAtMs(token: string): number | null {
	const payload = decodeJwtPayload(token)
	if (!payload) return null
	if (typeof payload.iatMs === 'number') return payload.iatMs
	return typeof payload.iat === 'number' ? payload.iat * 1000 : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getDefaultFetch(): typeof fetch {
	if (typeof globalThis.fetch !== 'function') {
		return async () => {
			throw new AuthError(
				'No fetch implementation is available in this runtime. Pass `fetch` to AuthClientConfig.',
				'AUTH_FETCH_UNAVAILABLE',
			)
		}
	}
	return globalThis.fetch.bind(globalThis)
}

function normalizeAuthUser(user: { id: string; email: string; name?: string | null }): AuthUser {
	return {
		id: user.id,
		email: user.email,
		name: user.name ?? null,
	}
}

function canRedirectCurrentWindow(): boolean {
	return (
		typeof globalThis.window !== 'undefined' &&
		typeof globalThis.window.location?.assign === 'function'
	)
}

function redirectCurrentWindow(url: string): void {
	if (!canRedirectCurrentWindow()) {
		throw new AuthError(
			'OAuth redirect is not available in this runtime. Pass redirect: false and open the returned URL with your platform browser API.',
			'AUTH_OAUTH_REDIRECT_UNAVAILABLE',
		)
	}
	globalThis.window.location.assign(url)
}

const OAUTH_BINDING_PREFIX = 'kora_oauth_binding:'

function getSessionStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
	try {
		const storage = (globalThis as { sessionStorage?: Storage }).sessionStorage
		return storage && typeof storage.getItem === 'function' ? storage : null
	} catch {
		return null
	}
}

// ---------------------------------------------------------------------------
// Refresh outcome classification (AUTH-13, LMS-1)
// ---------------------------------------------------------------------------

/**
 * Outcome of one refresh attempt. Only `rejected` ends a session, and only when
 * the auth server itself said so.
 */
type RefreshOutcome =
	| { kind: 'ok'; accessToken: string }
	| { kind: 'rejected' }
	| { kind: 'transient'; retryAfterMs?: number }

/** Body codes the Kora auth server uses to reject a refresh token. */
const DEFINITIVE_REFRESH_CODES = new Set(['REFRESH_TOKEN_INVALID', 'invalid_grant'])

interface RawResponse {
	status: number
	ok: boolean
	/** Parsed JSON body, or undefined when the body is not JSON (proxy/captive portal). */
	json: unknown
	retryAfterMs?: number
}

/**
 * A response is a definitive rejection only when it is a 401 (or a 400
 * `invalid_grant`) whose body is a Kora JSON error. Captive portals, proxies and
 * load balancers also answer 401/403/407 or HTML, and must never sign a user out.
 */
function isDefinitiveRejection(response: RawResponse): boolean {
	if (!isRecord(response.json)) return false
	const code = typeof response.json.code === 'string' ? response.json.code : undefined
	const error = typeof response.json.error === 'string' ? response.json.error : undefined
	if (response.status === 401) return code !== undefined || error !== undefined
	if (response.status === 400) {
		return (
			(code !== undefined && DEFINITIVE_REFRESH_CODES.has(code)) ||
			(error !== undefined && DEFINITIVE_REFRESH_CODES.has(error))
		)
	}
	return false
}

function parseRetryAfter(value: string | null | undefined): number | undefined {
	if (!value) return undefined
	const seconds = Number(value)
	if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
	const date = Date.parse(value)
	return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now())
}

function readTokenPair(json: unknown): AuthTokensResponse | null {
	if (!isRecord(json)) return null
	const data = json.data !== undefined ? json.data : json
	if (!isRecord(data)) return null
	return typeof data.accessToken === 'string' && typeof data.refreshToken === 'string'
		? { accessToken: data.accessToken, refreshToken: data.refreshToken }
		: null
}

// ---------------------------------------------------------------------------
// Single refresher across tabs (NEW-AUTH-2)
// ---------------------------------------------------------------------------

interface WebLockManager {
	request<T>(
		name: string,
		options: { signal?: AbortSignal },
		callback: () => Promise<T>,
	): Promise<T>
}

/** In-realm fallback when Web Locks are unavailable: one chain per token storage. */
const inProcessLocks = new WeakMap<object, Promise<unknown>>()

function getWebLocks(): WebLockManager | null {
	const nav = (globalThis as { navigator?: { locks?: unknown } }).navigator
	const locks = nav?.locks
	if (typeof locks !== 'object' || locks === null) return null
	return typeof (locks as { request?: unknown }).request === 'function'
		? (locks as WebLockManager)
		: null
}

// ---------------------------------------------------------------------------
// Simple token storage backed by localStorage (browser) or in-memory fallback
// ---------------------------------------------------------------------------

export interface AuthTokenStorage {
	getAccessToken(): MaybePromise<string | null>
	getRefreshToken(): MaybePromise<string | null>
	setTokens(access: string, refresh: string): MaybePromise<void>
	clear(): MaybePromise<void>
}

function createTokenStorage(prefix: string): AuthTokenStorage {
	// Try localStorage; fall back to in-memory if unavailable (SSR, Web Worker, etc.)
	let useLocalStorage = false
	try {
		if (typeof window !== 'undefined' && typeof window.localStorage !== 'undefined') {
			// Smoke test: ensure we can actually write
			const testKey = `${prefix}_test`
			window.localStorage.setItem(testKey, '1')
			window.localStorage.removeItem(testKey)
			useLocalStorage = true
		}
	} catch {
		// localStorage not available (e.g., Safari private browsing throws in some contexts)
	}

	if (useLocalStorage) {
		const accessKey = `${prefix}_access_token`
		const refreshKey = `${prefix}_refresh_token`
		return {
			getAccessToken(): string | null {
				return window.localStorage.getItem(accessKey)
			},
			getRefreshToken(): string | null {
				return window.localStorage.getItem(refreshKey)
			},
			setTokens(access: string, refresh: string): void {
				window.localStorage.setItem(accessKey, access)
				window.localStorage.setItem(refreshKey, refresh)
			},
			clear(): void {
				window.localStorage.removeItem(accessKey)
				window.localStorage.removeItem(refreshKey)
			},
		}
	}

	// In-memory fallback
	let accessToken: string | null = null
	let refreshToken: string | null = null
	return {
		getAccessToken(): string | null {
			return accessToken
		},
		getRefreshToken(): string | null {
			return refreshToken
		},
		setTokens(access: string, refresh: string): void {
			accessToken = access
			refreshToken = refresh
		},
		clear(): void {
			accessToken = null
			refreshToken = null
		},
	}
}

// ---------------------------------------------------------------------------
// AuthClient
// ---------------------------------------------------------------------------

/**
 * Client-side authentication manager for Kora.js.
 *
 * Manages token storage, session restoration, sign-up, sign-in, sign-out,
 * token refresh, and auth state change notifications. Framework-agnostic --
 * works in any JavaScript environment with `fetch` and optionally `localStorage`.
 *
 * Offline-first session rules (AUTH-13):
 * - Only the auth server ends a session: tokens are cleared only on a 401 (or a
 *   400 `invalid_grant`) carrying a Kora JSON error, on an explicit sign-out, or
 *   when the refresh token itself has expired.
 * - Every other failure (no network, timeout, abort, 5xx, 429, 511, HTML from a
 *   captive portal) keeps the tokens, keeps the user signed in as
 *   authenticated-offline and retries with jittered backoff.
 * - One tab refreshes at a time (Web Locks); the others adopt its result.
 *
 * @example
 * ```typescript
 * const auth = new AuthClient({ serverUrl: 'http://localhost:3001' })
 * await auth.initialize()
 *
 * if (!auth.isAuthenticated) {
 *   await auth.signIn({ email: 'user@example.com', password: 'secret' })
 * }
 *
 * const unsub = auth.onAuthChange((state) => {
 *   console.log('Auth state:', state)
 * })
 * ```
 */
export class AuthClient {
	private readonly serverUrl: string
	private readonly storage: AuthTokenStorage
	private readonly fetchFn: typeof fetch
	private readonly deviceIdentity: AuthDeviceIdentityProvider | undefined
	private readonly listeners: Set<(state: AuthState) => void> = new Set()
	private readonly sessionListeners: Set<(session: AuthClientSession | null) => void> = new Set()
	private readonly requestTimeoutMs: number
	private readonly maxOfflineGraceMs: number | undefined
	private readonly backoffBaseMs: number
	private readonly backoffMaxMs: number
	private readonly lockName: string

	private _state: AuthState = 'loading'
	private _user: AuthUser | null = null
	private _refreshPromise: Promise<RefreshOutcome> | null = null
	private _initialized = false

	private sessionStatus: AuthSessionStatus = 'fresh'
	private lastServerContactAt = 0
	private failureCount = 0
	private nextAttemptAt = 0
	private retryTimer: ReturnType<typeof setTimeout> | null = null
	private readonly detachEnvironment: () => void

	/**
	 * Creates a new AuthClient.
	 *
	 * @param config - Auth client configuration
	 */
	constructor(config: AuthClientConfig) {
		// Strip trailing slash to normalize URLs
		this.serverUrl = config.serverUrl.replace(/\/+$/, '')
		const prefix = config.storageKey ?? 'kora_auth'
		this.storage = config.storage ?? createTokenStorage(prefix)
		this.fetchFn = config.fetch ?? getDefaultFetch()
		this.deviceIdentity = config.deviceIdentity
		this.requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
		this.maxOfflineGraceMs = config.maxOfflineGraceMs
		this.backoffBaseMs = config.refreshBackoff?.baseDelayMs ?? DEFAULT_BACKOFF_BASE_MS
		this.backoffMaxMs = config.refreshBackoff?.maxDelayMs ?? DEFAULT_BACKOFF_MAX_MS
		this.lockName = `kora-auth-refresh:${prefix}`
		this.detachEnvironment = this.attachEnvironmentListeners()
	}

	// -----------------------------------------------------------------------
	// Public getters
	// -----------------------------------------------------------------------

	/** Current authentication state. */
	get state(): AuthState {
		return this._state
	}

	/** Current authenticated user, or null if not signed in. */
	get currentUser(): AuthUser | null {
		return this._user
	}

	/** Whether the user is currently authenticated (fresh or offline). */
	get isAuthenticated(): boolean {
		return this._state === 'authenticated'
	}

	/**
	 * The stored session identity and its freshness, or null when signed out.
	 * Unlike {@link getAccessToken}, this is available offline: the identity is
	 * decoupled from whether a fresh access token can be minted right now.
	 */
	get session(): AuthClientSession | null {
		if (this._state !== 'authenticated' || !this._user) return null
		return {
			userId: this._user.id,
			deviceId: this.cachedDeviceId,
			status: this.sessionStatus,
			lastServerContactAt: this.lastServerContactAt,
		}
	}

	private cachedDeviceId: string | null = null

	/**
	 * Read the stored session identity (user id and device id) from storage,
	 * without any network request. Returns null when no usable session is stored.
	 */
	async getStoredIdentity(): Promise<{ userId: string; deviceId: string | null } | null> {
		const claims = await this.getStoredClaims()
		if (!claims || typeof claims.sub !== 'string' || claims.sub.length === 0) return null
		return {
			userId: claims.sub,
			deviceId: typeof claims.dev === 'string' && claims.dev.length > 0 ? claims.dev : null,
		}
	}

	/**
	 * Decoded (unverified) claims of the stored credentials, preferring the access
	 * token even when it has expired. For client-side hints only (local database
	 * name, sync node id, handshake scope narrowing); the server re-derives
	 * everything it authorizes from a verified token.
	 */
	async getStoredClaims(): Promise<Record<string, unknown> | null> {
		const access = await this.storage.getAccessToken()
		const refresh = await this.storage.getRefreshToken()
		if (!refresh) return null
		for (const token of [access, refresh]) {
			if (!token) continue
			const claims = decodeJwtPayload(token)
			if (claims && typeof claims.sub === 'string' && claims.sub.length > 0) return claims
		}
		return null
	}

	// -----------------------------------------------------------------------
	// Initialization
	// -----------------------------------------------------------------------

	/**
	 * Initialize the auth client by restoring a session from stored tokens.
	 *
	 * Loads tokens from storage, validates the access token, and attempts a
	 * refresh if the access token is expired but a refresh token is available.
	 * When the auth server cannot be reached, the stored session is restored as
	 * authenticated-offline instead of being discarded.
	 * Safe to call multiple times -- subsequent calls are no-ops once initialized.
	 */
	async initialize(): Promise<void> {
		// Guard against double initialization (e.g., React StrictMode double-mount)
		if (this._initialized) {
			return
		}
		this._initialized = true

		const accessToken = await this.storage.getAccessToken()
		const refreshToken = await this.storage.getRefreshToken()

		// No stored tokens -- stay unauthenticated
		if (!accessToken || !refreshToken) {
			this.setState('unauthenticated', null)
			return
		}
		this.noteIssuedCredential(refreshToken)

		// Access token still valid -- restore session from it
		if (!isTokenExpired(accessToken)) {
			await this.restoreSession(accessToken)
			return
		}

		// Access token expired -- try refreshing
		const outcome = await this.refresh()
		if (outcome.kind === 'ok') {
			await this.restoreSession(outcome.accessToken)
			return
		}
		if (outcome.kind === 'rejected') {
			// refresh() already cleared tokens and moved to unauthenticated.
			this.setState('unauthenticated', null)
			return
		}
		await this.enterOfflineSession()
	}

	// -----------------------------------------------------------------------
	// Sign up / Sign in / Sign out
	// -----------------------------------------------------------------------

	/**
	 * Register a new user account.
	 *
	 * @param params - Sign-up credentials
	 * @returns The newly created AuthUser
	 * @throws {AuthError} If the request fails or the server returns an error
	 */
	async signUp(params: {
		email: string
		password: string
		name?: string
		deviceId?: string
		devicePublicKey?: string
	}): Promise<AuthUser> {
		const body = await this.withDeviceIdentity(params)
		const response = await this.request<AuthSignInResponse | AuthTokensResponse>('/auth/signup', {
			method: 'POST',
			body,
		})
		return this.completeSignIn(response)
	}

	/**
	 * Sign in with email and password.
	 *
	 * @param params - Sign-in credentials
	 * @returns The authenticated AuthUser
	 * @throws {AuthError} If the credentials are invalid or the request fails
	 */
	async signIn(params: {
		email: string
		password: string
		deviceId?: string
		devicePublicKey?: string
	}): Promise<AuthUser> {
		const body = await this.withDeviceIdentity(params)
		const response = await this.request<
			AuthSignInResponse | AuthTokensResponse | MfaChallengeResponse
		>('/auth/signin', {
			method: 'POST',
			body,
		})
		return this.completeSignIn(response)
	}

	/**
	 * Finish a sign-in that required a second factor.
	 *
	 * @param mfaToken - From the {@link MfaRequiredError} thrown by sign-in
	 * @param proof - A current TOTP code, or a recovery code
	 * @returns The authenticated AuthUser
	 * @throws {AuthError} If the code or the MFA session is invalid
	 */
	async verifyMfa(
		mfaToken: string,
		proof: { code: string } | { recoveryCode: string },
	): Promise<AuthUser> {
		const response = await this.request<AuthSignInResponse>('/auth/mfa/verify', {
			method: 'POST',
			body: { mfaToken, ...proof },
		})
		return this.completeSignIn(response)
	}

	/**
	 * Create an OAuth authorization URL and optionally redirect the current window.
	 *
	 * For web apps, call this from a button click and keep the default redirect behavior.
	 * For desktop/mobile, pass `redirect: false`, open the returned URL with the runtime's
	 * browser API, then call `completeOAuthSignIn()` after receiving the callback.
	 */
	async signInWithOAuth(
		provider: string,
		options: OAuthAuthorizationOptions = {},
	): Promise<OAuthAuthorizationResult> {
		const result = await this.createOAuthAuthorization(provider, options)
		if (options.redirect ?? canRedirectCurrentWindow()) {
			redirectCurrentWindow(result.url)
		}
		return result
	}

	/**
	 * Complete an OAuth sign-in callback and store the issued Kora tokens.
	 */
	async completeOAuthSignIn(provider: string, params: OAuthCallbackParams): Promise<AuthUser> {
		const body = await this.withDeviceIdentity(params)
		const binding = params.binding ?? this.takeOAuthBinding(params.state)
		const response = await this.request<OAuthSignInResponse | MfaChallengeResponse>(
			`/auth/oauth/${encodeURIComponent(provider)}/callback`,
			{
				method: 'POST',
				body: { ...body, ...(binding ? { binding } : {}) },
			},
		)
		if ('mfaRequired' in response) {
			throw new MfaRequiredError(response.mfaToken)
		}

		await this.storage.setTokens(response.tokens.accessToken, response.tokens.refreshToken)
		this.markFresh(response.tokens.refreshToken)
		const user = normalizeAuthUser(response.user)
		this.setState('authenticated', user)
		return user
	}

	/**
	 * Create an OAuth authorization URL for linking another provider to the current user.
	 */
	async getOAuthAuthorizationUrl(
		provider: string,
		_options: OAuthAuthorizationOptions = {},
	): Promise<OAuthAuthorizationResult> {
		// Linking starts from an authenticated endpoint so the state is bound to
		// this user and can never be redeemed by anyone else (AUTH-3).
		const token = await this.requireAccessToken()
		const result = await this.request<OAuthAuthorizationResult>(
			`/auth/oauth/${encodeURIComponent(provider)}/link/start`,
			{ method: 'POST', body: {}, token },
		)
		this.rememberOAuthBinding(result)
		return result
	}

	/**
	 * Link an OAuth provider to the current authenticated user.
	 */
	async linkOAuth(provider: string, params: OAuthCallbackParams): Promise<LinkedOAuthAccount> {
		const token = await this.requireAccessToken()
		const binding = params.binding ?? this.takeOAuthBinding(params.state)
		return this.request<LinkedOAuthAccount>(`/auth/oauth/${encodeURIComponent(provider)}/link`, {
			method: 'POST',
			body: {
				code: params.code,
				state: params.state,
				...(binding ? { binding } : {}),
			},
			token,
		})
	}

	/**
	 * List OAuth accounts linked to the current authenticated user.
	 */
	async listLinkedAccounts(): Promise<LinkedOAuthAccount[]> {
		const token = await this.requireAccessToken()
		return this.request<LinkedOAuthAccount[]>('/auth/oauth/links', {
			method: 'GET',
			token,
		})
	}

	/**
	 * Unlink an OAuth provider from the current authenticated user.
	 */
	async unlinkOAuth(provider: string): Promise<void> {
		const token = await this.requireAccessToken()
		await this.request<{ ok: true }>(`/auth/oauth/${encodeURIComponent(provider)}/link`, {
			method: 'DELETE',
			token,
		})
	}

	/**
	 * Sign out the current user.
	 *
	 * Clears local tokens and attempts to revoke the refresh token on the server
	 * (best-effort — succeeds even if the server is unreachable). This ensures that
	 * stolen refresh tokens cannot be used after the user explicitly signs out.
	 */
	async signOut(): Promise<void> {
		const accessToken = await this.storage.getAccessToken()
		const refreshToken = await this.storage.getRefreshToken()

		// Clear local state immediately (don't wait for server)
		await this.storage.clear()
		this._refreshPromise = null
		this.resetBackoff()
		this.sessionStatus = 'fresh'
		this.cachedDeviceId = null
		this.setState('unauthenticated', null)

		// Best-effort server-side revocation
		if (accessToken) {
			try {
				await this.request('/auth/signout', {
					method: 'POST',
					body: { refreshToken: refreshToken ?? undefined },
					token: accessToken,
				})
			} catch {
				// Server may be unreachable (offline) — local sign-out still succeeds
			}
		}
	}

	// -----------------------------------------------------------------------
	// Token access
	// -----------------------------------------------------------------------

	/**
	 * Get a valid access token, automatically refreshing if expired.
	 *
	 * Returns null when no fresh token can be obtained right now. That does NOT
	 * mean the user is signed out: check {@link state} / {@link session}. A
	 * transient failure keeps the session (authenticated-offline) and later calls
	 * retry with backoff.
	 *
	 * @returns A valid access token string, or null if none is available now
	 */
	async getAccessToken(): Promise<string | null> {
		const accessToken = await this.storage.getAccessToken()

		if (accessToken && !isTokenExpired(accessToken)) {
			if (this._state === 'authenticated' && this.sessionStatus !== 'fresh') {
				// Another tab refreshed while this one was offline.
				this.markFresh(await this.storage.getRefreshToken())
			}
			return accessToken
		}

		const refreshToken = await this.storage.getRefreshToken()
		if (!refreshToken) {
			return null
		}

		const outcome = await this.refresh()
		return outcome.kind === 'ok' ? outcome.accessToken : null
	}

	/**
	 * Refresh the session now, even when the cached access token has not expired
	 * locally. Used after the sync server ended a session with `AUTH_EXPIRED` or
	 * `AUTH_REVOKED`: the server's clock or a revocation says the cached token is
	 * no longer good. Concurrent calls (and other tabs) share one refresh.
	 *
	 * A transient failure keeps the session (authenticated-offline) and returns
	 * null; only a definitive server rejection signs the user out.
	 *
	 * @returns The refreshed access token, or null if none could be obtained now
	 */
	async refreshAccessToken(): Promise<string | null> {
		const refreshToken = await this.storage.getRefreshToken()
		if (!refreshToken) {
			return null
		}
		const outcome = await this.refresh()
		return outcome.kind === 'ok' ? outcome.accessToken : null
	}

	/**
	 * Get a valid token for the sync engine handshake.
	 * Alias for {@link getAccessToken}.
	 *
	 * @returns A valid access token string, or null if unavailable
	 */
	async getSyncToken(): Promise<string | null> {
		return this.getAccessToken()
	}

	/**
	 * Retry immediately: clears the refresh backoff and attempts a refresh if the
	 * session is offline. Call it when connectivity is known to be back (for
	 * example when a sync transport opens). Also wired to the browser `online`
	 * and `visibilitychange` events automatically.
	 */
	async retryNow(): Promise<void> {
		this.resetBackoff()
		if (this._state === 'authenticated' && this.sessionStatus !== 'fresh') {
			await this.getAccessToken()
		}
	}

	/** Remove environment listeners and timers (for tests and teardown). */
	destroy(): void {
		this.detachEnvironment()
		this.clearRetryTimer()
	}

	// -----------------------------------------------------------------------
	// State change subscriptions
	// -----------------------------------------------------------------------

	/**
	 * Subscribe to authentication state changes.
	 *
	 * The callback is invoked whenever the auth state transitions (e.g., from
	 * 'unauthenticated' to 'authenticated' on sign-in).
	 *
	 * @param callback - Function called with the new AuthState on each change
	 * @returns An unsubscribe function that removes the listener
	 *
	 * @example
	 * ```typescript
	 * const unsub = auth.onAuthChange((state) => {
	 *   console.log('Auth state changed to:', state)
	 * })
	 * // Later: unsub()
	 * ```
	 */
	onAuthChange(callback: (state: AuthState) => void): () => void {
		this.listeners.add(callback)
		return () => {
			this.listeners.delete(callback)
		}
	}

	/**
	 * Subscribe to session freshness changes (fresh, authenticated-offline,
	 * locked). Fires in addition to {@link onAuthChange}, including when the
	 * state stays 'authenticated' but connectivity to the auth server changes.
	 *
	 * @param callback - Called with the current session (null when signed out)
	 * @returns An unsubscribe function
	 */
	onSessionChange(callback: (session: AuthClientSession | null) => void): () => void {
		this.sessionListeners.add(callback)
		return () => {
			this.sessionListeners.delete(callback)
		}
	}

	// -----------------------------------------------------------------------
	// Internal helpers
	// -----------------------------------------------------------------------

	/**
	 * Update internal state and notify all listeners.
	 */
	private setState(state: AuthState, user: AuthUser | null): void {
		const changed = this._state !== state || this._user !== user
		this._state = state
		this._user = user

		if (changed) {
			for (const listener of this.listeners) {
				try {
					listener(state)
				} catch {
					// Listeners should not throw, but if they do, do not let it
					// break the notification loop for other listeners.
				}
			}
			this.notifySession()
		}
	}

	private setSessionStatus(status: AuthSessionStatus): void {
		if (this.sessionStatus === status) return
		this.sessionStatus = status
		this.notifySession()
	}

	private notifySession(): void {
		const session = this.session
		for (const listener of this.sessionListeners) {
			try {
				listener(session)
			} catch {
				// Same isolation as auth listeners.
			}
		}
	}

	private async completeSignIn(
		response: AuthSignInResponse | AuthTokensResponse | MfaChallengeResponse,
	): Promise<AuthUser> {
		if ('mfaRequired' in response) {
			throw new MfaRequiredError(response.mfaToken)
		}
		const tokens = 'tokens' in response ? response.tokens : response
		await this.storage.setTokens(tokens.accessToken, tokens.refreshToken)
		this.markFresh(tokens.refreshToken)
		const user =
			'user' in response && response.user
				? normalizeAuthUser(response.user)
				: await this.fetchUserProfile(tokens.accessToken)
		this.setState('authenticated', user)
		return user
	}

	/**
	 * Restore a session from a valid access token by fetching the user profile.
	 * A definitive 401 from `/auth/me` ends the session (NEW-AUTH-4); any other
	 * failure restores it as authenticated-offline from the stored identity.
	 */
	private async restoreSession(accessToken: string): Promise<void> {
		let response: RawResponse
		try {
			response = await this.rawRequest('/auth/me', { method: 'GET', token: accessToken })
		} catch {
			await this.enterOfflineSession()
			return
		}
		if (response.ok && isRecord(response.json)) {
			const profile = (response.json.data !== undefined ? response.json.data : response.json) as
				| UserProfileResponse
				| undefined
			if (isRecord(profile) && typeof profile.id === 'string') {
				this.markFresh(null)
				this.setState('authenticated', normalizeAuthUser(profile))
				return
			}
		}
		if (response.status === 401 && isDefinitiveRejection(response)) {
			await this.endSession()
			return
		}
		await this.enterOfflineSession()
	}

	/**
	 * Restore the session from stored credentials while the auth server is
	 * unreachable. Signs out only when the stored refresh token is unusable.
	 */
	private async enterOfflineSession(): Promise<void> {
		const refreshToken = await this.storage.getRefreshToken()
		const identity = await this.getStoredIdentity()
		if (!refreshToken || !identity || isTokenExpired(refreshToken, 0)) {
			await this.endSession()
			return
		}
		this.cachedDeviceId = identity.deviceId
		this.noteIssuedCredential(refreshToken)
		const user =
			this._user && this._user.id === identity.userId
				? this._user
				: { id: identity.userId, email: '', name: null }
		this.sessionStatus = this.offlineStatus()
		this.setState('authenticated', user)
		this.notifySession()
	}

	/** Offline, or locked when the grace period ran out or the clock went backwards. */
	private offlineStatus(): AuthSessionStatus {
		const now = Date.now()
		if (
			this.lastServerContactAt > 0 &&
			now + CLOCK_ROLLBACK_TOLERANCE_MS < this.lastServerContactAt
		) {
			// The device clock is earlier than a moment we know already happened:
			// it was set back, which would otherwise extend the offline grace.
			return 'locked'
		}
		if (
			this.maxOfflineGraceMs !== undefined &&
			this.lastServerContactAt > 0 &&
			now - this.lastServerContactAt > this.maxOfflineGraceMs
		) {
			return 'locked'
		}
		return 'offline'
	}

	private async endSession(): Promise<void> {
		await this.storage.clear()
		this.resetBackoff()
		this.sessionStatus = 'fresh'
		this.cachedDeviceId = null
		this.setState('unauthenticated', null)
	}

	/** The refresh token's issue time is the server's clock at the last rotation. */
	private noteIssuedCredential(refreshToken: string | null): void {
		if (!refreshToken) return
		const issued = tokenIssuedAtMs(refreshToken)
		if (issued !== null) this.lastServerContactAt = Math.max(this.lastServerContactAt, issued)
		const claims = decodeJwtPayload(refreshToken)
		if (claims && typeof claims.dev === 'string') this.cachedDeviceId = claims.dev
	}

	private markFresh(refreshToken: string | null): void {
		this.resetBackoff()
		this.lastServerContactAt = Math.max(this.lastServerContactAt, Date.now())
		this.noteIssuedCredential(refreshToken)
		this.setSessionStatus('fresh')
	}

	private markOffline(): void {
		if (this._state === 'authenticated') {
			this.setSessionStatus(this.offlineStatus())
		}
	}

	/**
	 * Fetch the current user profile from the server.
	 */
	private async fetchUserProfile(accessToken: string): Promise<AuthUser> {
		const profile = await this.request<UserProfileResponse>('/auth/me', {
			method: 'GET',
			token: accessToken,
		})
		return normalizeAuthUser(profile)
	}

	private async createOAuthAuthorization(
		provider: string,
		options: OAuthAuthorizationOptions,
	): Promise<OAuthAuthorizationResult> {
		const params = new URLSearchParams()

		if (options.returnTo) {
			params.set('returnTo', options.returnTo)
		}
		if (options.metadata) {
			for (const [key, value] of Object.entries(options.metadata)) {
				if (value !== undefined && value !== null) {
					params.set(key, String(value))
				}
			}
		}

		const query = params.toString()
		const result = await this.request<OAuthAuthorizationResult>(
			`/auth/oauth/${encodeURIComponent(provider)}${query ? `?${query}` : ''}`,
			{
				method: 'GET',
			},
		)
		this.rememberOAuthBinding(result)
		return result
	}

	/** Bindings of flows this client started, by state (survives the redirect on web). */
	private readonly oauthBindings = new Map<string, string>()

	private rememberOAuthBinding(result: OAuthAuthorizationResult): void {
		if (!result.binding || !result.state) return
		this.oauthBindings.set(result.state, result.binding)
		const session = getSessionStorage()
		try {
			session?.setItem(`${OAUTH_BINDING_PREFIX}${result.state}`, result.binding)
		} catch {
			// Session storage full or blocked: the in-memory copy still serves native flows.
		}
	}

	private takeOAuthBinding(state: string): string | undefined {
		const inMemory = this.oauthBindings.get(state)
		this.oauthBindings.delete(state)
		const session = getSessionStorage()
		let stored: string | null = null
		try {
			stored = session?.getItem(`${OAUTH_BINDING_PREFIX}${state}`) ?? null
			session?.removeItem(`${OAUTH_BINDING_PREFIX}${state}`)
		} catch {
			stored = null
		}
		return inMemory ?? stored ?? undefined
	}

	private async withDeviceIdentity<T extends { deviceId?: string; devicePublicKey?: string }>(
		params: T,
	): Promise<T> {
		if (!this.deviceIdentity || (params.deviceId && params.devicePublicKey)) {
			return params
		}

		const identity = await this.deviceIdentity.getDeviceIdentity()
		return {
			...params,
			deviceId: params.deviceId ?? identity.deviceId,
			devicePublicKey: params.devicePublicKey ?? identity.devicePublicKey,
		}
	}

	/**
	 * Refresh the session's tokens. De-duplicates concurrent calls in this
	 * client, serializes refreshes across tabs, and applies backoff after
	 * transient failures.
	 */
	private refresh(): Promise<RefreshOutcome> {
		if (this._refreshPromise) {
			return this._refreshPromise
		}
		const promise = this.refreshOnce().finally(() => {
			if (this._refreshPromise === promise) this._refreshPromise = null
		})
		this._refreshPromise = promise
		return promise
	}

	private async refreshOnce(): Promise<RefreshOutcome> {
		const refreshToken = await this.storage.getRefreshToken()
		if (!refreshToken) return { kind: 'rejected' }

		// A refresh token that has expired is unusable whatever the network says.
		if (isTokenExpired(refreshToken, 0)) {
			await this.endSession()
			return { kind: 'rejected' }
		}

		if (Date.now() < this.nextAttemptAt) {
			this.markOffline()
			return { kind: 'transient' }
		}

		let outcome: RefreshOutcome
		try {
			outcome = await this.withRefreshLock(async () => {
				// Another tab may have refreshed while we waited for the lock: adopt
				// its tokens instead of presenting a now-rotated refresh token.
				const current = await this.storage.getRefreshToken()
				if (!current) return { kind: 'rejected' } as const
				const currentAccess = await this.storage.getAccessToken()
				if (current !== refreshToken && currentAccess && !isTokenExpired(currentAccess)) {
					return { kind: 'ok', accessToken: currentAccess } as const
				}
				return this.performRefresh(current)
			})
		} catch {
			// Lock acquisition timed out (a hung tab holds it): transient.
			outcome = { kind: 'transient' }
		}

		if (outcome.kind === 'ok') {
			this.markFresh(await this.storage.getRefreshToken())
		} else if (outcome.kind === 'rejected') {
			this.resetBackoff()
			this.cachedDeviceId = null
			this.sessionStatus = 'fresh'
			this.setState('unauthenticated', null)
		} else {
			this.registerFailure(outcome.retryAfterMs)
			this.markOffline()
		}
		return outcome
	}

	/**
	 * Execute the token refresh network request and classify the answer.
	 */
	private async performRefresh(refreshToken: string): Promise<RefreshOutcome> {
		let response: RawResponse
		try {
			response = await this.rawRequest('/auth/refresh', {
				method: 'POST',
				body: { refreshToken },
			})
		} catch {
			// No network, DNS, TLS, CORS, abort or timeout: says nothing about the token.
			return { kind: 'transient' }
		}

		if (response.ok) {
			const tokens = readTokenPair(response.json)
			if (!tokens) {
				// 2xx without tokens: a captive portal or proxy answered, not Kora.
				return { kind: 'transient' }
			}
			await this.storage.setTokens(tokens.accessToken, tokens.refreshToken)
			return { kind: 'ok', accessToken: tokens.accessToken }
		}

		if (isDefinitiveRejection(response)) {
			// Never clear a token pair another tab stored after we read ours.
			if ((await this.storage.getRefreshToken()) === refreshToken) {
				await this.storage.clear()
				return { kind: 'rejected' }
			}
			const adopted = await this.storage.getAccessToken()
			return adopted && !isTokenExpired(adopted)
				? { kind: 'ok', accessToken: adopted }
				: { kind: 'transient' }
		}

		return { kind: 'transient', retryAfterMs: response.retryAfterMs }
	}

	private async withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
		const locks = getWebLocks()
		if (locks) {
			const controller = typeof AbortController === 'function' ? new AbortController() : null
			const timer = controller
				? setTimeout(() => controller.abort(), this.requestTimeoutMs * 2)
				: null
			try {
				return await locks.request(
					this.lockName,
					controller ? { signal: controller.signal } : {},
					async () => {
						if (timer) clearTimeout(timer)
						return fn()
					},
				)
			} finally {
				if (timer) clearTimeout(timer)
			}
		}
		// Same-realm fallback (Node, older browsers): serialize per storage object.
		const key = this.storage as object
		const previous = inProcessLocks.get(key) ?? Promise.resolve()
		const run = previous.then(fn, fn)
		inProcessLocks.set(
			key,
			run.then(
				() => undefined,
				() => undefined,
			),
		)
		return run
	}

	/**
	 * Schedule the next allowed refresh attempt. The first retry after a failure
	 * is immediate (it recovers a rotation response lost on the wire); after
	 * that, exponential backoff with equal jitter, never earlier than Retry-After.
	 */
	private registerFailure(retryAfterMs: number | undefined): void {
		this.failureCount++
		let delay = 0
		if (this.failureCount > 1) {
			const ceiling = Math.min(this.backoffBaseMs * 2 ** (this.failureCount - 2), this.backoffMaxMs)
			delay = ceiling / 2 + Math.random() * (ceiling / 2)
		}
		if (retryAfterMs !== undefined) delay = Math.max(delay, retryAfterMs)
		this.nextAttemptAt = Date.now() + delay
		this.scheduleRetry(Math.max(delay, this.backoffBaseMs))
	}

	private resetBackoff(): void {
		this.failureCount = 0
		this.nextAttemptAt = 0
		this.clearRetryTimer()
	}

	/** Background retry so an offline session recovers without the app calling in. */
	private scheduleRetry(delayMs: number): void {
		this.clearRetryTimer()
		if (typeof setTimeout !== 'function') return
		const timer = setTimeout(() => {
			this.retryTimer = null
			if (this._state === 'authenticated' && this.sessionStatus !== 'fresh') {
				void this.getAccessToken().catch(() => undefined)
			}
		}, delayMs)
		// Never keep a Node process alive just to retry a refresh.
		;(timer as { unref?: () => void }).unref?.()
		this.retryTimer = timer
	}

	private clearRetryTimer(): void {
		if (this.retryTimer !== null) {
			clearTimeout(this.retryTimer)
			this.retryTimer = null
		}
	}

	private attachEnvironmentListeners(): () => void {
		const target = (globalThis as { window?: unknown }).window as
			| {
					addEventListener?: (type: string, listener: () => void) => void
					removeEventListener?: (type: string, listener: () => void) => void
			  }
			| undefined
		if (!target || typeof target.addEventListener !== 'function') return () => {}
		const wake = (): void => {
			const doc = (globalThis as { document?: { visibilityState?: string } }).document
			if (doc?.visibilityState === 'hidden') return
			void this.retryNow().catch(() => undefined)
		}
		target.addEventListener('online', wake)
		target.addEventListener('visibilitychange', wake)
		return () => {
			target.removeEventListener?.('online', wake)
			target.removeEventListener?.('visibilitychange', wake)
		}
	}

	private async requireAccessToken(): Promise<string> {
		const token = await this.getAccessToken()
		if (!token) {
			throw new AuthError('You must be signed in to perform this action.', 'AUTH_REQUIRED')
		}
		return token
	}

	/**
	 * Send one request with a timeout and return status plus parsed JSON (if any).
	 * Throws only for transport failures (network, abort, timeout).
	 */
	private async rawRequest(
		path: string,
		options: {
			method: 'GET' | 'POST' | 'DELETE'
			body?: Record<string, unknown>
			token?: string
		},
	): Promise<RawResponse> {
		const url = `${this.serverUrl}${path}`
		const headers: Record<string, string> = {}
		if (options.body) {
			headers['Content-Type'] = 'application/json'
		}
		if (options.token) {
			headers.Authorization = `Bearer ${options.token}`
		}

		const controller = typeof AbortController === 'function' ? new AbortController() : null
		let timer: ReturnType<typeof setTimeout> | null = null
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				controller?.abort()
				reject(
					new AuthError(
						`Request to ${path} timed out after ${this.requestTimeoutMs}ms.`,
						'AUTH_TIMEOUT',
						{ path },
					),
				)
			}, this.requestTimeoutMs)
		})
		try {
			const response = await Promise.race([
				this.fetchFn(url, {
					method: options.method,
					headers,
					body: options.body ? JSON.stringify(options.body) : undefined,
					...(controller ? { signal: controller.signal } : {}),
				}),
				timeout,
			])
			let json: unknown
			try {
				json = await Promise.race([response.json() as Promise<unknown>, timeout])
			} catch {
				json = undefined
			}
			const headerGetter = (response as { headers?: { get?: (name: string) => string | null } })
				.headers
			return {
				status: response.status,
				ok: response.ok,
				json,
				retryAfterMs: parseRetryAfter(headerGetter?.get?.('Retry-After')),
			}
		} finally {
			if (timer !== null) clearTimeout(timer)
		}
	}

	/**
	 * Make an HTTP request to the auth server.
	 *
	 * @param path - URL path relative to serverUrl (e.g. '/auth/signin')
	 * @param options - Request options
	 * @returns Parsed JSON response body
	 * @throws {AuthError} On network failure, timeout, or non-2xx response
	 */
	private async request<T>(
		path: string,
		options: {
			method: 'GET' | 'POST' | 'DELETE'
			body?: Record<string, unknown>
			token?: string
		},
	): Promise<T> {
		let response: RawResponse
		try {
			response = await this.rawRequest(path, options)
		} catch (cause) {
			if (cause instanceof AuthError) throw cause
			throw new AuthError(
				`Network request to ${path} failed. The auth server at ${this.serverUrl} may be unreachable. Check your network connection and serverUrl configuration.`,
				'AUTH_NETWORK_ERROR',
				{ path, cause: cause instanceof Error ? cause.message : String(cause) },
			)
		}

		if (!response.ok) {
			let errorMessage = `Auth server returned HTTP ${response.status}`
			let serverError: string | undefined
			let serverCode: string | undefined
			if (isRecord(response.json)) {
				if (typeof response.json.error === 'string') {
					errorMessage = response.json.error
					serverError = errorMessage
				} else if (typeof response.json.message === 'string') {
					errorMessage = response.json.message
					serverError = errorMessage
				}
				if (typeof response.json.code === 'string') serverCode = response.json.code
			}

			throw new AuthError(errorMessage, 'AUTH_SERVER_ERROR', {
				path,
				status: response.status,
				serverError,
				serverCode,
			})
		}

		if (!isRecord(response.json) && !Array.isArray(response.json)) {
			throw new AuthError(
				`Auth server returned a non-JSON response for ${path}. A captive portal or proxy may be intercepting requests.`,
				'AUTH_INVALID_RESPONSE',
				{ path, status: response.status },
			)
		}
		const json = response.json as Record<string, unknown>

		// The BuiltInAuthRoutes server wraps success responses in { data: T }.
		// Unwrap the envelope so callers get the inner payload directly.
		return (json.data !== undefined ? json.data : json) as T
	}
}
