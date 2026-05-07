# @korajs/auth — Implementation Plan

> Offline-first authentication that works whether the device is online, offline, or intermittently connected.

---

## Why Build This

Every existing auth solution (Clerk, Auth0, Firebase Auth, Supabase Auth) assumes connectivity for login, token refresh, and permission checks. This fundamentally breaks offline-first apps:

- JWT access tokens expire in 15-60 min — a user offline for a day is locked out
- Session cookies require server validation — impossible offline
- OAuth flows require redirects to unreachable identity providers
- Permission checks that query a server fail offline

**Existing offline-first frameworks (PouchDB, Realm, PowerSync, ElectricSQL) all punt on this** — they only authenticate at sync time and leave local data completely unprotected. That's the gap `@korajs/auth` fills.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│                        @korajs/auth                          │
│                                                              │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────────────┐ │
│  │   Device     │  │   Token     │  │   Local Data         │ │
│  │   Identity   │  │   Strategy  │  │   Protection         │ │
│  │   (Layer 1)  │  │   (Layer 2) │  │   (Layer 3)          │ │
│  │             │  │             │  │                      │ │
│  │  ECDSA P-256 │  │  Access 15m │  │  AES-256-GCM DB      │ │
│  │  key pair    │  │  Refresh 90d│  │  encryption           │ │
│  │  per device  │  │  Device     │  │  Biometric/passphrase │ │
│  │             │  │  credential │  │  gated key release    │ │
│  └─────────────┘  └─────────────┘  └──────────────────────┘ │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │                  Provider Adapters                       │ │
│  │  Built-in │ Clerk │ Auth0 │ Supabase │ Custom JWT       │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

---

## Developer-Facing API

### Setup

```typescript
import { createApp, defineSchema, t } from 'korajs'
import { auth } from '@korajs/auth'

const app = createApp({
  schema,
  auth: auth({
    // Identity provider
    provider: 'built-in',  // or 'clerk', 'auth0', 'supabase', 'custom'

    // Local data protection
    encryption: {
      enabled: true,
      unlock: 'biometric',  // or 'passphrase' or 'both'
      autoLockTimeout: 15 * 60 * 1000,  // 15 minutes
    },

    // Max time offline before requiring re-auth
    maxOfflineDuration: 30 * 24 * 60 * 60 * 1000,  // 30 days
  }),
  sync: {
    url: 'wss://my-server.com/kora',
    scopes: {
      forms: (ctx) => ({ where: { userId: ctx.userId } }),
    },
  },
})
```

### Auth Operations

```typescript
// Sign up (online required)
await app.auth.signUp({ email: 'user@example.com', password: 'secure123' })

// Sign in (online — establishes device identity)
await app.auth.signIn({ email: 'user@example.com', password: 'secure123' })

// Sign in with passkey (Phase 3)
await app.auth.signInWithPasskey()

// Unlock local data (offline — biometric or passphrase)
await app.auth.unlock()

// Sign out (clears local session, optionally wipes local data)
await app.auth.signOut({ wipeData: false })

// Current user (synchronous, from local cache)
const user = app.auth.currentUser
// { id: 'usr_abc123', email: 'user@example.com', name: 'Kwame', deviceId: 'dev_xyz789' }

// Auth state observable
app.auth.onAuthChange((user) => {
  // null when signed out, User object when signed in
})

// Device management (online)
const devices = await app.auth.listDevices()
await app.auth.revokeDevice('dev_old_phone')
```

### React Hooks

```typescript
import { useAuth, useCurrentUser, useRequireAuth } from '@korajs/auth/react'

function App() {
  const { user, signIn, signUp, signOut, unlock, isLocked } = useAuth()

  if (!user) return <LoginScreen />
  if (isLocked) return <UnlockScreen />
  return <Dashboard />
}

function Profile() {
  const user = useCurrentUser()  // throws if not authenticated
  return <h1>Hello, {user.name}</h1>
}
```

---

## Layer 1: Device Identity

### What It Is

Every device gets a **cryptographic identity** — an ECDSA P-256 key pair generated on first app launch. The private key never leaves the device. The public key is registered with the server during first authentication.

This maps naturally to Kora's existing `nodeId` concept — the same identifier used for operations and version vectors now also serves as the device authentication identity.

### Implementation

#### Key Generation (Web Crypto API)

```
On first app launch:
  1. Generate ECDSA P-256 key pair (non-extractable private key)
  2. Store CryptoKey objects in IndexedDB (private key cannot be exported)
  3. Export public key as JWK for server registration
  4. Associate with Kora's nodeId
```

**Key properties:**
- `non-extractable`: JavaScript cannot read the private key — it exists only in the browser's crypto subsystem
- Origin-scoped: tied to the app's domain, inaccessible to other origins
- Survives page refresh but not clearing site data

#### Key Storage

| Platform | Storage | Notes |
|----------|---------|-------|
| Browser | IndexedDB (CryptoKey is structured-cloneable) | Non-extractable private key |
| Node.js | Filesystem (encrypted with OS keychain or passphrase) | Via `node:crypto` |
| React Native | Secure Keystore / Keychain | Platform-native secure storage |
| Electron | OS Keychain via `keytar` | System credential manager |

#### Device Registration Flow

```
First authentication (online required):

Client                                  Server
  │                                       │
  │ 1. Generate key pair                  │
  │                                       │
  │── signUp/signIn(email, password) ────>│
  │   + devicePublicKey                   │
  │   + deviceId (nodeId)                 │
  │                                       │
  │<── accessToken + refreshToken ────────│
  │    + deviceCredential (signed)        │
  │                                       │
  │ 2. Store tokens locally               │
  │ 3. Device is now registered           │
```

#### Proof of Possession

All token usage requires proof that the device holds the private key:

```
For any authenticated request:
  1. Server sends a nonce (or client includes timestamp)
  2. Client signs: ECDSA-SHA256(nonce + timestamp + deviceId)
  3. Server verifies signature with registered public key
  4. Stolen tokens are useless without the device's private key
```

### Files to Create

```
packages/auth/src/
  device/
    device-identity.ts         # Key pair generation, storage, export
    device-identity.test.ts
    device-store.ts            # Platform-specific key storage abstraction
    device-store.test.ts
    proof-of-possession.ts     # Challenge-response signing
    proof-of-possession.test.ts
```

---

## Layer 2: Token Strategy

### Token Types

| Token | Lifetime | Purpose | Storage |
|-------|----------|---------|---------|
| Access Token | 15 minutes | Active sync session auth | Memory only |
| Refresh Token | 30-90 days | Re-establish sync after brief offline | Encrypted local storage |
| Device Credential | 90 days | Reconnect after extended offline | Encrypted local storage |

### Token Format

All tokens are JWTs with additional claims:

```json
// Access Token
{
  "sub": "usr_abc123",
  "dev": "dev_xyz789",
  "iat": 1716000000,
  "exp": 1716000900,
  "scope": ["forms:read", "forms:write", "responses:read", "responses:write"]
}

// Device Credential (longer-lived, requires proof-of-possession)
{
  "sub": "usr_abc123",
  "dev": "dev_xyz789",
  "dpk": "<device-public-key-thumbprint>",
  "iat": 1716000000,
  "exp": 1723776000,
  "type": "device_credential",
  "must_checkin_by": 1718592000
}
```

### Token Refresh Strategy

```
┌─────────────────────────────────────────────────────────────┐
│ Access token valid (< 15 min old)                           │
│   → Sync immediately with existing token                    │
├─────────────────────────────────────────────────────────────┤
│ Access token expired, refresh token valid (< 90 days)       │
│   → Silent refresh, then sync (most common reconnect case)  │
├─────────────────────────────────────────────────────────────┤
│ Refresh token expired, device credential valid (< 90 days)  │
│   → Present device credential + proof-of-possession         │
│   → Server issues new refresh + access tokens               │
│   → Avoids forcing re-login after weeks offline             │
├─────────────────────────────────────────────────────────────┤
│ Device credential expired (> 90 days offline)               │
│   → User must re-authenticate interactively                 │
│   → Local operations preserved, queued for sync after login │
├─────────────────────────────────────────────────────────────┤
│ Device revoked by admin                                     │
│   → Server rejects all credentials                          │
│   → Client handles gracefully (lock, optionally wipe)       │
└─────────────────────────────────────────────────────────────┘

CRITICAL RULE: Never discard local operations due to auth expiry.
Operations are valid data mutations created while the user was
authorized. Auth gates sync, not data validity.
```

### Sync Handshake Integration

```
Client                                    Server
  │                                         │
  │── Handshake ───────────────────────────>│
  │   versionVector                         │
  │   schemaVersion                         │
  │   accessToken                           │
  │   proofOfPossession(nonce)              │
  │                                         │
  │   [Server validates token,              │
  │    verifies device signature,           │
  │    computes sync scope]                 │
  │                                         │
  │<── HandshakeResponse ──────────────────│
  │    versionVector                        │
  │    syncScope                            │
  │    refreshedAccessToken? (if near expiry)│
  │                                         │
  │   [Bidirectional sync begins]           │
```

### Files to Create

```
packages/auth/src/
  tokens/
    token-manager.ts           # Token lifecycle (issue, refresh, validate)
    token-manager.test.ts
    token-store.ts             # Encrypted local token persistence
    token-store.test.ts
    jwt.ts                     # JWT encode/decode (no external dep, < 100 lines)
    jwt.test.ts
```

---

## Layer 3: Local Data Protection

### Database Encryption

The local SQLite database is encrypted with AES-256-GCM. The encryption key is never stored in plaintext.

#### Key Derivation

```
Option A — Passphrase-based:
  encryptionKey = PBKDF2(passphrase, salt, 600_000 iterations, 256 bits)
  or
  encryptionKey = Argon2id(passphrase, salt, memory=64MB, iterations=3, 256 bits)

Option B — Biometric-gated:
  1. Generate random 256-bit encryption key on first setup
  2. Encrypt the key with a wrapping key stored in platform secure storage
  3. Biometric verification releases the wrapping key
  4. Wrapping key decrypts the encryption key
  5. Encryption key opens the database

Option C — Both (most secure):
  1. encryptionKey = PBKDF2(passphrase) XOR biometricKey
  2. Both factors required to derive the encryption key
```

#### Auto-Lock

```
When app goes to background or after inactivity timeout:
  1. Clear encryption key from memory
  2. Close database connection
  3. Show lock screen
  4. Require biometric/passphrase to unlock
  5. Re-derive encryption key, re-open database
```

#### Time-Bomb Credential

For extended offline scenarios, the device credential includes a `must_checkin_by` timestamp:

```
On each local operation:
  if (Date.now() > deviceCredential.must_checkin_by):
    lock the app
    show "Please connect to the internet to verify your identity"
    local data preserved but inaccessible until re-auth
```

This provides a form of delayed remote revocation — even if the device can't be reached, it will lock itself after the check-in deadline.

**Drift protection:** Use the HLC's existing drift detection. If the local clock is significantly behind the last known HLC wall time, refuse to trust the clock (prevents bypassing the time-bomb by changing the device clock).

### Files to Create

```
packages/auth/src/
  encryption/
    database-encryption.ts     # AES-256-GCM encrypt/decrypt
    database-encryption.test.ts
    key-derivation.ts          # PBKDF2/Argon2id key derivation
    key-derivation.test.ts
    biometric-gate.ts          # WebAuthn local user verification
    biometric-gate.test.ts
    auto-lock.ts               # Inactivity timer, lock/unlock state
    auto-lock.test.ts
```

---

## Built-in Identity Provider

For developers who don't want to integrate an external auth provider, `@korajs/auth` includes a built-in identity provider that runs on `@korajs/server`.

### User Model

```typescript
interface User {
  id: string              // UUID v7
  email: string
  name: string
  passwordHash: string    // Argon2id hash
  salt: string            // Unique per user
  createdAt: number
  updatedAt: number
}

interface Device {
  id: string              // Same as Kora nodeId
  userId: string
  publicKey: string       // JWK format
  name: string            // "iPhone 15", "Chrome on MacBook"
  registeredAt: number
  lastSeenAt: number
  status: 'active' | 'revoked'
}
```

### Server Endpoints

```
POST   /auth/signup          # Create account
POST   /auth/signin          # Sign in (email + password)
POST   /auth/refresh         # Refresh access token
POST   /auth/device/register # Register a new device key
POST   /auth/device/verify   # Proof-of-possession challenge
DELETE /auth/device/:id      # Revoke a device
GET    /auth/devices         # List user's devices
POST   /auth/signout         # Invalidate tokens
POST   /auth/passkey/register  # Phase 3: Register passkey
POST   /auth/passkey/authenticate  # Phase 3: Authenticate with passkey
```

### Password Hashing

```
Argon2id with:
  - Memory: 64 MB (65536 KB)
  - Iterations: 3
  - Parallelism: 4
  - Output: 32 bytes (256 bits)

Use the `argon2` npm package (Node.js native binding).
Fallback: PBKDF2 with 600,000 iterations (for environments without native Argon2).
```

### Files to Create

```
packages/auth/src/
  provider/
    built-in/
      server-routes.ts         # Express/Hono route handlers
      server-routes.test.ts
      password-hash.ts         # Argon2id hashing
      password-hash.test.ts
      user-store.ts            # User/device CRUD (uses Drizzle)
      user-store.test.ts
    adapter.ts                 # Provider adapter interface
    clerk-adapter.ts           # Clerk integration
    auth0-adapter.ts           # Auth0 integration
    supabase-adapter.ts        # Supabase Auth integration
    custom-adapter.ts          # Custom JWT issuer integration
```

---

## Permission & Sync Scope Model

### How Permissions Work

Permissions are enforced **at the sync boundary**, not locally. This is critical for offline-first:

```
Local (offline):
  - All data on the device is accessible to the authenticated local user
  - No permission checks on local reads/writes
  - Operations are created and queued freely

Sync boundary (online):
  - Server validates user identity (token + proof-of-possession)
  - Server computes sync scope based on user's permissions
  - Outbound: server only sends operations within user's scope
  - Inbound: server validates user can write to the target collection/record
  - Rejected writes are returned to client with error detail
```

### Permission Change While Offline

When a user's permissions change while they're offline:

```
Default behavior (accept-then-reconcile):
  1. User makes edits offline (they had permission when they started)
  2. Admin changes user to read-only while user is offline
  3. User reconnects
  4. Server accepts the operations (created under valid permissions)
  5. Going forward, new writes from this user are rejected
  6. Framework emits 'auth:permission-changed' event

Configurable alternatives:
  - 'reject': reject offline operations, return them to client
  - 'queue-for-review': accept into pending queue, admin approves/rejects
```

### Sync Scope Configuration

```typescript
const app = createApp({
  sync: {
    scopes: {
      // User sees only their own forms
      forms: (ctx) => ({ where: { userId: ctx.userId } }),

      // User sees responses to their forms
      responses: (ctx) => ({ where: { formId: { in: ctx.userFormIds } } }),

      // Team-shared data
      projects: (ctx) => ({ where: { teamId: { in: ctx.teamIds } } }),

      // Public data (everyone syncs)
      templates: () => ({}),
    },
  },
})
```

---

## Security Considerations

### Device Theft While Offline

**Defense layers (outer to inner):**

1. **OS-level device lock** (PIN, biometric) — first barrier, outside framework's control
2. **App auto-lock** — encryption key cleared after inactivity timeout
3. **Database encryption** — AES-256-GCM, key gated behind biometric/passphrase
4. **Time-bomb credential** — app locks after check-in deadline even without network
5. **Data minimization** — sync scopes limit what data exists on the device

### Remote Revocation

```
Admin revokes device:
  1. Server marks device credential as revoked (immediate)
  2. Revoked device continues locally (cannot be reached)
  3. On reconnection attempt: server rejects with DEVICE_REVOKED
  4. Client locks, optionally wipes local data
  5. Time-bomb credential provides delayed enforcement even without reconnection
```

### Key Rotation

| Key Type | Rotation Strategy |
|----------|-------------------|
| Server signing key | Maintain history of last 2 keys. New tokens use new key. Old tokens valid until expiry. |
| Device key pair | Device signs "key rotation" message with old key containing new public key. Server updates. |
| Database encryption key | New operations use new key. Old data re-encrypted lazily in background. Key history maintained. |
| Group/team key | On member removal: generate new key, re-wrap for remaining members. Old data accessible with old key (accepted limitation). |

### What We Cannot Protect Against

- **Determined attacker with physical access + OS-level compromise** — if they bypass both OS lock and database encryption, data is accessible. This is true for all local-first systems. Document this clearly.
- **Real-time remote wipe of offline devices** — physically impossible. Time-bomb credential is the best mitigation.
- **Clock manipulation to bypass time-bomb** — mitigated by HLC drift detection but not foolproof on a rooted/jailbroken device.

---

## Implementation Phases

### Phase 1: Device Identity + Basic Auth (4-6 weeks)

**Goal:** Users can sign up, sign in, and have per-user data isolation. Forms created by user A are invisible to user B.

```
Week 1-2: Device Identity
  - [ ] ECDSA P-256 key pair generation (Web Crypto API)
  - [ ] Key storage abstraction (IndexedDB for browser, filesystem for Node)
  - [ ] Proof-of-possession signing and verification
  - [ ] Integration with Kora's existing nodeId

Week 2-3: Token Management
  - [ ] JWT encode/decode (in-house, no dependency)
  - [ ] Access token (15 min) + refresh token (90 day) lifecycle
  - [ ] Device credential generation and validation
  - [ ] Encrypted local token storage
  - [ ] Tiered refresh strategy implementation

Week 3-4: Built-in Provider (Server)
  - [ ] User model + Drizzle schema (users, devices tables)
  - [ ] POST /auth/signup — email + password registration
  - [ ] POST /auth/signin — authentication + device registration
  - [ ] POST /auth/refresh — token refresh
  - [ ] POST /auth/device/verify — proof-of-possession challenge
  - [ ] Password hashing with Argon2id
  - [ ] Rate limiting on auth endpoints

Week 4-5: Sync Integration
  - [ ] Auth token in sync handshake (extend existing protocol)
  - [ ] Server-side sync scope computation from user identity
  - [ ] Per-user data filtering on sync operations
  - [ ] Graceful handling of expired tokens during sync

Week 5-6: Client SDK + React Hooks
  - [ ] app.auth.signUp() / signIn() / signOut()
  - [ ] app.auth.currentUser (synchronous, cached)
  - [ ] app.auth.onAuthChange() observable
  - [ ] useAuth() / useCurrentUser() React hooks
  - [ ] Auth state persistence across page refresh
```

**Deliverable:** A developer can add auth to their Kora app with 3 lines of config. Users sign up, sign in, and only see their own data. Works offline after initial sign-in.

### Phase 2: Local Encryption + Auto-Lock (3-4 weeks)

**Goal:** Data at rest is encrypted. Stolen devices can't access data without biometric/passphrase.

```
Week 1-2: Database Encryption
  - [ ] AES-256-GCM encryption/decryption primitives
  - [ ] Key derivation (PBKDF2 / Argon2id from passphrase)
  - [ ] SQLite encryption integration (encrypt before write, decrypt after read)
  - [ ] OR: SQLCipher/encryption extension integration (full-database encryption)
  - [ ] Performance benchmarks (encryption overhead target: < 10%)

Week 2-3: Biometric Gate
  - [ ] WebAuthn local user verification (navigator.credentials.get with userVerification: 'required')
  - [ ] Biometric-gated key release flow
  - [ ] Fallback to passphrase when biometric unavailable
  - [ ] Platform detection (is biometric available?)

Week 3-4: Auto-Lock + Time-Bomb
  - [ ] Inactivity timer with configurable timeout
  - [ ] Visibility change detection (app background)
  - [ ] Encryption key clearing on lock
  - [ ] Lock screen component (React)
  - [ ] Time-bomb credential enforcement
  - [ ] HLC drift detection integration
```

**Deliverable:** Local data is encrypted at rest. App locks after inactivity. Biometric or passphrase required to unlock. Time-bomb forces check-in after configurable offline period.

### Phase 3: Advanced Auth (4-6 weeks)

**Goal:** Passkeys, E2E encryption, team key management, device management UI.

```
Week 1-2: Passkey Support
  - [ ] WebAuthn credential creation (passkey registration)
  - [ ] WebAuthn assertion (passkey sign-in)
  - [ ] Hybrid flow: passkey online (WebAuthn assertion), biometric offline (local verification)
  - [ ] Passkey as alternative to email/password

Week 2-4: End-to-End Encryption
  - [ ] Operation data field encryption (metadata stays plaintext for sync)
  - [ ] Per-user encryption key (for private data)
  - [ ] Per-group encryption key with key wrapping (for shared/team data)
  - [ ] Key distribution protocol (new member receives wrapped group key)
  - [ ] Key rotation on member removal
  - [ ] Key history for decrypting historical data

Week 4-5: Device Management
  - [ ] GET /auth/devices — list registered devices
  - [ ] DELETE /auth/device/:id — revoke a device
  - [ ] Device naming (auto-detect browser/OS + user-editable)
  - [ ] Last seen timestamp tracking
  - [ ] React components: DeviceList, DeviceCard

Week 5-6: External Provider Adapters
  - [ ] Provider adapter interface (abstract)
  - [ ] Clerk adapter (JWT validation, user sync)
  - [ ] Auth0 adapter
  - [ ] Supabase Auth adapter
  - [ ] Custom JWT issuer adapter (bring your own)
  - [ ] Documentation for each provider
```

**Deliverable:** Full-featured auth system with passkeys, end-to-end encryption, device management, and integration with popular auth providers.

---

## Package Structure

```
packages/auth/
  src/
    index.ts                    # Public API: auth(), AuthConfig, User, etc.
    types.ts                    # Type definitions

    device/
      device-identity.ts        # Key pair generation and management
      device-store.ts           # Platform-specific secure key storage
      proof-of-possession.ts    # Challenge-response signing

    tokens/
      token-manager.ts          # Token lifecycle management
      token-store.ts            # Encrypted local token persistence
      jwt.ts                    # JWT encode/decode (< 100 lines, no dep)

    encryption/
      database-encryption.ts    # AES-256-GCM primitives
      key-derivation.ts         # PBKDF2/Argon2id
      biometric-gate.ts         # WebAuthn local user verification
      auto-lock.ts              # Inactivity timer, lock/unlock

    provider/
      adapter.ts                # Provider adapter interface
      built-in/
        server-routes.ts        # Auth API endpoints for @korajs/server
        password-hash.ts        # Argon2id hashing
        user-store.ts           # User/device CRUD
      clerk-adapter.ts
      auth0-adapter.ts
      supabase-adapter.ts
      custom-adapter.ts

    react/
      hooks.ts                  # useAuth, useCurrentUser, useRequireAuth
      AuthProvider.tsx           # React context provider
      LockScreen.tsx             # Default lock screen component

  tests/
    integration/
      auth-flow.test.ts         # Full signup → signin → sync → offline → reconnect
      device-revocation.test.ts
      permission-change.test.ts
      encryption.test.ts
    fixtures/

  package.json
  tsup.config.ts
  vitest.config.ts
  README.md
```

### Dependencies

```json
{
  "dependencies": {
    "@korajs/core": "workspace:*"
  },
  "devDependencies": {
    "@korajs/store": "workspace:*",
    "@korajs/sync": "workspace:*",
    "@korajs/server": "workspace:*"
  },
  "peerDependencies": {
    "react": ">=18"
  },
  "peerDependenciesMeta": {
    "react": { "optional": true }
  }
}
```

**External dependencies (keep minimal):**
- `argon2` — server-side only, for password hashing (native binding, much stronger than pure JS)
- No other external deps — JWT, encryption, key derivation all use Web Crypto API / `node:crypto`

---

## What Good Looks Like

### For correctness:
- [ ] No auth operation ever loses user data
- [ ] Expired tokens never block local operations
- [ ] Device revocation propagates within one sync cycle
- [ ] Password hashing uses Argon2id with recommended parameters
- [ ] All cryptographic operations use Web Crypto API (browser) or `node:crypto` (Node)
- [ ] No secrets stored in plaintext anywhere

### For developer experience:
- [ ] 3 lines of config to add auth to a Kora app
- [ ] Zero distributed systems knowledge required
- [ ] Clear error messages: "Your session expired after 90 days offline. Please sign in again."
- [ ] TypeScript autocomplete for all auth APIs
- [ ] Works with React StrictMode and concurrent mode

### For offline-first:
- [ ] Sign in once, work offline for weeks
- [ ] All local operations preserved regardless of auth state
- [ ] Seamless reconnection: no data loss, no duplicate sync
- [ ] Biometric unlock in < 200ms
- [ ] Database encryption overhead < 10% of unencrypted performance

---

## Comparison with Existing Solutions

| Feature | Clerk/Auth0 | Firebase Auth | Realm Auth | @korajs/auth |
|---------|-------------|---------------|------------|--------------|
| Offline sign-in | No | No | Limited (cached session) | Yes (biometric/passphrase) |
| Token works offline | No (expires) | No (expires) | Partial (1 week) | Yes (90 day device credential) |
| Local data encryption | No | No | Optional (app-provided key) | Built-in AES-256-GCM |
| Device key binding | No | No | No | Yes (ECDSA proof-of-possession) |
| Auto-lock | No | No | No | Yes (configurable timeout) |
| Stolen token protection | No (bearer token) | No (bearer token) | No | Yes (requires device key) |
| E2E encryption | No | No | No | Yes (Phase 3) |
| Works without internet | No | No | Partially | Fully |
| Open source | No | No | Partially | Yes |

---

*Kora: independent strings, shared harmony.*
