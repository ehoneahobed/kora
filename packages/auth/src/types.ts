import type { AuthUser } from './client/auth-client'

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
	/**
	 * Refresh-token family id. Every token minted by one sign-in and its refresh
	 * rotations shares it, so reuse detection can revoke exactly that family
	 * instead of the whole device. Absent on tokens minted before beta.13.
	 */
	fam?: string
	/**
	 * Issue time in milliseconds. `iat` has one-second resolution, which is too
	 * coarse to order a token against a revocation made in the same second.
	 */
	iatMs?: number
	/**
	 * Authentication methods used to obtain this session (RFC 8176), for example
	 * `['pwd']` or `['pwd', 'otp']`.
	 */
	amr?: string[]
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

// ============================================================================
// Auth events
// ============================================================================

/**
 * Events emitted by the auth system. `user` is the client's {@link AuthUser}, the same shape
 * as `AuthClient.currentUser`.
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

// ============================================================================
// Constants
// ============================================================================

/** Default access token lifetime: 15 minutes */
export const DEFAULT_ACCESS_TOKEN_LIFETIME = 15 * 60 * 1000

/** Default refresh token lifetime: 90 days */
export const DEFAULT_REFRESH_TOKEN_LIFETIME = 90 * 24 * 60 * 60 * 1000

/** Default device credential lifetime: 90 days */
export const DEFAULT_DEVICE_CREDENTIAL_LIFETIME = 90 * 24 * 60 * 60 * 1000
