---
title: Auth API
description: "@korajs/auth API reference: auth client, sync binding, device identity, passkeys, local encryption, React/Vue/Svelte bindings, the auth server, sessions, MFA, organizations, RBAC and OAuth."
---

# Auth API Reference

`@korajs/auth` provides authentication, authorization and identity for Kora.js apps. The
[Authentication guide](/guide/authentication) explains how the pieces fit together; this page lists
the API.

| Entry point | Contents |
|-------------|----------|
| `@korajs/auth` | Auth client, sync binding, device identity, token storage, passkeys (client), local encryption |
| `@korajs/auth/server` | Auth server, routes, tokens, user stores, sessions, MFA, organizations, RBAC, OAuth, admin |
| `@korajs/auth/react` | `AuthProvider`, `OrgProvider` and hooks |
| `@korajs/auth/vue` | `AuthProvider`, `OrgProvider` and composables |
| `@korajs/auth/svelte` | `initAuthProvider`, `initOrgProvider`, stores and helpers |

<!-- docs-check-prelude
import { AuthClient, OrgClient, createKoraAuth, createKoraAuthSync } from '@korajs/auth'
import type { AuthKeyValueStorage, DeviceKeyStore } from '@korajs/auth'
import { defineSchema, t } from 'korajs'
const schema = defineSchema({ version: 1, collections: { todos: { fields: { title: t.string() } } } })
const auth = createKoraAuth({ serverUrl: 'https://acme.example.com' })
declare const secureStore: AuthKeyValueStorage
declare const deviceKeyStore: DeviceKeyStore
declare function openSystemBrowser(url: string): Promise<void>
declare const code: string
declare const state: string
-->

---

## Client

### `createKoraAuth(options)`

Creates an `AuthClient` with offline-first defaults: token storage in `localStorage` (or your
credential store) and a persistent device identity when a key store is available.

```typescript
import { createKoraAuth } from '@korajs/auth'

const authClient = createKoraAuth({ serverUrl: 'https://acme.example.com' })

// Desktop and mobile: one secure credential store for tokens and the device id
const nativeAuth = createKoraAuth({
  serverUrl: 'https://acme.example.com',
  credentialStore: secureStore,
  deviceKeyStore,
})
```

| Option | Type | Default |
|--------|------|---------|
| `serverUrl` | `string` | required |
| `credentialStore` | `AuthKeyValueStorage` (sync or async `getItem`/`setItem`/`removeItem`) | `localStorage` when available, else memory |
| `storage` | `AuthTokenStorage` | adapted from `credentialStore` |
| `deviceKeyStore` | `DeviceKeyStore` | IndexedDB when available |
| `deviceIdentity` | `AuthDeviceIdentityProvider \| false` | created when persistent storage exists |
| `storageKey` | `string` | `'kora_auth'` |
| `fetch` | `typeof fetch` | `globalThis.fetch` |
| `requestTimeoutMs` | `number` | `20000` |
| `maxOfflineGraceMs` | `number` | no limit beyond the refresh token's expiry |
| `refreshBackoff` | `{ baseDelayMs?, maxDelayMs? }` | exponential with jitter, honours `Retry-After` |

`new AuthClient(config)` takes the same options without `credentialStore`/`deviceKeyStore`
(`storage` and `deviceIdentity` instead).

### `AuthClient`

| Member | Description |
|--------|-------------|
| `state` | `'loading' \| 'authenticated' \| 'unauthenticated'`. |
| `session` | `{ userId, deviceId, status: 'fresh' \| 'offline' \| 'locked', lastServerContactAt } \| null`. `offline`: the identity is known but no fresh token can be minted now; `locked`: offline longer than `maxOfflineGraceMs` or the clock moved backwards (local data is never wiped). |
| `currentUser` / `isAuthenticated` | The signed-in user. |
| `initialize()` | Restores the stored session. Network errors, timeouts, 5xx, rate limits and captive portals keep it (authenticated-offline); only a definitive rejection signs out. |
| `signUp({ email, password, name? })` | Creates an account and signs in. |
| `signIn({ email, password })` | Signs in. Throws `MfaRequiredError` (with `mfaToken`) when the account has MFA. |
| `verifyMfa(mfaToken, { code } \| { recoveryCode })` | Completes an MFA sign-in. |
| `signInWithOAuth(provider, options?)` | Creates the authorization URL and redirects (unless `redirect: false`). Returns `{ url, state, binding? }`. |
| `getOAuthAuthorizationUrl(provider, options?)` | The URL without redirecting, for desktop and mobile. |
| `completeOAuthSignIn(provider, { code, state })` | Completes a callback. The flow is bound to this client; a callback started elsewhere is refused. |
| `linkOAuth(provider, { code, state })`, `listLinkedAccounts()`, `unlinkOAuth(provider)` | Account linking for the signed-in user. |
| `signOut()` | Clears local tokens and revokes the refresh token on the server (best effort). |
| `getAccessToken()` | A valid access token, refreshed when expired; `null` when none can be minted **now**, which does not mean signed out. `getSyncToken()` is an alias. |
| `refreshAccessToken()` | Refreshes now even if the cached token looks valid (used when the sync server reports an expired or revoked session). Concurrent calls and tabs share one refresh. |
| `retryNow()` | Clears the backoff and retries a refresh (also wired to `online` and `visibilitychange`). |
| `getStoredIdentity()` / `getStoredClaims()` | Identity and claims of the stored tokens, without a network call. |
| `onAuthChange(cb)` / `onSessionChange(cb)` | Subscriptions; return an unsubscribe function. |
| `destroy()` | Removes listeners and timers. |

```typescript
import { MfaRequiredError } from '@korajs/auth'

await auth.initialize()
try {
  await auth.signIn({ email: 'alice@example.com', password: 'correct horse battery' })
} catch (error) {
  if (error instanceof MfaRequiredError) {
    await auth.verifyMfa(error.mfaToken, { code: '123456' })
  }
}

// Desktop and mobile OAuth
const { url } = await auth.getOAuthAuthorizationUrl('google', { redirect: false })
await openSystemBrowser(url)
await auth.completeOAuthSignIn('google', { code, state })
```

### `createKoraAuthSync(options)`

Binds an auth client to Kora sync: `createApp({ sync: { url, authClient: binding } })`.

```typescript
import { createApp } from 'korajs'

const binding = createKoraAuthSync({ authClient: auth, schema })
const app = createApp({
  schema,
  sync: { url: 'wss://acme.example.com/kora-sync', authClient: binding, autoConnect: true },
})
```

| Option | Type | Description |
|--------|------|-------------|
| `authClient` | `AuthSyncClient` | An `AuthClient` (or anything with `getAccessToken()` and optional `onAuthChange`). |
| `schema` | `SchemaDefinition` | Builds the client scope hint from token claims (`extractScopeValuesFromClaims`). |
| `scopeFromClaims` | `(claims) => Record<string, unknown>` | Custom claim to scope value mapping. |
| `anonymous` | `'suspend' \| 'allow'` | Signed-out behaviour. `'suspend'` (default) does not sync; `'allow'` syncs anonymously (server `MixedAuthProvider`). |

The binding (`AuthSyncBinding`) supplies `auth({ forceRefresh? })`, `resolveSyncState()` (`loading`,
`signed-out`, `anonymous` or `authenticated` with `userId`, `deviceId`, `offline`, `locked`),
`resolveScopeMap()`, `resolveNodeId()`, `resolveUserId()` and `subscribe()`. Kora uses them to bind
every local write to the signed-in user, keep one sync node per user and device, suspend sync while
signed out or loading, and reconnect when the user changes. The scope map is only a hint that can
narrow what the server grants.

### Token storage

| Function | Description |
|----------|-------------|
| `createAuthTokenStorage({ store, prefix? })` | Adapts a sync or async key-value store to `AuthTokenStorage`. |
| `createWebStorageAuthTokenStorage(storage, prefix?)` | `localStorage` or `sessionStorage`. |
| `createMemoryAuthTokenStorage()` | Memory only (tests, SSR). |
| `TokenStore` | Older synchronous token store (`saveTokens`, `loadTokens`, `clearTokens`). |
| `EncryptedTokenStore({ key, storageKey? })` | Tokens encrypted with AES-256-GCM in `localStorage`: `saveTokens`, `loadTokens`, `clearTokens`, `getAccessToken`, `getRefreshToken` (async). |

### Device identity

`createPersistentDeviceIdentity({ storage, keyStore?, deviceIdKey?, generateDeviceId? })` keeps a
stable device id and a non-extractable ECDSA P-256 key pair and presents the public key at every
sign-in. `createKoraAuth()` does this for you. Runtimes without IndexedDB (React Native) must pass a
`keyStore` backed by the platform's secure storage.

<!-- docs-check: signature @korajs/auth @korajs/auth/server -->
```typescript
function generateDeviceKeyPair(): Promise<CryptoKeyPair>
function exportPublicKeyJwk(keyPair: CryptoKeyPair): Promise<JsonWebKey>
function signChallenge(privateKey: CryptoKey, challenge: string): Promise<string>
function verifyChallenge(publicKeyJwk: JsonWebKey, challenge: string, signature: string): Promise<boolean>
function computePublicKeyThumbprint(publicKeyJwk: JsonWebKey): Promise<string>
function toBase64Url(buffer: ArrayBuffer): string
function fromBase64Url(str: string): Uint8Array

interface DeviceKeyStore {
  saveKeyPair(deviceId: string, keyPair: CryptoKeyPair): Promise<void>
  loadKeyPair(deviceId: string): Promise<CryptoKeyPair | null>
  deleteKeyPair(deviceId: string): Promise<void>
  hasKeyPair(deviceId: string): Promise<boolean>
}
```

`createDeviceKeyStore()` returns an `IndexedDBDeviceKeyStore` in browsers and an
`InMemoryDeviceKeyStore` elsewhere.

### `OrgClient`

Client for organization endpoints (`/orgs/...`). Those endpoints are **not** served by
`createKoraAuthServer().handleRequest`: wire [`OrgRoutes`](#orgroutes) into your server under the
same paths.

```typescript
const orgClient = new OrgClient({
  serverUrl: 'https://acme.example.com',
  getAccessToken: () => auth.getAccessToken(),
})
```

Properties: `activeOrgId`, `activeOrg`, `activeRole`. Methods: `createOrg({ name, slug? })`,
`listOrgs()`, `getOrg(orgId)`, `updateOrg(orgId, { name?, slug?, metadata? })`, `deleteOrg(orgId)`,
`switchOrg(orgId)`, `clearActiveOrg()`, `listMembers(orgId)`, `removeMember(orgId, userId)`,
`updateMemberRole(orgId, userId, role)`, `transferOwnership(orgId, newOwnerId)`, `leaveOrg(orgId)`,
`inviteMember(orgId, { email, role })`, `acceptInvitation(token)`, `listInvitations(orgId)`,
`revokeInvitation(orgId, invitationId)`, `listMyInvitations()`, and
`onOrgChange((orgId) => ...)`. Errors are `OrgClientError`.

---

## Passkeys (WebAuthn)

### Client (`@korajs/auth`)

<!-- docs-check: signature @korajs/auth @korajs/auth/server -->
```typescript
function isPasskeySupported(): boolean
function isPlatformAuthenticatorAvailable(): Promise<boolean>

function createPasskeyCredential(options: {
  challenge: string            // base64url, from the server
  rpId: string
  rpName: string
  userId: string               // base64url
  userName: string
  userDisplayName: string
  excludeCredentialIds?: string[]
  authenticatorSelection?: {
    authenticatorAttachment?: 'platform' | 'cross-platform'
    residentKey?: 'required' | 'preferred' | 'discouraged'
    userVerification?: 'required' | 'preferred' | 'discouraged'
  }
}): Promise<PasskeyRegistrationResponse>
// { credentialId, publicKey, clientDataJSON, attestationObject } (base64url)

function authenticateWithPasskey(options: {
  challenge: string
  rpId: string
  allowCredentialIds?: string[]
  userVerification?: 'required' | 'preferred' | 'discouraged'
  timeout?: number
}): Promise<PasskeyAuthenticationResponse>
// { credentialId, authenticatorData, clientDataJSON, signature, userHandle }
```

Both throw `PasskeyUnsupportedError` (`PASSKEY_UNSUPPORTED`) without WebAuthn and `PasskeyError`
(`PASSKEY_ERROR`) when the ceremony fails.

### Server (`@korajs/auth/server`)

<!-- docs-check: signature @korajs/auth/server @korajs/auth -->
```typescript
function generateRegistrationOptions(params: {
  rpId: string; rpName: string; userId: string; userName: string; userDisplayName: string
  existingCredentialIds?: string[]
}): RegistrationOptions

function verifyRegistrationResponse(params: {
  credential: PasskeyRegistrationResponse
  expectedChallenge: string; expectedOrigin: string; expectedRpId: string
}): Promise<{ verified: boolean; credentialId: string; publicKey: string; signCount: number }>

function generateAuthenticationOptions(params: {
  rpId: string; allowCredentialIds?: string[]
}): AuthenticationOptions

function verifyAuthenticationResponse(params: {
  assertion: PasskeyAuthenticationResponse
  expectedChallenge: string; expectedOrigin: string; expectedRpId: string
  publicKey: string            // stored at registration
  previousSignCount: number    // stored sign count
  requireUserVerification?: boolean  // default true
}): Promise<{ verified: boolean; newSignCount: number }>
```

Registration accepts the `none` attestation format. Authentication checks the ECDSA P-256
signature, the user-verified flag and the sign counter. Failures throw `PasskeyVerificationError`
(`PASSKEY_VERIFICATION_ERROR`).

---

## Local encryption

These helpers protect data **on the device** (tokens, local secrets). End-to-end encryption of
synced operations is configured with `sync.encryption` instead; see
[Sync Encryption](/guide/sync-encryption).

<!-- docs-check: signature @korajs/auth @korajs/auth/server -->
```typescript
function generateEncryptionKey(): Promise<CryptoKey>   // AES-256-GCM
function encryptData(key: CryptoKey, plaintext: Uint8Array): Promise<{ ciphertext: Uint8Array; iv: Uint8Array }>
function decryptData(key: CryptoKey, ciphertext: Uint8Array, iv: Uint8Array): Promise<Uint8Array>
function exportKey(key: CryptoKey): Promise<Uint8Array>          // 32 raw bytes
function importKey(rawKey: Uint8Array): Promise<CryptoKey>
function deriveEncryptionKey(passphrase: string, salt?: Uint8Array): Promise<{ key: CryptoKey; salt: Uint8Array }>
function generateSalt(): Uint8Array                    // 32 random bytes
```

`deriveEncryptionKey` uses PBKDF2-SHA-256 with 600 000 iterations and generates a salt when none is
given; store the salt to derive the same key again. Errors: `EncryptionError` (`ENCRYPTION_ERROR`),
`KeyDerivationError` (`KEY_DERIVATION_ERROR`), `CryptoUnavailableError` (`CRYPTO_UNAVAILABLE`).

```typescript
import { decryptData, deriveEncryptionKey, encryptData } from '@korajs/auth'

const { key, salt } = await deriveEncryptionKey('user passphrase')
const { ciphertext, iv } = await encryptData(key, new TextEncoder().encode('secret'))
const plaintext = await decryptData(key, ciphertext, iv)
const { key: sameKey } = await deriveEncryptionKey('user passphrase', salt)
```

`AutoLockManager({ timeout, onLock })` locks after `timeout` ms without `reportActivity()`:
`start()`, `stop()`, `reportActivity()`, `lock()`, `unlock()`, `isLocked`.

`OperationEncryptor({ key })` (`encryptOperation`, `decryptOperation`, `encryptBatch`,
`decryptBatch`, `isEncrypted`, and the standalone `isEncryptedField`) replaces an operation's `data`
and `previousData` with a ciphertext envelope while keeping its id. It is a low-level utility, **not
used by the sync engine**: an operation changed this way no longer matches its content-addressed id
and every Kora server and client refuses it (`INVALID_OPERATION_ID`). Use `sync.encryption`.

---

## React (`@korajs/auth/react`)

<!-- docs-check-prelude
import { createKoraAuth } from '@korajs/auth'
const authClient = createKoraAuth({ serverUrl: 'https://acme.example.com' })
declare function MyApp(): JSX.Element
declare function SignInForm(): JSX.Element
-->

| Export | Description |
|--------|-------------|
| `<AuthProvider client fallback?>` | Initializes the client on mount and provides it. `fallback` renders while loading. |
| `useAuth()` | `{ user, isAuthenticated, isLoading, error, initError, signUp, signIn, signOut, signInWithOAuth, getOAuthAuthorizationUrl, completeOAuthSignIn, linkOAuth, listLinkedAccounts, unlinkOAuth }`. |
| `useCurrentUser()` | `AuthUser \| null`. |
| `useAuthStatus()` | `{ state, isAuthenticated, isLoading }`; re-renders only when the state changes. |
| `<OrgProvider client>` | Provides an `OrgClient`. |
| `useOrg()` | `{ org, role, orgId, switchOrg, createOrg, leaveOrg, clearOrg, listOrgs, error }`. |
| `useOrgMembers(orgId)` | `{ members, isLoading, refresh, invite, removeMember, updateRole, error }`. |
| `usePermission(role)` / `checkOrgPermission(currentRole, role)` | `true` when the active role is at least `role` (`viewer` < `billing` < `member` < `admin` < `owner`). |

Hooks use `useSyncExternalStore`, so they are safe in concurrent rendering.

```tsx
import { AuthProvider, useAuth } from '@korajs/auth/react'

function Root() {
  return (
    <AuthProvider client={authClient} fallback={<p>Loading...</p>}>
      <Gate />
    </AuthProvider>
  )
}

function Gate() {
  const { user, isAuthenticated, error } = useAuth()
  if (!isAuthenticated) return <SignInForm />
  return (
    <>
      {error && <p role="alert">{error}</p>}
      <p>Signed in as {user?.email}</p>
      <MyApp />
    </>
  )
}
```

For apps whose local database belongs to the signed-in user, use `AuthBoundKoraProvider` from
`@korajs/react` (see [Authentication](/guide/authentication#authenticated-app-lifecycle)).

`@korajs/auth/vue` exports `AuthProvider`, `OrgProvider`, `useAuth`, `useCurrentUser`,
`useAuthStatus`, `useOrg`, `useOrgMembers` and `usePermission` with the same results as refs.
`@korajs/auth/svelte` exports `initAuthProvider`/`destroyAuthProvider`, `initOrgProvider`/
`destroyOrgProvider`, the store factories (`createAuthStore`, `createAuthStatusStore`,
`createCurrentUserStore`, `createPermissionStore`) and the same `useAuth`/`useOrg` helpers.

---

## Server (`@korajs/auth/server`)

<!-- docs-check-prelude
import { createKoraAuthServer, createSqliteUserStore } from '@korajs/auth/server'
-->

### `createKoraAuthServer(options)`

The built-in auth server: routes, tokens, devices, OAuth, MFA and the sync auth provider.

```typescript
import { createKoraAuthServer, createSqliteUserStore, TotpManager, InMemoryTotpStore } from '@korajs/auth/server'
import { createProductionServer, createSqliteServerStore } from '@korajs/server'

const userStore = await createSqliteUserStore({ filename: './auth.db' })
const authServer = createKoraAuthServer({
  jwtSecret: process.env.KORA_AUTH_SECRET,
  userStore,
  mfa: new TotpManager({ issuer: 'Acme', store: new InMemoryTotpStore() }),
})

const server = createProductionServer({
  store: createSqliteServerStore({ filename: './kora.db' }),
  syncOptions: { auth: authServer.auth },
  httpRoutes: [{ path: '/auth', handle: authServer.handleRequest }],
})
```

| Option | Type | Default |
|--------|------|---------|
| `jwtSecret` | `string \| string[]` (index 0 signs, all verify) | `KORA_AUTH_SECRET`; a generated development secret outside production |
| `userStore` | `UserStore` | `InMemoryUserStore` (refused in production) |
| `revocationStore` | `TokenRevocationStore` | the user store's own (`getTokenRevocationStore()`) |
| `allowInMemory` | `boolean` | `false`: with `NODE_ENV=production`, in-memory user or revocation stores throw `InMemoryAuthStoreError` (`IN_MEMORY_AUTH_STORE`) |
| `tokenManager` / `tokenManagerOptions` | `TokenManager` / `Omit<TokenManagerConfig, 'secret'>` | created from `jwtSecret` |
| `path` | `string` | `'/auth'` |
| `oauth` | `OAuthServerConfig` | OAuth disabled |
| `mfa` | `MfaVerifier` (for example a `TotpManager`) | none: sign-in is one step |
| `challengeStore` / `rateLimiter` | `ChallengeStore` / `RateLimiter` | in memory |
| `scopeValues` | `(claims) => values` | none: scoped collections bind `{ userId }` only |
| `resolveScopes` | `(claims) => ScopeMap` | none |

`scopeValues` and `resolveScopes` decide what each sync session may read and write; see
[Sync scopes](/guide/authentication#sync-scopes).

Returned `KoraAuthServer`:

| Member | Description |
|--------|-------------|
| `handleRequest(request)` | One handler for every route below. `request`: `{ method, path, body?, headers?, query?, ip? }`. |
| `auth` | Sync auth provider for `KoraSyncServer` (`authenticate(token)` with server-derived scopes, `onRevoke`). |
| `routes`, `userStore`, `tokenManager`, `oauth?`, `linkedIdentityStore?` | The configured parts. |
| `revokeAllForUser(userId)` | Revokes every credential of a user and ends their live sync sessions. |
| `onRevoke(listener)` | Revocation feed (`{ kind: 'device', userId, deviceId }` or `{ kind: 'user', userId }`). |
| `bindSyncServer(server)` | Ends sessions on a sync server built with a wrapping provider. |

| Route | Purpose |
|-------|---------|
| `POST /auth/signup`, `POST /auth/signin` | Returns `{ user, tokens }`, or `{ mfaRequired: true, mfaToken }` for MFA accounts. |
| `POST /auth/mfa/verify` | `{ mfaToken, code }` or `{ mfaToken, recoveryCode }`. |
| `POST /auth/refresh` | Rotates the refresh token. |
| `POST /auth/signout` | Revokes the session's tokens. |
| `GET /auth/me`, `GET /auth/devices` | Profile and devices. |
| `POST /auth/device/register`, `POST /auth/device/challenge`, `POST /auth/device/verify` | Device-key sign-in. |
| `DELETE /auth/device/:id` | Revokes a device. |
| `GET /auth/oauth/:provider` | Authorization URL and state (binding cookie for browsers). |
| `GET` or `POST /auth/oauth/:provider/callback` | Completes sign-in. |
| `POST /auth/oauth/:provider/link/start`, `POST` / `DELETE /auth/oauth/:provider/link`, `GET /auth/oauth/links` | Account linking. |

Error responses are `{ error, code }` with stable codes such as `INVALID_CREDENTIALS`,
`RATE_LIMITED`, `ACCESS_TOKEN_REQUIRED`, `ACCESS_TOKEN_INVALID`, `REFRESH_TOKEN_INVALID`,
`REFRESH_IN_PROGRESS`, `MFA_TOKEN_INVALID`, `MFA_CODE_INVALID` and `DEVICE_OWNERSHIP_CONFLICT`.

`OAuthServerConfig`: `providers` (required), `stateStore`, `stateTtlMs`, `fetch`,
`linkedIdentityStore`, `createNewUsers` (default `true`), `autoLinkVerifiedEmail` (default `false`),
`allowUnlinkLastIdentity` (default `false`, so an OAuth-only account keeps a way to sign in).

### `BuiltInAuthRoutes`

The handlers behind `handleRequest`, for custom wiring. Each returns
`{ status, body: { data } | { error, code? } }`.

| Method | Description |
|--------|-------------|
| `handleSignUp(body, clientIp?)` | `{ email, password, name?, deviceId?, devicePublicKey? }` |
| `handleSignIn(body, clientIp?)` | Returns `SignInResult`: `{ user, tokens }` or an MFA challenge. Rate limited per account and per IP. |
| `handleMfaVerify({ mfaToken, code? , recoveryCode? })` | Completes MFA. |
| `handleRefresh({ refreshToken })` | Atomic rotation with reuse detection. |
| `handleSignOut(accessToken, { refreshToken? })` | |
| `handleGetMe(accessToken)`, `handleListDevices(accessToken)` | |
| `handleDeviceRegister(accessToken, { deviceId, publicKey, name })`, `handleDeviceChallenge(accessToken, deviceId)`, `handleDeviceVerify({ deviceId, challenge, signature })` | Device keys. |
| `handleRevokeDevice(accessToken, deviceId)` | |
| `authenticateAccess(token)` | The one check every route and the sync provider use: signature, expiry, user and device revocation. |
| `revokeAllForUser(userId)`, `onRevoke(listener)` | Revocation. |
| `toSyncAuthProvider({ scopeValues?, resolveScopes? })` | Sync provider. |

Config: `userStore`, `tokenManager` (required), `challengeStore`, `rateLimiter`, `mfa`, `onRevoke`.

### User stores

`InMemoryUserStore`, `createSqliteUserStore({ filename })` (`SqliteUserStore`) and
`createPostgresUserStore(...)` (`PostgresUserStore`). The SQLite and Postgres stores also hold the
token revocations. Custom stores implement `UserStore` (`createUser`, `findByEmail`, `findById`,
`registerDevice`, `findDevice`, `listDevices`, `revokeDevice`, `setEmailVerified`, `updatePassword`,
`listAll`, `update`, `delete`, `touchDevice`, optional `getTokenRevocationStore`).

### `TokenManager`

<!-- docs-check: signature @korajs/auth/server @korajs/auth -->
```typescript
class TokenManager {
  constructor(options: {
    secret: string | string[]          // index 0 signs; all verify (rotation)
    accessTokenLifetime?: number       // ms, default 15 minutes
    refreshTokenLifetime?: number      // ms, default 90 days
    deviceCredentialLifetime?: number  // ms, default 90 days
    revocationStore?: TokenRevocationStore
    refreshReuseGraceMs?: number       // default 30 s, 0 disables
  })
}
```

Methods: `issueTokens`, `issueAccessToken(userId, deviceId, options?)`,
`issueRefreshToken(userId, deviceId, options?)`, `issueDeviceCredential`, `validateToken(token)`
(signature and expiry, synchronous), `validateTokenWithRevocation(token)`, `rotateRefreshToken`,
`refreshAccessToken`, `revokeToken(jti, expiresAt)`, `revokeFamily`, `revokeDeviceTokens(deviceId)`,
`revokeAllForUser(userId)`. Without a revocation store, tokens stay valid until they expire.

A just-rotated refresh token is accepted once more within `refreshReuseGraceMs` and returns the same
successor pair (two tabs refreshing at once); later reuse revokes the token family.
`TokenRevocationStore` implementations (`InMemoryTokenRevocationStore`,
`SqliteTokenRevocationStore`, `PostgresTokenRevocationStore`) provide `isRevoked`, `revoke`,
`consume`, `isConsumed` and the device and user cut-offs (`revokeAllForDevice`,
`getDeviceRevokedBefore`, `revokeAllForUser`, `getUserRevokedBefore`).

JWT helpers: `encodeJwt(payload, secret)`, `decodeJwt(token)`, `verifyJwt(token, secret)` (all
synchronous, HS256; `decodeJwt` and `verifyJwt` return `null` on failure) and `isExpired(payload)`.
Passwords: `hashPassword(password)` returns `{ hash, salt }` (PBKDF2-SHA-512, 600 000 iterations)
and `verifyPassword(password, hash, salt)`.

### `SessionManager`

Server-side sessions for apps that keep their own session cookies.

| Config | Default |
|--------|---------|
| `store` (`SessionStore`, for example `InMemorySessionStore`) | required |
| `sessionTtlMs` | 7 days |
| `idleTimeoutMs` | 30 minutes |
| `maxSessionsPerUser` | 10 |
| `slidingWindow` | `true` |

Methods: `create({ userId, deviceId?, ipAddress?, userAgent?, mfaVerified?, metadata? })`,
`validate(id)`, `touch(id)`, `markMfaVerified(id)`, `requireMfa(id)` (throws
`SessionMfaRequiredError`), `revoke(id)`, `revokeAll(userId)`, `revokeOthers(userId, keepId)`,
`listSessions(userId)`, `cleanExpired()`. Errors: `SessionNotFoundError`, `SessionExpiredError`,
`SessionLimitExceededError`, `SessionMfaRequiredError`.

### `TotpManager`

RFC 6238 TOTP, compatible with authenticator apps.

```typescript
import { InMemoryTotpStore, TotpManager } from '@korajs/auth/server'

const totp = new TotpManager({ issuer: 'Acme', store: new InMemoryTotpStore() })
const setup = await totp.enable('user-123', 'alice@example.com') // { secret, uri, recoveryCodes }
await totp.verifySetup('user-123', '123456')
```

Config: `issuer`, `store`, `digits` (6), `period` (30 s), `algorithm` (`'SHA-1'`), `window` (1),
`recoveryCodes` (8). Methods: `enable`, `verifySetup`, `verify`, `verifyRecoveryCode`,
`regenerateRecoveryCodes(userId, totpCode)`, `disable(userId, code)`, `isEnabled`,
`remainingRecoveryCodes`. A code is accepted once (replay protection); after 5 wrong codes the user
is locked out with exponential backoff from 30 s to 15 minutes (`TotpLockedError`, `TOTP_LOCKED`).

### `OrgRoutes`

Transport-agnostic organization handlers; every method returns `{ status, body }` and enforces
membership and roles.

```typescript
import { InMemoryOrgStore, OrgRoutes } from '@korajs/auth/server'

const userStore = await createSqliteUserStore({ filename: './auth.db' })
const orgRoutes = new OrgRoutes({ orgStore: new InMemoryOrgStore(), userLookup: userStore })
```

| Method | Requires |
|--------|----------|
| `createOrg(userId, { name, slug?, metadata? })` | any user (becomes owner) |
| `getOrg(userId, orgId)`, `listMembers(userId, orgId)` | membership |
| `updateOrg(userId, orgId, params)` | admin |
| `deleteOrg(userId, orgId)`, `transferOwnership(userId, orgId, { newOwnerId })` | owner |
| `listUserOrgs(userId)` | |
| `addMember(userId, orgId, { targetUserId, role })`, `updateMemberRole(...)`, `removeMember(userId, orgId, targetUserId)` | admin (or removing oneself) |
| `createInvitation(userId, orgId, { email, role })`, `revokeInvitation(...)`, `listPendingInvitations(...)` | admin |
| `acceptInvitation(userId, { token }, identity?)`, `listMyInvitations(userId, identity?)` | the invitee's **verified** email |

Invitations are matched to the caller's verified email, from `userLookup` (a `UserStore` works) or
an explicit `identity`; invitee listings never include the token.

### RBAC

`RbacEngine(orgStore, { roles? })`: `hasPermission(userId, orgId, permission)`,
`getUserPermissions`, `getRolePermissions(role)`, `roleHasPermission`, `registerScopeResolver`,
`resolveScopes(userId, orgId, collections?)`, `getRoleNames`, `getRoleDefinition`. Permissions are
`resource:action` strings with `*` wildcards. Built-in roles: `viewer` (`*:read`), `billing`
(`org:billing`), `member` (`*:write`, `*:delete`, inherits viewer), `admin` (member management,
settings, invitations, inherits member), `owner` (`*:*`).

```typescript
import { defineRoles } from '@korajs/auth/server'

const roles = defineRoles()
  .role('viewer', ['*:read'])
  .role('editor', ['*:write'], { inherits: ['viewer'] })
  .build()
```

`OrgScopeResolver(orgStore, rbac)` builds per-collection scope filters from membership:
`registerCollectionScope(collection, (ctx) => filter)`, `resolve(userId, orgId, collections)`,
`canRead`, `canWrite`. Return its result from `resolveScopes` to grant org-scoped sync.

### OAuth

`OAuthManager({ providers, stateStore?, stateTtlMs?, fetch? })` with `googleProvider`,
`githubProvider` and `microsoftProvider` (`{ clientId, clientSecret?, redirectUri, scopes?, pkce? }`).
Native public clients use `pkce: true` without `clientSecret`. Durable stores:
`createSqliteOAuthStores({ filename })` and `createPostgresOAuthStores(...)` return
`{ stateStore, linkedIdentityStore }`; the in-memory stores are for development.

### Other server modules

| Module | Summary |
|--------|---------|
| `PasswordResetManager({ userStore, resetStore?, tokenTtlMs?, maxRequestsPerEmail?, onResetRequested?, exposeTokenForDevelopment? })` | `requestReset(email)` (always succeeds, never returns the token outside development), `resetPassword`, `changePassword`. |
| `EmailVerificationManager({ userStore, verificationStore?, tokenTtlMs?, maxRequestsPerUser?, onVerificationRequired? })` | `sendVerification`, `verifyEmail(token)`, `resendVerification(userId)`. |
| `ExternalJwtProvider({ providerName, jwtSecret?, validateToken? })`, `createClerkAdapter`, `createSupabaseAdapter` | Accept tokens from another identity provider. |
| `AdminApi({ userStore, sessionStore?, auditLogger?, isAdmin?, revokeAllForUser? })` | `getUser`, `listUsers({ email?, emailVerified?, limit?, offset? })`, `updateUser`, `deleteUser`, `getUserSessions`, `revokeUserSessions`, `revokeSession`, `getStats`. Wire `revokeAllForUser` so admin actions end tokens too. |
| `AuditLogger` | `log`, `query`, `count`, `purge`, `getUserActivity`, `getFailedLogins`. |
| `WebhookManager({ store, fetch?, allowPrivateTargets?, resolveHost? })` | `register({ url, events, metadata? })`, `update`, `remove`, `list`, `get`, `getDeliveries`, `dispatch`. |

Webhook endpoints must be `https` URLs resolving to public addresses (`allowPrivateTargets: true`
relaxes this for development; refused targets throw `WebhookTargetError`). Each delivery carries
`X-Webhook-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`; verify it with
`verifyWebhookSignature(rawBody, header, secret, { toleranceSeconds })` (default 300 s). The
`sha256=<hex>` format of Kora 1.0.0-beta.12 and earlier is neither produced nor accepted.

---

## Types

<!-- docs-check: signature @korajs/auth @korajs/auth/server -->
```typescript
interface AuthUser { id: string; email: string; name: string | null }
interface AuthTokens { accessToken: string; refreshToken: string }
type TokenType = 'access' | 'refresh' | 'device_credential'

interface TokenPayload {
  jti: string
  sub: string        // user id
  dev: string        // device id
  type: TokenType
  iat: number        // seconds
  exp: number        // seconds
  fam?: string       // refresh-token family
  iatMs?: number
  amr?: string[]     // authentication methods, e.g. ['pwd', 'otp']
}

type OrgRole = 'owner' | 'admin' | 'member' | 'viewer' | 'billing'
type InvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired'
type Permission = `${string}:${string}`  // 'resource:action'
type SyncScopes = Record<string, ScopeFilter>
interface ScopeContext { userId: string; orgId: string; role: string; permissions: Permission[] }
type CollectionScopeResolver = (ctx: ScopeContext) => ScopeFilter | null
```

`AuthEvent` (`auth:signed-in`, `auth:signed-out`, `auth:locked`, `auth:unlocked`,
`auth:token-refreshed`, `auth:device-revoked`, `auth:permission-changed`) is declared but not
emitted; observe `onAuthChange` and `onSessionChange` instead.

## Errors

Every error extends `KoraError`. The [Error Codes reference](/api/errors#auth) gives cause and fix
for each code.

| Client (`@korajs/auth`) | Code |
|-------------------------|------|
| `AuthError` | varies; `MfaRequiredError` is `AUTH_MFA_REQUIRED` |
| `AuthDeviceIdentityError` | `AUTH_DEVICE_IDENTITY_ERROR` |
| `DeviceIdentityError`, `DeviceKeyStoreError`, `CryptoUnavailableError` | `DEVICE_IDENTITY_ERROR`, `DEVICE_KEY_STORE_ERROR`, `CRYPTO_UNAVAILABLE` |
| `EncryptedTokenStoreError`, `EncryptionError`, `KeyDerivationError`, `OperationEncryptionError` | `ENCRYPTED_TOKEN_STORE_ERROR`, `ENCRYPTION_ERROR`, `KEY_DERIVATION_ERROR`, `OPERATION_ENCRYPTION_ERROR` |
| `PasskeyError`, `PasskeyUnsupportedError` | `PASSKEY_ERROR`, `PASSKEY_UNSUPPORTED` |
| `OrgClientError` | the server's code |

| Server (`@korajs/auth/server`) | Codes |
|--------------------------------|-------|
| `InMemoryAuthStoreError` | `IN_MEMORY_AUTH_STORE` |
| `DuplicateEmailError`, `DeviceOwnershipError` | `DUPLICATE_EMAIL`, `DEVICE_OWNERSHIP_CONFLICT` |
| `PasskeyVerificationError` | `PASSKEY_VERIFICATION_ERROR` |
| Session errors | `SESSION_NOT_FOUND`, `SESSION_EXPIRED`, `SESSION_LIMIT_EXCEEDED`, `SESSION_MFA_REQUIRED` |
| TOTP errors | `TOTP_INVALID_CODE`, `TOTP_LOCKED`, `TOTP_NOT_ENABLED`, `TOTP_ALREADY_ENABLED`, `TOTP_NOT_VERIFIED`, `TOTP_RECOVERY_EXHAUSTED` |
| Organization errors | `ORG_NOT_FOUND`, `ORG_SLUG_TAKEN`, `MEMBERSHIP_NOT_FOUND`, `MEMBER_ALREADY_EXISTS`, `INSUFFICIENT_ROLE`, `CANNOT_REMOVE_OWNER`, `INVITATION_NOT_FOUND`, `INVITATION_EXPIRED` |
| RBAC errors | `INVALID_PERMISSION`, `ROLE_NOT_FOUND`, `CIRCULAR_INHERITANCE` |
| OAuth errors | `OAUTH_STATE_MISMATCH`, `OAUTH_CODE_EXCHANGE_FAILED`, `OAUTH_USER_INFO_FAILED`, `OAUTH_PROVIDER_NOT_FOUND`, `DUPLICATE_LINKED_IDENTITY` |
| Reset and verification | `RESET_TOKEN_EXPIRED`, `RESET_TOKEN_NOT_FOUND`, `RESET_RATE_LIMITED`, `VERIFICATION_TOKEN_EXPIRED`, `VERIFICATION_TOKEN_NOT_FOUND` |
| External providers | `AUTH_EXTERNAL_TOKEN_INVALID`, `AUTH_EXTERNAL_OPERATION_NOT_SUPPORTED` |
| Admin and webhooks | `ADMIN_USER_NOT_FOUND`, `ADMIN_UNAUTHORIZED`, `WEBHOOK_ENDPOINT_NOT_FOUND`, `WEBHOOK_TARGET_REFUSED` |
