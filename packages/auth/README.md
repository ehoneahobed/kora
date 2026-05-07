# @korajs/auth

Offline-first authentication for Kora.js applications.

## Overview

`@korajs/auth` provides a complete authentication system designed for offline-first applications. It includes:

- **Client-side auth management** -- token storage, session restoration, sign-up/sign-in/sign-out
- **React hooks** -- `useAuth()`, `useCurrentUser()`, `useAuthStatus()`, `useOrg()`, `usePermission()`
- **Server-side auth routes** -- email/password authentication with JWT tokens
- **Device identity** -- ECDSA P-256 key pairs for proof-of-possession
- **Token management** -- access/refresh token lifecycle with rotation and revocation detection
- **Session management** -- server-side sessions with idle timeout, max limits, and MFA awareness
- **Multi-factor authentication** -- TOTP (authenticator apps) with recovery codes
- **Organizations and RBAC** -- multi-tenant orgs with role hierarchy and permission checks
- **Passkeys (WebAuthn)** -- passwordless authentication with platform authenticators
- **Encrypted token storage** -- AES-256-GCM encryption for sensitive environments
- **End-to-end encryption** -- encrypt operation data before sync with `OperationEncryptor`

## Installation

```bash
pnpm add @korajs/auth
```

## Quick Start

### Client-side (React)

```tsx
import { AuthClient } from '@korajs/auth'
import { AuthProvider, useAuth } from '@korajs/auth/react'

const authClient = new AuthClient({ serverUrl: 'http://localhost:3001' })

function App() {
  return (
    <AuthProvider client={authClient}>
      <MyApp />
    </AuthProvider>
  )
}

function MyApp() {
  const { user, isAuthenticated, isLoading, signIn, signOut, error } = useAuth()

  if (isLoading) return <div>Loading...</div>

  if (!isAuthenticated) {
    return (
      <button onClick={() => signIn({ email: 'user@example.com', password: 'password' })}>
        Sign In
      </button>
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

### Server-side

```typescript
import { BuiltInAuthRoutes, InMemoryUserStore, TokenManager } from '@korajs/auth/server'

const userStore = new InMemoryUserStore()
const tokenManager = new TokenManager({ secret: process.env.AUTH_SECRET! })
const authRoutes = new BuiltInAuthRoutes({ userStore, tokenManager })

// Wire into your HTTP server:
app.post('/auth/signup', async (req, res) => {
  const result = await authRoutes.handleSignUp(req.body)
  res.status(result.status).json(result.body)
})

app.post('/auth/signin', async (req, res) => {
  const result = await authRoutes.handleSignIn(req.body)
  res.status(result.status).json(result.body)
})

app.post('/auth/refresh', async (req, res) => {
  const result = await authRoutes.handleRefresh(req.body)
  res.status(result.status).json(result.body)
})

app.get('/auth/me', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '') ?? ''
  const result = await authRoutes.handleGetMe(token)
  res.status(result.status).json(result.body)
})

// Bridge to Kora sync server:
const syncServer = new KoraSyncServer({
  store,
  auth: authRoutes.toSyncAuthProvider(),
})
```

## Exports

### `@korajs/auth` (client entry)

| Export | Description |
|--------|-------------|
| `AuthClient` | Client-side auth manager (sign-up, sign-in, sign-out, token refresh) |
| `OrgClient` | Client-side organization management |
| `TokenStore` | Client-side token persistence (localStorage) |
| `EncryptedTokenStore` | AES-256-GCM encrypted token persistence |
| `generateDeviceKeyPair` | ECDSA P-256 key pair generation |
| `exportPublicKeyJwk` | Export public key as JWK |
| `signChallenge` / `verifyChallenge` | Device proof-of-possession |
| `computePublicKeyThumbprint` | RFC 7638 JWK thumbprint |
| `isPasskeySupported` | Check WebAuthn availability |
| `createPasskeyCredential` | Register a new passkey |
| `authenticateWithPasskey` | Sign in with a passkey |
| `encryptData` / `decryptData` | AES-256-GCM data encryption |
| `OperationEncryptor` | E2E encryption for sync operations |
| `AutoLockManager` | Auto-lock encryption keys after idle timeout |

### `@korajs/auth/react`

| Export | Description |
|--------|-------------|
| `AuthProvider` | React context provider |
| `useAuth` | Full auth hook (user, methods, error, loading) |
| `useCurrentUser` | Lightweight current user hook |
| `useAuthStatus` | Auth status for route guards |
| `useOrg` | Organization context and switching |
| `useOrgMembers` | Org member listing |
| `usePermission` | RBAC permission check hook |

### `@korajs/auth/server`

| Export | Description |
|--------|-------------|
| `BuiltInAuthRoutes` | HTTP route handlers for all auth operations |
| `TokenManager` | JWT issuing, validation, refresh rotation, revocation |
| `InMemoryUserStore` | Dev/test user store |
| `InMemoryTokenRevocationStore` | Dev/test token revocation store |
| `SessionManager` / `InMemorySessionStore` | Server-side session management |
| `TotpManager` / `InMemoryTotpStore` | TOTP MFA with recovery codes |
| `OrgRoutes` / `InMemoryOrgStore` | Organization CRUD, invitations, member management |
| `RbacEngine` / `defineRoles` | Role-based access control with permission hierarchy |
| `OrgScopeResolver` | Generate sync scope filters from org membership |
| `EmailVerificationManager` | Email verification token flow |
| `PasswordResetManager` | Password reset and change flows |
| `hashPassword` / `verifyPassword` | PBKDF2-SHA512 password hashing |
| `encodeJwt` / `verifyJwt` | Low-level JWT operations |

## Security

- Passwords hashed with PBKDF2-SHA512 (600,000 iterations, 32-byte salt)
- JWT tokens signed with HMAC-SHA256 with constant-time comparison
- Refresh token rotation with replay detection and device-level revocation
- Device keys use ECDSA P-256 with non-extractable private keys (Web Crypto)
- TOTP uses SHA-1 HMAC per RFC 6238 with 30-second time steps
- Access tokens expire in 15 minutes (configurable), refresh tokens in 7 days
- Session idle timeout with sliding window and configurable max concurrent sessions
- Passkeys use WebAuthn L2 with platform authenticator support
- Encrypted token store uses AES-256-GCM with PBKDF2-derived keys

## Architecture

```
Client                                 Server
┌────────────────────┐                ┌────────────────────────┐
│ AuthClient         │                │ BuiltInAuthRoutes      │
│ ├─ TokenStore      │                │ ├─ UserStore           │
│ ├─ EncryptedStore  │  ── HTTP ───>  │ ├─ TokenManager        │
│ ├─ OrgClient       │                │ ├─ SessionManager      │
│ └─ DeviceKeyStore  │                │ ├─ TotpManager         │
│                    │                │ ├─ OrgRoutes           │
│ React Hooks        │                │ ├─ RbacEngine          │
│ ├─ useAuth         │                │ └─ PasswordResetMgr    │
│ ├─ useOrg          │                │                        │
│ └─ usePermission   │                │ SyncAuthProvider       │
│                    │                │ └─ authenticate()      │
│ Passkeys           │                │ └─ OrgScopeResolver    │
│ └─ WebAuthn API    │                └────────────────────────┘
└────────────────────┘
```

## Documentation

See the [Authentication Guide](https://ehoneahobed.github.io/kora/guide/authentication) and [Auth API Reference](https://ehoneahobed.github.io/kora/api/auth) for complete documentation.

## License

MIT
