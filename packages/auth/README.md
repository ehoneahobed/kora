# @korajs/auth

Offline-first authentication for Kora.js applications.

## Overview

`@korajs/auth` provides a complete authentication system designed for offline-first applications. It includes:

- **Client-side auth management** — token storage, session restoration, sign-up/sign-in/sign-out
- **React hooks** — `useAuth()`, `useCurrentUser()`, `useAuthStatus()` for reactive auth state
- **Server-side auth routes** — email/password authentication with JWT tokens
- **Device identity** — ECDSA P-256 key pairs for proof-of-possession
- **Token management** — access/refresh token lifecycle with rotation

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
| `AuthClient` | Client-side auth manager |
| `TokenStore` | Client-side token persistence |
| `generateDeviceKeyPair` | ECDSA P-256 key pair generation |
| `exportPublicKeyJwk` | Export public key as JWK |
| `signChallenge` | Sign challenge with device key |
| `verifyChallenge` | Verify challenge signature |
| `computePublicKeyThumbprint` | RFC 7638 JWK thumbprint |

### `@korajs/auth/react`

| Export | Description |
|--------|-------------|
| `AuthProvider` | React context provider |
| `useAuth` | Full auth hook (user, methods, error) |
| `useCurrentUser` | Lightweight current user hook |
| `useAuthStatus` | Auth status for route guards |

### `@korajs/auth/server`

| Export | Description |
|--------|-------------|
| `BuiltInAuthRoutes` | HTTP route handlers |
| `TokenManager` | JWT issuing/validation |
| `InMemoryUserStore` | Dev/test user store |
| `BuiltInProvider` | Adapter wrapping routes |
| `hashPassword` / `verifyPassword` | PBKDF2 password hashing |
| `encodeJwt` / `verifyJwt` | Low-level JWT operations |

## Security

- Passwords hashed with PBKDF2-SHA512 (600,000 iterations, 32-byte salt)
- JWT tokens signed with HMAC-SHA256
- Constant-time signature comparison (prevents timing attacks)
- Device keys use ECDSA P-256 with non-extractable private keys
- Refresh token rotation on each use
- Access tokens expire in 15 minutes (configurable)

## Architecture

```
Client                                Server
┌──────────────────┐                 ┌──────────────────┐
│   AuthClient     │                 │ BuiltInAuthRoutes│
│   ├─ TokenStore  │ ──── HTTP ────> │ ├─ UserStore     │
│   └─ AuthState   │                 │ ├─ TokenManager  │
│                  │                 │ └─ PasswordHash  │
│   React Hooks    │                 │                  │
│   ├─ useAuth     │                 │ SyncAuthProvider │
│   ├─ useCurrentUser                │ └─ authenticate()│
│   └─ useAuthStatus                 └──────────────────┘
└──────────────────┘
```
