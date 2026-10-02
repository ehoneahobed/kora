# LMS report Part A (@korajs/auth) — independent verification (items #1–#4)

HEAD 91c6350 (1.0.0-beta.12). Source: `packages/auth/src`; dist quoted by the report matches src behaviour (dist `performRefresh` is at line 538 and `initialize` at line 197, so the report's line numbers are correct for dist; src is `auth-client.ts:811-826` and `389-425`).
Repro tests (all fail at HEAD; the guard tests pass): `packages/auth/tests/repro/LMS-1.test.ts` (13 fail / 1 guard pass), `LMS-2.test.ts` (5 fail / 2 guards pass), `LMS-4.test.ts` (2 fail). No test for #3 because its problem is refuted.
To check whether the LMS patches work, I applied them verbatim to `AuthClient.prototype` in throwaway copies of the suites, then deleted the copies. Results are below.

---

## #1 `performRefresh()` destroys the session on any error

**Problem: CONFIRMED** (same defect as AUTH-13, lines 811-826).
- `catch {}` → `storage.clear()` + `setState('unauthenticated')` for every failure. Reproduced through `createKoraAuth().getAccessToken()` for 9 transient classes: fetch TypeError, AbortError, 500, 502-HTML, 503+Retry-After, 504, 429, 511, and 200-HTML from a captive portal. In every case the 90-day refresh token is deleted and the state becomes `unauthenticated`. The 401 control behaves correctly.
- Factual corrections:
  - The `AUTH_NETWORK_ERROR` classification does not cover "timeout". `request()` sets no timeout, so a lie-fi request can hang indefinitely. While it hangs, every caller waits on the shared `_refreshPromise` (repro: `bounded timeout` test).
  - A captive portal that returns 200 HTML does not produce an `AuthError` at all. `response.json()` throws a `SyntaxError`, which is unclassified.
  - "Destroys a 90-day token" is only half true. The token is deleted locally, but it stays valid on the server: it is discarded, not revoked.

**Proposed fix: REJECT as written** (it is the right direction, but it is under-specified). The LMS patch passes only 3 of 14 repro cases (TypeError, AbortError, and the control):
- **Only one transient class is handled.** 5xx, 429, 502/504 HTML from proxies, 511, and captive-portal 200-HTML (`SyntaxError`) still wipe the session. A Ghana 2G/captive-Wi-Fi deployment hits exactly these.
- **The rule is backwards.** It is "clear unless network error". It should be "keep unless definitive rejection".
- **No timeout, backoff or Retry-After handling.**
  - Returning `null` leaves the token, but every consumer re-triggers a network refresh. `createKoraAuthSync` calls `getAccessToken()` in `auth`, `resolveSyncState`, `resolveScopeMap`, `resolveNodeId` and `resolveUserId`, and the sync reconnect loop calls `auth()` on each attempt. `_refreshPromise` only de-duplicates calls that are in flight at the same moment.
  - Repro: 10 offline calls must make ≤2 refreshes, and the token must survive.
- **State becomes inconsistent for callers.** After a transient failure, `getAccessToken()` returns `null`. `createKoraAuthSync.resolveSyncState()` maps `null` to `signed-out`. `AuthBoundKoraProvider` then closes the app and renders `signedOut`, and `AuthSyncCoordinator` suspends sync with `auth-required`. So the patch keeps the token but the UI still behaves as signed out (see #2).
- **It ignores refresh-token rotation.** The Kora server rotates refresh tokens with reuse detection and no grace window (`token-manager.ts:444-477`, `auth-routes.ts:521-535`). Two failure modes follow, both reproduced against the real `TokenManager`:
  1. **Lost response.** The server commits the rotation, then the response is lost (common on 2G). The client keeps the old refresh token, as the patch intends. The retry is then treated as reuse: `revokeAllForDevice`, 401, sign-out.
  2. **Two tabs.** Two tabs share one storage and refresh at access-token expiry. The second refresh is flagged as reuse, gets a 401, and clears the shared storage, so both tabs are signed out. This matters because Kora explicitly supports multi-tab through the leader/follower SQLite setup.

**State-of-the-art design:**
1. **Classify on a typed server answer, not on whether an exception was thrown.**
   - Clear tokens only on a definitive rejection from the Kora auth server: HTTP 401 (or 400 with `error: invalid_grant`, RFC 6749 §5.2) **and** a JSON body carrying a Kora error code. Add `code: 'REFRESH_TOKEN_INVALID'` to `handleRefresh`; today the body is only `{ error: string }`.
   - Requiring the body code matters because captive portals and proxies also emit 401/403/407.
   - Everything else is transient: network errors, aborts and timeouts, 408, 425, 429, 5xx, 511, non-JSON bodies, and 2xx bodies without tokens. Transient failures keep the tokens and the state.
   - This is the model used by Firebase Auth (signs out only on `user-disabled` / `user-token-expired`, `packages/auth/src/core/user/invalidation.ts`) and MSAL (only `InteractionRequiredAuthError` requires interaction; network and server errors go to the app's retry policy).
2. **Bound and pace refresh attempts.**
   - Per-attempt timeout via `AbortController`, around 15–20 s.
   - Single-flight refresh plus a persisted cooldown: exponential backoff with full jitter, honouring `Retry-After`.
   - Reset the backoff on the `online` event, on `visibilitychange`, and when the sync transport opens.
   - `navigator.onLine === false` may short-circuit (skip) an attempt as a hint. It must never decide session validity.
3. **Make refresh rotation-safe across tabs.**
   - Wrap refresh in a Web Lock (`navigator.locks.request('kora-auth-refresh')`).
   - After acquiring the lock, re-read storage. If the refresh token has changed, use the stored pair instead of refreshing again.
   - Broadcast new tokens via `BroadcastChannel`.
4. **Server side** (route to the server reviewer):
   - Add a short reuse grace interval (Auth0 "reuse interval", Okta grace period) that returns the already-issued successor pair, so lost responses are idempotent.
   - Make check-then-revoke atomic.
5. **Expose the outcome.** Return a typed `AuthError` (`AUTH_REFRESH_TRANSIENT` / `AUTH_REFRESH_REJECTED`) or a status, and emit an event, instead of silently returning `null`.

**Adjacent defects found while verifying (not in the report; HIGH, route to the server/auth owners):**
- `TokenManager.refreshAccessToken` never checks `isDeviceRevoked`. Verified: after `revokeDeviceTokens('d')`, `refreshAccessToken` still mints a new pair. A revoked device can keep refreshing, and reuse detection's `revokeAllForDevice` does not stop the refresh chain.
- Concurrent reuse is a TOCTOU (time-of-check to time-of-use) race. Two simultaneous refreshes with the same token both succeed.
- `restoreSession()` treats a 401 from `/auth/me` as "offline" and authenticates from the JWT anyway (`auth-client.ts:698-716`).

**AUTH-13 overlap:** identical defect. AUTH-13's rule (clear only on definitive 400/401; keep on network/5xx) is more correct than the LMS patch. Refinements: require the typed body code, treat 429/511/non-JSON as transient, and add the timeout, backoff, cross-tab lock and server grace window.
**Severity: P0.** **Effort:** classification + timeout + backoff is S (~1 day). Web Locks is S–M. Server grace window + atomic consume + device check is M.

---

## #2 `initialize()` clears tokens on an offline cold start

**Problem: CONFIRMED** (AUTH-13, lines 411-424). With an expired access token, a valid refresh token and fetch rejecting, the result is `unauthenticated` with tokens wiped. The same happens with captive-portal 200-HTML. Afterwards, coming back online cannot recover the session (repro).
Factual errors in the report:
- **`this.isOnline()` does not exist** anywhere in Kora (`grep` finds nothing in any `src`). As written, the call sits outside the `try`, so `initialize()` would reject with a TypeError on exactly the offline path, and the state would stay `loading` forever. Even TypeScript would reject the patch.
- **"The local SQLite store is gated by userId namespace, correctly extracted from the expired token" is false.**
  - `createKoraAuthSync.resolveUserId()` and `resolveSyncState()` derive identity from `getAccessToken()`, which is `null` offline once the access token has expired.
  - So `namespaceByAuthUser` opens `<db>__user_signed-out` (`initialize-app.ts:55-59, 264`), and `AuthBoundKoraProvider` renders `signedOut` (`auth-bound-kora-provider.ts:113,190`).
  - This contradicts the binding's own contract ("Tokens are never used as readiness signals", `core/src/bindings/types.ts:83`).
- **"restoreSession() already handles this — no new code path" is incomplete.** `restoreSession` also swallows 401s (see #1).

**Proposed fix: REJECT.** Verbatim (with a stub `isOnline` added) it passes the plain offline case but fails three cases:
- **Lie-fi** (captive portal, `navigator.onLine === true`): the session is still wiped.
- **Sync binding / namespacing still report signed-out**, so the app never mounts the user's local data. The report's headline claim ("cold-start offline and show locally cached data") does not hold.
- **The 401 guard breaks** when `onLine` is false (false negatives are documented on Chrome/Linux/VPN). `performRefresh` clears storage, and then the stale local `refreshToken` variable passes `!isTokenExpired`. The result is `authenticated` with empty storage after a definitive revocation.

`navigator.onLine` must not be the decision input. MDN: `true` does not mean internet access (https://developer.mozilla.org/en-US/docs/Web/API/Navigator/onLine).

**State-of-the-art design (security model):**
- **Separate identity from credential freshness.**
  - Persist a session record: `{ userId, deviceId, refreshExp, lastServerContactAt, claimsSnapshot }`.
  - The state machine adds an explicit degraded state. Either `AuthState = 'authenticated'` with `session.freshness: 'fresh' | 'stale'`, or `'authenticated-offline'`. It must be observable through `onAuthChange` and the React/Vue/Svelte hooks.
- **Decision rule.** Degrade iff the refresh outcome is **transient** (the #1 classifier), the refresh token is unexpired on the local clock, and `sub` is present. A definitive rejection, or an expired refresh token, means signed out.
  - Guard against clock rollback: refuse if `Date.now() < lastServerContactAt`.
  - Optional `maxOfflineSessionAge` (default: refresh-token lifetime). Past it, require re-auth (lock), but **never** wipe the local DB or outbox for that user.
- **Bindings use the session identity, not a fresh token.** `resolveUserId` / `resolveSyncState` return `{ state: 'authenticated', userId }` from the stored session so the local DB mounts. Opening the sync transport separately waits for a fresh token. `AuthSyncState.authenticated.token` is then optional or nullable.
- **UI gating.** Claims and RBAC in a stale session are hints only. Server-authorized actions are queued; they are never assumed granted.
- **Revocation while offline** is unenforceable locally (also true of Firebase, MSAL and AppAuth). On reconnect, the definitive 401 or `DEVICE_REVOKED` signs out. The sync engine already suspends on `DEVICE_REVOKED`. Queued ops stay bound to the user and are rejected server-side if the device is revoked.
- **Shared devices** (church tablets): the offline grace window must be paired with the existing auto-lock / PIN (`encryption/auto-lock.ts`). Sign-out must be explicit and complete.
- **Precedent:**
  - Firebase restores `currentUser` from IndexedDB persistence without network and signs out only on invalidation codes.
  - AppAuth keeps `AuthState` authorized across network errors; only `invalid_grant` requires re-auth.
  - MSAL: as described in #1.

**AUTH-13 overlap:** same lines. AUTH-13's fix ("stay authenticated offline from cached JWT") is still incomplete without the binding changes above (`auth-sync.ts`, `AuthBoundKoraProvider`, `namespaceByAuthUser`).
**Severity: P0.** Offline cold start is the framework's core promise. **Effort: M** (auth-client state, auth-sync, core binding type, provider, 3 UI bindings, docs).

---

## #3 "Resilient" dual localStorage + IndexedDB token store

**Problem: REFUTED.** The claim that localStorage is evicted independently while IndexedDB/OPFS survive contradicts browser documentation:
- Eviction is per-origin and all-or-nothing. MDN: "all of its data, not parts of it, is deleted at the same time"; localStorage is in scope (https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria).
- WebKit: "the data of an origin will be deleted as a whole" (https://webkit.org/blog/14403/updates-to-storage-policy/).
- Safari's 7-day cap on script-writable storage deletes IndexedDB **and** localStorage together. Home-screen web apps "have their own counter of days of use" (https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/).

So the IndexedDB "backup" is evicted in the same event. The report gives no evidence (browser, version, repro). Likely explanations are app code (e.g. `localStorage.clear()` in the LMS app) or a `QuotaExceededError` on `setItem`. The second one interacts with #1: a failed `setTokens` after a server rotation is caught and wipes the session.
"Fast synchronous reads" is moot: `AuthTokenStorage` is `MaybePromise` and every call site awaits.

**Proposed fix: REJECT. It is a security regression.**
- `clear()` preserves the IndexedDB copy when offline. `signOut()` calls `storage.clear()`, and the server revocation is best-effort and fails offline. On the next `initialize()`, localStorage misses, the IndexedDB fallback restores the refresh token, and **the previous user is signed back in**. On the shared church tablets the report itself cites, that is a session takeover.
- A storage adapter must not change its semantics based on connectivity.
- "No breaking change" is false: it changes sign-out semantics.

**State-of-the-art design** (justified by real problems, not eviction):
- **Default browser token store:** one IndexedDB-backed store, the same origin store family as `IndexedDBDeviceKeyStore`.
  - Works in workers and service workers; localStorage does not, which blocks background sync.
  - Transactional writes of both tokens together.
  - In-memory cache for hot reads.
- **Protection at rest:**
  - Encrypt the refresh token with AES-GCM under a **non-extractable** WebCrypto key stored in IndexedDB.
  - Be precise about scope: this blocks raw-key exfiltration and disk/backup scraping. It does **not** stop in-page XSS from using the key.
  - The real fix for token theft is sender-constrained tokens. Bind refresh to a proof from the existing non-extractable device ECDSA key (DPoP, RFC 9449, or Kora's device credential); compare Chrome's Device Bound Session Credentials.
- **Cross-tab:** Web Locks around refresh, plus `BroadcastChannel` (repro in LMS-1).
- **`clear()` is total and synchronous with sign-out.** An offline sign-out persists a pending revocation that is sent on reconnect.
- **Eviction protection** belongs to #4, not to duplicate copies.
- **Native:** keep `credentialStore` (Keychain/Keystore). Make `EncryptedTokenStore` implement `AuthTokenStorage`; today it exposes `saveTokens`/`clearTokens` and cannot be plugged into `createKoraAuth`.

**AUTH-13 overlap:** none directly. The cross-tab refresh race is a new, related P1 (reproduced in LMS-1).
**Severity:** report problem n/a. The proposed fix would introduce a P1 security bug. The IndexedDB/encrypted/device-bound store is a P2 hardening item. **Effort: M** (store) to **L** (DPoP/device-bound refresh).

---

## #4 Request `navigator.storage.persist()`

**Problem: PARTIAL; the premise is factually wrong.**
- **Kora already calls `persist()` on every browser `createApp()` with OPFS.** The chain is `initialize-app.ts:153` → `resolveBlobStore` → `createOpfsBlobStore` → `createOpfsBlobDirectory` (`packages/store/src/blob/opfs-blob-store.ts:151-157`). It **awaits** the call before `app.ready` and discards the result.
  - It is skipped entirely if the app supplies `config.blob.store`.
  - `storeInfo.durable` (`initialize-app.ts:237`) reports adapter durability, not eviction protection.
- **`StorageSafetyGate` does not exist in Kora** (no match in any package). It is LMS app code: **NOT-FRAMEWORK**.
- "Every Kora app uses OPFS" is false: there are IndexedDB fallback, Tauri, React Native and Node paths.
- **Real defect (reproduced):** because the promise is awaited, a `persist()` that never resolves (Firefox prompts and waits for the user's choice) blocks blob-store resolution and therefore `app.ready`. `LMS-4.test.ts` fails at HEAD. With `persist()` resolving immediately, the same tests pass (control run), so the hang is caused by awaiting `persist()`.
  - The claim that Firefox keeps the promise pending until the user answers is inferred from its prompt UI and is not documented by Mozilla. Verify manually in Firefox.

**Proposed fix: REJECT as written; ACCEPT-WITH-CHANGES on intent.**
- "No side effects if the browser declines" is false for Firefox, which shows a permission popup (MDN eviction page). web.dev advises against calling it "on page load, or in other bootstrap code" and recommends doing it on saving critical data, ideally behind a user gesture (https://web.dev/articles/persistent-storage).
- Chrome grants silently by heuristics: engagement, installed/bookmarked, notification permission. WebKit (Safari 17+) grants by heuristics such as Home Screen web app, with no prompt.
- Their `console.warn` on denial fires on most first visits in Chrome, where silent denial is the normal case. That is noise.
- Duplicating the call in `createApp` and in `AuthBoundKoraProvider` is redundant with the existing blob-store call.

**State-of-the-art design:**
- **Remove `persist()` from `createOpfsBlobDirectory`.** A storage primitive must not request permissions, and nothing on the critical path awaits it.
- **First-class API on the app:** `app.storage.persistence.{ status(), request() }` built on `persisted()`, `persist()` and `estimate()`.
- **Event:** `storage:persistence` with `{ state: 'persisted' | 'best-effort' | 'unsupported', quota, usage }`. Also surface it in DevTools and `useStorageStatus()`.
- **Default policy** `store.persistence: 'auto'`:
  - At startup call `persisted()` only. It never prompts.
  - Fire-and-forget `persist()` (never awaited) after the first meaningful signal: successful sign-in, first local write, or running as an installed PWA (`display-mode: standalone`). The Chromium and WebKit heuristics are most likely to grant at that point.
  - Options `'request-on-gesture'` (app calls `request()` from a click; recommended for Firefox) and `'off'`.
  - Re-check after `appinstalled`.
- **Docs:** for low-cost Android, the strongest lever is installing the PWA (Chrome auto-grants and gives a higher quota). Persistence does not protect against user "Clear data" or OS app-data clears; the server is still the durable copy.

**AUTH-13 overlap:** none.
**Severity: P2** (Firefox startup hang and missing status API). **Effort: S** (~0.5–1 day).

---

## Summary

| # | Problem | Proposed fix | Severity | Effort | AUTH-13 |
|---|---|---|---|---|---|
| 1 | CONFIRMED | REJECT (handles only 1 transient class, no timeout/backoff, rotation-unsafe; passes 3/14 repro cases) | P0 | S + M (server) | same defect |
| 2 | CONFIRMED | REJECT (`isOnline` does not exist; lie-fi; bindings still signed-out; can authenticate a revoked session) | P0 | M | same defect; AUTH-13 fix also needs binding changes |
| 3 | REFUTED (eviction is per-origin) | REJECT (sign-out resurrection on shared devices) | n/a (P1 if adopted) | M–L for the real hardening | — |
| 4 | PARTIAL (already called, awaited, result discarded; `StorageSafetyGate` is app code) | REJECT as written / ACCEPT-WITH-CHANGES on intent | P2 | S | — |

New issues to route to the server reviewer:
- **P0:** `TokenManager.refreshAccessToken` ignores device revocation.
- **P1:** reuse-detection TOCTOU race; no reuse grace window.
- **P1:** cross-tab refresh race signs out all tabs.
- **P2:** `restoreSession` treats a 401 from `/auth/me` as offline.

### Sources
- MDN, Storage quotas and eviction criteria: https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria
- MDN, `StorageManager.persist()`: https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist
- MDN, `navigator.onLine`: https://developer.mozilla.org/en-US/docs/Web/API/Navigator/onLine
- web.dev, Persistent storage: https://web.dev/articles/persistent-storage
- WebKit, Updates to storage policy (Safari 17): https://webkit.org/blog/14403/updates-to-storage-policy/
- WebKit, 7-day cap on script-writable storage: https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/
- Firebase JS SDK, invalidation logic: https://github.com/firebase/firebase-js-sdk/blob/main/packages/auth/src/core/user/invalidation.ts
- MSAL.js, error handling: https://learn.microsoft.com/en-us/entra/msal/javascript/browser/handle-errors-and-exceptions
- RFC 6749 §5.2 (token endpoint errors): https://datatracker.ietf.org/doc/html/rfc6749#section-5.2
- Auth0, refresh token reuse interval: https://support.auth0.com/center/s/article/Refresh-token-leeway
- Auth0, refresh token rotation: https://auth0.com/blog/securing-single-page-applications-with-refresh-token-rotation/
- Dexie, StorageManager: https://dexie.org/docs/StorageManager
