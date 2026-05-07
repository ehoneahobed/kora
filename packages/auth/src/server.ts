// @korajs/auth/server — Server-side public API
// Every export here is a public API commitment. Be explicit.

// === Auth Routes (built-in email/password provider) ===
export { BuiltInAuthRoutes, InMemoryChallengeStore, InMemoryRateLimiter } from './provider/built-in/auth-routes'
export type { AuthRoutesConfig, AuthRouteResponse, ChallengeStore, RateLimiter } from './provider/built-in/auth-routes'

// === Token Manager ===
export { TokenManager, InMemoryTokenRevocationStore } from './tokens/token-manager'
export type { TokenManagerConfig, TokenRevocationStore } from './tokens/token-manager'

// === JWT Utilities ===
export { encodeJwt, decodeJwt, verifyJwt, isExpired } from './tokens/jwt'

// === Password Hashing ===
export { hashPassword, verifyPassword } from './provider/built-in/password-hash'

// === User Store ===
export { InMemoryUserStore, DuplicateEmailError } from './provider/built-in/user-store'
export type { AuthUser, StoredUser, AuthDevice } from './provider/built-in/user-store'

// === Provider Adapter ===
export { BuiltInProvider, AuthProviderError } from './provider/adapter'
export type { AuthProviderAdapter, SignUpParams, SignInParams } from './provider/adapter'

// === External Auth Provider Adapters ===
export {
	ExternalJwtProvider,
	ExternalAuthOperationNotSupportedError,
	ExternalTokenValidationError,
} from './provider/external/external-jwt-provider'
export type {
	ExternalJwtProviderConfig,
	ExternalUserInfo,
} from './provider/external/external-jwt-provider'

export { createClerkAdapter } from './provider/external/clerk-adapter'
export type { ClerkAdapterConfig } from './provider/external/clerk-adapter'

export { createSupabaseAdapter } from './provider/external/supabase-adapter'
export type { SupabaseAdapterConfig } from './provider/external/supabase-adapter'

// === Passkey / WebAuthn (server-side verification) ===
export {
	generateRegistrationOptions,
	verifyRegistrationResponse,
	generateAuthenticationOptions,
	verifyAuthenticationResponse,
	PasskeyVerificationError,
} from './passkey/passkey-server'
export type {
	RegistrationOptions,
	RegistrationVerificationResult,
	AuthenticationOptions,
	AuthenticationVerificationResult,
} from './passkey/passkey-server'

// === E2E Operation Encryption (server-side: detect encrypted fields) ===
export {
	OperationEncryptor,
	OperationEncryptionError,
	isEncryptedField,
} from './encryption/operation-encryptor'
export type { OperationEncryptorConfig } from './encryption/operation-encryptor'

// === Device Identity (verification on server) ===
export { verifyChallenge, computePublicKeyThumbprint } from './device/device-identity'
