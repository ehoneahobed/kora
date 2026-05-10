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

## Quick Start: Server-Side Setup

Install the auth package:

```bash
pnpm add @korajs/auth
```

Set up the three core server components: a user store, a token manager, and the auth routes.

```typescript
// server.ts
import {
  BuiltInAuthRoutes,
  InMemoryUserStore,
  TokenManager,
  InMemoryTokenRevocationStore,
} from '@korajs/auth/server'

// 1. User store — holds user accounts and device registrations
const userStore = new InMemoryUserStore()

// 2. Token manager — issues and validates JWTs
const tokenManager = new TokenManager({
  secret: process.env.AUTH_SECRET!,     // At least 32 characters
  revocationStore: new InMemoryTokenRevocationStore(),
  // Defaults: accessTokenLifetime = 15 min, refreshTokenLifetime = 90 days
})

// 3. Auth routes — framework-agnostic HTTP handlers
const authRoutes = new BuiltInAuthRoutes({ userStore, tokenManager })
```

::: tip Generating a secret
Use `TokenManager.generateSecret()` to create a cryptographically random 256-bit secret. Store it in an environment variable, never in source code.
:::

Wire the route handlers into your HTTP server. The handlers accept parsed request bodies and return `{ status, body }` response objects:

```typescript
// Express example
import express from 'express'

const app = express()
app.use(express.json())

app.post('/auth/signup', async (req, res) => {
  const result = await authRoutes.handleSignUp(req.body, req.ip)
  res.status(result.status).json(result.body)
})

app.post('/auth/signin', async (req, res) => {
  const result = await authRoutes.handleSignIn(req.body, req.ip)
  res.status(result.status).json(result.body)
})

app.post('/auth/refresh', async (req, res) => {
  const result = await authRoutes.handleRefresh(req.body)
  res.status(result.status).json(result.body)
})

app.post('/auth/signout', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '') ?? ''
  const result = await authRoutes.handleSignOut(token, req.body)
  res.status(result.status).json(result.body)
})

app.get('/auth/me', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '') ?? ''
  const result = await authRoutes.handleGetMe(token)
  res.status(result.status).json(result.body)
})

app.listen(3001, () => console.log('Auth server on :3001'))
```

The `handleSignUp` and `handleSignIn` methods accept an optional `clientIp` parameter for per-IP rate limiting. Pass `req.ip` (or your reverse proxy's real IP header) for best protection against brute-force attacks.

---

## Quick Start: Client-Side Setup

Create an `AuthClient` instance and wrap your React app with `AuthProvider`:

```typescript
// auth.ts
import { AuthClient } from '@korajs/auth'

export const authClient = new AuthClient({
  serverUrl: 'http://localhost:3001',
  // storageKey: 'my_app_auth',  // optional prefix for localStorage keys
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
  const { user, isAuthenticated, isLoading, signIn, signUp, signOut, error } = useAuth()

  if (isLoading) return <div>Restoring session...</div>

  if (!isAuthenticated) {
    return (
      <div>
        <h1>Sign In</h1>
        {error && <p style={{ color: 'red' }}>{error}</p>}
        <button onClick={() => signIn({ email: 'alice@example.com', password: 'secret123' })}>
          Sign In
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

The `AuthProvider` calls `authClient.initialize()` on mount, which restores any existing session from stored tokens. If the access token has expired, it automatically refreshes using the stored refresh token. This means returning users are signed in without any action.

### React Hooks Reference

| Hook | Purpose |
|------|---------|
| `useAuth()` | Full auth: `user`, `isAuthenticated`, `isLoading`, `signIn`, `signUp`, `signOut`, `error` |
| `useCurrentUser()` | Lightweight alternative returning just the `AuthUser` or `null` |
| `useAuthStatus()` | Returns `{ state, isAuthenticated, isLoading }` for route guards |

All hooks use `useSyncExternalStore` under the hood for React 18+ concurrent mode safety.

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

The `BuiltInAuthRoutes` class provides a `toSyncAuthProvider()` method that bridges authentication with the Kora sync server. This method returns an object implementing the `AuthProvider` interface expected by `@korajs/server`.

```typescript
import { createProductionServer, createSqliteServerStore } from '@korajs/server'

const store = createSqliteServerStore({ filename: './kora.db' })

const syncServer = createProductionServer({
  store,
  port: 3001,
  staticDir: './dist',
  syncPath: '/kora-sync',
  syncOptions: {
    auth: authRoutes.toSyncAuthProvider(),
  },
})
```

The sync auth provider:
- Validates the access token on every WebSocket connection
- Verifies that the user still exists in the user store
- Checks device revocation status (revoked devices are rejected even if their tokens have not expired)
- Updates the device's `lastSeenAt` timestamp on each connection

On the client side, pass the auth client's token getter to the sync configuration:

```typescript
import { createApp } from 'korajs'
import { authClient } from './auth'

const app = createApp({
  schema,
  sync: {
    url: 'wss://my-server.com/kora-sync',
    auth: async () => {
      const token = await authClient.getAccessToken()
      return token ? { token } : {}
    },
  },
})
```

The `getAccessToken()` method automatically refreshes an expired access token before returning it, so the sync engine always receives a valid token.

### Desktop and Tauri apps

`@korajs/auth` works in desktop apps built with the Kora Tauri template. A Tauri app runs the Kora frontend inside a WebView, so the auth client can use the same `AuthClient`, React hooks, `fetch`, and sync-token flow used by web apps.

The normal desktop setup is:

1. Deploy a remote sync/auth server.
2. Add the auth HTTP routes to that server.
3. Create `AuthClient` in the Tauri frontend with the same server origin.
4. Pass `authClient.getAccessToken()` to `createApp({ sync: { auth } })`.

```typescript
const authClient = new AuthClient({
  serverUrl: 'https://acme.example.com',
})

const app = createApp({
  schema,
  sync: {
    url: 'wss://acme.example.com/kora-sync',
    auth: async () => ({
      token: (await authClient.getAccessToken()) ?? '',
    }),
  },
})
```

Email/password auth, token refresh, sync authorization, MFA, organizations, and RBAC all use HTTP plus WebSocket tokens and apply to web and desktop clients the same way. Passkeys depend on WebAuthn support in the platform WebView and should be feature-detected with `isPasskeySupported()`. OAuth works too, but desktop apps need an explicit redirect strategy such as a loopback callback, custom URL scheme, or hosted web sign-in that returns control to the app.

### Secure token storage for desktop and mobile

By default, `AuthClient` uses browser `localStorage` when it is available and falls back to memory storage when it is not. That is convenient for development and web apps, but desktop and mobile production apps should pass a storage adapter backed by the platform credential store.

```typescript
const authClient = new AuthClient({
  serverUrl: 'https://acme.example.com',
  storage: {
    getAccessToken: () => secureStore.getItem('kora_access_token'),
    getRefreshToken: () => secureStore.getItem('kora_refresh_token'),
    setTokens: async (accessToken, refreshToken) => {
      await secureStore.setItem('kora_access_token', accessToken)
      await secureStore.setItem('kora_refresh_token', refreshToken)
    },
    clear: async () => {
      await secureStore.removeItem('kora_access_token')
      await secureStore.removeItem('kora_refresh_token')
    },
  },
})
```

Use Tauri secure storage on desktop, Expo SecureStore or React Native Keychain on mobile, and iOS Keychain or Android Keystore for native integrations. The adapter may be synchronous or asynchronous.

When your app has a stable local device identity, pass it during sign-up or sign-in so the server can bind tokens to that device:

```typescript
await authClient.signIn({
  email: 'alice@example.com',
  password: 'correct-horse-battery-staple',
  deviceId,
  devicePublicKey,
})
```

### Mixed Auth (Authenticated + Anonymous)

If your app needs both authenticated and anonymous sync (e.g., signed-in users create forms, anyone can submit responses), use `MixedAuthProvider`:

```typescript
import { MixedAuthProvider } from '@korajs/server'

const syncServer = new KoraSyncServer({
  store,
  auth: new MixedAuthProvider({
    primary: authRoutes.toSyncAuthProvider(),
    anonymousScopes: {
      responses: {},  // anonymous users can only sync 'responses'
    },
  }),
})
```

On the client, return an empty token for unauthenticated users:

```typescript
sync: {
  auth: async () => ({
    token: (await authClient.getAccessToken()) ?? '',
  }),
}
```

See the [Common Patterns guide](/guide/common-patterns#anonymous-public-data-access) for a full walkthrough.

---

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

The `requestReset` method always returns HTTP 200 regardless of whether the email exists. This prevents attackers from using the reset endpoint to enumerate registered email addresses.

---

## Device Identity

Kora uses ECDSA P-256 key pairs to establish device identity. Each device generates a non-extractable private key that stays in the browser and a public key that is registered with the server. This enables proof-of-possession verification: the server can confirm that a request genuinely comes from a specific device.

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
const publicKeyJwk = await exportPublicKeyJwk(keyPair.publicKey)
const publicKeyJson = JSON.stringify(publicKeyJwk)

// Compute the SHA-256 thumbprint (RFC 7638) for unique device identification
const thumbprint = await computePublicKeyThumbprint(publicKeyJwk)
```

### Client: Persistent Device Key Storage

Device keys must survive page refreshes. Use the `DeviceKeyStore`:

```typescript
import { createDeviceKeyStore } from '@korajs/auth'

// Uses IndexedDB by default, falls back to in-memory
const deviceKeyStore = createDeviceKeyStore()

// Save after generation
await deviceKeyStore.save('my-device-id', keyPair)

// Load on subsequent visits
const storedKeyPair = await deviceKeyStore.load('my-device-id')
```

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

// Step 2: Client signs the challenge with the device private key
const signature = await signChallenge(keyPair.privateKey, challenge)

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
  if (authResult.status !== 200) {
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
async function requireSession(req, res, next) {
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
async function requireMfa(req, res, next) {
  try {
    await sessions.requireMfa(req.session.id)
    next()
  } catch {
    res.status(403).json({ error: 'MFA verification required.' })
  }
}

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
const revokedCount = await sessions.revokeAll(userId)

// Sign out other devices (keep current session)
const revokedCount = await sessions.revokeOthers(userId, currentSessionId)

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
const rbac = new RbacEngine(orgStore)

// Or define custom roles
const customRoles = defineRoles()
  .role('viewer', ['*:read'])
  .role('editor', ['todos:write', 'projects:write'], { inherits: ['viewer'] })
  .role('admin', ['org:manage-members', 'org:manage-settings'], { inherits: ['editor'] })
  .role('owner', ['*:*'])
  .build()

const rbac = new RbacEngine(orgStore, { roles: customRoles })
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
import { OrgContext, useOrg, useOrgMembers, usePermission } from '@korajs/auth/react'
import { OrgClient } from '@korajs/auth'

const orgClient = new OrgClient({
  serverUrl: 'http://localhost:3001',
  authClient,
})

function App() {
  return (
    <OrgContext.Provider value={{ client: orgClient }}>
      <OrgSwitcher />
    </OrgContext.Provider>
  )
}

function OrgSwitcher() {
  const { org, switchOrg, listOrgs, createOrg, error } = useOrg()

  // org?.name, org?.id, org?.slug
  // switchOrg(orgId), createOrg({ name, slug }), listOrgs()
}

function MembersList({ orgId }: { orgId: string }) {
  const { members, isLoading, invite, removeMember, updateRole } = useOrgMembers(orgId)

  // members: ClientMembership[]
  // invite(email, role), removeMember(userId), updateRole(userId, role)
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

## Encrypted Token Storage

By default, `AuthClient` stores tokens in plaintext `localStorage`. While convenient, this is vulnerable to XSS attacks since any JavaScript running on the page can read the tokens. `EncryptedTokenStore` encrypts tokens with AES-256-GCM before writing them to storage.

### Setup

```typescript
import { EncryptedTokenStore, deriveEncryptionKey, generateSalt } from '@korajs/auth'

// Option A: Derive a key from a user passphrase
const salt = generateSalt() // store this alongside the user's account
const { key } = await deriveEncryptionKey('user-passphrase', salt)

// Option B: Use a randomly generated key
import { generateEncryptionKey } from '@korajs/auth'
const key = await generateEncryptionKey()

// Create the encrypted store
const encryptedStore = new EncryptedTokenStore({
  key,
  // storageKey: 'my_app_encrypted_tokens',  // optional custom key
})
```

### Usage

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
const tokenManager = new TokenManager({
  secret: [newSecret, oldSecret], // index 0 = signing key
  // Old tokens signed with oldSecret are still valid for verification
})
```

To rotate: add the new secret at index 0, then remove the old secret after all tokens signed with it have expired (at most 90 days for refresh tokens).

### Rate Limiting

The `InMemoryRateLimiter` implements a sliding-window rate limiter (default: 10 attempts per 60 seconds). Sign-in uses a composite key of `email + IP` for per-account protection. Successful logins reset the rate limit counter.

For production multi-server deployments, implement the `RateLimiter` interface with a Redis-backed store.

### Device Revocation

When a device is revoked via `handleRevokeDevice()`:
1. The device is marked as revoked in the user store
2. All tokens issued to that device are invalidated in the revocation store
3. The sync auth provider rejects connections from revoked devices, even if their tokens have not expired

### Challenge Security

Device proof-of-possession challenges are:
- Generated with 32 bytes of cryptographic randomness
- Stored server-side with a 60-second TTL
- Single-use (consumed on first verification attempt)
- Bound to a specific device ID (prevents cross-device replay)

### Production Checklist

- [ ] Use a persistent user store (database-backed, not `InMemoryUserStore`)
- [ ] Use a persistent token revocation store (Redis or database, not `InMemoryTokenRevocationStore`)
- [ ] Use a persistent session store (not `InMemorySessionStore`)
- [ ] Use a persistent TOTP store (not `InMemoryTotpStore`)
- [ ] Set `AUTH_SECRET` as an environment variable (at least 32 characters)
- [ ] Serve all auth endpoints over HTTPS
- [ ] Implement the `RateLimiter` interface with Redis for multi-server deployments
- [ ] Configure `onResetRequested` and `onVerificationRequired` callbacks for production email delivery
- [ ] Set appropriate CORS headers on auth endpoints
- [ ] Consider using `EncryptedTokenStore` for sensitive environments
- [ ] Periodically call `cleanExpired()` on session and token stores to prevent unbounded memory growth
