// @korajs/auth/server — Server-side public API
// Every export here is a public API commitment. Be explicit.

// === Auth Routes (built-in email/password provider) ===
export {
	BuiltInAuthRoutes,
	InMemoryChallengeStore,
	InMemoryRateLimiter,
} from './provider/built-in/auth-routes'
export type {
	AuthRoutesConfig,
	AuthRouteResponse,
	ChallengeStore,
	RateLimiter,
} from './provider/built-in/auth-routes'
export { createKoraAuthServer } from './provider/built-in/quickstart-server'
export type {
	CreateKoraAuthServerOptions,
	KoraAuthHttpRequest,
	KoraAuthServer,
} from './provider/built-in/quickstart-server'

// === Token Manager ===
export { TokenManager, InMemoryTokenRevocationStore } from './tokens/token-manager'
export type { TokenManagerConfig, TokenRevocationStore } from './tokens/token-manager'

// === JWT Utilities ===
export { encodeJwt, decodeJwt, verifyJwt, isExpired } from './tokens/jwt'

// === Password Hashing ===
export { hashPassword, verifyPassword } from './provider/built-in/password-hash'

// === Password Reset ===
export {
	PasswordResetManager,
	InMemoryPasswordResetStore,
	PasswordResetError,
	ResetTokenExpiredError,
	ResetTokenNotFoundError,
	ResetRateLimitedError,
} from './provider/built-in/password-reset'
export type {
	PasswordResetToken,
	PasswordResetStore,
	PasswordResetConfig,
} from './provider/built-in/password-reset'

// === Email Verification ===
export {
	EmailVerificationManager,
	InMemoryEmailVerificationStore,
	EmailVerificationError,
	VerificationTokenExpiredError,
	VerificationTokenNotFoundError,
} from './provider/built-in/email-verification'
export type {
	EmailVerificationToken,
	EmailVerificationStore,
	EmailVerificationConfig,
} from './provider/built-in/email-verification'

// === User Store ===
export { InMemoryUserStore, DuplicateEmailError } from './provider/built-in/user-store'
export type { UserStore, AuthUser, StoredUser, AuthDevice } from './provider/built-in/user-store'

// === SQLite User Store ===
export { SqliteUserStore, createSqliteUserStore } from './provider/built-in/sqlite-user-store'

// === PostgreSQL User Store ===
export { PostgresUserStore, createPostgresUserStore } from './provider/built-in/postgres-user-store'

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

// === Organizations & Memberships ===
export { OrgRoutes } from './org/org-routes'
export type { OrgRouteResponse, OrgRoutesConfig } from './org/org-routes'
export { InMemoryOrgStore } from './org/org-store'
export type { OrgStore } from './org/org-store'
export {
	OrgError,
	OrgNotFoundError,
	OrgSlugTakenError,
	MembershipNotFoundError,
	MemberAlreadyExistsError,
	InsufficientRoleError,
	CannotRemoveOwnerError,
	InvitationNotFoundError,
	InvitationExpiredError,
	hasRoleLevel,
	ROLE_HIERARCHY,
	ORG_ROLES,
	INVITATION_STATUSES,
} from './org/org-types'
export type {
	Organization,
	CreateOrgParams,
	UpdateOrgParams,
	Membership,
	OrgRole,
	OrgInvitation,
	CreateInvitationParams,
	InvitationStatus,
} from './org/org-types'

// === RBAC (Role-Based Access Control) ===
export { RbacEngine, defineRoles } from './rbac/rbac-engine'
export {
	BUILT_IN_ROLES,
	parsePermission,
	permissionCovers,
	RbacError,
	InvalidPermissionError,
	RoleNotFoundError,
	CircularInheritanceError,
} from './rbac/rbac-types'
export type {
	Permission,
	RoleDefinition,
	RbacConfig,
	SyncScopes,
	ScopeFilter,
	ScopeContext,
	CollectionScopeResolver,
} from './rbac/rbac-types'

// === Org Scope Resolver ===
export { OrgScopeResolver } from './rbac/scope-resolver'

// === OAuth / Social Login ===
export {
	OAuthManager,
	InMemoryOAuthStateStore,
	googleProvider,
	githubProvider,
	microsoftProvider,
} from './provider/oauth/oauth-flow'
export type { OAuthManagerConfig } from './provider/oauth/oauth-flow'
export {
	OAuthError,
	OAuthStateMismatchError,
	OAuthCodeExchangeError,
	OAuthUserInfoError,
	OAuthProviderNotFoundError,
} from './provider/oauth/oauth-types'
export type {
	OAuthProviderConfig,
	OAuthTokens,
	OAuthUserInfo,
	OAuthState,
	OAuthStateStore,
	LinkedIdentity,
} from './provider/oauth/oauth-types'

// === Session Management ===
export {
	SessionManager,
	InMemorySessionStore,
	SessionError,
	SessionNotFoundError,
	SessionExpiredError,
	SessionLimitExceededError,
	SessionMfaRequiredError,
} from './session/session'
export type {
	Session,
	SessionManagerConfig,
	CreateSessionParams,
	SessionStore,
} from './session/session'

// === TOTP MFA ===
export {
	TotpManager,
	InMemoryTotpStore,
	base32Encode,
	base32Decode,
	TotpError,
	TotpInvalidCodeError,
	TotpNotEnabledError,
	TotpAlreadyEnabledError,
	TotpNotVerifiedError,
	TotpRecoveryExhaustedError,
} from './mfa/totp'
export type {
	TotpConfig,
	TotpSecret,
	TotpSetupResult,
	TotpStore,
} from './mfa/totp'

// === Admin API ===
export {
	AdminApi,
	AdminApiError,
	AdminUserNotFoundError,
	AdminUnauthorizedError,
} from './admin/admin-api'
export type {
	AdminApiConfig,
	PaginatedResult,
	UserListQuery,
	AdminUserUpdate,
} from './admin/admin-api'

// === Audit Logging ===
export {
	AuditLogger,
	InMemoryAuditLogStore,
	AuditLogError,
} from './admin/audit-log'
export type {
	AuditAction,
	AuditEntry,
	AuditLogQuery,
	AuditLogStore,
} from './admin/audit-log'

// === Webhooks ===
export {
	WebhookManager,
	InMemoryWebhookStore,
	verifyWebhookSignature,
	WebhookError,
	WebhookEndpointNotFoundError,
} from './admin/webhooks'
export type {
	WebhookEvent,
	WebhookEndpoint,
	WebhookDelivery,
	WebhookPayload,
	WebhookStore,
} from './admin/webhooks'

// === Device Identity (verification on server) ===
export { verifyChallenge, computePublicKeyThumbprint } from './device/device-identity'
