---
title: Authentication
description: "Add sign-up, sign-in, sessions, MFA, passkeys, organizations, and role-based access control to an offline-first Kora.js app with @korajs/auth."
---

# Authentication

`@korajs/auth` provides a complete authentication system designed for offline-first applications. It covers the entire auth lifecycle: sign-up, sign-in, session management, device identity, multi-factor authentication, organizations with role-based access control, passkeys, and encrypted token storage.

**Time required:** ~15 minutes to add full auth to your Kora app.

---

## Overview

The auth package is split into three entry points:

| Entry Point | Import | Purpose |
|-------------|--------|---------|
| `@korajs/auth` | Client code | `AuthClient`, device identity, passkeys, encrypted token store |
| `@korajs/auth/server` | Server code | `BuiltInAuthRoutes`, `TokenManager`, user/session/org stores, MFA, RBAC |
| `@korajs/auth/react` | React components | `AuthProvider`, `useAuth`, `useCurrentUser`, `useAuthStatus`, org hooks |

The architecture follows a clean client-server split:

```
Client                                Server
+-----------------------+            +---------------------------+
| AuthClient            |            | BuiltInAuthRoutes         |
|   +- AuthTokenStorage | -- HTTP -> |   +- InMemoryUserStore    |
|   +- AuthState        |            |   +- TokenManager         |
|                       |            |   +- PasswordHash (PBKDF2)|
| React Hooks           |            |                           |
|   +- useAuth          |            | SyncAuthProvider          |
|   +- useCurrentUser   |            |   +- authenticate()       |
|   +- useAuthStatus    |            +---------------------------+
+-----------------------+
```

---

<!-- docs-check-prelude
declare const KORA_AUTH_SECRET: string
-->

## Quick Start: Server-Side Setup

Install the auth package:

```bash
pnpm add @korajs/auth@beta
```

For a standard Kora app, create the auth server with one call:

<!-- docs-check: file auth-server.ts -->
```typescript
// server.ts
import {
  createKoraAuthServer,
  createSqliteOAuthStores,
  createSqliteUserStore,
  googleProvider,
} from '@korajs/auth/server'

const userStore = await createSqliteUserStore({ filename: './auth.db' })
const oauthStores = await createSqliteOAuthStores({ filename: './auth.db' })

export const auth = createKoraAuthServer({
  jwtSecret: KORA_AUTH_SECRET,
  userStore, // users and token revocations persist across restarts
  oauth: {
    providers: [
      googleProvider({
        clientId: 'your-google-client-id',
        clientSecret: 'your-google-client-secret',
        redirectUri: 'https://app.example.com/auth/oauth/google/callback',
      }),
    ],
    stateStore: oauthStores.stateStore,
    linkedIdentityStore: oauthStores.linkedIdentityStore,
  },
})
```

::: tip Generating a secret
Run `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` to create a 256-bit secret. Store it in `KORA_AUTH_SECRET`, never in source code.
:::

In production (`NODE_ENV=production`) `createKoraAuthServer` refuses the in-memory user and
revocation stores, which lose every account and every sign-out on restart: pass
`createSqliteUserStore` or `createPostgresUserStore` (revocations are stored with the users), or
set `allowInMemory: true` deliberately.

Mount the auth routes on the Kora production server:

```typescript
import { createProductionServer, createSqliteServerStore } from '@korajs/server'
import { auth } from './auth-server'

const store = createSqliteServerStore({ filename: './kora.db' })

const server = createProductionServer({
  store,
  syncOptions: {
    auth: auth.auth,
  },
  httpRoutes: [
    {
      path: '/auth',
      handle: auth.handleRequest,
    },
  ],
})
```

`createKoraAuthServer()` includes token revocation, atomic refresh-token rotation, rate limiting (per account and per IP), device registration, OAuth sign-in routes with browser-bound state, account linking, MFA at sign-in (with `mfa`), and sync-server authentication with server-granted scopes. For custom stores or advanced route wiring, use `BuiltInAuthRoutes`, `OAuthManager`, `TokenManager`, and `UserStore` directly.

Behind a reverse proxy, set `trustProxy` on the production server so `request.ip` (the key sign-in
rate limits use) comes from `X-Forwarded-For` only for the proxies you trust.

---

<!-- docs-check-prelude
import { createApp, defineSchema, t } from 'korajs'
import { createKoraAuth, createKoraAuthSync } from '@korajs/auth'
import type { AuthKeyValueStorage, DeviceKeyStore } from '@korajs/auth'
const schema = defineSchema({ version: 1, collections: { todos: { fields: { title: t.string(), userId: t.string() } } } })
const authClient = createKoraAuth({ serverUrl: 'https://acme.example.com' })
declare const secureStore: AuthKeyValueStorage
declare const deviceKeyStore: DeviceKeyStore
declare const url: string
declare const code: string
declare const state: string
declare function openSystemBrowser(url: string): Promise<void>
declare function Spinner(): JSX.Element
declare function SignIn(): JSX.Element
declare function AuthenticatedApp(): JSX.Element
-->

## Quick Start: Client-Side Setup

Create a Kora auth client and wrap your React app with `AuthProvider`:

<!-- docs-check: file auth.ts -->
```typescript
// auth.ts
import { createKoraAuth } from '@korajs/auth'

export const authClient = createKoraAuth({
  serverUrl: 'http://localhost:3001',
})
```

```tsx
// App.tsx
import { AuthProvider, useAuth } from '@korajs/auth/react'
import { authClient } from './auth'

function App() {
  return (
    <AuthProvider client={authClient} fallback={<div>Loading...</div>}>
      <Main />
    </AuthProvider>
  )
}

function Main() {
  const {
    user,
    isAuthenticated,
    isLoading,
    signIn,
    signInWithOAuth,
    signUp,
    signOut,
    error,
  } = useAuth()

  if (isLoading) return <div>Restoring session...</div>

  if (!isAuthenticated) {
    return (
      <div>
        <h1>Sign In</h1>
        {error && <p style={{ color: 'red' }}>{error}</p>}
        <button onClick={() => signIn({ email: 'alice@example.com', password: 'secret123' })}>
          Sign In
        </button>
        <button onClick={() => signInWithOAuth('google')}>
          Sign In with Google
        </button>
        <button onClick={() => signUp({ email: 'alice@example.com', password: 'secret123', name: 'Alice' })}>
          Sign Up
        </button>
      </div>
    )
  }

  return (
    <div>
      <p>Welcome, {user?.name ?? user?.email}</p>
      <button onClick={() => signOut()}>Sign Out</button>
    </div>
  )
}
```

The `AuthProvider` calls `authClient.initialize()` on mount, which restores any existing session from stored tokens. If the access token has expired, it refreshes using the stored refresh token. Returning users are signed in without any action, also offline: network errors, timeouts, 5xx responses, rate limits and captive portals never sign anyone out or destroy tokens. While the auth server cannot be reached the session is `authenticated-offline` (the user's identity is known, `token` is `null`), the user's own local database opens, and only sync waits for a fresh token.

A user with MFA enabled gets `MfaRequiredError` from `signIn`; complete it with
`authClient.verifyMfa(error.mfaToken, { code })` (or `{ recoveryCode }`).

### React Hooks Reference

| Hook | Purpose |
|------|---------|
| `useAuth()` | Full auth: `user`, `isAuthenticated`, `isLoading`, email/password methods, OAuth methods, `signOut`, `error` |
| `useCurrentUser()` | Lightweight alternative returning just the `AuthUser` or `null` |
| `useAuthStatus()` | Returns `{ state, isAuthenticated, isLoading }` for route guards |

All hooks use `useSyncExternalStore` under the hood for React 18+ concurrent mode safety.

For desktop and mobile OAuth, create the provider URL without redirecting, open it with the platform browser API, then complete the callback:

```typescript
const { url } = await authClient.getOAuthAuthorizationUrl('google')
await openSystemBrowser(url)

await authClient.completeOAuthSignIn('google', {
  code,
  state,
})
```

**Route guard example:**

```tsx
import { useAuthStatus } from '@korajs/auth/react'
import { Navigate } from 'react-router-dom'

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuthStatus()

  if (isLoading) return <Spinner />
  if (!isAuthenticated) return <Navigate to="/login" />

  return <>{children}</>
}
```

---

## Connecting Auth to the Sync Server

The auth server exposes a sync auth provider through `auth.auth`. If you used the server setup above, sync is already protected. The explicit wiring looks like this:

```typescript
import { createProductionServer, createSqliteServerStore } from '@korajs/server'
import { auth } from './auth-server'

const store = createSqliteServerStore({ filename: './kora.db' })

const syncServer = createProductionServer({
  store,
  port: 3001,
  staticDir: './dist',
  syncPath: '/kora-sync',
  syncOptions: {
    auth: auth.auth,
  },
})
```

The sync auth provider:
- Validates the access token at every handshake (WebSocket and every HTTP long-poll request), with the same `authenticateAccess` check that guards every auth route
- Verifies that the user still exists and that neither the device nor the user was revoked
- Returns the **server-derived scope grant** for the session (see [Sync scopes](#sync-scopes))
- Ends live sessions when their credential is revoked or expires, on this instance at once and on other instances within `sessionRevalidationIntervalMs`
- Updates the device's `lastSeenAt` timestamp on each connection

On the client side, wire auth to sync with **`createKoraAuthSync()`** (recommended):

```typescript
import { createApp, defineSchema, t } from 'korajs'
import { createKoraAuthSync } from '@korajs/auth'
import { authClient } from './auth'

const schema = defineSchema({ version: 1, collections: { todos: { fields: { title: t.string() } } } })

const app = createApp({
  schema,
  sync: {
    url: 'wss://my-server.com/kora-sync',
    authClient: createKoraAuthSync({ authClient, schema }),
    autoConnect: true,
  },
})
```

`createKoraAuthSync()` returns an `AuthSyncBinding` that `createApp` understands. It:

- Supplies the access token at every connection attempt, refreshing it when the server ended a session as expired or revoked
- Tells Kora who is signed in, so every local write is bound to that user (see [Writes belong to the signed-in user](#writes-belong-to-the-signed-in-user))
- Suspends sync while auth is loading or signed out (`anonymous: 'allow'` syncs anonymously instead)
- Sends a client-side scope hint built from JWT claims and your schema's scope declarations; the server only uses it to **narrow** its own grant
- Reconnects when auth state changes (sign-in, sign-out, a different user)

#### Manual auth wiring (advanced)

If you need custom token logic, pass `sync.auth` directly:

```typescript
const manualApp = createApp({
  schema,
  sync: {
    url: 'wss://my-server.com/kora-sync',
    auth: async (options) => {
      const token = options?.forceRefresh
        ? await authClient.refreshAccessToken()
        : await authClient.getAccessToken()
      return { token: token ?? '' }
    },
    autoConnect: true,
  },
})
```

Do not pass both `auth` and `authClient`; `authClient` takes precedence when both are set. A
plain `auth` function does not tell Kora who is signed in, so writes are not bound to users on
shared devices; prefer the binding.

#### Client scope hints from JWT claims

When you pass `schema` to `createKoraAuthSync()`, Kora extracts flat scope values from the access token using `extractScopeValuesFromClaims()` and builds the handshake scope map with `buildScopeMap()`. This is only a hint that narrows the session: the server decides what the session may sync (next section).

| Claim source | Maps to scope field |
|--------------|---------------------|
| Top-level claim matching a schema scope field (e.g. `orgId`) | That field |
| Nested `claims.scope[field]` | That field |
| JWT `sub` | `userId` when `userId` is a scope field |

Override mapping with `scopeFromClaims`:

```typescript
createKoraAuthSync({
  authClient,
  schema,
  scopeFromClaims: (claims) => ({
    userId: claims.sub as string,
    orgId: (claims.org_id as string) ?? 'default-org',
  }),
})
```

For static scope values unrelated to the token, use `sync.scope` instead (merged only when no auth binding resolves scope).

### Sync scopes

What a session may sync is decided by the server, from the verified identity, never from the
client. `createKoraAuthServer()` (and `routes.toSyncAuthProvider()`) grants every schema-scoped
collection bound to the verified `{ userId }`. Collections scoped by any other key (for example
`orgId`) are **denied** until you supply the value on the server:

<!-- docs-check: standalone -->
```typescript
import { createKoraAuthServer, createSqliteUserStore } from '@korajs/auth/server'
import { claimScopes } from '@korajs/core'

declare function orgOf(userId: string): Promise<string>
declare function teamsOf(userId: string): Promise<string[]>

const userStore = await createSqliteUserStore({ filename: './auth.db' })

// Extra verified values, merged over { userId }:
export const authServer = createKoraAuthServer({
  userStore,
  jwtSecret: process.env.KORA_AUTH_SECRET,
  scopeValues: async ({ userId }) => ({ orgId: await orgOf(userId) }),
})

// Or a full explicit grant (collections it omits are not visible):
export const explicitAuthServer = createKoraAuthServer({
  userStore,
  jwtSecret: process.env.KORA_AUTH_SECRET,
  resolveScopes: async ({ userId }) =>
    claimScopes({ userId }, { projects: { teamId: { $in: await teamsOf(userId) } } }),
})
```

- The client handshake (`syncScope`, scope hints, query views) can only **narrow** the grant; a
  collection the grant does not name is not synced.
- A grant value that is `undefined` or `null` fails closed: the session is refused with
  `SCOPE_REQUIRED` (or `INVALID_SCOPE_PREDICATE`) instead of matching every record without the
  field. A custom provider must return scopes for scoped collections.
- Uploads are authorized against the **stored** record and the resulting record, never against
  client-sent `previousData`, inside the store's write path on every server store. A client cannot
  move a record out of its own scope (ownership transfer goes through a server route), and foreign
  keys must point at parents inside the writer's scope.
- Downloads are judged per operation, from the scope values recorded when it was applied, so a
  record that changes owner does not disclose its earlier history; a record entering a scope
  arrives complete.
- Rich-text updates, presence and blobs are authorized and delivered within scope too.
- When a user's grant changes (removed from a team), live sessions end with `SCOPE_CHANGED`
  within `sessionRevalidationIntervalMs` and reconnect with the new grant.

### Node ids belong to users

Operations must come from the session's own node (`NODE_ID_MISMATCH` otherwise), and the server
records which principal claimed each node id. A signed-in device keeps its node per user; another
user's node is refused, and a device whose node has history from before claims existed is refused
with `NODE_ID_CLAIMED`. A device that uses `createKoraAuthSync` (every sync template) cannot move
to another node id, because its node id is its signed-in device id: after upgrading a beta.12
server, bind each such node to its device's owner once, before clients reconnect (script in
[Upgrading a beta.12 server database](/guide/production-server#upgrading-a-beta-12-server-database-with-authentication)).
Other devices refused their node move to a fresh node id and re-send their unsynced writes under
it (`sync:node-id-rotated`). Anonymous devices prove their node with a secret node token.

### Desktop and Tauri apps

`@korajs/auth` works in desktop apps built with the Kora Tauri template. A Tauri app runs the Kora frontend inside a WebView, so the auth client can use the same `AuthClient`, React hooks, `fetch`, and sync-token flow used by web apps.

The normal desktop setup is:

1. Deploy a remote sync/auth server.
2. Set `KORA_AUTH_SECRET` on that server to enable built-in `/auth/*` routes.
3. Create a Kora auth client in the Tauri frontend with the same server origin.
4. Pass `createKoraAuthSync({ authClient, schema })` to `createApp({ sync: { authClient } })`.

```typescript
import { createKoraAuth, createKoraAuthSync } from '@korajs/auth'
import { createApp } from 'korajs'

const authClient = createKoraAuth({
  serverUrl: 'https://acme.example.com',
})

const app = createApp({
  schema,
  sync: {
    url: 'wss://acme.example.com/kora-sync',
    authClient: createKoraAuthSync({ authClient, schema }),
    autoConnect: true,
  },
})
```

Email/password auth, OAuth sign-in, account linking, token refresh, sync authorization, MFA, organizations, and RBAC all use HTTP plus WebSocket tokens and apply to web and desktop clients the same way. Passkeys depend on WebAuthn support in the platform WebView and should be feature-detected with `isPasskeySupported()`.

For desktop and mobile OAuth, use an app redirect strategy such as a loopback callback, custom URL scheme, or hosted web sign-in that returns control to the app. Create the authorization URL without redirecting, open it with the platform's browser, then hand the returned `code` and `state` to the client:

```typescript
const { url: authorizationUrl } = await authClient.getOAuthAuthorizationUrl('google')
await openSystemBrowser(authorizationUrl)
// ...the app receives code and state from its redirect handler:
const user = await authClient.completeOAuthSignIn('google', { code, state })
```

OAuth state is bound to the device and to its purpose (sign-in or linking), so a callback
completed elsewhere is refused. Linking an account to a signed-in user starts at
`POST /auth/oauth/:provider/link/start` (`authClient.linkOAuth`).

### Secure token storage for desktop and mobile

By default, `createKoraAuth()` uses browser `localStorage` when it is available. Desktop and mobile production apps should pass a credential store backed by the platform credential store.

```typescript
import { createKoraAuth } from '@korajs/auth'

const authClient = createKoraAuth({
  serverUrl: 'https://acme.example.com',
  credentialStore: secureStore,
})
```

Use Tauri secure storage on desktop, Expo SecureStore or React Native Keychain on mobile, and iOS Keychain or Android Keystore for native integrations. The adapter may be synchronous or asynchronous.

`createKoraAuth()` creates a stable local device identity automatically when persistent key storage exists. For React Native and other runtimes without IndexedDB, pass a platform-backed `deviceKeyStore`:

```typescript
import { createKoraAuth } from '@korajs/auth'

const authClient = createKoraAuth({
  serverUrl: 'https://acme.example.com',
  credentialStore: secureStore,
  deviceKeyStore,
})

await authClient.signIn({
  email: 'alice@example.com',
  password: 'correct-horse-battery-staple',
})
```

The device identity provider stores a stable device ID and a non-extractable ECDSA P-256 key pair. The server receives `deviceId` and `devicePublicKey`, so token claims and device revocation apply to the actual offline device. Browsers and Tauri WebViews use IndexedDB for the key pair by default; React Native and other runtimes without IndexedDB should pass a platform-backed `deviceKeyStore`.

### Mixed Auth (Authenticated + Anonymous)

If your app needs both authenticated and anonymous sync (e.g., signed-in users create forms, anyone can submit responses), use `MixedAuthProvider`:

```typescript
import { KoraSyncServer, MixedAuthProvider, createSqliteServerStore } from '@korajs/server'
import { auth } from './auth-server'

const syncServer = new KoraSyncServer({
  store: createSqliteServerStore({ filename: './kora.db' }),
  auth: new MixedAuthProvider({
    primary: auth.auth,
    anonymousScopes: {
      responses: {}, // anonymous users can only sync 'responses'
    },
  }),
})
```

On the client, sync while signed out with `createKoraAuthSync({ authClient, schema, anonymous: 'allow' })`.
An anonymous device receives a node token at its first handshake and must present it to reconnect
with its node id.

See the [Common Patterns guide](/guide/common-patterns#anonymous-public-data-access) for a full walkthrough.

---

<!-- docs-check-prelude
import {
  BuiltInAuthRoutes,
  EmailVerificationManager,
  OrgRoutes,
  PasswordResetManager,
  RbacEngine,
  SessionManager,
  TokenManager,
  TotpManager,
} from '@korajs/auth/server'
import type { OrgStore, UserStore } from '@korajs/auth/server'
// An Express-style router; req and res are your framework's.
// biome-ignore lint: documentation scaffolding
type Handler = (req: any, res: any, next: () => void) => unknown
declare const app: {
  get(path: string, ...handlers: Handler[]): void
  post(path: string, ...handlers: Handler[]): void
  patch(path: string, ...handlers: Handler[]): void
  delete(path: string, ...handlers: Handler[]): void
}
declare const userStore: UserStore
declare const orgStore: OrgStore
declare const tokenManager: TokenManager
declare const authRoutes: BuiltInAuthRoutes
declare const sessions: SessionManager
declare const totp: TotpManager
declare const orgRoutes: OrgRoutes
declare const rbac: RbacEngine
declare const emailVerifier: EmailVerificationManager
declare const passwordReset: PasswordResetManager
declare const userId: string
declare const orgId: string
declare const code: string
declare const sessionId: string
declare const currentSessionId: string
declare function sendVerificationEmail(email: string, link: string): Promise<void>
declare function sendPasswordResetEmail(email: string, link: string): Promise<void>
declare function storePasskeyCredential(userId: string, credential: unknown): Promise<void>
declare function getUserCredentialIds(email: string): Promise<string[]>
declare function getStoredCredential(credentialId: string): Promise<{ userId: string; publicKey: string; signCount: number }>
declare function updateSignCount(credentialId: string, signCount: number): Promise<void>
-->

## Email Verification

Email verification confirms that users own the email addresses they register with.

### Server Setup

```typescript
import {
  EmailVerificationManager,
  InMemoryEmailVerificationStore,
} from '@korajs/auth/server'

const emailVerifier = new EmailVerificationManager({
  userStore,
  // In production, provide an onVerificationRequired callback to send emails:
  onVerificationRequired: async (email, token, expiresAt) => {
    const link = `https://my-app.com/verify?token=${token}`
    await sendVerificationEmail(email, link) // your email sending logic
  },
  // Optional configuration:
  // verificationStore: new InMemoryEmailVerificationStore(),  // default
  // tokenTtlMs: 24 * 60 * 60 * 1000,                        // 24 hours (default)
  // maxRequestsPerUser: 3,                                    // rate limit (default)
})
```

Wire the verification endpoints:

```typescript
// Send verification email after sign-up
app.post('/auth/verify/send', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '') ?? ''
  const payload = tokenManager.validateToken(token)
  if (!payload) return res.status(401).json({ error: 'Unauthorized' })

  const result = await emailVerifier.sendVerification(payload.sub, req.body.email)
  res.status(result.status).json(result.body)
})

// Verify email with token from the link
app.post('/auth/verify/confirm', async (req, res) => {
  const result = await emailVerifier.verifyEmail(req.body.token)
  res.status(result.status).json(result.body)
})

// Resend verification for the authenticated user
app.post('/auth/verify/resend', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '') ?? ''
  const payload = tokenManager.validateToken(token)
  if (!payload) return res.status(401).json({ error: 'Unauthorized' })

  const result = await emailVerifier.resendVerification(payload.sub)
  res.status(result.status).json(result.body)
})
```

::: tip Development mode
If you do not provide an `onVerificationRequired` callback, the verification token is returned directly in the API response. This is convenient for development and testing but must never be used in production.
:::

---

## Password Reset

The password reset flow uses single-use tokens with configurable TTL (default: 1 hour).

### Server Setup

```typescript
import { PasswordResetManager } from '@korajs/auth/server'

const passwordReset = new PasswordResetManager({
  userStore,
  onResetRequested: async (email, token, expiresAt) => {
    const link = `https://my-app.com/reset-password?token=${token}`
    await sendPasswordResetEmail(email, link) // your email sending logic
  },
  // tokenTtlMs: 60 * 60 * 1000,  // 1 hour (default)
  // maxRequestsPerEmail: 3,        // rate limit (default)
})
```

Wire the reset endpoints:

```typescript
// Request a password reset (always returns 200 to prevent email enumeration)
app.post('/auth/password/reset-request', async (req, res) => {
  const result = await passwordReset.requestReset(req.body.email)
  res.status(result.status).json(result.body)
})

// Consume the reset token and set a new password
app.post('/auth/password/reset', async (req, res) => {
  const result = await passwordReset.resetPassword(req.body.token, req.body.newPassword)
  res.status(result.status).json(result.body)
})

// Change password (authenticated, requires current password)
app.post('/auth/password/change', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '') ?? ''
  const payload = tokenManager.validateToken(token)
  if (!payload) return res.status(401).json({ error: 'Unauthorized' })

  const result = await passwordReset.changePassword(
    payload.sub,
    req.body.currentPassword,
    req.body.newPassword,
  )
  res.status(result.status).json(result.body)
})
```

The `requestReset` method always returns HTTP 200 regardless of whether the email exists, and it
never returns the reset token: without `onResetRequested` nobody receives it. For local
development only, `exposeTokenForDevelopment: true` returns it in the response (never in
production). Wire `onPasswordChanged: authServer.revokeAllForUser` so a password change ends
every session and token of that user.

---

## Device Identity

Kora uses ECDSA P-256 key pairs to establish device identity. Each device generates a non-extractable private key that stays in the browser and a public key that is registered with the server. This enables proof-of-possession verification: the server can confirm that a request genuinely comes from a specific device.

<!-- docs-check-prelude
import { createApp, defineSchema, t } from 'korajs'
import { createKoraAuth, createKoraAuthSync } from '@korajs/auth'
import type { AuthKeyValueStorage, DeviceKeyStore } from '@korajs/auth'
const schema = defineSchema({ version: 1, collections: { todos: { fields: { title: t.string(), userId: t.string() } } } })
const authClient = createKoraAuth({ serverUrl: 'https://acme.example.com' })
declare const secureStore: AuthKeyValueStorage
declare const deviceKeyStore: DeviceKeyStore
declare const url: string
declare const code: string
declare const state: string
declare function openSystemBrowser(url: string): Promise<void>
declare function Spinner(): JSX.Element
declare function SignIn(): JSX.Element
declare function AuthenticatedApp(): JSX.Element
-->

### Client: Generate and Register a Device Key Pair

```typescript
import {
  generateDeviceKeyPair,
  exportPublicKeyJwk,
  signChallenge,
  computePublicKeyThumbprint,
} from '@korajs/auth'

// Generate an ECDSA P-256 key pair (private key is non-extractable)
const keyPair = await generateDeviceKeyPair()

// Export the public key as a JWK for server registration
const publicKeyJwk = await exportPublicKeyJwk(keyPair)
const publicKeyJson = JSON.stringify(publicKeyJwk)

// Compute the SHA-256 thumbprint (RFC 7638) for unique device identification
const thumbprint = await computePublicKeyThumbprint(publicKeyJwk)
```

### Client: Persistent Device Key Storage

Device keys must survive page refreshes. Use the `DeviceKeyStore`:

```typescript
import { createDeviceKeyStore, generateDeviceKeyPair } from '@korajs/auth'

// IndexedDB in browsers, in-memory elsewhere
const keyStore = createDeviceKeyStore()

// Save after generation
const keyPair = await generateDeviceKeyPair()
await keyStore.saveKeyPair('my-device-id', keyPair)

// Load on subsequent visits
const storedKeyPair = await keyStore.loadKeyPair('my-device-id')
```

`createKoraAuth()` does this for you (`createPersistentDeviceIdentity`): the device id and key
pair are created once and presented at every sign-in.

<!-- docs-check-prelude
import {
  BuiltInAuthRoutes,
  EmailVerificationManager,
  OrgRoutes,
  PasswordResetManager,
  RbacEngine,
  SessionManager,
  TokenManager,
  TotpManager,
} from '@korajs/auth/server'
import type { OrgStore, UserStore } from '@korajs/auth/server'
// An Express-style router; req and res are your framework's.
// biome-ignore lint: documentation scaffolding
type Handler = (req: any, res: any, next: () => void) => unknown
declare const app: {
  get(path: string, ...handlers: Handler[]): void
  post(path: string, ...handlers: Handler[]): void
  patch(path: string, ...handlers: Handler[]): void
  delete(path: string, ...handlers: Handler[]): void
}
declare const userStore: UserStore
declare const orgStore: OrgStore
declare const tokenManager: TokenManager
declare const authRoutes: BuiltInAuthRoutes
declare const sessions: SessionManager
declare const totp: TotpManager
declare const orgRoutes: OrgRoutes
declare const rbac: RbacEngine
declare const emailVerifier: EmailVerificationManager
declare const passwordReset: PasswordResetManager
declare const userId: string
declare const orgId: string
declare const code: string
declare const sessionId: string
declare const currentSessionId: string
declare function sendVerificationEmail(email: string, link: string): Promise<void>
declare function sendPasswordResetEmail(email: string, link: string): Promise<void>
declare function storePasskeyCredential(userId: string, credential: unknown): Promise<void>
declare function getUserCredentialIds(email: string): Promise<string[]>
declare function getStoredCredential(credentialId: string): Promise<{ userId: string; publicKey: string; signCount: number }>
declare function updateSignCount(credentialId: string, signCount: number): Promise<void>
-->

### Server: Register and Verify Devices

Register a device during or after sign-up:

```typescript
app.post('/auth/device/register', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '') ?? ''
  const result = await authRoutes.handleDeviceRegister(token, {
    deviceId: req.body.deviceId,
    publicKey: req.body.publicKey,  // JSON-encoded JWK string
    name: req.body.name,            // e.g., "Chrome on MacBook"
  })
  res.status(result.status).json(result.body)
})
```

Verify device possession with a challenge-response flow:

```typescript
// Step 1: Server issues a challenge (single-use, 60-second TTL)
app.post('/auth/device/challenge', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '') ?? ''
  const result = await authRoutes.handleDeviceChallenge(token, req.body.deviceId)
  res.status(result.status).json(result.body)
})

// Step 2 (on the client): sign the challenge with the device private key,
// const signature = await signChallenge(keyPair.privateKey, challenge)

// Step 3: Server verifies the signature and issues fresh tokens
app.post('/auth/device/verify', async (req, res) => {
  const result = await authRoutes.handleDeviceVerify({
    deviceId: req.body.deviceId,
    challenge: req.body.challenge,
    signature: req.body.signature,
  })
  res.status(result.status).json(result.body)
})
```

### Managing Devices

```typescript
// List all devices for the authenticated user
app.get('/auth/devices', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '') ?? ''
  const result = await authRoutes.handleListDevices(token)
  res.status(result.status).json(result.body)
})

// Revoke a device (invalidates all its tokens)
app.delete('/auth/device/:id', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '') ?? ''
  const result = await authRoutes.handleRevokeDevice(token, req.params.id)
  res.status(result.status).json(result.body)
})
```

---

## Multi-Factor Authentication (TOTP)

Kora supports TOTP-based multi-factor authentication, compatible with Google Authenticator, Authy, 1Password, and other authenticator apps. The implementation follows RFC 6238 (TOTP) and RFC 4226 (HOTP).

::: tip MFA at sign-in
Pass the manager to the auth server (`createKoraAuthServer({ ..., mfa: totp })`) and sign-in
enforces it: a user with MFA enabled receives `{ mfaRequired, mfaToken }` instead of tokens and
completes it at `POST /auth/mfa/verify` (`authClient.verifyMfa`). The routes below are for
enrolment and for apps that wire their own endpoints.
:::

### Server Setup

```typescript
import { TotpManager, InMemoryTotpStore } from '@korajs/auth/server'

const totp = new TotpManager({
  issuer: 'My App',                 // Shown in authenticator apps
  store: new InMemoryTotpStore(),
  // Optional:
  // digits: 6,                     // Code length (default: 6)
  // period: 30,                    // Time step in seconds (default: 30)
  // algorithm: 'SHA-1',            // Most compatible (default)
  // window: 1,                     // Accept codes +/- 1 period (default)
  // recoveryCodes: 8,              // Number of recovery codes (default)
})
```

### Step 1: Enable MFA

The user initiates MFA setup. Return the URI for a QR code and the recovery codes.

```typescript
app.post('/auth/mfa/enable', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '') ?? ''
  const payload = tokenManager.validateToken(token)
  if (!payload) return res.status(401).json({ error: 'Unauthorized' })

  try {
    const setup = await totp.enable(payload.sub, req.body.email)
    // setup.uri     -> otpauth:// URI for QR code generation
    // setup.secret  -> base32 secret for manual entry
    // setup.recoveryCodes -> array of single-use recovery codes
    res.json({ data: setup })
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed' })
  }
})
```

On the client, display the `setup.uri` as a QR code (use a library like `qrcode` or `qrcode.react`) and instruct the user to save the recovery codes securely.

### Step 2: Verify Setup

The user enters a code from their authenticator app to confirm setup.

```typescript
app.post('/auth/mfa/verify-setup', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '') ?? ''
  const payload = tokenManager.validateToken(token)
  if (!payload) return res.status(401).json({ error: 'Unauthorized' })

  try {
    await totp.verifySetup(payload.sub, req.body.code)
    res.json({ data: { message: 'MFA enabled successfully.' } })
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid code' })
  }
})
```

### Step 3: Verify on Login

After successful password authentication, require a TOTP code:

```typescript
app.post('/auth/mfa/verify', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '') ?? ''
  const payload = tokenManager.validateToken(token)
  if (!payload) return res.status(401).json({ error: 'Unauthorized' })

  const valid = await totp.verify(payload.sub, req.body.code)
  if (!valid) {
    return res.status(401).json({ error: 'Invalid TOTP code.' })
  }

  res.json({ data: { message: 'MFA verified.' } })
})
```

### Recovery Codes

If the user loses access to their authenticator app, they can use a recovery code instead. Each recovery code is single-use:

```typescript
app.post('/auth/mfa/recover', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '') ?? ''
  const payload = tokenManager.validateToken(token)
  if (!payload) return res.status(401).json({ error: 'Unauthorized' })

  const valid = await totp.verifyRecoveryCode(payload.sub, req.body.recoveryCode)
  if (!valid) {
    return res.status(401).json({ error: 'Invalid recovery code.' })
  }

  res.json({ data: { message: 'Recovery code accepted.' } })
})
```

Regenerate recovery codes (requires a valid TOTP code for authorization):

```typescript
app.post('/auth/mfa/regenerate-codes', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '') ?? ''
  const payload = tokenManager.validateToken(token)
  if (!payload) return res.status(401).json({ error: 'Unauthorized' })

  try {
    const newCodes = await totp.regenerateRecoveryCodes(payload.sub, req.body.code)
    res.json({ data: { recoveryCodes: newCodes } })
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed' })
  }
})
```

### Check MFA Status

```typescript
const mfaEnabled = await totp.isEnabled(userId)
const remaining = await totp.remainingRecoveryCodes(userId)
```

### Disable MFA

Requires either a valid TOTP code or a recovery code:

```typescript
await totp.disable(userId, code)
```

---

## Session Management

The `SessionManager` provides server-side session tracking with support for idle timeout, sliding window expiry, max concurrent sessions, and MFA verification tracking.

### Server Setup

```typescript
import { SessionManager, InMemorySessionStore } from '@korajs/auth/server'

const sessions = new SessionManager({
  store: new InMemorySessionStore(),
  sessionTtlMs: 7 * 24 * 60 * 60 * 1000,  // 7 days (default)
  idleTimeoutMs: 30 * 60 * 1000,            // 30 minutes (default)
  maxSessionsPerUser: 5,                      // 10 (default)
  slidingWindow: true,                        // extend on activity (default)
})
```

### Create a Session on Login

```typescript
app.post('/auth/signin', async (req, res) => {
  const authResult = await authRoutes.handleSignIn(req.body, req.ip)
  if (!('data' in authResult.body) || !('user' in authResult.body.data)) {
    // An error, or an MFA challenge the client completes first
    return res.status(authResult.status).json(authResult.body)
  }

  // Create a server-side session
  const session = await sessions.create({
    userId: authResult.body.data.user.id,
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'] ?? null,
    deviceId: req.body.deviceId,
  })

  res.json({
    ...authResult.body,
    sessionId: session.id,
  })
})
```

### Validate Sessions on Requests

```typescript
async function requireSession(req: any, res: any, next: () => void) {
  const sessionId = req.headers['x-session-id']
  if (!sessionId) return res.status(401).json({ error: 'Session required.' })

  try {
    const session = await sessions.validate(sessionId)
    await sessions.touch(sessionId) // update last activity
    req.session = session
    next()
  } catch (err) {
    res.status(401).json({ error: 'Session expired or invalid.' })
  }
}
```

### MFA-Aware Sessions

Mark a session as MFA-verified after TOTP verification:

```typescript
app.post('/auth/mfa/verify', async (req, res) => {
  // ... verify TOTP code ...

  // Mark session as MFA-verified
  await sessions.markMfaVerified(req.session.id)
  res.json({ data: { message: 'MFA verified.' } })
})
```

Require MFA on sensitive endpoints:

```typescript
async function requireMfa(req: any, res: any, next: () => void) {
  try {
    await sessions.requireMfa(req.session.id)
    next()
  } catch {
    res.status(403).json({ error: 'MFA verification required.' })
  }
}

declare function requireSession(req: any, res: any, next: () => void): Promise<void>
app.post('/auth/password/change', requireSession, requireMfa, async (req, res) => {
  // Only reachable if session is valid AND MFA-verified
})
```

### Session Operations

```typescript
// List all active sessions for a user
const activeSessions = await sessions.listSessions(userId)

// Revoke a specific session
await sessions.revoke(sessionId)

// Sign out everywhere (revoke all sessions)
const revokedAll = await sessions.revokeAll(userId)

// Sign out other devices (keep current session)
const revokedOthers = await sessions.revokeOthers(userId, currentSessionId)

// Clean up expired sessions (call periodically)
const cleanedCount = await sessions.cleanExpired()
```

---

## Organizations and RBAC

Organizations group users together for multi-tenant applications. Each organization has members with roles, and Kora provides a role-based access control (RBAC) engine for permission evaluation.

### Role Hierarchy

Kora ships with five built-in roles, ordered by decreasing privilege:

| Role | Level | Capabilities |
|------|-------|-------------|
| `owner` | 40 | Full control: delete org, transfer ownership, all permissions (`*:*`) |
| `admin` | 30 | Manage members, settings, invitations; inherits `member` permissions |
| `member` | 20 | Read and write data; inherits `viewer` permissions |
| `billing` | 15 | Billing management only, no data access |
| `viewer` | 10 | Read-only access to shared data |

### Server Setup

```typescript
import { OrgRoutes, InMemoryOrgStore } from '@korajs/auth/server'

const orgStore = new InMemoryOrgStore()
const orgRoutes = new OrgRoutes({ orgStore })
```

### Creating Organizations

```typescript
app.post('/orgs', async (req, res) => {
  const userId = req.userId // from your auth middleware
  const result = await orgRoutes.createOrg(userId, {
    name: req.body.name,
    slug: req.body.slug,       // optional, auto-generated if omitted
    metadata: req.body.metadata, // optional
  })
  res.status(result.status).json(result.body)
})
```

The creating user automatically becomes the `owner`.

### Managing Members

```typescript
// List members (requires membership in the org)
app.get('/orgs/:orgId/members', async (req, res) => {
  const result = await orgRoutes.listMembers(req.userId, req.params.orgId)
  res.status(result.status).json(result.body)
})

// Add a member (requires admin or higher)
app.post('/orgs/:orgId/members', async (req, res) => {
  const result = await orgRoutes.addMember(req.userId, req.params.orgId, {
    targetUserId: req.body.userId,
    role: req.body.role,  // 'admin', 'member', 'viewer', or 'billing'
  })
  res.status(result.status).json(result.body)
})

// Update a member's role (requires admin or higher)
app.patch('/orgs/:orgId/members/role', async (req, res) => {
  const result = await orgRoutes.updateMemberRole(req.userId, req.params.orgId, {
    targetUserId: req.body.userId,
    role: req.body.role,
  })
  res.status(result.status).json(result.body)
})

// Remove a member (requires admin, or self-removal for any member)
app.delete('/orgs/:orgId/members/:userId', async (req, res) => {
  const result = await orgRoutes.removeMember(req.userId, req.params.orgId, req.params.userId)
  res.status(result.status).json(result.body)
})

// Transfer ownership (requires owner)
app.post('/orgs/:orgId/transfer', async (req, res) => {
  const result = await orgRoutes.transferOwnership(req.userId, req.params.orgId, {
    newOwnerId: req.body.newOwnerId,
  })
  res.status(result.status).json(result.body)
})
```

### Invitations

Invitations let you invite users by email. Each invitation has a single-use token and a 7-day expiry.

```typescript
// Create an invitation (requires admin or higher)
app.post('/orgs/:orgId/invitations', async (req, res) => {
  const result = await orgRoutes.createInvitation(req.userId, req.params.orgId, {
    email: req.body.email,
    role: req.body.role,
  })
  // Send the invitation.token to the invitee via email
  res.status(result.status).json(result.body)
})

// Accept an invitation (authenticated user joins the org)
app.post('/orgs/invitations/accept', async (req, res) => {
  const result = await orgRoutes.acceptInvitation(req.userId, {
    token: req.body.token,
  })
  res.status(result.status).json(result.body)
})

// List pending invitations for the org (requires admin)
app.get('/orgs/:orgId/invitations', async (req, res) => {
  const result = await orgRoutes.listPendingInvitations(req.userId, req.params.orgId)
  res.status(result.status).json(result.body)
})

// Revoke a pending invitation (requires admin)
app.delete('/orgs/:orgId/invitations/:invId', async (req, res) => {
  const result = await orgRoutes.revokeInvitation(req.userId, req.params.orgId, req.params.invId)
  res.status(result.status).json(result.body)
})
```

### RBAC Engine

For fine-grained permission checks beyond role hierarchy, use the `RbacEngine`:

```typescript
import { RbacEngine, defineRoles, OrgScopeResolver } from '@korajs/auth/server'

// Use built-in roles
const builtInRbac = new RbacEngine(orgStore)

// Or define custom roles
const customRoles = defineRoles()
  .role('viewer', ['*:read'])
  .role('editor', ['todos:write', 'projects:write'], { inherits: ['viewer'] })
  .role('admin', ['org:manage-members', 'org:manage-settings'], { inherits: ['editor'] })
  .role('owner', ['*:*'])
  .build()

const customRbac = new RbacEngine(orgStore, { roles: customRoles })
```

Check permissions:

```typescript
// Does user have a specific permission?
const canWrite = await rbac.hasPermission(userId, orgId, 'todos:write')

// Get all permissions for a user in an org
const perms = await rbac.getUserPermissions(userId, orgId)

// Resolve sync scopes (what data the user can see during sync)
const scopes = await rbac.resolveScopes(userId, orgId, ['todos', 'projects'])
```

Permissions follow the `resource:action` format with wildcard support:

```
todos:read       -> read access to todos
todos:*          -> all actions on todos
*:read           -> read access to all collections
*:*              -> full access to everything
```

### React Organization Hooks

```tsx
import { OrgProvider, useOrg, useOrgMembers, usePermission } from '@korajs/auth/react'
import { OrgClient, createKoraAuth } from '@korajs/auth'

const authClient = createKoraAuth({ serverUrl: 'http://localhost:3001' })
const orgClient = new OrgClient({
  serverUrl: 'http://localhost:3001',
  getAccessToken: () => authClient.getAccessToken(),
})

function App() {
  return (
    <OrgProvider client={orgClient}>
      <OrgSwitcher />
    </OrgProvider>
  )
}

function OrgSwitcher() {
  const { org, switchOrg, error } = useOrg()
  // Also: role, orgId, createOrg({ name, slug }), listOrgs(), leaveOrg(), clearOrg()
  return (
    <div>
      <p>{org?.name ?? 'No organization'}</p>
      {error && <p role="alert">{error}</p>}
      <button onClick={() => switchOrg('org-123')}>Switch</button>
    </div>
  )
}

function MembersList({ orgId }: { orgId: string }) {
  const { members, isLoading, invite } = useOrgMembers(orgId)
  // Also: refresh(), removeMember(userId), updateRole(userId, role), error
  if (isLoading) return null
  return (
    <ul>
      {members.map((m) => (
        <li key={m.userId}>{m.role}</li>
      ))}
      <button onClick={() => invite('bob@example.com', 'member')}>Invite</button>
    </ul>
  )
}

function AdminPanel() {
  const canManage = usePermission('admin')

  if (!canManage) return <p>Access denied</p>
  return <div>Admin settings...</div>
}
```

---

## Passkeys (WebAuthn)

Passkeys provide passwordless authentication using biometrics (Touch ID, Face ID, Windows Hello) or hardware security keys. Kora implements the WebAuthn standard with both client-side and server-side components.

<!-- docs-check-prelude
import { createApp, defineSchema, t } from 'korajs'
import { createKoraAuth, createKoraAuthSync } from '@korajs/auth'
import type { AuthKeyValueStorage, DeviceKeyStore } from '@korajs/auth'
const schema = defineSchema({ version: 1, collections: { todos: { fields: { title: t.string(), userId: t.string() } } } })
const authClient = createKoraAuth({ serverUrl: 'https://acme.example.com' })
declare const secureStore: AuthKeyValueStorage
declare const deviceKeyStore: DeviceKeyStore
declare const url: string
declare const code: string
declare const state: string
declare function openSystemBrowser(url: string): Promise<void>
declare function Spinner(): JSX.Element
declare function SignIn(): JSX.Element
declare function AuthenticatedApp(): JSX.Element
-->

### Check Support

```typescript
import { isPasskeySupported, isPlatformAuthenticatorAvailable } from '@korajs/auth'

// Check if WebAuthn is available at all
if (isPasskeySupported()) {
  // Check if biometric authenticator is available (Touch ID, etc.)
  const hasBiometric = await isPlatformAuthenticatorAvailable()

  if (hasBiometric) {
    // Show "Sign in with Touch ID" button
  }
}
```

<!-- docs-check-prelude
import { TokenManager } from '@korajs/auth/server'
// biome-ignore lint: documentation scaffolding
type Handler = (req: any, res: any) => unknown
declare const app: { post(path: string, ...handlers: Handler[]): void }
declare const tokenManager: TokenManager
declare const serverOptions: { challenge: string; userId: string; allowCredentialIds?: string[] }
declare function storePasskeyCredential(userId: string, credential: unknown): Promise<void>
declare function getUserCredentialIds(email: string): Promise<string[]>
declare function getStoredCredential(credentialId: string): Promise<{ userId: string; publicKey: string; signCount: number }>
declare function updateSignCount(credentialId: string, signCount: number): Promise<void>
-->

### Registration Flow

**Step 1: Server generates registration options:**

```typescript
import { generateRegistrationOptions } from '@korajs/auth/server'

app.post('/auth/passkey/register/options', async (req, res) => {
  const options = generateRegistrationOptions({
    rpId: 'example.com',            // your domain
    rpName: 'My App',
    userId: req.userId,
    userName: req.body.email,
    userDisplayName: req.body.name,
    existingCredentialIds: [],       // exclude already-registered credentials
  })

  // Store options.challenge in the user's session for verification
  req.session.passkeyChallenge = options.challenge
  res.json({ data: options })
})
```

**Step 2: Client creates the credential:**

```typescript
import { createPasskeyCredential } from '@korajs/auth'

const credential = await createPasskeyCredential({
  challenge: serverOptions.challenge,
  rpId: 'example.com',
  rpName: 'My App',
  userId: serverOptions.userId,
  userName: 'alice@example.com',
  userDisplayName: 'Alice',
  // Optional: customize authenticator selection
  // authenticatorSelection: {
  //   authenticatorAttachment: 'platform',  // biometric only
  //   residentKey: 'preferred',
  //   userVerification: 'required',
  // },
})

// Send credential to server for verification
await fetch('/auth/passkey/register/verify', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(credential),
})
```

**Step 3: Server verifies and stores the credential:**

```typescript
import { verifyRegistrationResponse } from '@korajs/auth/server'

app.post('/auth/passkey/register/verify', async (req, res) => {
  const result = await verifyRegistrationResponse({
    credential: req.body,
    expectedChallenge: req.session.passkeyChallenge,
    expectedOrigin: 'https://example.com',
    expectedRpId: 'example.com',
  })

  if (result.verified) {
    // Store in your database:
    // result.credentialId  -> identifies this passkey
    // result.publicKey     -> COSE public key for future verification
    // result.signCount     -> signature counter (detect cloned authenticators)
    await storePasskeyCredential(req.userId, result)
    res.json({ data: { success: true } })
  }
})
```

### Authentication Flow

**Step 1: Server generates authentication options:**

```typescript
import { generateAuthenticationOptions } from '@korajs/auth/server'

app.post('/auth/passkey/login/options', async (req, res) => {
  const options = generateAuthenticationOptions({
    rpId: 'example.com',
    allowCredentialIds: await getUserCredentialIds(req.body.email),
  })

  req.session.passkeyChallenge = options.challenge
  res.json({ data: options })
})
```

**Step 2: Client performs the assertion:**

```typescript
import { authenticateWithPasskey } from '@korajs/auth'

const assertion = await authenticateWithPasskey({
  challenge: serverOptions.challenge,
  rpId: 'example.com',
  allowCredentialIds: serverOptions.allowCredentialIds,
})

// Send assertion to server
await fetch('/auth/passkey/login/verify', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(assertion),
})
```

**Step 3: Server verifies the signature:**

```typescript
import { verifyAuthenticationResponse } from '@korajs/auth/server'

app.post('/auth/passkey/login/verify', async (req, res) => {
  const storedCredential = await getStoredCredential(req.body.credentialId)

  const result = await verifyAuthenticationResponse({
    assertion: req.body,
    expectedChallenge: req.session.passkeyChallenge,
    expectedOrigin: 'https://example.com',
    expectedRpId: 'example.com',
    publicKey: storedCredential.publicKey,
    previousSignCount: storedCredential.signCount,
  })

  if (result.verified) {
    // Update the stored sign count to detect cloned authenticators
    await updateSignCount(req.body.credentialId, result.newSignCount)

    // Issue auth tokens
    const tokens = tokenManager.issueTokens(storedCredential.userId, 'passkey')
    res.json({ data: { tokens } })
  } else {
    res.status(401).json({ error: 'Passkey verification failed.' })
  }
})
```

---

<!-- docs-check-prelude
import { createApp, defineSchema, t } from 'korajs'
import { createKoraAuth, createKoraAuthSync } from '@korajs/auth'
import type { AuthKeyValueStorage, DeviceKeyStore } from '@korajs/auth'
const schema = defineSchema({ version: 1, collections: { todos: { fields: { title: t.string(), userId: t.string() } } } })
const authClient = createKoraAuth({ serverUrl: 'https://acme.example.com' })
declare const secureStore: AuthKeyValueStorage
declare const deviceKeyStore: DeviceKeyStore
declare const url: string
declare const code: string
declare const state: string
declare function openSystemBrowser(url: string): Promise<void>
declare function Spinner(): JSX.Element
declare function SignIn(): JSX.Element
declare function AuthenticatedApp(): JSX.Element
-->

## Encrypted Token Storage

By default, `AuthClient` stores tokens in plaintext `localStorage`. While convenient, this is vulnerable to XSS attacks since any JavaScript running on the page can read the tokens. `EncryptedTokenStore` encrypts tokens with AES-256-GCM before writing them to storage.

### Setup

```typescript
import { EncryptedTokenStore, deriveEncryptionKey, generateSalt } from '@korajs/auth'

// Option A: Derive a key from a user passphrase
const salt = generateSalt() // store this alongside the user's account
const { key: passphraseKey } = await deriveEncryptionKey('user-passphrase', salt)

// Option B: Use a randomly generated key
import { generateEncryptionKey } from '@korajs/auth'
const randomKey = await generateEncryptionKey()

// Create the encrypted store
export const encryptedStore = new EncryptedTokenStore({
  key: passphraseKey, // or randomKey
  // storageKey: 'my_app_encrypted_tokens',  // optional custom key
})
```

### Usage

<!-- docs-check: continue -->
```typescript
// After login: encrypt and save tokens
await encryptedStore.saveTokens({
  accessToken: 'eyJhbG...',
  refreshToken: 'eyJhbG...',
})

// Before API calls: decrypt and retrieve
const accessToken = await encryptedStore.getAccessToken()
const refreshToken = await encryptedStore.getRefreshToken()

// Load both tokens at once
const tokens = await encryptedStore.loadTokens()
// tokens: { accessToken, refreshToken } or null

// On logout: clear encrypted data
encryptedStore.clearTokens()
```

The stored format in `localStorage` is a JSON object with two base64url-encoded fields: `iv` (the 12-byte initialization vector) and `data` (the AES-256-GCM ciphertext). Without the encryption key, the tokens are unreadable.

`loadTokens()` returns `null` (instead of throwing) if decryption fails for any reason: wrong key, tampered data, or missing tokens. This fail-silent design allows graceful fallback to re-authentication.

---

<!-- docs-check-prelude
import {
  BuiltInAuthRoutes,
  EmailVerificationManager,
  OrgRoutes,
  PasswordResetManager,
  RbacEngine,
  SessionManager,
  TokenManager,
  TotpManager,
} from '@korajs/auth/server'
import type { OrgStore, UserStore } from '@korajs/auth/server'
// An Express-style router; req and res are your framework's.
// biome-ignore lint: documentation scaffolding
type Handler = (req: any, res: any, next: () => void) => unknown
declare const app: {
  get(path: string, ...handlers: Handler[]): void
  post(path: string, ...handlers: Handler[]): void
  patch(path: string, ...handlers: Handler[]): void
  delete(path: string, ...handlers: Handler[]): void
}
declare const userStore: UserStore
declare const orgStore: OrgStore
declare const tokenManager: TokenManager
declare const authRoutes: BuiltInAuthRoutes
declare const sessions: SessionManager
declare const totp: TotpManager
declare const orgRoutes: OrgRoutes
declare const rbac: RbacEngine
declare const emailVerifier: EmailVerificationManager
declare const passwordReset: PasswordResetManager
declare const userId: string
declare const orgId: string
declare const code: string
declare const sessionId: string
declare const currentSessionId: string
declare function sendVerificationEmail(email: string, link: string): Promise<void>
declare function sendPasswordResetEmail(email: string, link: string): Promise<void>
declare function storePasskeyCredential(userId: string, credential: unknown): Promise<void>
declare function getUserCredentialIds(email: string): Promise<string[]>
declare function getStoredCredential(credentialId: string): Promise<{ userId: string; publicKey: string; signCount: number }>
declare function updateSignCount(credentialId: string, signCount: number): Promise<void>
-->

## Security Considerations

### Password Hashing

Passwords are hashed using PBKDF2-SHA512 with 600,000 iterations and a 32-byte random salt. This follows OWASP recommendations for password storage.

### Token Security

- **Access tokens** expire in 15 minutes by default (configurable). They are signed with HMAC-SHA256.
- **Refresh tokens** expire in 90 days by default with token rotation: each refresh request issues a new refresh token and invalidates the old one.
- All tokens include a unique `jti` (JWT ID) for individual revocation.
- Signature comparison uses constant-time algorithms to prevent timing attacks.

### Key Rotation

The `TokenManager` supports key rotation via an array of secrets:

```typescript
const rotatingTokenManager = new TokenManager({
  secret: [process.env.NEW_SECRET ?? '', process.env.OLD_SECRET ?? ''], // index 0 = signing key
  // Old tokens signed with the old secret are still valid for verification
})
```

To rotate: add the new secret at index 0, then remove the old secret after all tokens signed with it have expired (at most 90 days for refresh tokens).

### Rate Limiting

The `InMemoryRateLimiter` implements a sliding-window rate limiter (default: 10 attempts per 60 seconds). Sign-in has two independent budgets: one per account (rotating source IPs cannot buy unlimited guesses against one user) and one per client IP (one client cannot spray many accounts). A successful sign-in clears that account's budget. Sign-in always runs the password KDF, also for unknown emails, so response time does not reveal whether an account exists. The client IP comes from the socket or from proxies listed in `trustProxy`, never from a raw header.

For production multi-server deployments, implement the `RateLimiter` interface with a Redis-backed store.

### Revocation

When a device is revoked (`handleRevokeDevice()`), or every credential of a user
(`authServer.revokeAllForUser(userId)`, `AdminApi`, `onPasswordChanged`):
1. The device (or user) is marked revoked, with a cut-off time in the revocation store
2. Every route and the sync auth provider refuse its tokens at once through the same `authenticateAccess` check, even before they expire, also on other server instances that share the stores
3. Live sync sessions end immediately on this instance (the provider's `onRevoke` feed) and within `sessionRevalidationIntervalMs` (30 s) on others; a narrowed scope ends sessions with `SCOPE_CHANGED`
4. Refresh-token rotation is atomic and safe across tabs: a reused refresh token is refused after a short grace period (`DEFAULT_REFRESH_REUSE_GRACE_MS`)

Custom `TokenRevocationStore` implementations must provide `consume`, `isConsumed` and the revocation cut-offs.

### Challenge Security

Device proof-of-possession challenges are:
- Generated with 32 bytes of cryptographic randomness
- Stored server-side with a 60-second TTL
- Single-use (consumed on first verification attempt)
- Bound to a specific device ID (prevents cross-device replay)

### Production Checklist

- [ ] Use a persistent user store (`createSqliteUserStore` / `createPostgresUserStore`; production refuses in-memory stores unless `allowInMemory`)
- [ ] Use a persistent token revocation store (the SQLite and Postgres user stores include one)
- [ ] Use a persistent session store (not `InMemorySessionStore`)
- [ ] Use a persistent TOTP store (not `InMemoryTotpStore`)
- [ ] Set `KORA_AUTH_SECRET` as an environment variable (at least 32 characters)
- [ ] Set `trustProxy` on the production server when it runs behind a proxy
- [ ] Wire `onPasswordChanged: authServer.revokeAllForUser` and the `AdminApi` `revokeAllForUser`
- [ ] Serve all auth endpoints over HTTPS
- [ ] Implement the `RateLimiter` interface with Redis for multi-server deployments
- [ ] Configure `onResetRequested` and `onVerificationRequired` callbacks for production email delivery
- [ ] Set appropriate CORS headers on auth endpoints
- [ ] Consider using `EncryptedTokenStore` for sensitive environments
- [ ] Periodically call `cleanExpired()` on session and token stores to prevent unbounded memory growth
<!-- docs-check-prelude
import { AuthBoundKoraProvider } from '@korajs/react'
import { createKoraAuth, createKoraAuthSync } from '@korajs/auth'
import { createApp, defineSchema, t } from 'korajs'
const schema = defineSchema({ version: 1, collections: { todos: { fields: { title: t.string() } } } })
const authClient = createKoraAuth({ serverUrl: 'https://acme.example.com' })
const binding = createKoraAuthSync({ authClient, schema })
const app = createApp({ schema, sync: { url: 'wss://sync.example.com/kora-sync', authClient: binding } })
declare const url: string
declare function SignIn(): JSX.Element
declare function AuthenticatedApp(): JSX.Element
-->

## Authenticated app lifecycle

Authenticated sync is suspended while auth is loading or signed out. `createKoraAuthSync()`
uses `anonymous: 'suspend'` by default, so a sign-in screen opens no WebSocket and schedules
no reconnect. Opt into anonymous replication only with `anonymous: 'allow'` and a server
configured with `MixedAuthProvider`.

On shared browsers, bind the whole app lifetime to the authenticated user:

```tsx
const lifecycle = (
  <AuthBoundKoraProvider
    authClient={binding}
    createApp={() =>
      createApp({
        schema,
        store: { name: 'acme', namespaceByAuthUser: true },
        sync: { url, authClient: binding, autoConnect: true },
      })
    }
    signedOut={<SignIn />}
  >
    <AuthenticatedApp />
  </AuthBoundKoraProvider>
)
```

`createApp` receives the authenticated session (`userId`), `locked` renders while the session
is locked, and `error` renders initialization failures with a `retry()`.

The host waits for initial auth restoration, removes the old provider tree, closes the old
app, and only then creates the next user's app. A refresh or scope change for the same user
keeps the app and store. `app.storeInfo()` exposes the active database identity and durability
without providing access to any other user's data. `app.close()` remains the teardown boundary.

## Writes belong to the signed-in user

### Held writes

With `sync.authClient`, Kora binds every local write to the user who is signed in when it is
made, even when several users share one local database (`namespaceByAuthUser` off, the default):

- At start, and on every auth change the binding reports, the store moves to that user's own
  sync node (creating one the first time), before the next local write.
- A node that belongs to another user is never uploaded, adopted or re-authored on this user's
  session. Its unsynced writes wait for their user and are reported in
  `useSyncStatus().heldOperations`, not in `pendingOperations`. They upload, as that user, when
  they sign in again on this device.
- A database that never synced does not hand one user's offline writes to the next user.
- A node whose owner was never recorded (a database created before this release, or writes
  made while nobody was signed in) is never given to whoever signs in first. Kora learns its
  owner from the sync server instead:
  - If the node synced before, the server holds a claim on it. Kora tries it once on each
    signed-in user's session: the user the server accepts it for owns it from then on, and its
    writes upload as them; a user the server refuses is never tried again for it.
  - If the node never synced, nobody can tell whose its writes are. They are held, reported in
    `status.heldNodes` with reason `unassigned`, until the app decides:

    ```typescript
    for (const node of (await app.sync?.getHeldOperations()) ?? []) {
      if (node.reason !== 'unassigned') continue
      // A single-user device, or after asking the user:
      await app.sync?.assignHeld(node.nodeId, 'current-user')
      // Or never upload them (they stay in this device's local database only):
      // await app.sync?.discardHeld(node.nodeId)
    }
    ```

    Only `unassigned` writes can be assigned or discarded; writes held for another user
    (reason `other-user`) wait for that user.

    A single-user app, where writes made before sign-in can only belong to the user who
    signs in, can skip that decision with one line:

    ```typescript
    createApp({
      schema,
      sync: {
        url: 'wss://sync.example.com/kora-sync',
        authClient: binding,
        // Default 'hold': wait for app.sync.assignHeld / discardHeld.
        unassignedWrites: 'assign-to-first-user',
      },
    })
    ```

    The writes are then assigned to the first user the sync server accepts a session for on
    this device, and upload as that user. A user the server refuses never gets them, and
    writes held for another user (`other-user`) are never reassigned. Keep the default in apps
    where several people can use the same browser profile.
- The binding moves to the new user as soon as the auth binding reports the change, even while
  an earlier reconnect is still fetching a credential or connecting. That attempt re-checks the
  signed-in user before its handshake and starts over if it changed, so a node is never
  presented with another user's credential.

What this does not cover:

- Writes issued in the same instant as a sign-in, before the auth binding reports the new user
  and the store has moved to their node (one local database round trip), are still authored
  under the previous user's node (and wait for that user). Use `AuthBoundKoraProvider`, which
  creates the app only after auth resolves, when this matters.
- A node id pinned by the auth device id (`resolveNodeId`) cannot move: if another user signs
  in on an app created for a different user, sync is suspended with reason
  `node-owned-by-another-user` instead of uploading. Recreate the app for the new user.
- Apps that pass only a `sync.auth` token function do not tell Kora who is signed in, so Kora
  cannot tell two users' unsynced writes apart. The server still refuses another user's node,
  and those writes are held for the user who first synced it.

`namespaceByAuthUser` stays off by default. Turning it on gives each user a separate local
database, which also keeps their rows apart on the device; turning it on for an existing app
makes the data in the shared database invisible until it is migrated, so it is not enabled
implicitly.
