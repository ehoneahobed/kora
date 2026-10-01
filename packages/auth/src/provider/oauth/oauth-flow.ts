import type {
	OAuthProviderConfig,
	OAuthState,
	OAuthStateStore,
	OAuthTokens,
	OAuthUserInfo,
} from './oauth-types'
import {
	OAuthCodeExchangeError,
	OAuthProviderNotFoundError,
	OAuthStateMismatchError,
	OAuthUserInfoError,
} from './oauth-types'

// ============================================================================
// InMemoryOAuthStateStore
// ============================================================================

/**
 * Reserved metadata key holding the flow binding. Stored inside the state's
 * metadata so every persisted state store round-trips it without a migration,
 * and stripped from the metadata handed back to callers.
 */
const BINDING_METADATA_KEY = '__kora_oauth_binding'

/** What an OAuth flow is for. A state minted for one purpose is useless for the other. */
export type OAuthFlowPurpose = 'signin' | 'link'

/** Binding requested when an authorization URL is created (AUTH-3). */
export interface OAuthFlowBinding {
	/** The flow purpose. Defaults to `'signin'`. */
	purpose?: OAuthFlowPurpose
	/** For `'link'`: the authenticated Kora user starting the flow. */
	userId?: string
	/**
	 * A random secret held only by the initiating client (an HttpOnly cookie on
	 * the web, memory for native/PKCE). Only its SHA-256 is stored server-side.
	 */
	binding?: string
}

interface StoredBinding {
	purpose: OAuthFlowPurpose
	userId?: string
	bindingHash?: string
}

/** Default state TTL: 10 minutes */
const DEFAULT_STATE_TTL_MS = 10 * 60 * 1000
const PKCE_VERIFIER_BYTES = 32

/**
 * In-memory OAuth state store for development.
 * Use Redis or a database in production for multi-server deployments.
 */
export class InMemoryOAuthStateStore implements OAuthStateStore {
	private readonly states = new Map<string, OAuthState>()

	async store(state: OAuthState): Promise<void> {
		this.states.set(state.state, state)
	}

	async consume(stateValue: string): Promise<OAuthState | null> {
		const state = this.states.get(stateValue)
		if (!state) return null

		// Single-use
		this.states.delete(stateValue)

		// Check expiry
		if (Date.now() > state.expiresAt) return null

		return state
	}

	async cleanExpired(): Promise<number> {
		const now = Date.now()
		let count = 0
		for (const [key, state] of this.states) {
			if (now > state.expiresAt) {
				this.states.delete(key)
				count++
			}
		}
		return count
	}
}

// ============================================================================
// OAuthManager
// ============================================================================

/**
 * Configuration for the OAuth manager.
 */
export interface OAuthManagerConfig {
	/** Registered OAuth providers */
	providers: OAuthProviderConfig[]
	/** State store. Defaults to InMemoryOAuthStateStore. */
	stateStore?: OAuthStateStore
	/** State TTL in milliseconds. Defaults to 10 minutes. */
	stateTtlMs?: number
	/**
	 * Custom fetch function. Defaults to global fetch.
	 * Useful for testing or custom HTTP clients.
	 */
	fetch?: typeof globalThis.fetch
}

/**
 * Manages the OAuth 2.0 authorization code flow.
 *
 * Supports any standard OAuth 2.0 / OpenID Connect provider.
 * Pre-built configurations available for Google, GitHub, and Microsoft.
 *
 * @example
 * ```typescript
 * const oauth = new OAuthManager({
 *   providers: [
 *     googleProvider({ clientId: '...', clientSecret: '...', redirectUri: '...' }),
 *     githubProvider({ clientId: '...', clientSecret: '...', redirectUri: '...' }),
 *   ],
 * })
 *
 * // Step 1: Generate authorization URL
 * const { url, state } = await oauth.getAuthorizationUrl('google')
 * // Redirect user to url...
 *
 * // Step 2: Handle callback
 * const { tokens, userInfo } = await oauth.handleCallback('google', code, stateParam)
 * ```
 */
export class OAuthManager {
	private readonly providers = new Map<string, OAuthProviderConfig>()
	private readonly stateStore: OAuthStateStore
	private readonly stateTtlMs: number
	private readonly fetchFn: typeof globalThis.fetch

	constructor(config: OAuthManagerConfig) {
		for (const provider of config.providers) {
			this.providers.set(provider.providerId, provider)
		}
		this.stateStore = config.stateStore ?? new InMemoryOAuthStateStore()
		this.stateTtlMs = config.stateTtlMs ?? DEFAULT_STATE_TTL_MS
		this.fetchFn = config.fetch ?? globalThis.fetch.bind(globalThis)
	}

	/**
	 * Generate an authorization URL for the user to visit.
	 * Returns the URL and the state parameter for CSRF validation.
	 */
	async getAuthorizationUrl(
		providerId: string,
		metadata?: Record<string, unknown>,
		flow: OAuthFlowBinding = {},
	): Promise<{ url: string; state: string }> {
		const provider = this.getProvider(providerId)
		const purpose = flow.purpose ?? 'signin'
		if (purpose === 'link' && !flow.userId) {
			throw new OAuthStateMismatchError()
		}
		const stored: StoredBinding = {
			purpose,
			...(flow.userId ? { userId: flow.userId } : {}),
			...(flow.binding ? { bindingHash: await sha256Base64Url(flow.binding) } : {}),
		}
		const userMetadata = { ...(metadata ?? {}) }
		delete userMetadata[BINDING_METADATA_KEY]

		const state = generateState()
		const codeVerifier = provider.pkce ? generateCodeVerifier() : undefined
		const codeChallenge = codeVerifier ? await createCodeChallenge(codeVerifier) : undefined
		const now = Date.now()

		const oauthState: OAuthState = {
			state,
			provider: providerId,
			redirectUri: provider.redirectUri,
			createdAt: now,
			expiresAt: now + this.stateTtlMs,
			metadata: { ...userMetadata, [BINDING_METADATA_KEY]: stored },
			codeVerifier,
		}

		await this.stateStore.store(oauthState)

		const params = new URLSearchParams({
			client_id: provider.clientId,
			redirect_uri: provider.redirectUri,
			response_type: 'code',
			scope: provider.scopes.join(' '),
			state,
		})
		if (codeChallenge) {
			params.set('code_challenge', codeChallenge)
			params.set('code_challenge_method', 'S256')
		}

		const url = `${provider.authorizationUrl}?${params.toString()}`
		return { url, state }
	}

	/**
	 * Handle the OAuth callback after the user authorizes.
	 * Validates the state parameter, exchanges the code for tokens,
	 * and fetches user info.
	 *
	 * The state is single-use and is redeemable only for the purpose it was
	 * minted for, by the same user (for linking) and the same client binding.
	 * A mismatch is rejected before the code is exchanged.
	 *
	 * @param providerId - The OAuth provider
	 * @param code - The authorization code from the callback
	 * @param state - The state parameter from the callback
	 * @param expected - The purpose, user and client binding of this callback
	 * @returns Tokens and user info from the provider
	 */
	async handleCallback(
		providerId: string,
		code: string,
		state: string,
		expected: OAuthFlowBinding = {},
	): Promise<{
		tokens: OAuthTokens
		userInfo: OAuthUserInfo
		stateMetadata?: Record<string, unknown>
	}> {
		const provider = this.getProvider(providerId)

		// Validate state (CSRF protection)
		const oauthState = await this.stateStore.consume(state)
		if (!oauthState || oauthState.provider !== providerId) {
			throw new OAuthStateMismatchError()
		}
		await assertBindingMatches(oauthState, expected)

		// Exchange code for tokens
		const tokens = await this.exchangeCodeForTokens(provider, code, oauthState)

		// Fetch user info
		const userInfo = await this.fetchUserInfo(provider, tokens.accessToken)

		return { tokens, userInfo, stateMetadata: withoutBinding(oauthState.metadata) }
	}

	/**
	 * Get a registered provider by ID.
	 */
	getProvider(providerId: string): OAuthProviderConfig {
		const provider = this.providers.get(providerId)
		if (!provider) {
			throw new OAuthProviderNotFoundError(providerId)
		}
		return provider
	}

	/**
	 * List all registered provider IDs.
	 */
	getProviderIds(): string[] {
		return [...this.providers.keys()]
	}

	// --- Private ---

	private async exchangeCodeForTokens(
		provider: OAuthProviderConfig,
		code: string,
		oauthState: OAuthState,
	): Promise<OAuthTokens> {
		const body = new URLSearchParams({
			grant_type: 'authorization_code',
			code,
			redirect_uri: provider.redirectUri,
			client_id: provider.clientId,
		})
		if (provider.clientSecret) {
			body.set('client_secret', provider.clientSecret)
		}
		if (oauthState.codeVerifier) {
			body.set('code_verifier', oauthState.codeVerifier)
		}

		let response: Response
		try {
			response = await this.fetchFn(provider.tokenUrl, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					Accept: 'application/json',
				},
				body: body.toString(),
			})
		} catch (err) {
			throw new OAuthCodeExchangeError(err instanceof Error ? err.message : 'Network error')
		}

		if (!response.ok) {
			let details = `HTTP ${response.status}`
			try {
				const errorBody = await response.text()
				details += `: ${errorBody}`
			} catch {
				// ignore
			}
			throw new OAuthCodeExchangeError(details)
		}

		const data = (await response.json()) as Record<string, unknown>

		return {
			accessToken: data.access_token as string,
			tokenType: (data.token_type as string) ?? 'Bearer',
			expiresIn: data.expires_in as number | undefined,
			refreshToken: data.refresh_token as string | undefined,
			idToken: data.id_token as string | undefined,
			scope: data.scope as string | undefined,
		}
	}

	private async fetchUserInfo(
		provider: OAuthProviderConfig,
		accessToken: string,
	): Promise<OAuthUserInfo> {
		let response: Response
		try {
			response = await this.fetchFn(provider.userInfoUrl, {
				headers: {
					Authorization: `Bearer ${accessToken}`,
					Accept: 'application/json',
				},
			})
		} catch (err) {
			throw new OAuthUserInfoError(err instanceof Error ? err.message : 'Network error')
		}

		if (!response.ok) {
			throw new OAuthUserInfoError(`HTTP ${response.status}`)
		}

		const profile = (await response.json()) as Record<string, unknown>

		// Normalize user info based on provider
		return normalizeUserInfo(provider.providerId, profile)
	}
}

// ============================================================================
// User Info Normalization
// ============================================================================

function normalizeUserInfo(providerId: string, profile: Record<string, unknown>): OAuthUserInfo {
	switch (providerId) {
		case 'google':
			return {
				providerId: profile.sub as string,
				provider: 'google',
				email: (profile.email as string) ?? null,
				emailVerified: (profile.email_verified as boolean) ?? false,
				name: (profile.name as string) ?? null,
				avatarUrl: (profile.picture as string) ?? null,
				rawProfile: profile,
			}
		case 'github':
			return {
				providerId: String(profile.id),
				provider: 'github',
				email: (profile.email as string) ?? null,
				emailVerified: false, // GitHub doesn't confirm in the profile response
				name: (profile.name as string) ?? (profile.login as string) ?? null,
				avatarUrl: (profile.avatar_url as string) ?? null,
				rawProfile: profile,
			}
		case 'microsoft':
			return {
				providerId: profile.id as string,
				provider: 'microsoft',
				email: (profile.mail as string) ?? (profile.userPrincipalName as string) ?? null,
				emailVerified: false,
				name: (profile.displayName as string) ?? null,
				avatarUrl: null,
				rawProfile: profile,
			}
		default:
			// Generic normalization
			return {
				providerId: String(profile.id ?? profile.sub ?? ''),
				provider: providerId,
				email: (profile.email as string) ?? null,
				emailVerified: (profile.email_verified as boolean) ?? false,
				name: (profile.name as string) ?? null,
				avatarUrl: (profile.picture as string) ?? (profile.avatar_url as string) ?? null,
				rawProfile: profile,
			}
	}
}

// ============================================================================
// Provider Factories
// ============================================================================

interface ProviderFactoryConfig {
	clientId: string
	clientSecret?: string
	redirectUri: string
	scopes?: string[]
	pkce?: boolean
}

/**
 * Create a Google OAuth provider configuration.
 */
export function googleProvider(config: ProviderFactoryConfig): OAuthProviderConfig {
	return {
		providerId: 'google',
		clientId: config.clientId,
		clientSecret: config.clientSecret,
		authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
		tokenUrl: 'https://oauth2.googleapis.com/token',
		userInfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
		scopes: config.scopes ?? ['openid', 'email', 'profile'],
		redirectUri: config.redirectUri,
		pkce: config.pkce,
	}
}

/**
 * Create a GitHub OAuth provider configuration.
 */
export function githubProvider(config: ProviderFactoryConfig): OAuthProviderConfig {
	return {
		providerId: 'github',
		clientId: config.clientId,
		clientSecret: config.clientSecret,
		authorizationUrl: 'https://github.com/login/oauth/authorize',
		tokenUrl: 'https://github.com/login/oauth/access_token',
		userInfoUrl: 'https://api.github.com/user',
		scopes: config.scopes ?? ['read:user', 'user:email'],
		redirectUri: config.redirectUri,
		pkce: config.pkce,
	}
}

/**
 * Create a Microsoft OAuth provider configuration.
 */
export function microsoftProvider(
	config: ProviderFactoryConfig & { tenantId?: string },
): OAuthProviderConfig {
	const tenant = config.tenantId ?? 'common'
	return {
		providerId: 'microsoft',
		clientId: config.clientId,
		clientSecret: config.clientSecret,
		authorizationUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
		tokenUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
		userInfoUrl: 'https://graph.microsoft.com/v1.0/me',
		scopes: config.scopes ?? ['openid', 'email', 'profile', 'User.Read'],
		redirectUri: config.redirectUri,
		pkce: config.pkce,
	}
}

// ============================================================================
// Helpers
// ============================================================================

function readStoredBinding(state: OAuthState): StoredBinding {
	const raw = state.metadata?.[BINDING_METADATA_KEY]
	if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
		const value = raw as Record<string, unknown>
		return {
			purpose: value.purpose === 'link' ? 'link' : 'signin',
			...(typeof value.userId === 'string' ? { userId: value.userId } : {}),
			...(typeof value.bindingHash === 'string' ? { bindingHash: value.bindingHash } : {}),
		}
	}
	// States minted before beta.13 carry no binding: they are sign-in states.
	return { purpose: 'signin' }
}

async function assertBindingMatches(state: OAuthState, expected: OAuthFlowBinding): Promise<void> {
	const stored = readStoredBinding(state)
	const purpose = expected.purpose ?? 'signin'
	if (stored.purpose !== purpose) throw new OAuthStateMismatchError()
	if (purpose === 'link' && (!expected.userId || stored.userId !== expected.userId)) {
		throw new OAuthStateMismatchError()
	}
	if (stored.bindingHash !== undefined) {
		if (!expected.binding) throw new OAuthStateMismatchError()
		const presented = await sha256Base64Url(expected.binding)
		if (!constantTimeEqual(presented, stored.bindingHash)) throw new OAuthStateMismatchError()
	}
}

function withoutBinding(
	metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!metadata) return undefined
	const copy = { ...metadata }
	delete copy[BINDING_METADATA_KEY]
	return Object.keys(copy).length > 0 ? copy : undefined
}

async function sha256Base64Url(value: string): Promise<string> {
	const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
	return toBase64Url(new Uint8Array(digest))
}

function constantTimeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false
	let diff = 0
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
	return diff === 0
}

/**
 * Generate a random client binding for an OAuth flow (32 bytes, base64url).
 */
export function generateOAuthBinding(): string {
	const bytes = new Uint8Array(32)
	globalThis.crypto.getRandomValues(bytes)
	return toBase64Url(bytes)
}

function generateState(): string {
	const bytes = new Uint8Array(32)
	globalThis.crypto.getRandomValues(bytes)
	return toBase64Url(bytes)
}

function generateCodeVerifier(): string {
	const bytes = new Uint8Array(PKCE_VERIFIER_BYTES)
	globalThis.crypto.getRandomValues(bytes)
	return toBase64Url(bytes)
}

async function createCodeChallenge(codeVerifier: string): Promise<string> {
	const data = new TextEncoder().encode(codeVerifier)
	const digest = await globalThis.crypto.subtle.digest('SHA-256', data)
	return toBase64Url(new Uint8Array(digest))
}

function toBase64Url(bytes: Uint8Array): string {
	let binary = ''
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i] as number)
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
