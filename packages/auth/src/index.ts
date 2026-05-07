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

// === Device Key Store (persistent storage for device key pairs) ===
export {
	createDeviceKeyStore,
	IndexedDBDeviceKeyStore,
	InMemoryDeviceKeyStore,
	DeviceKeyStoreError,
} from './device/device-store'
export type { DeviceKeyStore } from './device/device-store'

// === Token Store (client-side persistence) ===
export { TokenStore } from './tokens/token-store'

// === Encryption (Phase 2: local data protection) ===
export {
	generateEncryptionKey,
	encryptData,
	decryptData,
	exportKey,
	importKey,
	EncryptionError,
} from './encryption/database-encryption'

export {
	deriveEncryptionKey,
	generateSalt,
	KeyDerivationError,
} from './encryption/key-derivation'

export { AutoLockManager } from './encryption/auto-lock'
export type { AutoLockConfig } from './encryption/auto-lock'
