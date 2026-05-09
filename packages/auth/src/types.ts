import { KoraError } from '@korajs/core'

// ============================================================================
// User types
// ============================================================================

/**
 * Authenticated user record.
 * Represents the public-facing user identity returned by sign-in and sign-up flows.
 */
export interface AuthUser {
	/** Unique user identifier (UUID v7) */
	id: string
	/** User's email address, used as the primary login credential */
	email: string
	/** Display name */
	name: string
	/** Timestamp of user creation (milliseconds since epoch) */
	createdAt: number
	/** Timestamp of last profile update (milliseconds since epoch) */
	updatedAt: number
}

/**
 * A registered device that can operate on behalf of a user.
 * Each device has its own keypair for offline credential verification.
 */
export interface AuthDevice {
	/** Device identifier, same as the Kora nodeId for this device */
	id: string
	/** The user this device belongs to */
	userId: string
	/** JWK-encoded public key for this device's keypair */
	publicKey: string
	/** Human-readable device name (e.g., "Chrome on MacBook") */
	name: string
	/** Timestamp when the device was first registered (milliseconds since epoch) */
	registeredAt: number
	/** Timestamp of last activity from this device (milliseconds since epoch) */
	lastSeenAt: number
	/** Whether this device is allowed to sync */
	status: DeviceStatus
}

/** Device status values */
export type DeviceStatus = 'active' | 'revoked'

// ============================================================================
// Token types
// ============================================================================

/** The three kinds of tokens issued by the auth system */
export type TokenType = 'access' | 'refresh' | 'device_credential'

/**
 * Base payload present in all JWT tokens.
 * Fields follow standard JWT claim names.
 */
export interface TokenPayload {
	/** JWT ID: unique identifier for this specific token (for revocation and replay detection) */
	jti: string
	/** Subject: the user ID */
	sub: string
	/** Device ID that this token was issued to */
	dev: string
	/** Which kind of token this is */
	type: TokenType
	/** Issued-at time (seconds since epoch, per JWT spec) */
	iat: number
	/** Expiration time (seconds since epoch, per JWT spec) */
	exp: number
}

/**
 * Short-lived token used to authenticate API requests.
 * Typically lives for 15 minutes.
 */
export interface AccessTokenPayload extends TokenPayload {
	type: 'access'
}

/**
 * Longer-lived token used to obtain new access tokens.
 * Typically lives for 90 days.
 */
export interface RefreshTokenPayload extends TokenPayload {
	type: 'refresh'
}

/**
 * Offline credential stored on the device.
 * Allows the device to continue operating offline, with a mandatory
 * check-in deadline by which it must reconnect to remain authorized.
 */
export interface DeviceCredentialPayload extends TokenPayload {
	type: 'device_credential'
	/** Device public key thumbprint, binds this credential to a specific device keypair */
	dpk: string
	/** Timestamp (seconds since epoch) by which the device must check in with the server */
	mustCheckinBy: number
}

/**
 * Bundle of tokens returned after successful authentication.
 */
export interface AuthTokens {
	/** Short-lived access token */
	accessToken: string
	/** Long-lived refresh token */
	refreshToken: string
	/** Optional device credential for offline operation */
	deviceCredential?: string
}

// ============================================================================
// Auth configuration
// ============================================================================

/** Supported auth provider types */
export type AuthProviderType = 'built-in' | 'custom'

/** Unlock mechanism for encrypted local storage */
export type UnlockMethod = 'biometric' | 'passphrase' | 'both'

/**
 * Encryption settings for locally stored auth credentials.
 */
export interface AuthEncryptionConfig {
	/** Whether local credential encryption is enabled */
	enabled: boolean
	/** How the user unlocks encrypted credentials */
	unlock: UnlockMethod
	/** Milliseconds of inactivity before the app auto-locks. Defaults to 15 minutes. */
	autoLockTimeout?: number
}

/**
 * Custom lifetimes for each token type.
 * All values are in milliseconds.
 */
export interface TokenLifetimeConfig {
	/** Access token lifetime in ms. Default: 15 minutes. */
	access?: number
	/** Refresh token lifetime in ms. Default: 90 days. */
	refresh?: number
	/** Device credential lifetime in ms. Default: 90 days. */
	deviceCredential?: number
}

/**
 * Configuration for the Kora auth system.
 * Passed to the auth initializer to control provider, encryption, and token behavior.
 */
export interface AuthConfig {
	/** Which auth provider to use */
	provider: AuthProviderType
	/** Local encryption settings for stored credentials */
	encryption?: AuthEncryptionConfig
	/** Maximum time a device can operate offline without checking in (ms). Default: 30 days. */
	maxOfflineDuration?: number
	/** Custom token lifetimes */
	tokenLifetimes?: TokenLifetimeConfig
}

// ============================================================================
// Auth state
// ============================================================================

/** Possible authentication states */
export type AuthStatus = 'authenticated' | 'unauthenticated' | 'locked'

/**
 * Current state of the auth system.
 * This is the value exposed to the UI layer for rendering auth-dependent views.
 */
export interface AuthState {
	/** Current authentication status */
	status: AuthStatus
	/** The authenticated user, or null if unauthenticated/locked */
	user: AuthUser | null
	/** The current device's ID, or null if not yet registered */
	deviceId: string | null
}

// ============================================================================
// Auth events
// ============================================================================

/**
 * Events emitted by the auth system.
 * These integrate with Kora's event system for DevTools observability.
 */
export type AuthEvent =
	| { type: 'auth:signed-in'; user: AuthUser }
	| { type: 'auth:signed-out' }
	| { type: 'auth:locked' }
	| { type: 'auth:unlocked'; user: AuthUser }
	| { type: 'auth:token-refreshed' }
	| { type: 'auth:device-revoked'; deviceId: string }
	| { type: 'auth:permission-changed' }

/** Extract the event type string union from AuthEvent */
export type AuthEventType = AuthEvent['type']

/** Extract a specific auth event by its type */
export type AuthEventByType<T extends AuthEventType> = Extract<AuthEvent, { type: T }>

// ============================================================================
// Auth errors
// ============================================================================

/**
 * Base error class for authentication-related failures.
 * Extends KoraError to integrate with the framework's error handling patterns.
 */
export class AuthError extends KoraError {
	constructor(message: string, code: string, context?: Record<string, unknown>) {
		super(message, code, context)
		this.name = 'AuthError'
	}
}

/**
 * Thrown when sign-in credentials are invalid (wrong email or password).
 */
export class InvalidCredentialsError extends AuthError {
	constructor() {
		super('Invalid email or password.', 'AUTH_INVALID_CREDENTIALS')
		this.name = 'InvalidCredentialsError'
	}
}

/**
 * Thrown when a user tries to sign up with an email that already exists.
 */
export class EmailAlreadyExistsError extends AuthError {
	constructor() {
		super('An account with this email already exists.', 'AUTH_EMAIL_EXISTS')
		this.name = 'EmailAlreadyExistsError'
	}
}

/**
 * Thrown when a token is expired, malformed, or has an invalid signature.
 */
export class TokenError extends AuthError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, 'AUTH_TOKEN_ERROR', context)
		this.name = 'TokenError'
	}
}

/**
 * Thrown when a device's credential has expired or the device has been revoked.
 */
export class DeviceRevokedError extends AuthError {
	constructor(deviceId: string) {
		super(`Device "${deviceId}" has been revoked and can no longer sync.`, 'AUTH_DEVICE_REVOKED', {
			deviceId,
		})
		this.name = 'DeviceRevokedError'
	}
}

/**
 * Thrown when the maximum offline duration has been exceeded
 * and the device must reconnect to continue operating.
 */
export class OfflineExpiredError extends AuthError {
	constructor(maxDuration: number, lastCheckin: number) {
		const daysSinceCheckin = Math.round((Date.now() - lastCheckin) / (24 * 60 * 60 * 1000))
		super(
			`Device has been offline for ${daysSinceCheckin} days, exceeding the maximum offline duration. Reconnect to re-authenticate.`,
			'AUTH_OFFLINE_EXPIRED',
			{ maxDuration, lastCheckin, daysSinceCheckin },
		)
		this.name = 'OfflineExpiredError'
	}
}

// ============================================================================
// Sign up / sign in params
// ============================================================================

/**
 * Parameters for creating a new user account.
 */
export interface SignUpParams {
	/** Email address (used as login credential) */
	email: string
	/** Password (will be hashed before storage) */
	password: string
	/** Optional display name. Defaults to the local part of the email if omitted. */
	name?: string
}

/**
 * Parameters for signing in to an existing account.
 */
export interface SignInParams {
	/** Email address */
	email: string
	/** Password */
	password: string
}

// ============================================================================
// Server-side types for the built-in provider
// ============================================================================

/**
 * Parameters for creating a user record in the server-side store.
 * The password has already been hashed by the time this is used.
 */
export interface CreateUserParams {
	/** Email address */
	email: string
	/** Argon2id or bcrypt hash of the password */
	passwordHash: string
	/** Random salt used during hashing */
	salt: string
	/** Display name */
	name: string
}

/**
 * Full user record as stored on the server, including sensitive credential fields.
 * This type must NEVER be returned to the client; strip passwordHash and salt first.
 */
export interface StoredUser extends AuthUser {
	/** Hashed password */
	passwordHash: string
	/** Salt used for hashing */
	salt: string
}

// ============================================================================
// Auth provider adapter interface
// ============================================================================

/**
 * Adapter interface for pluggable auth providers.
 * Implement this to integrate Kora auth with a custom identity provider
 * (e.g., Firebase Auth, Auth0, Supabase Auth).
 *
 * The built-in provider implements this interface internally.
 */
export interface AuthProviderAdapter {
	/** Register a new user and return the user with initial tokens */
	signUp(params: SignUpParams): Promise<{ user: AuthUser; tokens: AuthTokens }>
	/** Authenticate an existing user and return the user with tokens */
	signIn(params: SignInParams): Promise<{ user: AuthUser; tokens: AuthTokens }>
	/** Exchange a refresh token for a new token set */
	refreshToken(refreshToken: string): Promise<AuthTokens>
	/** Validate an access token and return its payload, or null if invalid */
	validateAccessToken(token: string): Promise<TokenPayload | null>
	/** Revoke a device, preventing it from syncing */
	revokeDevice(deviceId: string): Promise<void>
}

// ============================================================================
// Constants
// ============================================================================

/** Default access token lifetime: 15 minutes */
export const DEFAULT_ACCESS_TOKEN_LIFETIME = 15 * 60 * 1000

/** Default refresh token lifetime: 90 days */
export const DEFAULT_REFRESH_TOKEN_LIFETIME = 90 * 24 * 60 * 60 * 1000

/** Default device credential lifetime: 90 days */
export const DEFAULT_DEVICE_CREDENTIAL_LIFETIME = 90 * 24 * 60 * 60 * 1000

/** Default maximum offline duration: 30 days */
export const DEFAULT_MAX_OFFLINE_DURATION = 30 * 24 * 60 * 60 * 1000

/** Default auto-lock timeout: 15 minutes */
export const DEFAULT_AUTO_LOCK_TIMEOUT = 15 * 60 * 1000
