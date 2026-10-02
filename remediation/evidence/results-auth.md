# Verification results: AUTH-1 .. AUTH-14 (+ NEW-AUTH-1)

Verifier: independent. Every claim was re-derived from source. All repros live in
`packages/auth/tests/repro/` and assert the CORRECT behavior, so they fail today and pass once fixed.
Run: `cd packages/auth && npx vitest run tests/repro/<ID>.test.ts`.
Current state: 15 files, 27 tests, 27 failing, every failure an `AssertionError` (no setup errors).

Entry points used: `createKoraAuthServer()` + `handleRequest()` (the documented quickstart),
`auth.auth` / `routes.toSyncAuthProvider()` fed into a real `KoraSyncServer` over
`createServerTransportPair` (the documented sync wiring), plus the documented `MixedAuthProvider` / `KoraAuthProvider` / `OrgRoutes` / `PasswordResetManager` / `TotpManager`.

| ID | Verdict | Sev | Effort |
|---|---|---|---|
| AUTH-1 | CONFIRMED (high confidence) | P0 | M |
| AUTH-2 | CONFIRMED | P1 | S |
| AUTH-3 | CONFIRMED (server side; exploitation needs a victim click) | P1 | M |
| AUTH-4 | CONFIRMED (library level; wiring is app-owned, but the shipped client steers to the vulnerable wiring) | P1 | S |
| AUTH-5 | CONFIRMED | P1 | M |
| AUTH-6 | CONFIRMED | P2 | S (in-memory) / M (store interface) |
| AUTH-7 | CONFIRMED: (a) misconfiguration footgun with no prod guard, (b) default | P1 (a) / P2 (b) | S |
| AUTH-8 | CONFIRMED | P2 | S |
| AUTH-9 | CONFIRMED (timing and brute force); sign-up 409 is a low-risk design choice | P2 | S |
| AUTH-10 | CONFIRMED | P1 (issuance) / P2 (brute force) / P3 (disable replay) | M |
| AUTH-11 | CONFIRMED | P1 | M |
| AUTH-12 | CONFIRMED (documented limitation, but no persistent implementation ships) | P2 | M |
| AUTH-13 | CONFIRMED, wider than claimed | P1 | S |
| AUTH-14 | CONFIRMED for UV / ExternalJwt / webhooks; AdminApi is PARTIAL | P3 | S each |
| NEW-AUTH-1 | CONFIRMED | P1 | S |

---

## AUTH-1: sync scope is client-controlled under the documented wiring. CONFIRMED, P0

**Evidence:** `tests/repro/AUTH-1.test.ts` (4 tests, all fail):
- `createKoraAuthServer().auth` and a real KoraSyncServer, with schema `todos.scope=['userId']`. Mallory (valid account) handshakes with `syncScope:{todos:{userId:<alice>}}`. The server echoes `acceptedScope == {todos:{userId:alice}}` and Mallory receives `'alice secret'`. Mallory uploads `{userId:alice,title:'planted'}`: the store goes from 1 to 2 ops and the row is relayed to Alice (`expected ['planted'] to not include 'planted'`).
- With no `syncScope`, Mallory receives every tenant's rows (`expected ['alice secret'] to not include ...`). The server only `console.warn`s.
- Documented `MixedAuthProvider`: an anonymous (empty-token) client with `anonymousScopes:{notes:{...}}` handshakes `{todos:{}}` and receives Alice's todos.
- `KoraAuthProvider` with `resolveScopes` (the alternative the warning text recommends) returns only `{todos:{userId}}`. A handshake of `{notes:{}}` still gets `acceptedScope` keys `['notes','todos']`.

**Locations:**
- `packages/auth/src/provider/built-in/auth-routes.ts:966-1008`: `toSyncAuthProvider().authenticate` returns `{userId, metadata}` with no `scopes`.
- `packages/auth/src/provider/built-in/quickstart-server.ts:122`: the quickstart exports exactly that provider, and there is no option to add scopes.
- `packages/server/src/scopes/resolve-session-scopes.ts:31-32`: the handshake becomes the base when there are no scopeValues.
- `resolve-session-scopes.ts:45-46,59-64`: the handshake merge adds collections absent from auth scopes. Per `server-scope-filter.ts:72-73`, a missing collection means hidden, so adding one grants access.
- `packages/server/src/session/client-session.ts:740-753`: an undefined auth scope plus a handshake gives a handshake-only scope that is used for both downlink and uplink.
- `packages/server/src/auth/mixed-auth-provider.ts:91-104`.

**Intent:** `resolve-session-scopes.test.ts:38` deliberately tests "handshake scope used when auth is absent". The docs (`authentication.md:218-316`, `sync-configuration.md:120-136`) tell developers that scope is built client-side from JWT claims, and say "If you used the server setup above, sync is already protected." This is intentional but harmful.

**Avoiding config:** none via `createKoraAuthServer`. A hand-wired `KoraAuthProvider({resolveScopes})` pins the declared collections, but it is not the default or the quickstart, and it still leaks undeclared collections.

**Root cause:** the server treats client-declared scope as authorization, not as a narrowing filter.

**Fix:**
1. `toSyncAuthProvider()` / `createKoraAuthServer({ resolveScopes?, scopeFromClaims? })` must return server-derived scopes. The default should derive them from the verified JWT (`sub` → `userId` binding through `buildScopeMap(schema, {userId: sub, ...})`) when the server store has a schema.
2. In `resolveSessionScopes`, when `authScopes !== undefined`, the result is an intersection: the collection set is `keys(authScopes)` only, and per collection it is `{...handshake[c], ...auth[c]}` (handshake can only narrow).
3. When an authenticated provider (not `NoAuthProvider` or null) yields no scopes and the schema has scoped collections, deny with `SCOPE_REQUIRED` instead of warning.
4. Do the same for `MixedAuthProvider`: the anonymous collection set must equal `keys(anonymousScopes)`.

**Invariant:** `effectiveScope ⊆ serverGrant` per collection and per field.

**Regression risk:** apps relying on client-only scope will see empty or denied sync until they configure scopes. That is a breaking change, so ship a migration note.

## AUTH-2: revoked device keeps working on refresh and HTTP. CONFIRMED, P1

**Evidence:** `AUTH-2.test.ts`. The owner revokes "laptop" from "phone" (200). Then the laptop's refresh token gets `/auth/refresh` → 200 (expected 401), and the laptop's access token gets `/auth/me` → 200 and `/auth/devices` → 200. The revoked laptop can then `DELETE /auth/device/phone` → 200, revoking the owner's remaining device. The sync path does reject it (`validateTokenWithRevocation`).

**Locations:**
- `token-manager.ts:444-476`: `refreshAccessToken` checks `isRevoked(jti)` but not `isDeviceRevoked(dev)`, and does not check `userStore` device.revoked.
- `auth-routes.ts:554,588,627,657,713,791` and `quickstart-server.ts:451`: they use the sync `validateToken` (no revocation).
- The documented `/auth/password/change` and `/auth/mfa/verify` snippets also use `validateToken` (`authentication.md:713-731,529-541`).

**Fix:**
- `refreshAccessToken`: reject when `isDeviceRevoked(payload.dev)`, and inject a device check hook so `BuiltInAuthRoutes.handleRefresh` also consults `userStore.findDevice(dev)?.revoked`.
- Every HTTP handler and `requireAuthUser` must use `validateTokenWithRevocation` plus the device-revoked check. Factor this into one `authenticateAccess(token)` helper.

**Invariant:** no credential whose `dev` is revoked is accepted on any path.

**Regression risk:** low. Tests that rely on revoked tokens working on `/me` will break, as intended.

## AUTH-3: OAuth state not bound to initiator or purpose. CONFIRMED, P1

**Evidence:** `AUTH-3.test.ts`, with a fake IdP via `oauth.fetch`. Unauthenticated `GET /auth/oauth/acme` mints a state. Alice's authenticated `POST /auth/oauth/acme/link` with Mallory's code+state → 201. Mallory's later OAuth sign-in returns Alice's user id.

**Locations:**
- `oauth-flow.ts:184-187`: the only check is state existence plus provider.
- `quickstart-server.ts:266-271`: the state is minted with no session or browser binding and no purpose.
- `quickstart-server.ts:292-300`: link accepts any state.
- `quickstart-server.ts:365,369`: `deviceId` and `devicePublicKey` taken from attacker-controllable state metadata (from the query) on sign-in.

**Login CSRF:** the same root cause. The client (`auth-client.ts:507`) keeps no record of the state it started, so a crafted callback URL logs the victim into the attacker's account. In an offline-first app, the victim's local writes then sync into the attacker's tenant.

**Reachability:** requires an app callback page that reads `code`/`state` from the URL, which is the documented pattern, plus one victim click.

**Fix:**
- `getAuthorizationUrl(provider, {purpose:'signin'|'link', userId?, bindingHash})` stores `purpose`, `userId` (for link), and `sha256(binding)`. The binding is a random value returned to the client: an HttpOnly cookie for web, kept in memory for native/PKCE.
- `handleCallback(provider, code, state, {purpose, userId?, binding})` rejects on purpose, user, or binding mismatch.
- Add a `/oauth/:p/link/start` endpoint that requires auth.
- Never accept `deviceId` from state metadata.

**Invariant:** a state is redeemable only by the same client, for the same purpose, and (for link) the same user that minted it.

**Regression risk:** medium. This changes client/server OAuth handshake fields.

## AUTH-4: invitations. CONFIRMED, P1

**Evidence:** `AUTH-4.test.ts`.
- (a) `listMyInvitations('bob@example.com')` returns Bob's invitation including `token`.
- (b) `acceptInvitation('mallory-1', {token})` → 200, and Mallory becomes an **admin** member.
- (c) Mallory, as owner of org B, calls `revokeInvitation('mallory-1', orgB, <orgA invitation id>)` → 200, and Org A's invitation disappears.

**Locations:**
- `org-routes.ts:643-650`: email is a parameter, and the full `OrgInvitation` including `token` is returned.
- `client/org-client.ts:299-300`: the shipped client sends `GET /invitations?email=<any>`.
- `org-routes.ts:564-596`: no invitee-email check.
- `org-routes.ts:600-617` and `OrgStore.revokeInvitation(invitationId)`: no `orgId` scoping.

**Fix:**
- `listMyInvitations(userId)` resolves the verified email server-side and strips `token`.
- `acceptInvitation(userId, {token}, {userEmail, emailVerified})` requires `invitation.email === normalize(userEmail) && emailVerified`.
- Make it `revokeInvitation(orgId, invitationId)` in the store and throw NotFound when `invitation.orgId !== orgId`.

**Invariant:** an invitation is visible to, and redeemable by, only the owner of the verified invited email, and mutable only within its own org.

**Regression risk:** low. The signature changes are breaking for app wiring.

## AUTH-5: client-chosen deviceId is not bound to the user. CONFIRMED, P1

**Evidence:** `AUTH-5.test.ts`. Mallory signs in with `deviceId:'alice-laptop'` → 200, and her access token has `dev:'alice-laptop'`. She replays her own refresh token once, which triggers `revokeAllForDevice('alice-laptop')`. Alice's valid token is now rejected by sync (`expected null not to be null`).

The device id is not secret: `createKoraAuthSync` uses `dev` as the sync node id, which is stamped on every op and in version vectors.

**Locations:**
- `auth-routes.ts:393,396-401,483-491,755-760` and `quickstart-server.ts:365-371`: `registerDevice` with a client id.
- `user-store.ts:246-249`: an existing active device is returned regardless of `userId`. The SQLite and Postgres stores behave the same (`sqlite-user-store.ts:153`, `postgres-user-store.ts:135`), and they re-activate a revoked device without checking the owner.
- `token-manager.ts:465`: reuse detection revokes the device id globally.
- Default `device-${userId}` (`auth-routes.ts:393,483`): all deviceId-less browsers of a user share one device.

**Fix:**
- `registerDevice` must throw `DeviceOwnershipError` when `existing.userId !== params.userId`, and routes return 409.
- Namespace device ids server-side: `dev = H(userId || clientDeviceId)`, or a server-generated id returned to the client.
- Default to a random id, not `device-${userId}`.

**Invariant:** a token's `dev` always refers to a device owned by `sub`.

**Regression risk:** low or medium. Existing shared default ids will need migration.

## AUTH-6: refresh rotation is not atomic. CONFIRMED, P2

**Evidence:** `AUTH-6.test.ts`. Five concurrent refreshes with one token give 5 × 200 (expected ≤1).

**Location:** `token-manager.ts:460-470`: `isRevoked` → `await` → `revoke`. The `TokenRevocationStore` interface (`:28-57`) has no atomic consume, so even a correct database implementation cannot fix it.

**Fix:** add `consume(jti, exp): Promise<boolean>` (atomic test-and-set: `SET NX` or `INSERT ... ON CONFLICT DO NOTHING RETURNING`) and use it in `refreshAccessToken`. A false result means reuse.

**Invariant:** each refresh `jti` mints at most one successor.

**Regression risk:** this is an interface addition. Keep the fallback path for old stores, but log a warning.

## AUTH-7: password reset. CONFIRMED

**Evidence:** `AUTH-7.test.ts`.
- (a) With `NODE_ENV=production` and no `onResetRequested`, `requestReset(victimEmail)` returns `data.token`, and `resetPassword(token, ...)` → 200. That is account takeover by anyone who knows an email. The response message also differs for existing accounts, which enables enumeration.
- (b) After a legitimate reset, the old refresh token still refreshes (200) and the old access token still passes sync.

**Locations:**
- `password-reset.ts:254-257`: token in the response. Intent: `password-reset.test.ts:34-56` tests it as "development mode". It is intentional but unguarded.
- `password-reset.ts:283-298` and `:339`: no session or token revocation. The manager has no `TokenManager` dependency.
- `password-reset.ts:283-295`: get-then-consume is also non-atomic (minor).

**Fix:**
- (a) Throw in the constructor when `!onResetRequested && NODE_ENV === 'production'`. Otherwise, return the token only behind an explicit `exposeTokenForDevelopment: true`.
- (b) Add an `onPasswordChanged(userId)` hook, or a `tokenManager` dependency plus a per-user `revokeAllForUser(userId, before=now)` (store `tokensValidAfter[userId]` and reject `iat < tokensValidAfter`). Call it from `resetPassword` and `changePassword`.

**Invariant:** a reset token reaches only the mailbox, and a password change kills every earlier credential.

**Severity:** P1 (a), P2 (b). **Effort:** S (a), M (b; needs a per-user revocation primitive, which also fixes the AdminApi and AUTH-11 gaps).

## AUTH-8: sign-out does not stop the access token on HTTP routes. CONFIRMED, P2

**Evidence:** `AUTH-8.test.ts`. After `/auth/signout` → 200, `auth.auth.authenticate(token)` is null (sync is correct), but `/auth/me` → 200 and `/auth/devices` → 200.

**Root cause, fix and lines:** shared with AUTH-2 (the `validateToken` call sites). The lifetime of the exposure is bounded by the 15-minute access TTL.

**Regression risk:** low.

## AUTH-9: enumeration and brute force. CONFIRMED, P2

**Evidence:** `AUTH-9.test.ts`.
- (a) Wrong-password sign-in averages about 400-640 ms; unknown-email sign-in about 0.12 ms. The difference is trivially observable.
- (b) 15 guesses against one account from rotating IPs: all 401, no 429.

**Locations:**
- `auth-routes.ts:459-465`: return before PBKDF2 (600k iterations, `password-hash.ts:4`).
- `auth-routes.ts:447-449`: the limiter key is `email:ip`.
- IPs are attacker-chosen because `production-server.ts:320-325` trusts the left-most `X-Forwarded-For` (cross-ref SEC-9).
- `auth-routes.ts:383-387`: sign-up returns 409. This is an explicit enumeration design choice and is low risk.

**Side effect:** sign-in is a 400 ms CPU (threadpool) cost per unauthenticated request with no global limit, which is a DoS lever.

**Fix:**
- Run `verifyPassword` against a fixed dummy hash when the user is missing.
- Rate-limit with two keys: `signin:email` (per account, with backoff or lock) and `signin:ip`.
- Use a socket address, or a configured trusted-proxy hop count, instead of the raw XFF.

**Invariant:** response time and status are independent of account existence, and per-account guesses are bounded regardless of IP.

**Regression risk:** low. A per-account lock enables targeted lockout, so use backoff rather than a hard lock.

## AUTH-10: MFA. CONFIRMED

**Evidence:** `AUTH-10.test.ts`.
- (a) After more than 100 wrong `verify()` calls, the right code still returns true. There is no attempt limit; across a 1e6 space with about 3 valid codes per 30 s, roughly 3.3e5 tries succeed in expectation.
- (b) A code consumed by `verify()` is accepted again by `disable()`.

**Issuance (code reading):** `handleSignIn` (`auth-routes.ts:426-507`) and `completeOAuthSignIn` issue full access and refresh tokens and never consult `TotpManager`. `TokenPayload` has no MFA claim. The sync provider accepts them. The documented "Step 3: Verify on Login" (`authentication.md:713-731`) runs after tokens are already issued, so a password-only attacker gets full sync and HTTP access to an MFA-enabled account.

**Locations:** `totp.ts:273-284` (no limiter); `totp.ts:356` (`validateCode`, not `consumeCode`); also `regenerateRecoveryCodes` at `totp.ts:328`.

**Fix:**
- Sign-in for MFA-enrolled users returns `{mfaRequired, mfaToken}`: short-lived, type `mfa_pending`, rejected by `toSyncAuthProvider` and all routes. A `/auth/mfa/verify` step exchanges `mfaToken` plus a code for real tokens carrying an `amr:['pwd','otp']` claim.
- Give `TotpManager` a per-user failure counter with exponential backoff (persist it in `TotpSecret`).
- Use `consumeCode` in `disable` and `regenerateRecoveryCodes`.

**Invariant:** no full-privilege token is issued to an MFA user without a fresh second factor.

**Severity:** P1 (issuance), P2 (brute force), P3 (replay).

## AUTH-11: live sync sessions are never re-checked. CONFIRMED, P1

**Evidence:** `AUTH-11.test.ts`. The laptop session is open, and the owner revokes the laptop (200); a new laptop handshake is correctly refused. The open laptop session still receives the owner's post-revocation write, and its own upload is persisted (store has 2 ops, expected 1). The same applies to sign-out, password reset and role changes, and to access tokens past their 15-minute expiry.

**Locations:** auth runs only in `client-session.ts:727-738` (`handleHandshake`). `KoraSyncServer` (`kora-sync-server.ts`) exposes no `disconnectWhere(userId|deviceId)` or re-validation API, and the auth package has no hook into the sync server.

**Fix:**
- Store the token `exp` in `AuthContext` and close the session with `AUTH_EXPIRED` (retriable) at expiry, so the client re-handshakes with a fresh token.
- Add `KoraSyncServer.terminateSessions({userId?, deviceId?})`.
- Have `createKoraAuthServer` accept an `onRevoke` hook, or return a `bindSyncServer(server)` that wires device revoke, sign-out and reset to termination.

**Invariant:** session lifetime ≤ token lifetime, and revocation is effective within O(seconds).

**Regression risk:** medium. There will be more reconnects, so the client must refresh tokens on `AUTH_EXPIRED`.

## AUTH-12: in-memory revocation store in the quickstart. CONFIRMED, P2

**Evidence:** `AUTH-12.test.ts`. Sign out, then construct a new `createKoraAuthServer` with the same secret and user store (a restart or a second replica). The revoked refresh token → 200, and the revoked access token passes sync.

**Location:** `quickstart-server.ts:152-156`. It is overridable via `tokenManagerOptions.revocationStore`. The production checklist says to use a persistent store (`authentication.md:1367`), but **no persistent `TokenRevocationStore` ships** (only `InMemory`), while SQLite and Postgres user and OAuth stores do.

**Related:** the quickstart example (`authentication.md:64-77`) also omits `userStore`, so it defaults to `InMemoryUserStore` (`quickstart-server.ts:105`) and every user is lost on restart.

**Fix:**
- Ship `createSqliteTokenRevocationStore` and a Postgres equivalent, including the atomic `consume` from AUTH-6.
- Have `createKoraAuthServer` throw in production when `userStore` or `revocationStore` is in-memory, unless `allowInMemory:true` is set.

**Regression risk:** low.

## AUTH-13: offline users are signed out and their refresh token destroyed. CONFIRMED (wider than claimed), P1

**Evidence:** `AUTH-13.test.ts`. With an expired access token, a valid refresh token, and a `fetch` that throws `TypeError('Failed to fetch')`:
- `initialize()` leaves state `unauthenticated` and storage refresh token `null`.
- `getAccessToken()` alone also wipes storage. Sync calls this on every reconnect attempt, so this happens mid-session too, not only at startup.

**Locations:** `auth-client.ts:811-825` (`performRefresh` catches every error, then calls `storage.clear()` and sets unauthenticated); `auth-client.ts:411-424` (initialize). Contrast `restoreSession` at `:698-715`, which already handles network failure.

**Fix:** in `performRefresh`, clear only on a definitive server rejection (HTTP 400/401 with `AUTH_SERVER_ERROR`). On network or 5xx failure, keep tokens, keep the state `authenticated` (offline, user from cached JWT), return null, and retry with backoff.

**Invariant:** only the server can end a session; network loss cannot.

**Regression risk:** low. Ensure a 401 still clears.

## AUTH-14: lows

**Evidence:** `AUTH-14.test.ts`, 5 tests, all fail.

1. **Passkey UV.** CONFIRMED, P3. `generate*Options` sets `userVerification:'required'` (`passkey-server.ts:44,109`), but `verifyAuthenticationResponse` checks only UP (`:504-510`), and registration likewise (`:253`). A correctly signed assertion with flags `0x01` returns `verified:true`.
   - Fix: add a `requireUserVerification=true` param and reject when `(flags & 0x04)===0`.
2. **ExternalJwtProvider HS256.** CONFIRMED, P3. A token with no `exp` is accepted (`external-jwt-provider.ts:426` → `jwt.ts:230-233` returns false when `exp` is missing). `aud` and `iss` are never checked, so a token for another audience sharing the secret is accepted. It also returns no scopes, so AUTH-1 applies to every external adapter.
   - Fix: require numeric `exp`, add `audience`/`issuer` config and enforce them when set (and by default for the Supabase adapter: `aud:'authenticated'`).
3. **Webhooks.** CONFIRMED, P3.
   - `verifyWebhookSignature` (`webhooks.ts:321-333`) has no timestamp window and no timestamp in the signed header, so a delivery captured 24 h earlier verifies.
   - `register()` (`:212-229`) accepts `http://169.254.169.254/...`. This is blind SSRF (status only), reachable only by whoever can register endpoints.
   - Fix: sign `${timestamp}.${body}`, send `X-Webhook-Timestamp`, verify with a tolerance (default 5 min); validate the URL scheme (https), and resolve and deny private, link-local and loopback addresses at delivery time.
4. **AdminApi trusts adminId.** PARTIAL, P3. `adminId` is used only for audit attribution, and `AdminUnauthorizedError` (`admin-api.ts:75`) is declared but never thrown. The class is a server-side library and the docs do not claim it authorizes, so this is harmless if the app gates the route; that is why it is PARTIAL.
   - More consequential: `revokeUserSessions` (`:215-220`) deletes `SessionStore` rows only, so JWT and refresh tokens stay valid (same root cause as AUTH-7b).
   - Fix: accept an `isAdmin(adminId)` predicate in config and throw `AdminUnauthorizedError`; wire `revokeUserSessions` and `deleteUser` to per-user token revocation.

## NEW-AUTH-1: permanent device-id ban, with a benign trigger. CONFIRMED, P1

**Evidence:** `NEW-AUTH-1.test.ts`. A user refreshes and the response is lost; the client retries with the same refresh token, which trips reuse detection and calls `revokeAllForDevice('phone')`. The user then signs in again with their password from the same device (sign-in → 200), but `auth.auth.authenticate(newToken)` is null. Sync is locked out until the process restarts with the in-memory store, and permanently with any persistent store implementing the interface.

Realistic triggers:
- Two tabs sharing localStorage tokens, each with its own `_refreshPromise` dedupe (`auth-client.ts:784-797`).
- The default `createKoraAuth` device identity gives a stable `deviceId`.
- The `device-${userId}` default shared by all browsers.
- AUTH-5 (an attacker-triggered ban).

**Locations:** `token-manager.ts:81-90` (`revokedDevices` is a permanent Set keyed by device id); `token-manager.ts:393-396`; `token-manager.ts:465`; `auth-routes.ts:396-401,486-491` (re-sign-in re-registers the same id without clearing).

**Fix:** record device revocation as `revokedBefore[deviceId] = now` and reject only tokens with `iat <= revokedBefore`. A fresh password sign-in (or device re-verification) issues tokens with a later `iat`, so it recovers. Alternatively, rotate to a new server-issued device id on re-registration. Replace reuse-triggered whole-device revocation with revocation of the token family (`familyId` claim).

**Invariant:** a successful primary authentication always yields a usable credential.

**Regression risk:** low.

---

## Notes for other verifiers
- AUTH-1 composes with SEC-2/SEC-3: a forged `nodeId` plus AUTH-5's victim `dev` claim lets an attacker write ops that look like the victim's device.
- AUTH-9's limiter bypass depends on SEC-9 (the XFF trust); it was independently confirmed at `production-server.ts:320-325`.
