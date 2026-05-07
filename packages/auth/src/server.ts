// @korajs/auth/server — Server-side public API
// Every export here is a public API commitment. Be explicit.

// === Auth Routes (built-in email/password provider) ===
export { BuiltInAuthRoutes } from './provider/built-in/auth-routes'
export type { AuthRoutesConfig, AuthRouteResponse } from './provider/built-in/auth-routes'

// === Token Manager ===
export { TokenManager } from './tokens/token-manager'
export type { TokenManagerConfig } from './tokens/token-manager'

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

// === Device Identity (verification on server) ===
export { verifyChallenge, computePublicKeyThumbprint } from './device/device-identity'
