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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Possible authentication states for the client.
 * - 'loading': Initial state while restoring tokens from storage
 * - 'authenticated': User is signed in with a valid session
 * - 'unauthenticated': No valid session exists
 */
export type AuthState = 'loading' | 'authenticated' | 'unauthenticated'

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
		return JSON.parse(json) as Record<string, unknown>
	} catch {
		return null
	}
}

/**
 * Returns true if the JWT's `exp` claim is in the past (with a small buffer).
 * If the token cannot be decoded, returns true (treat as expired).
 */
function isTokenExpired(token: string): boolean {
	const payload = decodeJwtPayload(token)
	if (!payload || typeof payload.exp !== 'number') {
		return true
	}
	const nowSeconds = Math.floor(Date.now() / 1000)
	return (payload.exp as number) <= nowSeconds + EXPIRY_BUFFER_SECONDS
}

/**
 * Extracts the `sub` (user ID) from a JWT payload.
 * Returns null if the token is malformed or missing the sub claim.
 */
function getUserIdFromToken(token: string): string | null {
	const payload = decodeJwtPayload(token)
	if (!payload || typeof payload.sub !== 'string') {
		return null
	}
	return payload.sub as string
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

	private _state: AuthState = 'loading'
	private _user: AuthUser | null = null
	private _refreshPromise: Promise<string | null> | null = null
	private _initialized = false

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

	/** Whether the user is currently authenticated. */
	get isAuthenticated(): boolean {
		return this._state === 'authenticated'
	}

	// -----------------------------------------------------------------------
	// Initialization
	// -----------------------------------------------------------------------

	/**
	 * Initialize the auth client by restoring a session from stored tokens.
	 *
	 * Loads tokens from storage, validates the access token, and attempts a
	 * refresh if the access token is expired but a refresh token is available.
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

		// Access token still valid -- restore session from it
		if (!isTokenExpired(accessToken)) {
			await this.restoreSession(accessToken)
			return
		}

		// Access token expired -- try refreshing
		try {
			const newAccessToken = await this.refreshAccessToken(refreshToken)
			if (newAccessToken) {
				await this.restoreSession(newAccessToken)
				return
			}
		} catch {
			// Refresh failed (network error, token revoked, etc.)
		}

		// Could not restore session
		await this.storage.clear()
		this.setState('unauthenticated', null)
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

		const tokens = 'tokens' in response ? response.tokens : response
		await this.storage.setTokens(tokens.accessToken, tokens.refreshToken)

		const user = await this.fetchUserProfile(tokens.accessToken)
		this.setState('authenticated', user)
		return user
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
		const response = await this.request<AuthSignInResponse | AuthTokensResponse>('/auth/signin', {
			method: 'POST',
			body,
		})

		const tokens = 'tokens' in response ? response.tokens : response
		await this.storage.setTokens(tokens.accessToken, tokens.refreshToken)

		const user = await this.fetchUserProfile(tokens.accessToken)
		this.setState('authenticated', user)
		return user
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
		const response = await this.request<OAuthSignInResponse>(
			`/auth/oauth/${encodeURIComponent(provider)}/callback`,
			{
				method: 'POST',
				body: { ...body },
			},
		)

		await this.storage.setTokens(response.tokens.accessToken, response.tokens.refreshToken)
		const user = normalizeAuthUser(response.user)
		this.setState('authenticated', user)
		return user
	}

	/**
	 * Create an OAuth authorization URL for linking another provider to the current user.
	 */
	async getOAuthAuthorizationUrl(
		provider: string,
		options: OAuthAuthorizationOptions = {},
	): Promise<OAuthAuthorizationResult> {
		return this.createOAuthAuthorization(provider, { ...options, redirect: false })
	}

	/**
	 * Link an OAuth provider to the current authenticated user.
	 */
	async linkOAuth(provider: string, params: OAuthCallbackParams): Promise<LinkedOAuthAccount> {
		const token = await this.requireAccessToken()
		return this.request<LinkedOAuthAccount>(`/auth/oauth/${encodeURIComponent(provider)}/link`, {
			method: 'POST',
			body: {
				code: params.code,
				state: params.state,
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
	 * @returns A valid access token string, or null if the user is not
	 *          authenticated and refresh is not possible
	 */
	async getAccessToken(): Promise<string | null> {
		const accessToken = await this.storage.getAccessToken()

		if (accessToken && !isTokenExpired(accessToken)) {
			return accessToken
		}

		// Attempt refresh
		const refreshToken = await this.storage.getRefreshToken()
		if (!refreshToken) {
			return null
		}

		try {
			const newAccessToken = await this.refreshAccessToken(refreshToken)
			return newAccessToken
		} catch {
			return null
		}
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
		}
	}

	/**
	 * Restore a session from a valid access token by fetching the user profile.
	 * Falls back to extracting the user ID from the token payload if the
	 * /auth/me request fails (offline scenario).
	 */
	private async restoreSession(accessToken: string): Promise<void> {
		try {
			const user = await this.fetchUserProfile(accessToken)
			this.setState('authenticated', user)
		} catch {
			// Network may be unavailable -- extract minimal user info from the token
			const userId = getUserIdFromToken(accessToken)
			if (userId) {
				this.setState('authenticated', {
					id: userId,
					email: '',
					name: null,
				})
			} else {
				await this.storage.clear()
				this.setState('unauthenticated', null)
			}
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
		const withIdentity = await this.withDeviceIdentity({
			deviceId: options.deviceId,
			devicePublicKey: options.devicePublicKey,
		})

		if (options.returnTo) {
			params.set('returnTo', options.returnTo)
		}
		if (withIdentity.deviceId) {
			params.set('deviceId', withIdentity.deviceId)
		}
		if (withIdentity.devicePublicKey) {
			params.set('devicePublicKey', withIdentity.devicePublicKey)
		}
		if (options.metadata) {
			for (const [key, value] of Object.entries(options.metadata)) {
				if (value !== undefined && value !== null) {
					params.set(key, String(value))
				}
			}
		}

		const query = params.toString()
		return this.request<OAuthAuthorizationResult>(
			`/auth/oauth/${encodeURIComponent(provider)}${query ? `?${query}` : ''}`,
			{
				method: 'GET',
			},
		)
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
	 * Refresh the access token using a refresh token.
	 * De-duplicates concurrent refresh calls so only one network request is made.
	 */
	private async refreshAccessToken(refreshToken: string): Promise<string | null> {
		// De-duplicate: if a refresh is already in progress, return the same promise
		if (this._refreshPromise) {
			return this._refreshPromise
		}

		this._refreshPromise = this.performRefresh(refreshToken)

		try {
			const result = await this._refreshPromise
			return result
		} finally {
			this._refreshPromise = null
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
	 * Execute the token refresh network request.
	 */
	private async performRefresh(refreshToken: string): Promise<string | null> {
		try {
			const response = await this.request<AuthTokensResponse>('/auth/refresh', {
				method: 'POST',
				body: { refreshToken },
			})

			await this.storage.setTokens(response.accessToken, response.refreshToken)
			return response.accessToken
		} catch {
			// Refresh failed -- clear tokens to avoid infinite retry loops
			await this.storage.clear()
			this.setState('unauthenticated', null)
			return null
		}
	}

	/**
	 * Make an HTTP request to the auth server.
	 *
	 * @param path - URL path relative to serverUrl (e.g. '/auth/signin')
	 * @param options - Request options
	 * @returns Parsed JSON response body
	 * @throws {AuthError} On network failure or non-2xx response
	 */
	private async request<T>(
		path: string,
		options: {
			method: 'GET' | 'POST' | 'DELETE'
			body?: Record<string, unknown>
			token?: string
		},
	): Promise<T> {
		const url = `${this.serverUrl}${path}`

		const headers: Record<string, string> = {}
		if (options.body) {
			headers['Content-Type'] = 'application/json'
		}
		if (options.token) {
			headers.Authorization = `Bearer ${options.token}`
		}

		let response: Response
		try {
			response = await this.fetchFn(url, {
				method: options.method,
				headers,
				body: options.body ? JSON.stringify(options.body) : undefined,
			})
		} catch (cause) {
			throw new AuthError(
				`Network request to ${path} failed. The auth server at ${this.serverUrl} may be unreachable. Check your network connection and serverUrl configuration.`,
				'AUTH_NETWORK_ERROR',
				{ path, cause: cause instanceof Error ? cause.message : String(cause) },
			)
		}

		if (!response.ok) {
			let errorMessage = `Auth server returned HTTP ${response.status}`
			let serverError: string | undefined
			try {
				const body = (await response.json()) as Record<string, unknown>
				if (typeof body.error === 'string') {
					errorMessage = body.error as string
					serverError = errorMessage
				} else if (typeof body.message === 'string') {
					errorMessage = body.message as string
					serverError = errorMessage
				}
			} catch {
				// Response body is not JSON -- use the status text
			}

			throw new AuthError(errorMessage, 'AUTH_SERVER_ERROR', {
				path,
				status: response.status,
				serverError,
			})
		}

		const json = (await response.json()) as Record<string, unknown>

		// The BuiltInAuthRoutes server wraps success responses in { data: T }.
		// Unwrap the envelope so callers get the inner payload directly.
		const data = (json.data !== undefined ? json.data : json) as T
		return data
	}
}
