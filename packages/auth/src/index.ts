// @korajs/auth — public API
// Every export here is a public API commitment. Be explicit.

// === Client ===
export { AuthClient, AuthError } from './client/auth-client'
export type { AuthClientConfig, AuthUser, AuthState } from './client/auth-client'

// === Token Types ===
export type {
	AuthTokens,
	TokenPayload,
	TokenType,
	AuthConfig,
	AuthStatus,
	AuthEvent,
	AuthEventType,
} from './types'

// === Device Identity ===
export {
	generateDeviceKeyPair,
	exportPublicKeyJwk,
	signChallenge,
	verifyChallenge,
	computePublicKeyThumbprint,
	toBase64Url,
	fromBase64Url,
	CryptoUnavailableError,
	DeviceIdentityError,
} from './device/device-identity'

// === Token Store (client-side persistence) ===
export { TokenStore } from './tokens/token-store'
