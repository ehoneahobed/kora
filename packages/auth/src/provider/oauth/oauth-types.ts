import { KoraError } from '@korajs/core'

// ============================================================================
// OAuth Provider Configuration
// ============================================================================

/**
 * Configuration for an OAuth 2.0 provider.
 */
export interface OAuthProviderConfig {
	/** Provider identifier (e.g., 'google', 'github', 'microsoft') */
	providerId: string
	/** OAuth client ID */
	clientId: string
	/** OAuth client secret */
	clientSecret: string
	/** Authorization endpoint URL */
	authorizationUrl: string
	/** Token exchange endpoint URL */
	tokenUrl: string
	/** User info endpoint URL */
	userInfoUrl: string
	/** OAuth scopes to request */
	scopes: string[]
	/** Redirect URI for the callback */
	redirectUri: string
}

// ============================================================================
// OAuth Tokens
// ============================================================================

/**
 * Tokens returned by the OAuth provider after code exchange.
 */
export interface OAuthTokens {
	/** OAuth access token */
	accessToken: string
	/** Token type (usually 'Bearer') */
	tokenType: string
	/** Access token expiry in seconds (if provided) */
	expiresIn?: number
	/** Refresh token (if provided) */
	refreshToken?: string
	/** ID token (if provided, e.g., OpenID Connect) */
	idToken?: string
	/** Granted scopes (may differ from requested scopes) */
	scope?: string
}

// ============================================================================
// OAuth User Info
// ============================================================================

/**
 * User information from the OAuth provider.
 */
export interface OAuthUserInfo {
	/** Provider-specific user ID */
	providerId: string
	/** Provider name (e.g., 'google', 'github') */
	provider: string
	/** User's email address (may be null if not granted) */
	email: string | null
	/** Whether the email is verified by the provider */
	emailVerified: boolean
	/** User's display name */
	name: string | null
	/** URL to the user's avatar/profile picture */
	avatarUrl: string | null
	/** Raw profile data from the provider */
	rawProfile: Record<string, unknown>
}

// ============================================================================
// OAuth State
// ============================================================================

/**
 * State stored during the OAuth flow for CSRF protection.
 */
export interface OAuthState {
	/** Random state parameter for CSRF protection */
	state: string
	/** Provider ID */
	provider: string
	/** Redirect URI used for this flow */
	redirectUri: string
	/** When this state was created (ms since epoch) */
	createdAt: number
	/** When this state expires (ms since epoch) */
	expiresAt: number
	/** Optional: user-defined data to pass through the flow */
	metadata?: Record<string, unknown>
}

/**
 * Store for OAuth state parameters.
 */
export interface OAuthStateStore {
	/** Store a state parameter for later validation. */
	store(state: OAuthState): Promise<void>
	/** Consume a state parameter (single-use). Returns null if not found or expired. */
	consume(stateValue: string): Promise<OAuthState | null>
	/** Clean up expired states. */
	cleanExpired(): Promise<number>
}

// ============================================================================
// Linked Identity
// ============================================================================

/**
 * A linked OAuth identity for a user.
 * Users can have multiple linked identities (e.g., Google + GitHub).
 */
export interface LinkedIdentity {
	/** Unique ID of this link */
	id: string
	/** Kora user ID */
	userId: string
	/** OAuth provider name */
	provider: string
	/** Provider-specific user ID */
	providerUserId: string
	/** Provider email (at time of linking) */
	email: string | null
	/** When this identity was linked */
	linkedAt: number
}

// ============================================================================
// Errors
// ============================================================================

export class OAuthError extends KoraError {
	constructor(message: string, code: string, context?: Record<string, unknown>) {
		super(message, code, context)
		this.name = 'OAuthError'
	}
}

export class OAuthStateMismatchError extends OAuthError {
	constructor() {
		super('OAuth state parameter does not match. Possible CSRF attack.', 'OAUTH_STATE_MISMATCH')
	}
}

export class OAuthCodeExchangeError extends OAuthError {
	constructor(details?: string) {
		super(
			`Failed to exchange authorization code for tokens.${details ? ` ${details}` : ''}`,
			'OAUTH_CODE_EXCHANGE_FAILED',
			details ? { details } : undefined,
		)
	}
}

export class OAuthUserInfoError extends OAuthError {
	constructor(details?: string) {
		super(
			`Failed to fetch user info from OAuth provider.${details ? ` ${details}` : ''}`,
			'OAUTH_USER_INFO_FAILED',
			details ? { details } : undefined,
		)
	}
}

export class OAuthProviderNotFoundError extends OAuthError {
	constructor(provider: string) {
		super(`OAuth provider "${provider}" is not configured.`, 'OAUTH_PROVIDER_NOT_FOUND', { provider })
	}
}
