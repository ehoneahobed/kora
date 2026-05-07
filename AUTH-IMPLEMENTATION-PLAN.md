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

### Phase 1: Device Identity + Basic Auth — COMPLETE

**Goal:** Users can sign up, sign in, and have per-user data isolation.
**Status:** Shipped in commit `bed0e06`. 237 tests passing.

```
Device Identity
  - [x] ECDSA P-256 key pair generation (Web Crypto API)
  - [x] Key storage abstraction (IndexedDB for browser, InMemory for Node/tests)
  - [x] Challenge-response signing and verification
  - [x] Public key thumbprint computation (SHA-256)
  - [x] Base64url encoding/decoding utilities

Token Management
  - [x] JWT encode/decode (in-house HS256, no dependency, < 100 lines)
  - [x] Access token (15 min) + refresh token (90 day) lifecycle
  - [x] Device credential generation and validation
  - [x] Local token persistence (TokenStore with localStorage)
  - [x] Token refresh with rotation

Built-in Provider (Server)
  - [x] InMemoryUserStore (User + Device models)
  - [x] POST /auth/signup — email + password registration
  - [x] POST /auth/signin — authentication + device registration
  - [x] POST /auth/refresh — token refresh with rotation
  - [x] POST /auth/device/verify — challenge-response verification
  - [x] POST /auth/device/revoke — device revocation
  - [x] GET /auth/devices — list user's devices
  - [x] Password hashing with PBKDF2-SHA512 (600K iterations, timing-safe)
  - [x] BuiltInProvider adapter wrapping routes into AuthProviderAdapter interface

Sync Integration
  - [x] KoraAuthProvider bridge in @korajs/server
  - [x] Token validation in sync handshake
  - [x] Per-user sync scope resolution
  - [x] Device last-seen tracking

Client SDK + React Hooks
  - [x] AuthClient (signUp/signIn/signOut/refresh)
  - [x] Auth state management (authenticated/unauthenticated/loading)
  - [x] AuthProvider React context
  - [x] useAuth() / useCurrentUser() / useAuthStatus() hooks
  - [x] Auth state persistence across page refresh
```

### Phase 2: Security Hardening + Local Encryption — COMPLETE

**Goal:** Production-grade security, encrypted data at rest.
**Status:** Shipped in commit `a9caea9`. 249 tests passing.

```
Security Hardening
  - [x] Minimum 32-char JWT secret enforcement
  - [x] Token IDs (jti) — every token has a unique UUID for revocation
  - [x] TokenRevocationStore interface + InMemoryTokenRevocationStore
  - [x] Refresh token rotation with reuse detection (replay = device-wide revocation)
  - [x] Key rotation support (array of secrets, sign newest, verify all)
  - [x] Algorithm confusion prevention (alg header validation = HS256)
  - [x] Server-side ChallengeStore (60s TTL, single-use nonces)
  - [x] Rate limiting (pluggable RateLimiter interface, InMemoryRateLimiter)
  - [x] Server-side sign-out (token revocation endpoint)
  - [x] Max password length (128 chars, hash-DoS prevention)
  - [x] Input sanitization (control char stripping, 200-char name limit)
  - [x] Clock skew tolerance (5 seconds in isExpired)
  - [x] PII removal from error messages

Database Encryption
  - [x] AES-256-GCM encryption/decryption primitives (Web Crypto API)
  - [x] PBKDF2-SHA256 key derivation (600K iterations, OWASP-compliant)
  - [x] Random salt generation (16 bytes)
  - [x] Key export/import for persistence
  - [x] Extractable CryptoKey objects for wrapping patterns

Auto-Lock
  - [x] Configurable inactivity timeout (AutoLockManager)
  - [x] Visibility change detection (document hidden)
  - [x] Lock/unlock state machine
  - [x] Callback hooks (onLock, onUnlock, onWarning)
  - [x] Warning threshold before lock
```

### Phase 3: Passkeys, External Providers, Encrypted Tokens — COMPLETE

**Goal:** WebAuthn passkeys, third-party auth, encrypted token storage, E2E encryption.
**Status:** Shipped in commits `6601ed2` and `ee51b57`. 444 tests passing.

```
Passkey / WebAuthn Support
  - [x] Client: isPasskeySupported(), isPlatformAuthenticatorAvailable()
  - [x] Client: createPasskeyCredential() — browser credential creation
  - [x] Client: authenticateWithPasskey() — browser credential assertion
  - [x] Server: generateRegistrationOptions() / verifyRegistrationResponse()
  - [x] Server: generateAuthenticationOptions() / verifyAuthenticationResponse()
  - [x] Minimal CBOR decoder (no external dependency)
  - [x] DER↔P1363 ECDSA signature format conversion
  - [x] Cloned authenticator detection (sign counter validation)
  - [x] Constant-time comparison for hash verification
  - [x] 78 tests (42 client + 36 server)

External Provider Adapters
  - [x] ExternalJwtProvider base class (HS256 secret or custom validator)
  - [x] createClerkAdapter() factory (RS256/JWKS, org metadata mapping)
  - [x] createSupabaseAdapter() factory (HS256, user_metadata mapping)
  - [x] Custom claim extraction for roles, org_id, etc.
  - [x] 54 tests

Encrypted Token Store
  - [x] EncryptedTokenStore — AES-256-GCM encrypted localStorage
  - [x] Memory fallback for SSR environments
  - [x] Custom storage key support
  - [x] Only persists expected token fields (strips extras)
  - [x] 31 tests

E2E Operation Encryption
  - [x] OperationEncryptor class — encrypts data/previousData fields
  - [x] Self-describing encrypted envelope (marker, ciphertext, IV, algorithm, version)
  - [x] Plaintext passthrough in decryptOperation (backward compatible)
  - [x] Batch encrypt/decrypt helpers
  - [x] isEncryptedField() standalone utility
  - [x] 32 tests

Deferred to Phase 5 (originally planned for Phase 3)
  - [ ] Per-group encryption key with key wrapping (for shared/team data)
  - [ ] Key distribution protocol (new member receives wrapped group key)
  - [ ] Key rotation on member removal
  - [ ] Key history for decrypting historical data
  - [ ] React components: DeviceList, DeviceCard
```

---

### Phase 4: SaaS Readiness — Multi-Tenancy & Organizations (TODO)

**Goal:** Enable building multi-tenant SaaS applications where users belong to organizations/teams with role-based access control. Both single-tenant (personal) and multi-tenant (team/org) patterns should be first-class citizens.

#### 4A: Organization & Membership Model

The core data model for multi-tenancy. Every SaaS needs users grouped into orgs/workspaces.

```
packages/auth/src/
  org/
    org-types.ts               # Organization, Membership, Role types
    org-types.test.ts
    org-store.ts               # InMemoryOrgStore (dev/test) + OrgStore interface
    org-store.test.ts
    org-routes.ts              # Server route handlers for org CRUD
    org-routes.test.ts

Types to define:
  - [ ] Organization { id, name, slug, ownerId, plan, createdAt, updatedAt, metadata }
  - [ ] Membership { id, orgId, userId, role, invitedBy, joinedAt, metadata }
  - [ ] OrgRole — 'owner' | 'admin' | 'member' | 'viewer' | 'billing' (extensible)
  - [ ] OrgInvitation { id, orgId, email, role, invitedBy, expiresAt, status, token }

OrgStore interface:
  - [ ] createOrg(params) → Organization
  - [ ] getOrg(orgId) → Organization | null
  - [ ] getOrgBySlug(slug) → Organization | null
  - [ ] updateOrg(orgId, updates) → Organization
  - [ ] deleteOrg(orgId) → void
  - [ ] listUserOrgs(userId) → Organization[]
  - [ ] addMember(orgId, userId, role) → Membership
  - [ ] removeMember(orgId, userId) → void
  - [ ] updateMemberRole(orgId, userId, role) → Membership
  - [ ] listMembers(orgId) → Membership[]
  - [ ] getMembership(orgId, userId) → Membership | null
  - [ ] InMemoryOrgStore implementation for dev/testing

Server routes:
  - [ ] POST /auth/orgs — create organization
  - [ ] GET /auth/orgs — list user's organizations
  - [ ] GET /auth/orgs/:id — get organization details
  - [ ] PATCH /auth/orgs/:id — update organization
  - [ ] DELETE /auth/orgs/:id — delete organization (owner only)
  - [ ] GET /auth/orgs/:id/members — list members
  - [ ] POST /auth/orgs/:id/members — add member (admin+)
  - [ ] PATCH /auth/orgs/:id/members/:userId — update member role (admin+)
  - [ ] DELETE /auth/orgs/:id/members/:userId — remove member (admin+)
```

#### 4B: Invitation System

Users invite teammates by email. Invitations are time-limited and single-use.

```
packages/auth/src/
  org/
    invitation-store.ts        # InvitationStore interface + InMemoryInvitationStore
    invitation-store.test.ts
    invitation-routes.ts       # Invite endpoints
    invitation-routes.test.ts

InvitationStore interface:
  - [ ] createInvitation(orgId, email, role, invitedBy, expiresIn?) → OrgInvitation
  - [ ] getInvitation(token) → OrgInvitation | null
  - [ ] consumeInvitation(token) → OrgInvitation (marks as accepted, single-use)
  - [ ] revokeInvitation(id) → void
  - [ ] listPendingInvitations(orgId) → OrgInvitation[]
  - [ ] listInvitationsForEmail(email) → OrgInvitation[]
  - [ ] cleanExpired() → number (purge expired invitations)

Server routes:
  - [ ] POST /auth/orgs/:id/invitations — create invitation (admin+)
  - [ ] GET /auth/orgs/:id/invitations — list pending invitations
  - [ ] DELETE /auth/orgs/:id/invitations/:invitationId — revoke invitation
  - [ ] POST /auth/invitations/accept — accept invitation (by token)
  - [ ] GET /auth/invitations/pending — list invitations for current user's email
```

#### 4C: Role-Based Access Control (RBAC)

Hierarchical permissions that integrate with sync scopes.

```
packages/auth/src/
  rbac/
    rbac-types.ts              # Permission, RoleDefinition types
    rbac-types.test.ts
    rbac-engine.ts             # Permission evaluation engine
    rbac-engine.test.ts
    scope-resolver.ts          # Convert RBAC roles → sync scopes
    scope-resolver.test.ts

Permission model:
  - [ ] Permission = { resource: string, action: string }
        Examples: 'todos:read', 'todos:write', 'todos:delete', 'org:admin'
  - [ ] RoleDefinition = { name: string, permissions: Permission[], inherits?: string[] }
  - [ ] Built-in roles with permissions:
        owner:   all permissions + org management + billing
        admin:   all data permissions + member management
        member:  read + write on own data + read shared data
        viewer:  read-only on shared data
        billing: org billing management only

RBAC engine:
  - [ ] hasPermission(userId, orgId, permission) → boolean
  - [ ] getUserPermissions(userId, orgId) → Permission[]
  - [ ] Can define custom roles beyond the built-in ones
  - [ ] Role inheritance (viewer < member < admin < owner)

Sync scope integration:
  - [ ] resolveOrgScopes(userId, orgId, role) → Record<string, Record<string, unknown>>
  - [ ] Owner/admin: all org data
  - [ ] Member: own data + shared data within org
  - [ ] Viewer: read-only scope (server rejects writes)
  - [ ] Custom scope resolvers per collection

Developer API:
  - [ ] defineRoles() builder for custom role definitions
  - [ ] Middleware-style permission checks on server routes
```

#### 4D: Org-Aware Auth Client & React Hooks

Client-side org management and context switching.

```
packages/auth/src/
  client/
    org-client.ts              # Client-side org operations
    org-client.test.ts
  react/
    org-hooks.ts               # React hooks for org context
    org-hooks.test.ts

Client API:
  - [ ] app.auth.createOrg({ name, slug }) → Organization
  - [ ] app.auth.listOrgs() → Organization[]
  - [ ] app.auth.switchOrg(orgId) → void (changes active org context)
  - [ ] app.auth.currentOrg → Organization | null
  - [ ] app.auth.currentRole → OrgRole | null
  - [ ] app.auth.inviteMember(email, role) → OrgInvitation
  - [ ] app.auth.acceptInvitation(token) → Membership
  - [ ] app.auth.leaveOrg(orgId) → void

React hooks:
  - [ ] useOrg() → { org, role, switchOrg, createOrg, leaveOrg }
  - [ ] useOrgMembers(orgId) → { members, invite, removeMember, updateRole }
  - [ ] usePermission(permission) → boolean
  - [ ] <OrgProvider orgId={...}> — org context wrapper
  - [ ] <RequirePermission permission="todos:write"> — conditional render
```

#### 4E: Multi-Tenancy Sync Integration

Wire org context into the sync pipeline.

```
packages/server/src/
  auth/
    org-scope-resolver.ts      # Org-aware scope resolution
    org-scope-resolver.test.ts

Server integration:
  - [ ] Org ID in sync handshake (client sends active org)
  - [ ] Server validates user membership in claimed org
  - [ ] Scope resolver uses org membership + role to compute data filter
  - [ ] Operations tagged with orgId for routing
  - [ ] Cross-org data isolation enforced at server level
  - [ ] Org switch triggers re-handshake with new scopes
```

**Deliverable:** A developer can build a multi-tenant SaaS where users create organizations, invite teammates, assign roles, and see data scoped to their org and permissions. Works with both single-user and team patterns.

---

### Phase 5: Auth Flows & Production UX (TODO)

**Goal:** Complete the auth experience with standard production flows that every SaaS needs.

#### 5A: Password Reset

Self-service password reset via time-limited tokens.

```
packages/auth/src/
  provider/built-in/
    password-reset.ts          # Reset token generation + validation
    password-reset.test.ts

Implementation:
  - [ ] PasswordResetStore interface + InMemoryPasswordResetStore
  - [ ] generateResetToken(email) → { token, expiresAt } (cryptographically random, 1 hour TTL)
  - [ ] validateResetToken(token) → { userId, email } | null
  - [ ] consumeResetToken(token, newPassword) → void (single-use)
  - [ ] Rate limit: max 3 reset requests per email per hour

Server routes:
  - [ ] POST /auth/forgot-password — request reset (accepts email, always returns 200)
  - [ ] POST /auth/reset-password — consume token + set new password
  - [ ] POST /auth/change-password — change password (requires current password + access token)

Webhook/callback:
  - [ ] onPasswordResetRequested(email, token, expiresAt) callback
        Developer implements email sending (Kora doesn't send emails)
  - [ ] Clear, documented example with Resend/SendGrid/Nodemailer
```

#### 5B: Email Verification

Verify email ownership on sign-up and email changes.

```
packages/auth/src/
  provider/built-in/
    email-verification.ts      # Verification token generation + validation
    email-verification.test.ts

Implementation:
  - [ ] EmailVerificationStore interface + InMemoryEmailVerificationStore
  - [ ] generateVerificationToken(userId, email) → { token, expiresAt } (24 hour TTL)
  - [ ] verifyEmail(token) → { userId, email } (single-use)
  - [ ] User model: add `emailVerified: boolean` field
  - [ ] Optional: block sign-in until email verified (configurable)
  - [ ] Optional: re-verify on email change

Server routes:
  - [ ] POST /auth/verify-email — consume verification token
  - [ ] POST /auth/resend-verification — resend (rate limited, max 3/hour)

Webhook/callback:
  - [ ] onVerificationRequired(email, token, expiresAt) callback
  - [ ] Developer implements email sending
```

#### 5C: OAuth / Social Login

OAuth 2.0 authorization code flow for Google, GitHub, Microsoft.

```
packages/auth/src/
  provider/oauth/
    oauth-types.ts             # OAuthProvider, OAuthTokens, OAuthUserInfo types
    oauth-flow.ts              # Authorization URL generation, code exchange
    oauth-flow.test.ts
    google-provider.ts         # Google OAuth configuration
    github-provider.ts         # GitHub OAuth configuration
    microsoft-provider.ts      # Microsoft Entra ID configuration

Implementation:
  - [ ] OAuthProviderConfig { clientId, clientSecret, scopes, authUrl, tokenUrl, userInfoUrl }
  - [ ] generateAuthorizationUrl(provider, state, redirectUri) → URL
  - [ ] exchangeCodeForTokens(provider, code, redirectUri) → OAuthTokens
  - [ ] fetchUserInfo(provider, accessToken) → OAuthUserInfo
  - [ ] Link OAuth identity to existing Kora user (or create new user)
  - [ ] PKCE support (code_verifier + code_challenge for public clients)
  - [ ] State parameter validation (CSRF protection)
  - [ ] Nonce validation for OpenID Connect

Server routes:
  - [ ] GET /auth/oauth/:provider — redirect to OAuth provider
  - [ ] GET /auth/oauth/:provider/callback — handle OAuth callback
  - [ ] POST /auth/oauth/:provider/token — exchange code (for SPA clients)
  - [ ] POST /auth/link-account — link OAuth to existing account

Pre-built providers:
  - [ ] Google (OpenID Connect, email + profile scopes)
  - [ ] GitHub (OAuth 2.0, user + email scopes)
  - [ ] Microsoft (Entra ID / Azure AD, OpenID Connect)
  - [ ] Generic OIDC provider factory (works with any OpenID Connect provider)
```

#### 5D: TOTP-Based Multi-Factor Authentication

Time-based One-Time Password (RFC 6238) as a second factor.

```
packages/auth/src/
  mfa/
    totp.ts                    # TOTP generation + validation (RFC 6238)
    totp.test.ts
    mfa-routes.ts              # MFA enrollment + verification routes
    mfa-routes.test.ts

Implementation:
  - [ ] generateTOTPSecret() → { secret, uri, qrCodeDataUrl }
  - [ ] verifyTOTP(secret, code, window?) → boolean (±1 window for clock drift)
  - [ ] User model: add mfaEnabled, mfaSecret, mfaBackupCodes fields
  - [ ] Backup codes: 10 single-use recovery codes generated at enrollment
  - [ ] TOTP implementation using Web Crypto HMAC-SHA1 (no dependency)

Server routes:
  - [ ] POST /auth/mfa/enroll — begin enrollment (returns secret + QR URI)
  - [ ] POST /auth/mfa/confirm — confirm enrollment (verify first code)
  - [ ] POST /auth/mfa/verify — verify TOTP during sign-in
  - [ ] POST /auth/mfa/backup — use backup code
  - [ ] DELETE /auth/mfa — disable MFA (requires password confirmation)

Sign-in flow with MFA:
  - [ ] POST /auth/signin returns { requiresMfa: true, mfaToken: '...' } instead of tokens
  - [ ] Client presents TOTP input
  - [ ] POST /auth/mfa/verify with mfaToken + code → returns full auth tokens
```

#### 5E: Session Management

Comprehensive session tracking and management across devices.

```
packages/auth/src/
  session/
    session-store.ts           # SessionStore interface + InMemorySessionStore
    session-store.test.ts
    session-routes.ts          # Session management routes
    session-routes.test.ts

Implementation:
  - [ ] Session { id, userId, deviceId, ipAddress, userAgent, createdAt, lastActiveAt, expiresAt }
  - [ ] Track active sessions per user
  - [ ] Revoke individual sessions or all sessions
  - [ ] "Sign out everywhere" functionality
  - [ ] Session activity tracking (last active timestamp)
  - [ ] Concurrent session limit (configurable, e.g., max 5 active sessions)

Server routes:
  - [ ] GET /auth/sessions — list active sessions for current user
  - [ ] DELETE /auth/sessions/:id — revoke a specific session
  - [ ] DELETE /auth/sessions — revoke all sessions except current
```

**Deliverable:** A complete production auth system with self-service password reset, email verification, social login (Google/GitHub/Microsoft), TOTP-based MFA, and comprehensive session management.

---

### Phase 6: Admin API & Operational Tooling (TODO)

**Goal:** Server-side management capabilities for operating a SaaS.

```
Admin API:
  - [ ] GET /admin/users — list users (paginated, searchable)
  - [ ] GET /admin/users/:id — get user details + devices + sessions + orgs
  - [ ] PATCH /admin/users/:id — update user (name, email, emailVerified, suspended)
  - [ ] DELETE /admin/users/:id — delete user + cascade (data, memberships, sessions)
  - [ ] POST /admin/users/:id/suspend — suspend user (revoke all sessions, reject sync)
  - [ ] POST /admin/users/:id/unsuspend — unsuspend user
  - [ ] GET /admin/orgs — list organizations (paginated)
  - [ ] GET /admin/orgs/:id — org details + members
  - [ ] DELETE /admin/orgs/:id — delete org + cascade
  - [ ] Admin auth: separate admin token or superuser role

Webhooks:
  - [ ] WebhookConfig { url, events, secret }
  - [ ] Events: user.created, user.deleted, user.suspended, org.created, org.deleted,
        member.invited, member.joined, member.removed, session.created, session.revoked,
        password.changed, mfa.enabled, mfa.disabled
  - [ ] HMAC-SHA256 signature verification on webhook payloads
  - [ ] Retry with exponential backoff (3 attempts)
  - [ ] WebhookStore for managing webhook registrations

Monitoring:
  - [ ] GET /health — server health check
  - [ ] GET /metrics — basic metrics (active connections, sync ops/sec, auth events/min)
  - [ ] Auth event logging interface (pluggable for external logging services)

Data Management:
  - [ ] POST /admin/users/:id/export — export user data (GDPR compliance)
  - [ ] POST /admin/users/:id/purge — permanently delete all user data
  - [ ] Data retention policy configuration (auto-purge after N days)
```

**Deliverable:** Production operational tooling for managing users, organizations, and system health.

---

## Package Structure

```
packages/auth/
  src/
    index.ts                    # Client public API exports
    server.ts                   # Server public API exports
    react.ts                    # React hooks + provider exports
    types.ts                    # Shared types (TokenPayload, AuthTokens, etc.)

    client/
      auth-client.ts            # AuthClient (signUp/signIn/signOut/refresh)  [DONE]
      org-client.ts             # Org management client                       [Phase 4]

    device/
      device-identity.ts        # ECDSA P-256 key generation + signing        [DONE]
      device-store.ts           # IndexedDB + InMemory key persistence        [DONE]

    tokens/
      jwt.ts                    # JWT encode/decode/verify (HS256, < 100 LOC) [DONE]
      token-manager.ts          # Server-side token lifecycle + revocation    [DONE]
      token-store.ts            # localStorage token persistence              [DONE]
      encrypted-token-store.ts  # AES-256-GCM encrypted localStorage          [DONE]

    encryption/
      database-encryption.ts    # AES-256-GCM encrypt/decrypt primitives      [DONE]
      key-derivation.ts         # PBKDF2-SHA256 (600K iterations)             [DONE]
      auto-lock.ts              # Inactivity timer, lock/unlock               [DONE]
      operation-encryptor.ts    # E2E encryption for sync operations          [DONE]

    passkey/
      passkey-client.ts         # WebAuthn credential creation + assertion    [DONE]
      passkey-server.ts         # Server-side verification + CBOR decoder     [DONE]

    provider/
      adapter.ts                # AuthProviderAdapter + BuiltInProvider       [DONE]
      built-in/
        auth-routes.ts          # Server route handlers for auth              [DONE]
        password-hash.ts        # PBKDF2-SHA512 (600K iterations)             [DONE]
        user-store.ts           # InMemoryUserStore (dev/test)                [DONE]
        password-reset.ts       # Self-service password reset                 [Phase 5]
        email-verification.ts   # Email ownership verification               [Phase 5]
      external/
        external-jwt-provider.ts # Base adapter for any JWT issuer            [DONE]
        clerk-adapter.ts         # Clerk RS256/JWKS adapter                   [DONE]
        supabase-adapter.ts      # Supabase HS256 adapter                    [DONE]
      oauth/
        oauth-types.ts          # OAuth types and config                      [Phase 5]
        oauth-flow.ts           # Authorization URL + code exchange           [Phase 5]
        google-provider.ts      # Google OAuth / OIDC                         [Phase 5]
        github-provider.ts      # GitHub OAuth                                [Phase 5]
        microsoft-provider.ts   # Microsoft Entra ID / Azure AD              [Phase 5]

    org/
      org-types.ts              # Organization, Membership, Role types        [Phase 4]
      org-store.ts              # OrgStore interface + InMemoryOrgStore        [Phase 4]
      org-routes.ts             # Org CRUD route handlers                     [Phase 4]
      invitation-store.ts       # InvitationStore + InMemoryInvitationStore   [Phase 4]
      invitation-routes.ts      # Invitation route handlers                   [Phase 4]

    rbac/
      rbac-types.ts             # Permission, RoleDefinition types            [Phase 4]
      rbac-engine.ts            # Permission evaluation engine                [Phase 4]
      scope-resolver.ts         # RBAC roles → sync scopes                   [Phase 4]

    mfa/
      totp.ts                   # TOTP generation + validation (RFC 6238)     [Phase 5]
      mfa-routes.ts             # MFA enrollment + verification               [Phase 5]

    session/
      session-store.ts          # Session tracking + management               [Phase 5]
      session-routes.ts         # Session management routes                   [Phase 5]

    react/
      hooks.ts                  # useAuth, useCurrentUser, useAuthStatus      [DONE]
      auth-provider.tsx         # AuthProvider context                         [DONE]
      org-hooks.ts              # useOrg, useOrgMembers, usePermission        [Phase 4]

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
- [x] No auth operation ever loses user data
- [x] Expired tokens never block local operations
- [x] Device revocation propagates within one sync cycle
- [x] Password hashing uses PBKDF2-SHA512 with 600K iterations (OWASP-compliant)
- [x] All cryptographic operations use Web Crypto API (browser) or `node:crypto` (Node)
- [x] No secrets stored in plaintext (encrypted token store available)
- [x] Refresh token reuse detection (replay triggers device-wide revocation)
- [x] Algorithm confusion prevention in JWT verification

### For developer experience:
- [x] 3 lines of config to add auth to a Kora app
- [x] Zero distributed systems knowledge required
- [x] Clear error messages with context for debugging
- [x] TypeScript autocomplete for all auth APIs
- [x] Works with React StrictMode and concurrent mode
- [ ] Single command to scaffold auth (Phase 4+)
- [ ] Pre-built UI components for common flows (Phase 5+)

### For offline-first:
- [x] Sign in once, work offline for weeks
- [x] All local operations preserved regardless of auth state
- [x] Seamless reconnection: no data loss, no duplicate sync
- [x] Auto-lock with configurable timeout
- [x] Database encryption with AES-256-GCM
- [x] E2E operation encryption for sync (server can't read user data)

### For SaaS (Phase 4+):
- [ ] Multi-tenant data isolation via org-aware scopes
- [ ] RBAC with role hierarchy (owner > admin > member > viewer)
- [ ] Invitation system with email-based invites
- [ ] Org switching without re-authentication
- [ ] Permission-aware React hooks
- [ ] Admin API for user/org management

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
| E2E operation encryption | No | No | No | Yes (AES-256-GCM per-operation) |
| Passkeys / WebAuthn | Yes | No | No | Yes (client + server) |
| External provider adapters | N/A (is provider) | N/A | N/A | Yes (Clerk, Supabase, custom) |
| Encrypted token storage | No | No | No | Yes (AES-256-GCM localStorage) |
| Refresh token reuse detection | Yes | Partial | No | Yes (device-wide revocation) |
| Works without internet | No | No | Partially | Fully |
| Open source | No | No | Partially | Yes |
| Multi-tenancy | Yes | No (BYO) | No | Phase 4 (planned) |
| RBAC | Yes | Custom claims | No | Phase 4 (planned) |
| OAuth social login | Yes | Yes | No | Phase 5 (planned) |
| MFA / TOTP | Yes | Yes | No | Phase 5 (planned) |
| Password reset | Yes | Yes | N/A | Phase 5 (planned) |

---

*Kora: independent strings, shared harmony.*
