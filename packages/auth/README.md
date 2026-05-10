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

The client APIs work in browser, Tauri desktop WebView, and mobile JavaScript environments. For desktop apps, run auth routes on your remote sync/auth server and point `AuthClient.serverUrl` at that server. Email/password auth, token refresh, sync authorization, MFA, organizations, and RBAC work across web and desktop clients. Passkeys should be feature-detected because WebAuthn support depends on the operating system WebView.

For production desktop and mobile apps, pass a custom token storage adapter backed by the platform credential store and attach a stable device identity:

```typescript
import { createKoraAuth } from '@korajs/auth'

const authClient = createKoraAuth({
  serverUrl: 'https://acme.example.com',
  credentialStore: secureStore,
  deviceKeyStore,
})
```

`createKoraAuth()` uses IndexedDB for the device key pair when available. React Native and other runtimes without IndexedDB should pass a platform-backed `deviceKeyStore`.

## Installation

```bash
pnpm add @korajs/auth
```

## Quick Start

### Client-side (React)

```tsx
import { createKoraAuth } from '@korajs/auth'
import { AuthProvider, useAuth } from '@korajs/auth/react'

const authClient = createKoraAuth({ serverUrl: 'http://localhost:3001' })

function App() {
  return (
    <AuthProvider client={authClient}>
      <MyApp />
    </AuthProvider>
  )
}

function MyApp() {
  const { user, isAuthenticated, isLoading, signIn, signInWithOAuth, signOut, error } = useAuth()

  if (isLoading) return <div>Loading...</div>

  if (!isAuthenticated) {
    return (
      <>
        <button onClick={() => signIn({ email: 'user@example.com', password: 'password' })}>
          Sign In
        </button>
        <button onClick={() => signInWithOAuth('google')}>
          Sign In with Google
        </button>
      </>
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
import {
  createKoraAuthServer,
  createSqliteOAuthStores,
  googleProvider,
} from '@korajs/auth/server'

const oauthStores = await createSqliteOAuthStores({
  filename: './auth.db',
})

const auth = createKoraAuthServer({
  jwtSecret: process.env.KORA_AUTH_SECRET!,
  oauth: {
    providers: [
      googleProvider({
        clientId: process.env.GOOGLE_CLIENT_ID!,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
        redirectUri: 'https://app.example.com/auth/oauth/google/callback',
      }),
    ],
    stateStore: oauthStores.stateStore,
    linkedIdentityStore: oauthStores.linkedIdentityStore,
  },
})

// Wire into your HTTP server:
app.all('/auth/*', async (req, res) => {
  const result = await auth.handleRequest({
    method: req.method,
    path: req.path,
    body: req.body,
    headers: req.headers,
    query: req.query,
    ip: req.ip,
  })
  res.status(result.status).json(result.body)
})

// Bridge to Kora sync server:
const syncServer = new KoraSyncServer({
  store,
  auth: auth.auth,
})
```

## Exports

### `@korajs/auth` (client entry)

| Export | Description |
|--------|-------------|
| `createKoraAuth` | Quickstart client factory with storage and device identity defaults |
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
| `createKoraAuthServer` | Quickstart server factory with auth routes and sync provider |
| `BuiltInAuthRoutes` | HTTP route handlers for all auth operations |
| `TokenManager` | JWT issuing, validation, refresh rotation, revocation |
| `InMemoryUserStore` | Dev/test user store |
| `InMemoryTokenRevocationStore` | Dev/test token revocation store |
| `OAuthManager` / provider helpers | OAuth authorization code flow and provider configs |
| `InMemoryLinkedIdentityStore` | Dev/test OAuth account-linking store |
| `createSqliteOAuthStores` / `createPostgresOAuthStores` | Durable OAuth state and linked identity stores |
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
