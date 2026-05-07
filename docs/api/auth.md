# Auth API Reference

`@korajs/auth` provides authentication, authorization, encryption, and identity management for Kora.js applications.

The package exposes three entry points:

- `@korajs/auth` -- Client-side: auth client, device identity, token storage, passkeys, encryption
- `@korajs/auth/server` -- Server-side: auth routes, token management, sessions, MFA, orgs, RBAC, OAuth
- `@korajs/auth/react` -- React bindings: provider, hooks for auth and org state

---

## Client API

```typescript
import {
  AuthClient,
  AuthError,
  OrgClient,
  OrgClientError,
  TokenStore,
  EncryptedTokenStore,
  generateDeviceKeyPair,
  exportPublicKeyJwk,
  signChallenge,
  verifyChallenge,
  computePublicKeyThumbprint,
  toBase64Url,
  fromBase64Url,
  createDeviceKeyStore,
  IndexedDBDeviceKeyStore,
  InMemoryDeviceKeyStore,
} from '@korajs/auth'
```

### `AuthClient`

Client-side authentication manager. Handles token storage, session restoration, sign-up, sign-in, sign-out, automatic token refresh, and auth state change notifications. Framework-agnostic.

```typescript
const auth = new AuthClient({ serverUrl: 'http://localhost:3001' })
```

#### `AuthClientConfig`

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `serverUrl` | `string` | Yes | -- |
| `storageKey` | `string` | No | `'kora_auth'` |

#### Properties

- `state: AuthState` -- Current auth state: `'loading'`, `'authenticated'`, or `'unauthenticated'`.
- `currentUser: AuthUser | null` -- Currently authenticated user, or null.
- `isAuthenticated: boolean` -- Whether the user is currently authenticated.

#### Methods

- `initialize(): Promise<void>` -- Restore session from stored tokens. Safe to call multiple times.
- `signUp(params: { email: string; password: string; name?: string }): Promise<AuthUser>` -- Register a new account.
- `signIn(params: { email: string; password: string }): Promise<AuthUser>` -- Sign in with email/password.
- `signOut(): Promise<void>` -- Sign out. Clears local tokens and attempts server-side revocation (best-effort).
- `getAccessToken(): Promise<string | null>` -- Get a valid access token, auto-refreshing if expired.
- `getSyncToken(): Promise<string | null>` -- Alias for `getAccessToken()`. Used by the sync engine handshake.
- `onAuthChange(callback: (state: AuthState) => void): () => void` -- Subscribe to auth state changes. Returns an unsubscribe function.

#### Example

```typescript
const auth = new AuthClient({ serverUrl: 'http://localhost:3001' })
await auth.initialize()

if (!auth.isAuthenticated) {
  await auth.signIn({ email: 'alice@example.com', password: 'secret' })
}

const unsub = auth.onAuthChange((state) => {
  console.log('Auth state:', state)
})
```

### `AuthUser`

```typescript
interface AuthUser {
  id: string
  email: string
  name: string | null
}
```

### `AuthState`

```typescript
type AuthState = 'loading' | 'authenticated' | 'unauthenticated'
```

### `OrgClient`

Client-side organization management. Communicates with the server's org routes.

```typescript
const orgClient = new OrgClient({
  serverUrl: 'http://localhost:3001',
  getAccessToken: () => auth.getAccessToken(),
})
```

#### `OrgClientConfig`

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `serverUrl` | `string` | Yes | -- |
| `getAccessToken` | `() => Promise<string \| null>` | Yes | -- |

#### Properties

- `activeOrgId: string | null` -- Currently active organization ID.
- `activeOrg: ClientOrganization | null` -- Currently active organization.
- `activeRole: string | null` -- Current user's role in the active org.

#### Methods

- `switchOrg(orgId: string): Promise<void>` -- Switch to a different organization.
- `clearActiveOrg(): void` -- Clear the active organization.
- `createOrg(params: { name: string; slug?: string }): Promise<ClientOrganization>` -- Create a new organization.
- `listOrgs(): Promise<ClientOrganization[]>` -- List all organizations the user belongs to.
- `getOrg(orgId: string): Promise<ClientOrganization>` -- Get a single organization.
- `leaveOrg(orgId: string): Promise<void>` -- Leave an organization.
- `listMembers(orgId: string): Promise<ClientMembership[]>` -- List members of an org.
- `inviteMember(orgId: string, params: { email: string; role: string }): Promise<ClientInvitation>` -- Invite a user.
- `removeMember(orgId: string, userId: string): Promise<void>` -- Remove a member.
- `updateMemberRole(orgId: string, userId: string, role: string): Promise<void>` -- Update a member's role.
- `onOrgChange(callback: () => void): () => void` -- Subscribe to active org changes.

### `TokenStore`

Client-side token persistence backed by `localStorage` with an in-memory fallback. Used internally by `AuthClient`.

```typescript
import { TokenStore } from '@korajs/auth'
```

### `EncryptedTokenStore`

AES-256-GCM encrypted `localStorage` token store. Encrypts tokens at rest with a device-bound key.

```typescript
import { EncryptedTokenStore } from '@korajs/auth'

const store = new EncryptedTokenStore({ encryptionKey: key })
```

#### `EncryptedTokenStoreConfig`

| Field | Type | Required |
|-------|------|----------|
| `encryptionKey` | `CryptoKey` | Yes |

### Device Identity

Cryptographic device identity using ECDSA P-256 key pairs via the Web Crypto API.

#### Functions

- `generateDeviceKeyPair(): Promise<CryptoKeyPair>` -- Generate an ECDSA P-256 key pair.
- `exportPublicKeyJwk(publicKey: CryptoKey): Promise<JsonWebKey>` -- Export public key as JWK.
- `signChallenge(privateKey: CryptoKey, challenge: Uint8Array): Promise<Uint8Array>` -- Sign a challenge with the device's private key.
- `verifyChallenge(publicKey: CryptoKey, challenge: Uint8Array, signature: Uint8Array): Promise<boolean>` -- Verify a signed challenge.
- `computePublicKeyThumbprint(publicKey: CryptoKey): Promise<string>` -- Compute a SHA-256 thumbprint of the public key.
- `toBase64Url(buffer: ArrayBuffer | Uint8Array): string` -- Encode bytes to base64url.
- `fromBase64Url(str: string): Uint8Array` -- Decode base64url to bytes.

### Device Key Store

Persistent storage for device key pairs.

- `createDeviceKeyStore(): DeviceKeyStore` -- Create a store (IndexedDB with in-memory fallback).
- `IndexedDBDeviceKeyStore` -- IndexedDB-backed store.
- `InMemoryDeviceKeyStore` -- In-memory store (testing/development).

#### `DeviceKeyStore` Interface

```typescript
interface DeviceKeyStore {
  getKeyPair(): Promise<CryptoKeyPair | null>
  saveKeyPair(keyPair: CryptoKeyPair): Promise<void>
  deleteKeyPair(): Promise<void>
}
```

---

## Passkeys (WebAuthn)

Client-side functions are in `@korajs/auth`. Server-side functions are in `@korajs/auth/server`.

### Client-Side

```typescript
import {
  isPasskeySupported,
  isPlatformAuthenticatorAvailable,
  createPasskeyCredential,
  authenticateWithPasskey,
} from '@korajs/auth'
```

#### `isPasskeySupported()`

Check if WebAuthn is supported in the current environment.

```typescript
function isPasskeySupported(): boolean
```

#### `isPlatformAuthenticatorAvailable()`

Check if a platform authenticator (Touch ID, Face ID, Windows Hello) is available.

```typescript
async function isPlatformAuthenticatorAvailable(): Promise<boolean>
```

#### `createPasskeyCredential(options)`

Create a passkey credential during registration.

```typescript
async function createPasskeyCredential(options: {
  challenge: string           // Base64url-encoded challenge from server
  rpId: string                // Relying party ID (e.g. "example.com")
  rpName: string              // Relying party display name
  userId: string              // Base64url-encoded user ID
  userName: string            // User email or username
  userDisplayName: string     // Human-readable display name
  excludeCredentialIds?: string[]
  authenticatorSelection?: {
    authenticatorAttachment?: 'platform' | 'cross-platform'
    residentKey?: 'required' | 'preferred' | 'discouraged'
    userVerification?: 'required' | 'preferred' | 'discouraged'
  }
}): Promise<PasskeyRegistrationResponse>
```

Returns:

```typescript
interface PasskeyRegistrationResponse {
  credentialId: string      // Base64url-encoded credential ID
  publicKey: string         // Base64url-encoded COSE public key
  clientDataJSON: string    // Base64url-encoded clientDataJSON
  attestationObject: string // Base64url-encoded attestation object
}
```

#### `authenticateWithPasskey(options)`

Authenticate with a passkey during login.

```typescript
async function authenticateWithPasskey(options: {
  challenge: string             // Base64url-encoded challenge from server
  rpId: string                  // Relying party ID
  allowCredentialIds?: string[] // Limit to specific credentials
  userVerification?: 'required' | 'preferred' | 'discouraged'
  timeout?: number              // Timeout in ms (default: 60000)
}): Promise<PasskeyAuthenticationResponse>
```

Returns:

```typescript
interface PasskeyAuthenticationResponse {
  credentialId: string       // Base64url-encoded credential ID
  authenticatorData: string  // Base64url-encoded authenticator data
  clientDataJSON: string     // Base64url-encoded clientDataJSON
  signature: string          // Base64url-encoded ECDSA signature
  userHandle: string | null  // Base64url-encoded user handle
}
```

#### Example

```typescript
if (isPasskeySupported()) {
  // Registration
  const credential = await createPasskeyCredential({
    challenge: serverOptions.challenge,
    rpId: 'example.com',
    rpName: 'My App',
    userId: serverOptions.userId,
    userName: 'alice@example.com',
    userDisplayName: 'Alice',
  })
  // Send credential to server for verification

  // Authentication
  const assertion = await authenticateWithPasskey({
    challenge: serverOptions.challenge,
    rpId: 'example.com',
  })
  // Send assertion to server for verification
}
```

### Server-Side

```typescript
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@korajs/auth/server'
```

#### `generateRegistrationOptions(params)`

Generate options for creating a new passkey. Returns options to send to the client.

```typescript
function generateRegistrationOptions(params: {
  rpId: string
  rpName: string
  userId: string
  userName: string
  userDisplayName: string
  existingCredentialIds?: string[]
}): RegistrationOptions
```

#### `verifyRegistrationResponse(params)`

Verify a registration response from the client. Supports `"none"` attestation format.

```typescript
async function verifyRegistrationResponse(params: {
  credential: PasskeyRegistrationResponse
  expectedChallenge: string
  expectedOrigin: string
  expectedRpId: string
}): Promise<RegistrationVerificationResult>
```

Returns:

```typescript
interface RegistrationVerificationResult {
  verified: boolean
  credentialId: string
  publicKey: string     // Store this for future authentication
  signCount: number
}
```

#### `generateAuthenticationOptions(params)`

Generate options for signing in with a passkey.

```typescript
function generateAuthenticationOptions(params: {
  rpId: string
  allowCredentialIds?: string[]
}): AuthenticationOptions
```

#### `verifyAuthenticationResponse(params)`

Verify an authentication response. Checks the ECDSA P-256 signature and validates the sign counter.

```typescript
async function verifyAuthenticationResponse(params: {
  assertion: PasskeyAuthenticationResponse
  expectedChallenge: string
  expectedOrigin: string
  expectedRpId: string
  publicKey: string           // Stored COSE public key from registration
  previousSignCount: number   // Stored sign count
}): Promise<AuthenticationVerificationResult>
```

Returns:

```typescript
interface AuthenticationVerificationResult {
  verified: boolean
  newSignCount: number  // Store this to detect cloned authenticators
}
```

---

## Encryption

```typescript
import {
  generateEncryptionKey,
  encryptData,
  decryptData,
  exportKey,
  importKey,
  deriveEncryptionKey,
  generateSalt,
  OperationEncryptor,
  AutoLockManager,
  isEncryptedField,
} from '@korajs/auth'
```

### Database Encryption (AES-256-GCM)

#### `generateEncryptionKey()`

Generate a random 256-bit AES-GCM encryption key.

```typescript
async function generateEncryptionKey(): Promise<CryptoKey>
```

#### `encryptData(key, plaintext)`

Encrypt data using AES-256-GCM with a randomly generated IV.

```typescript
async function encryptData(
  key: CryptoKey,
  plaintext: Uint8Array,
): Promise<{ ciphertext: Uint8Array; iv: Uint8Array }>
```

#### `decryptData(key, ciphertext, iv)`

Decrypt AES-256-GCM encrypted data. Detects tampering via the GCM authentication tag.

```typescript
async function decryptData(
  key: CryptoKey,
  ciphertext: Uint8Array,
  iv: Uint8Array,
): Promise<Uint8Array>
```

#### `exportKey(key)`

Export an AES-256-GCM CryptoKey to raw bytes (32 bytes).

```typescript
async function exportKey(key: CryptoKey): Promise<Uint8Array>
```

#### `importKey(rawKey)`

Import raw key bytes (must be exactly 32 bytes) into an AES-256-GCM CryptoKey.

```typescript
async function importKey(rawKey: Uint8Array): Promise<CryptoKey>
```

#### Example

```typescript
const key = await generateEncryptionKey()
const data = new TextEncoder().encode('sensitive data')
const { ciphertext, iv } = await encryptData(key, data)

const decrypted = await decryptData(key, ciphertext, iv)
const text = new TextDecoder().decode(decrypted)
```

### Key Derivation (PBKDF2)

#### `deriveEncryptionKey(passphrase, salt?)`

Derive an AES-256-GCM key from a passphrase using PBKDF2 with SHA-256 and 600,000 iterations (OWASP-recommended).

```typescript
async function deriveEncryptionKey(
  passphrase: string,
  salt?: Uint8Array,
): Promise<{ key: CryptoKey; salt: Uint8Array }>
```

If no salt is provided, a random 32-byte salt is generated. The salt must be persisted alongside encrypted data.

#### `generateSalt()`

Generate a cryptographically random 32-byte salt.

```typescript
function generateSalt(): Uint8Array
```

#### Example

```typescript
// First time: derive key and store the salt
const { key, salt } = await deriveEncryptionKey('my-passphrase')

// Later: re-derive the same key
const { key: sameKey } = await deriveEncryptionKey('my-passphrase', salt)
```

### `OperationEncryptor`

End-to-end encryption for Kora sync operations. Encrypts `data` and `previousData` fields while leaving sync metadata (id, nodeId, timestamp, causalDeps, etc.) in cleartext.

```typescript
const encryptor = new OperationEncryptor({ key })
```

#### `OperationEncryptorConfig`

| Field | Type | Required |
|-------|------|----------|
| `key` | `CryptoKey` | Yes |

#### Methods

- `encryptOperation(operation: Operation): Promise<Operation>` -- Encrypt an operation's data fields. Returns a new operation (immutable).
- `decryptOperation(operation: Operation): Promise<Operation>` -- Decrypt an operation's data fields.
- `isEncrypted(operation: Operation): boolean` -- Check if an operation's data fields are encrypted.
- `encryptBatch(operations: Operation[]): Promise<Operation[]>` -- Encrypt multiple operations in parallel.
- `decryptBatch(operations: Operation[]): Promise<Operation[]>` -- Decrypt multiple operations in parallel.

#### `isEncryptedField(field)`

Standalone utility to detect encrypted operation fields without an `OperationEncryptor` instance.

```typescript
function isEncryptedField(field: Record<string, unknown> | null): boolean
```

#### Example

```typescript
const key = await generateEncryptionKey()
const encryptor = new OperationEncryptor({ key })

// Before sending via sync
const encrypted = await encryptor.encryptOperation(operation)
syncEngine.send(encrypted)

// After receiving from sync
const decrypted = await encryptor.decryptOperation(receivedOp)
store.apply(decrypted)
```

### `AutoLockManager`

Manages inactivity-based auto-locking for the encrypted local store. No DOM dependencies -- uses `setTimeout` internally and accepts an `onLock` callback.

```typescript
const manager = new AutoLockManager({
  timeout: 15 * 60 * 1000, // 15 minutes
  onLock: () => {
    // Clear decrypted data from memory, show lock screen
  },
})
```

#### `AutoLockConfig`

| Field | Type | Required |
|-------|------|----------|
| `timeout` | `number` | Yes |
| `onLock` | `() => void` | Yes |

#### Properties

- `isLocked: boolean` -- Whether the manager is in the locked state.

#### Methods

- `start(): void` -- Begin monitoring for inactivity.
- `stop(): void` -- Stop monitoring. Does not change lock state.
- `reportActivity(): void` -- Reset the inactivity timer. Call on user interactions.
- `lock(): void` -- Manually lock immediately. Invokes `onLock`.
- `unlock(): void` -- Return to unlocked state. Restarts the timer if running.

---

## React API

```typescript
import {
  AuthProvider,
  useAuth,
  useCurrentUser,
  useAuthStatus,
  AuthContext,
  OrgContext,
  useOrg,
  useOrgMembers,
  usePermission,
} from '@korajs/auth/react'
```

### `<AuthProvider>`

React context provider that wraps the `AuthClient`. Calls `client.initialize()` on mount and subscribes to auth state changes.

```typescript
interface AuthProviderProps {
  client: AuthClient
  children: ReactNode
  fallback?: ReactNode  // Shown while initializing
}
```

Must be placed above any component that uses `useAuth`, `useCurrentUser`, or `useAuthStatus`.

#### Example

```typescript
import { AuthClient } from '@korajs/auth'
import { AuthProvider } from '@korajs/auth/react'

const authClient = new AuthClient({ serverUrl: 'http://localhost:3001' })

function App() {
  return (
    <AuthProvider client={authClient} fallback={<div>Loading...</div>}>
      <MyApp />
    </AuthProvider>
  )
}
```

### `useAuth()`

Full authentication hook. Returns user, loading state, error state, and auth methods. Re-renders on state changes. Uses `useSyncExternalStore` for React 18+ concurrent mode safety.

```typescript
function useAuth(): UseAuthResult
```

Returns:

```typescript
interface UseAuthResult {
  user: AuthUser | null
  isAuthenticated: boolean
  isLoading: boolean
  signUp: (params: { email: string; password: string; name?: string }) => Promise<void>
  signIn: (params: { email: string; password: string }) => Promise<void>
  signOut: () => Promise<void>
  error: string | null
}
```

#### Example

```typescript
function LoginPage() {
  const { user, isAuthenticated, isLoading, signIn, error } = useAuth()

  if (isLoading) return <div>Loading...</div>
  if (isAuthenticated) return <div>Welcome, {user?.name}</div>

  return (
    <form onSubmit={async (e) => {
      e.preventDefault()
      await signIn({ email: 'user@example.com', password: 'secret' })
    }}>
      {error && <p>{error}</p>}
      <button type="submit">Sign In</button>
    </form>
  )
}
```

### `useCurrentUser()`

Lightweight hook that returns only the current user. Use instead of `useAuth` when you do not need auth methods or error state.

```typescript
function useCurrentUser(): AuthUser | null
```

#### Example

```typescript
function UserAvatar() {
  const user = useCurrentUser()
  if (!user) return null
  return <span>{user.name ?? user.email}</span>
}
```

### `useAuthStatus()`

Returns the current auth status. Re-renders only when the auth state changes.

```typescript
function useAuthStatus(): AuthStatus
```

Returns:

```typescript
interface AuthStatus {
  state: AuthState
  isAuthenticated: boolean
  isLoading: boolean
}
```

#### Example

```typescript
function AuthGuard({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuthStatus()
  if (isLoading) return <Spinner />
  if (!isAuthenticated) return <Navigate to="/login" />
  return <>{children}</>
}
```

### `useOrg()`

Organization management hook. Re-renders when the active organization changes.

```typescript
function useOrg(): UseOrgResult
```

Returns:

```typescript
interface UseOrgResult {
  org: ClientOrganization | null
  role: string | null
  orgId: string | null
  switchOrg: (orgId: string) => Promise<void>
  createOrg: (params: { name: string; slug?: string }) => Promise<ClientOrganization>
  leaveOrg: () => Promise<void>
  clearOrg: () => void
  listOrgs: () => Promise<ClientOrganization[]>
  error: string | null
}
```

Must be used within an `OrgContext.Provider`.

### `useOrgMembers(orgId)`

Hook for managing organization members. Automatically loads members when `orgId` changes.

```typescript
function useOrgMembers(orgId: string): UseOrgMembersResult
```

Returns:

```typescript
interface UseOrgMembersResult {
  members: ClientMembership[]
  isLoading: boolean
  refresh: () => Promise<void>
  invite: (email: string, role: string) => Promise<ClientInvitation>
  removeMember: (userId: string) => Promise<void>
  updateRole: (userId: string, role: string) => Promise<void>
  error: string | null
}
```

### `usePermission(requiredRole)`

Check if the current user has at least the specified role level in the active organization.

```typescript
function usePermission(requiredRole: string): boolean
```

Role hierarchy (lowest to highest): `viewer` < `billing` < `member` < `admin` < `owner`.

#### Example

```typescript
function AdminPanel() {
  const canManage = usePermission('admin')
  if (!canManage) return <p>Access denied</p>
  return <AdminSettings />
}
```

---

## Server API

```typescript
import {
  BuiltInAuthRoutes,
  TokenManager,
  SessionManager,
  TotpManager,
  OrgRoutes,
  RbacEngine,
  OrgScopeResolver,
  // ... and many more
} from '@korajs/auth/server'
```

### `BuiltInAuthRoutes`

Server-side route handlers for email/password authentication. Transport-agnostic -- returns `{ status, body }` response objects to wire into any HTTP framework.

```typescript
const routes = new BuiltInAuthRoutes(config)
```

#### `AuthRoutesConfig`

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `userStore` | `UserStore` | Yes | -- |
| `tokenManager` | `TokenManager` | Yes | -- |
| `challengeStore` | `ChallengeStore` | No | `InMemoryChallengeStore` |
| `rateLimiter` | `RateLimiter` | No | `InMemoryRateLimiter` |

#### Methods

All handlers return `Promise<AuthRouteResponse<T>>` where:

```typescript
interface AuthRouteResponse<T> {
  status: number
  body: { data: T } | { error: string }
}
```

- `signUp(params: { email, password, name? }): Promise<AuthRouteResponse<{ accessToken, refreshToken }>>` -- Register a new user.
- `signIn(params: { email, password }): Promise<AuthRouteResponse<{ accessToken, refreshToken }>>` -- Sign in. Returns token pair.
- `refresh(params: { refreshToken }): Promise<AuthRouteResponse<{ accessToken, refreshToken }>>` -- Refresh the access token.
- `signOut(userId: string, params: { refreshToken? }): Promise<AuthRouteResponse<{ success: true }>>` -- Revoke tokens.
- `getProfile(userId: string): Promise<AuthRouteResponse<UserProfile>>` -- Get the authenticated user's profile.
- `changePassword(userId: string, params: { currentPassword, newPassword }): Promise<AuthRouteResponse<{ success: true }>>` -- Change password.
- `registerDevice(userId: string, params: { publicKeyJwk, name? }): Promise<AuthRouteResponse<{ deviceId, challenge }>>` -- Register a device key.
- `verifyDevice(userId: string, params: { deviceId, signature }): Promise<AuthRouteResponse<{ verified: true }>>` -- Verify device challenge.

#### Example

```typescript
import { BuiltInAuthRoutes, TokenManager, InMemoryUserStore } from '@korajs/auth/server'

const tokenManager = new TokenManager({
  accessTokenSecret: process.env.JWT_SECRET!,
  refreshTokenSecret: process.env.REFRESH_SECRET!,
})

const routes = new BuiltInAuthRoutes({
  userStore: new InMemoryUserStore(),
  tokenManager,
})

// Wire to Express
app.post('/auth/signup', async (req, res) => {
  const result = await routes.signUp(req.body)
  res.status(result.status).json(result.body)
})

app.post('/auth/signin', async (req, res) => {
  const result = await routes.signIn(req.body)
  res.status(result.status).json(result.body)
})
```

### `TokenManager`

Server-side JWT token creation, verification, and revocation.

```typescript
const tokenManager = new TokenManager(config)
```

#### `TokenManagerConfig`

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `accessTokenSecret` | `string` | Yes | -- |
| `refreshTokenSecret` | `string` | Yes | -- |
| `accessTokenTtlSeconds` | `number` | No | `900` (15 min) |
| `refreshTokenTtlSeconds` | `number` | No | `604800` (7 days) |
| `issuer` | `string` | No | `'kora'` |
| `revocationStore` | `TokenRevocationStore` | No | `InMemoryTokenRevocationStore` |

#### Methods

- `createAccessToken(userId: string, claims?: Record<string, unknown>): Promise<string>` -- Create a signed access JWT.
- `createRefreshToken(userId: string): Promise<string>` -- Create a signed refresh JWT.
- `verifyAccessToken(token: string): Promise<TokenPayload>` -- Verify and decode an access token.
- `verifyRefreshToken(token: string): Promise<TokenPayload>` -- Verify and decode a refresh token.
- `revokeRefreshToken(token: string): Promise<void>` -- Revoke a refresh token.
- `revokeAllUserTokens(userId: string): Promise<void>` -- Revoke all tokens for a user.
- `isRevoked(tokenId: string): Promise<boolean>` -- Check if a token has been revoked.

### `SessionManager`

Server-side session management with support for sliding window expiry, idle timeout, concurrent session limits, and MFA tracking.

```typescript
const sessions = new SessionManager({
  store: new InMemorySessionStore(),
  sessionTtlMs: 7 * 24 * 60 * 60 * 1000,
  idleTimeoutMs: 30 * 60 * 1000,
  maxSessionsPerUser: 5,
})
```

#### `SessionManagerConfig`

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `store` | `SessionStore` | Yes | -- |
| `sessionTtlMs` | `number` | No | 7 days |
| `idleTimeoutMs` | `number` | No | 30 minutes |
| `maxSessionsPerUser` | `number` | No | `10` |
| `slidingWindow` | `boolean` | No | `true` |

#### Methods

- `create(params: CreateSessionParams): Promise<Session>` -- Create a new session. Enforces max sessions limit.
- `validate(sessionId: string): Promise<Session>` -- Validate a session. Throws if expired or not found.
- `touch(sessionId: string): Promise<Session>` -- Update last activity time. Extends expiry if sliding window is enabled.
- `markMfaVerified(sessionId: string): Promise<Session>` -- Mark a session as MFA-verified.
- `requireMfa(sessionId: string): Promise<Session>` -- Require MFA verification. Throws `SessionMfaRequiredError` if not verified.
- `revoke(sessionId: string): Promise<void>` -- Delete a session.
- `revokeAll(userId: string): Promise<number>` -- Revoke all sessions for a user (sign out everywhere).
- `revokeOthers(userId: string, currentSessionId: string): Promise<number>` -- Revoke all sessions except the current one.
- `listSessions(userId: string): Promise<Session[]>` -- List all active sessions.
- `cleanExpired(): Promise<number>` -- Clean up expired sessions.

#### `Session`

```typescript
interface Session {
  id: string
  userId: string
  deviceId: string | null
  ipAddress: string | null
  userAgent: string | null
  createdAt: number
  lastActiveAt: number
  expiresAt: number
  mfaVerified: boolean
  metadata?: Record<string, unknown>
}
```

#### `SessionStore` Interface

```typescript
interface SessionStore {
  create(session: Session): Promise<void>
  getById(sessionId: string): Promise<Session | null>
  update(session: Session): Promise<void>
  delete(sessionId: string): Promise<void>
  listByUserId(userId: string): Promise<Session[]>
  deleteAllForUser(userId: string): Promise<number>
  deleteAllExcept(userId: string, keepSessionId: string): Promise<number>
  cleanExpired(): Promise<number>
}
```

Built-in: `InMemorySessionStore` (development/testing).

### `TotpManager`

TOTP-based Multi-Factor Authentication. Implements RFC 6238 (TOTP) and RFC 4226 (HOTP). Compatible with Google Authenticator, Authy, 1Password, and other TOTP apps.

```typescript
const totp = new TotpManager({
  issuer: 'MyApp',
  store: new InMemoryTotpStore(),
})
```

#### `TotpConfig`

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `issuer` | `string` | Yes | -- |
| `store` | `TotpStore` | Yes | -- |
| `digits` | `number` | No | `6` |
| `period` | `number` | No | `30` |
| `algorithm` | `'SHA-1' \| 'SHA-256' \| 'SHA-512'` | No | `'SHA-1'` |
| `window` | `number` | No | `1` |
| `recoveryCodes` | `number` | No | `8` |

#### Methods

- `enable(userId: string, accountName: string): Promise<TotpSetupResult>` -- Enable TOTP MFA. Returns a QR code URI and recovery codes.
- `verifySetup(userId: string, code: string): Promise<boolean>` -- Confirm MFA setup with a valid code from the authenticator app.
- `verify(userId: string, code: string): Promise<boolean>` -- Verify a TOTP code during login.
- `verifyRecoveryCode(userId: string, recoveryCode: string): Promise<boolean>` -- Verify a single-use recovery code.
- `regenerateRecoveryCodes(userId: string, totpCode: string): Promise<string[]>` -- Regenerate recovery codes. Requires a valid TOTP code.
- `disable(userId: string, code: string): Promise<void>` -- Disable MFA. Accepts either a TOTP code or a recovery code.
- `isEnabled(userId: string): Promise<boolean>` -- Check if MFA is enabled and verified.
- `remainingRecoveryCodes(userId: string): Promise<number>` -- Get the count of remaining recovery codes.

#### `TotpSetupResult`

```typescript
interface TotpSetupResult {
  secret: string         // Base32-encoded secret (for manual entry)
  uri: string            // otpauth:// URI for QR code generation
  recoveryCodes: string[] // Plaintext recovery codes (shown once)
}
```

#### Example

```typescript
const totp = new TotpManager({ issuer: 'MyApp', store: new InMemoryTotpStore() })

// Step 1: Enable (show QR code and recovery codes)
const setup = await totp.enable('user-123', 'alice@example.com')

// Step 2: Verify setup
await totp.verifySetup('user-123', '123456')

// Step 3: On login, verify code
const valid = await totp.verify('user-123', '654321')
```

### `OrgRoutes`

Server-side route handlers for organization management. Enforces authorization (role checks) and input validation.

```typescript
const orgRoutes = new OrgRoutes({ orgStore: new InMemoryOrgStore() })
```

All methods return `Promise<OrgRouteResponse<T>>`.

#### Organization Methods

- `createOrg(userId, params: { name, slug?, metadata? })` -- Create an org. The caller becomes the owner. Status: 201.
- `getOrg(userId, orgId)` -- Get an org by ID. Requires membership.
- `updateOrg(userId, orgId, params: { name?, slug?, metadata? })` -- Update an org. Requires admin+.
- `deleteOrg(userId, orgId)` -- Delete an org. Requires owner.
- `listUserOrgs(userId)` -- List all orgs the user belongs to.

#### Member Methods

- `addMember(userId, orgId, params: { targetUserId, role })` -- Add a member. Requires admin+.
- `removeMember(userId, orgId, targetUserId)` -- Remove a member. Requires admin+ (or self-removal).
- `updateMemberRole(userId, orgId, params: { targetUserId, role })` -- Update a member's role. Requires admin+.
- `listMembers(userId, orgId)` -- List all members. Requires membership.
- `transferOwnership(userId, orgId, params: { newOwnerId })` -- Transfer ownership. Requires owner.

#### Invitation Methods

- `createInvitation(userId, orgId, params: { email, role })` -- Create an invitation. Requires admin+.
- `acceptInvitation(userId, params: { token })` -- Accept an invitation by token.
- `revokeInvitation(userId, orgId, invitationId)` -- Revoke a pending invitation. Requires admin+.
- `listPendingInvitations(userId, orgId)` -- List pending invitations. Requires admin+.
- `listMyInvitations(email)` -- List invitations for a user's email.

#### Org Roles

Roles in order of ascending privilege: `viewer`, `billing`, `member`, `admin`, `owner`.

### `RbacEngine`

Permission evaluation engine for role-based access control with role inheritance and wildcard matching.

```typescript
const rbac = new RbacEngine(orgStore)
// or with custom roles:
const rbac = new RbacEngine(orgStore, { roles: customRoles })
```

#### Methods

- `hasPermission(userId: string, orgId: string, permission: Permission): Promise<boolean>` -- Check if a user has a permission.
- `getUserPermissions(userId: string, orgId: string): Promise<Permission[]>` -- Get all effective permissions.
- `getRolePermissions(roleName: string): Permission[]` -- Get permissions for a role (including inherited).
- `roleHasPermission(roleName: string, permission: Permission): boolean` -- Check if a role has a permission.
- `registerScopeResolver(collection: string, resolver: CollectionScopeResolver): void` -- Register a custom scope resolver.
- `resolveScopes(userId: string, orgId: string, collections?: string[]): Promise<SyncScopes | null>` -- Resolve sync scopes.
- `getRoleNames(): string[]` -- Get all defined role names.
- `getRoleDefinition(roleName: string): RoleDefinition | null` -- Get a role definition.

#### `defineRoles()`

Builder for defining custom roles with inheritance.

```typescript
const roles = defineRoles()
  .role('viewer', ['*:read'])
  .role('editor', ['*:write'], { inherits: ['viewer'] })
  .role('admin', ['org:manage-members'], { inherits: ['editor'] })
  .build()
```

#### Permission Format

Permissions are strings in the format `resource:action` (e.g., `todos:read`, `*:write`). The `*` wildcard matches any resource or action.

### `OrgScopeResolver`

Resolves sync scopes for org-aware data filtering. Combines org membership with RBAC permissions.

```typescript
const resolver = new OrgScopeResolver(orgStore, rbacEngine)
```

#### Methods

- `registerCollectionScope(collection: string, resolver: CollectionScopeResolver): void` -- Register a custom scope for a collection.
- `resolve(userId: string, orgId: string, collections: string[]): Promise<SyncScopes | null>` -- Resolve scopes for all collections.
- `canWrite(userId: string, orgId: string, collection: string): Promise<boolean>` -- Check write access.
- `canRead(userId: string, orgId: string, collection: string): Promise<boolean>` -- Check read access.

#### Example

```typescript
const resolver = new OrgScopeResolver(orgStore, rbacEngine)

// Custom: members only see their own todos
resolver.registerCollectionScope('todos', (ctx) => {
  if (ctx.role === 'member') {
    return { orgId: ctx.orgId, userId: ctx.userId }
  }
  return { orgId: ctx.orgId }
})

const scopes = await resolver.resolve('user-1', 'org-1', ['todos', 'projects'])
```

### OAuth / Social Login

```typescript
import {
  OAuthManager,
  InMemoryOAuthStateStore,
  googleProvider,
  githubProvider,
  microsoftProvider,
} from '@korajs/auth/server'
```

Built-in provider configs for Google, GitHub, and Microsoft. The `OAuthManager` handles the full OAuth2 authorization code flow: generating authorization URLs, exchanging codes for tokens, and fetching user info.

### Password Reset

```typescript
import {
  PasswordResetManager,
  InMemoryPasswordResetStore,
} from '@korajs/auth/server'
```

Manages password reset token generation, validation, and consumption with rate limiting.

### Email Verification

```typescript
import {
  EmailVerificationManager,
  InMemoryEmailVerificationStore,
} from '@korajs/auth/server'
```

Manages email verification tokens for confirming user email addresses.

### External Auth Providers

```typescript
import {
  ExternalJwtProvider,
  createClerkAdapter,
  createSupabaseAdapter,
} from '@korajs/auth/server'
```

- `ExternalJwtProvider` -- Validate JWTs from external identity providers.
- `createClerkAdapter(config)` -- Create a Clerk auth adapter.
- `createSupabaseAdapter(config)` -- Create a Supabase auth adapter.

### Admin API

```typescript
import { AdminApi } from '@korajs/auth/server'
```

Administrative operations for managing users: list, search, update, ban, and delete users. Returns paginated results.

### Audit Logging

```typescript
import { AuditLogger, InMemoryAuditLogStore } from '@korajs/auth/server'
```

Structured audit logging for auth events (sign-in, sign-out, password change, MFA enable/disable, etc.).

### Webhooks

```typescript
import {
  WebhookManager,
  InMemoryWebhookStore,
  verifyWebhookSignature,
} from '@korajs/auth/server'
```

Register webhook endpoints and receive notifications for auth events. Signatures are HMAC-SHA256 for verification.

### JWT Utilities

```typescript
import { encodeJwt, decodeJwt, verifyJwt, isExpired } from '@korajs/auth/server'
```

- `encodeJwt(payload, secret): Promise<string>` -- Create a signed JWT.
- `decodeJwt(token): TokenPayload | null` -- Decode a JWT without verification.
- `verifyJwt(token, secret): Promise<TokenPayload>` -- Verify and decode a JWT.
- `isExpired(payload): boolean` -- Check if a JWT payload is expired.

### Password Hashing

```typescript
import { hashPassword, verifyPassword } from '@korajs/auth/server'
```

- `hashPassword(password: string): Promise<string>` -- Hash a password using PBKDF2.
- `verifyPassword(password: string, hash: string): Promise<boolean>` -- Verify a password against a hash.

---

## Types

### Shared Types (from `@korajs/auth`)

```typescript
type AuthState = 'loading' | 'authenticated' | 'unauthenticated'

interface AuthUser {
  id: string
  email: string
  name: string | null
}

interface AuthTokens {
  accessToken: string
  refreshToken: string
}

type TokenType = 'access' | 'refresh'

interface TokenPayload {
  sub: string          // User ID
  type: TokenType
  iat: number          // Issued at (seconds)
  exp: number          // Expiry (seconds)
  jti: string          // Token ID
  iss?: string         // Issuer
  [key: string]: unknown
}

type AuthEventType =
  | 'signUp'
  | 'signIn'
  | 'signOut'
  | 'tokenRefresh'
  | 'sessionExpired'

interface AuthEvent {
  type: AuthEventType
  userId?: string
  timestamp: number
}
```

### Organization Types (from `@korajs/auth/server`)

```typescript
type OrgRole = 'owner' | 'admin' | 'member' | 'viewer' | 'billing'

interface Organization {
  id: string
  name: string
  slug: string
  ownerId: string
  createdAt: number
  updatedAt: number
  metadata?: Record<string, unknown>
}

interface Membership {
  orgId: string
  userId: string
  role: OrgRole
  joinedAt: number
  invitedBy: string | null
}

interface OrgInvitation {
  id: string
  orgId: string
  email: string
  role: OrgRole
  token: string
  status: InvitationStatus
  invitedBy: string
  createdAt: number
  expiresAt: number
}

type InvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired'
```

### RBAC Types (from `@korajs/auth/server`)

```typescript
type Permission = string  // Format: "resource:action" (e.g., "todos:read", "*:write")

interface RoleDefinition {
  name: string
  permissions: Permission[]
  inherits?: string[]
}

interface ScopeFilter {
  orgId?: string
  userId?: string
  __readonly?: boolean
  [key: string]: unknown
}

type SyncScopes = Record<string, ScopeFilter>

interface ScopeContext {
  userId: string
  orgId: string
  role: string
  permissions: Permission[]
}

type CollectionScopeResolver = (ctx: ScopeContext) => ScopeFilter | null
```

### Error Classes

All errors extend `KoraError` from `@korajs/core`.

| Error | Code | Entry Point |
|-------|------|-------------|
| `AuthError` | varies | `@korajs/auth` |
| `OrgClientError` | varies | `@korajs/auth` |
| `DeviceIdentityError` | `DEVICE_IDENTITY_ERROR` | `@korajs/auth` |
| `CryptoUnavailableError` | `CRYPTO_UNAVAILABLE` | `@korajs/auth` |
| `DeviceKeyStoreError` | `DEVICE_KEY_STORE_ERROR` | `@korajs/auth` |
| `EncryptedTokenStoreError` | varies | `@korajs/auth` |
| `PasskeyError` | `PASSKEY_ERROR` | `@korajs/auth` |
| `PasskeyUnsupportedError` | `PASSKEY_UNSUPPORTED` | `@korajs/auth` |
| `EncryptionError` | `ENCRYPTION_ERROR` | `@korajs/auth` |
| `KeyDerivationError` | `KEY_DERIVATION_ERROR` | `@korajs/auth` |
| `OperationEncryptionError` | `OPERATION_ENCRYPTION_ERROR` | `@korajs/auth` |
| `PasskeyVerificationError` | `PASSKEY_VERIFICATION_ERROR` | `@korajs/auth/server` |
| `SessionError` | varies | `@korajs/auth/server` |
| `SessionNotFoundError` | `SESSION_NOT_FOUND` | `@korajs/auth/server` |
| `SessionExpiredError` | `SESSION_EXPIRED` | `@korajs/auth/server` |
| `SessionLimitExceededError` | `SESSION_LIMIT_EXCEEDED` | `@korajs/auth/server` |
| `SessionMfaRequiredError` | `SESSION_MFA_REQUIRED` | `@korajs/auth/server` |
| `TotpError` | varies | `@korajs/auth/server` |
| `TotpInvalidCodeError` | `TOTP_INVALID_CODE` | `@korajs/auth/server` |
| `TotpNotEnabledError` | `TOTP_NOT_ENABLED` | `@korajs/auth/server` |
| `TotpAlreadyEnabledError` | `TOTP_ALREADY_ENABLED` | `@korajs/auth/server` |
| `TotpNotVerifiedError` | `TOTP_NOT_VERIFIED` | `@korajs/auth/server` |
| `TotpRecoveryExhaustedError` | `TOTP_RECOVERY_EXHAUSTED` | `@korajs/auth/server` |
| `OrgError` | varies | `@korajs/auth/server` |
| `OrgNotFoundError` | `ORG_NOT_FOUND` | `@korajs/auth/server` |
| `OrgSlugTakenError` | `ORG_SLUG_TAKEN` | `@korajs/auth/server` |
| `MembershipNotFoundError` | `MEMBERSHIP_NOT_FOUND` | `@korajs/auth/server` |
| `MemberAlreadyExistsError` | `MEMBER_ALREADY_EXISTS` | `@korajs/auth/server` |
| `InsufficientRoleError` | `INSUFFICIENT_ROLE` | `@korajs/auth/server` |
| `CannotRemoveOwnerError` | `CANNOT_REMOVE_OWNER` | `@korajs/auth/server` |
| `InvitationNotFoundError` | `INVITATION_NOT_FOUND` | `@korajs/auth/server` |
| `InvitationExpiredError` | `INVITATION_EXPIRED` | `@korajs/auth/server` |
| `RbacError` | varies | `@korajs/auth/server` |
| `RoleNotFoundError` | `ROLE_NOT_FOUND` | `@korajs/auth/server` |
| `CircularInheritanceError` | `CIRCULAR_INHERITANCE` | `@korajs/auth/server` |
| `OAuthError` | varies | `@korajs/auth/server` |
| `PasswordResetError` | varies | `@korajs/auth/server` |
| `EmailVerificationError` | varies | `@korajs/auth/server` |
| `AdminApiError` | varies | `@korajs/auth/server` |
| `WebhookError` | varies | `@korajs/auth/server` |
