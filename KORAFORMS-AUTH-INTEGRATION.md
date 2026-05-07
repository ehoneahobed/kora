# KoraForms Auth Integration Plan

This document describes how to integrate `@korajs/auth` into KoraForms once the auth package is published.

## Prerequisites

1. `@korajs/auth` published to npm (or linked locally via `pnpm link`)
2. KoraForms sync server running (already exists at `packages/server`)

## Integration Steps

### Step 1: Install Dependencies

```bash
cd koraforms
pnpm add @korajs/auth
```

### Step 2: Add Auth Routes to Sync Server

In the KoraForms server entry point, wire the auth routes alongside the existing sync server:

```typescript
import { BuiltInAuthRoutes, InMemoryUserStore, TokenManager } from '@korajs/auth/server'

const userStore = new InMemoryUserStore()
const tokenManager = new TokenManager({
  secret: process.env.KORA_AUTH_SECRET || 'dev-secret-change-in-production',
})
const authRoutes = new BuiltInAuthRoutes({ userStore, tokenManager })

// Add auth endpoints to Express/Hono/etc:
// POST /auth/signup
// POST /auth/signin
// POST /auth/refresh
// GET  /auth/me

// Bridge to sync server for authenticated sync:
const syncServer = new KoraSyncServer({
  store,
  auth: authRoutes.toSyncAuthProvider(),
})
```

**Production note:** Replace `InMemoryUserStore` with a database-backed store (SQLite/Postgres) for persistence across server restarts.

### Step 3: Add AuthClient to Frontend

```typescript
// src/auth.ts
import { AuthClient } from '@korajs/auth'

export const authClient = new AuthClient({
  serverUrl: import.meta.env.VITE_API_URL || 'http://localhost:3001',
})
```

### Step 4: Wrap App with AuthProvider

```tsx
// src/main.tsx
import { AuthProvider } from '@korajs/auth/react'
import { authClient } from './auth'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <AuthProvider client={authClient}>
    <App />
  </AuthProvider>
)
```

### Step 5: Add Login/Register Pages

Create `src/pages/Login.tsx` and `src/pages/Register.tsx` using the `useAuth()` hook:

```tsx
import { useAuth } from '@korajs/auth/react'

function LoginPage() {
  const { signIn, error, isLoading } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  return (
    <form onSubmit={async (e) => {
      e.preventDefault()
      await signIn({ email, password })
    }}>
      {error && <p className="text-red-500">{error}</p>}
      <input value={email} onChange={(e) => setEmail(e.target.value)} />
      <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <button type="submit" disabled={isLoading}>Sign In</button>
    </form>
  )
}
```

### Step 6: Protect Routes

Use `useAuthStatus()` for route protection:

```tsx
import { useAuthStatus } from '@korajs/auth/react'

function ProtectedRoute({ children }) {
  const { isAuthenticated, isLoading } = useAuthStatus()

  if (isLoading) return <Spinner />
  if (!isAuthenticated) return <Navigate to="/login" />
  return children
}
```

### Step 7: Wire Auth Token to Sync

Pass the auth client's `getSyncToken()` to the Kora sync configuration:

```typescript
const app = createApp({
  schema,
  sync: {
    url: 'ws://localhost:3001/kora-sync',
    auth: async () => {
      const token = await authClient.getSyncToken()
      return token ? { token } : null
    },
  },
})
```

### Step 8: Update Schema for User Ownership

Add `userId` field to forms collection to scope forms per user:

```typescript
const schema = defineSchema({
  version: 3,
  collections: {
    forms: {
      fields: {
        // ... existing fields
        userId: t.string().optional(),  // Owner of the form
      }
    }
  }
})
```

## UI Changes

1. **Header**: Show user name/avatar when authenticated, login link when not
2. **Form list**: Filter by `userId` to show only the user's forms
3. **Form builder**: Automatically set `userId` on form creation
4. **Published forms**: Remain publicly accessible (no auth required to fill)
5. **Analytics**: Only show analytics for forms owned by the current user

## Timeline

| Task | Effort |
|------|--------|
| Server auth routes | 1-2 hours |
| Login/Register pages | 2-3 hours |
| Route protection | 1 hour |
| Sync token wiring | 30 min |
| User ownership (schema + filtering) | 2-3 hours |
| Testing | 2-3 hours |
| **Total** | **~1 day** |

## Future Enhancements

- Database-backed user store (replace InMemoryUserStore)
- Password reset flow
- Email verification
- OAuth providers (Google, GitHub)
- Team/workspace sharing
