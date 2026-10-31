# @korajs/auth

## 1.0.0-beta.15

### Minor Changes

- 3b539f4: Password reset and change in `createKoraAuthServer`: `passwordReset: { url, send }` serves `POST /auth/password/forgot` and `/auth/password/reset`, and `POST /auth/password/change` is always served. A reset link is single-use, hashed at rest, kept in the user store's database, valid for an hour and only while the account keeps the address; asking for one answers the same for every address; resetting ends every session of the account. Changing a password keeps the calling device signed in with new tokens and ends every other session. The client gains `requestPasswordReset`, `resetPassword` and `changePassword` (also on `useAuth()` in React, Vue and Svelte).

  Breaking: `PasswordResetManager` is now `new PasswordResetManager(userStore, { url, send, ... })` with `request`, `reset` and `change`; its tokens are stored hashed. The previous options (`onResetRequested`, `exposeTokenForDevelopment`, `maxRequestsPerEmail`) and the `PasswordResetError`, `ResetTokenExpiredError`, `ResetTokenNotFoundError` and `ResetRateLimitedError` classes are removed.

  Also: `UserStore.update()` now writes the profile only (email, name, emailVerified), so an update made from an earlier copy cannot undo a password change; passwords change through `updatePassword` and the new `updatePasswordIf` (required by password reset; the built-in stores have it). Requests to `handleRequest` may carry `waitUntil`, for serverless hosts, so emails sent after the response still go out.

  Additive: `RateLimiter.consume` (atomic check-and-count; `InMemoryRateLimiter` has it and sign-in uses it), `MfaVerifier.removeForUser` (`TotpManager` has it), `IssueTokenOptions.issuedAtMs`, and `TokenManager`/`BuiltInAuthRoutes.revokeAllForUser(userId, at?)` returning the cut-off. Sessions completed at MFA verification are dated from the first factor, so a revocation after it covers them; a revocation also cancels a pending MFA sign-in.

- 941c67e: Offline readiness knows whether the signed-in session survives an offline reload (A3). `AuthSyncBinding` gains `resolveOfflineRestore()`, which `createKoraAuthSync` implements from the stored tokens: restorable only with both tokens stored, on storage that survives a reload, with a refresh token that has not expired and an offline grace (`maxOfflineGraceMs`, measured from the stored refresh token's issue time) that has not run out. A wall clock set back reports `clock-rollback`, and a 30 second watchdog re-checks while the session is restorable. `AuthTokenStorage` gains an optional `durability` (`durable`, `session`, `memory`): the default `localStorage` store is durable, `createMemoryAuthTokenStorage` and `sessionStorage` are not, and a custom store that does not say is `unknown`, so `app.offline` is never `ready` on an assumption. `createAuthTokenStorage({ store, durability })` declares it.

  `createApp({ offline: { auth } })` declares restorability for apps with their own sign-in (a bare `sync.auth` token function cannot know). `app.offline.status().auth` is now `restorable`, `not-restorable`, `unknown`, `loading` or `n/a`, and `ready` flips off when the session's limit passes.

### Patch Changes

- 0c1f8f3: New guide, [Offline Readiness](https://korajs.dev/guide/offline-readiness): what Kora guarantees (a `ready` app opens offline, a write whose promise resolved is never lost) and what the app is responsible for, with `app.offline.status()`, `keep`, the app shell and `<OfflineBadge />`, offline sign-in, storage-loss reporting and durable writes on the IndexedDB fallback.

  Upgrade notes for `1.0.0-beta.15`:

  - Update `korajs`, `@korajs/auth` and `@korajs/cli` together. An older `@korajs/auth` cannot report offline sign-in (`auth-unknown`, never `ready`); an older `@korajs/cli` plugin publishes no shell status (`shell-none`).
  - A custom `AuthTokenStorage` that does not declare `durability` reads as `unknown` and is never `ready`. Pass `durability: 'durable'` to `createAuthTokenStorage` for a store that survives a restart, or declare `offline.auth`.
  - A custom `ContentAddressedBlobStore` that does not declare `durable` counts as not durable: a pin that keeps files reports `storage-non-durable`. Declare `readonly durable = true` on a store whose bytes survive a restart.
  - On the IndexedDB fallback a write can now reject with `WriteNotDurableError` (it used to resolve even when its snapshot failed). The write exists; do not retry it.
  - An app with a bare `sync.auth` token function reads `not-ready` until it declares `offline.auth`.

- fe14504: Email verification in `createKoraAuthServer({ emailVerification: { url, send } })`: a single-use link is sent at sign-up (unless `sendOnSignUp: false`) and on `POST /auth/email/send-verification`, and `POST /auth/email/verify` marks the address verified. Only a SHA-256 of each token is stored, in the SQLite or Postgres user store's database (`getEmailVerificationStore()`); a link verifies only the account it was sent for, opened while signed in to it (so whoever registered someone else's address cannot get the owner to verify it by clicking the email), and only while the account still has that address; it expires after 24 hours and ends the user's other links. Sending is limited to 3 emails per user per hour, counted atomically; delivery failures are reported; sign-up never waits for the email. Production refuses an in-memory verification store. Clients get `authClient.sendVerificationEmail()`, `authClient.verifyEmail(token)` and `currentUser.emailVerified`, also on `useAuth()` in React, Vue and Svelte. Sign-in is never blocked on verification; sharing, organization invitations and OAuth linking check `emailVerified`. `oauth.autoLinkVerifiedEmail` now also requires the existing account to have verified the address, and `AdminApi.updateUser` resets `emailVerified` when it changes the address (unless it sets `emailVerified` too).

  Breaking (experimental API): `EmailVerificationManager` is now `new EmailVerificationManager(userStore, { url, send, ... })` with `send(userId, reason)` and `verify(token, userId)`; it no longer returns tokens in responses, and `EmailVerificationStore` stores token hashes (`take`, `countSend`, `deleteForUser`, `deleteExpired`); `UserStore` gains an optional `markEmailVerifiedIfEmail`. `VerificationTokenExpiredError` and `VerificationTokenNotFoundError` are removed (results carry `VERIFICATION_TOKEN_EXPIRED` and `VERIFICATION_TOKEN_INVALID`).

- b378fb9: Shared browsers: each account gets a device id, and so a sync node, of its own. beta.12 gave every
  account on a browser the same device id, so with `store.namespaceByAuthUser` two users' databases
  authored under one node; later servers refused every account but the device's first
  (`DEVICE_OWNERSHIP_CONFLICT`). The persistent device identity now holds one device id per account
  that signed in on the device (and one unused id), storing nothing about the accounts; every
  sign-in, sign-up and OAuth callback offers them all (`deviceCandidates`) and the auth server picks
  the one registered to the account, else an unregistered one (sign-up checks before creating the
  account; an MFA sign-in registers it only after the second factor; when every candidate is refused
  the browser replaces its unused id and retries once). A namespaced database whose pinned node moved retires the previous node, asks the server
  by id which of its own writes it stores (`probeOperationIds` / `operationProbe` in the handshake),
  and re-authors the rest under its own node (`sync:operations-rewritten`, reason `node-rotation`;
  `sync:local-node` action `retired-repaired`), never an operation it received under that node, and
  not while a tab still has the node open. The device's registered owner keeps the old node, and the
  server hands it over as before.
  A node known only from outbound-queue entries (beta.12 queued writes a tab received from the
  user's other device) is asked about by id too: what the server stores is settled
  (`queue-settled`) instead of being reported as held unassigned writes.
- Updated dependencies [24f5531]
- Updated dependencies [6c72c04]
- Updated dependencies [6fd998a]
- Updated dependencies [946dd42]
- Updated dependencies [8667762]
- Updated dependencies [003d7bf]
- Updated dependencies [0b461fa]
- Updated dependencies [8411be3]
- Updated dependencies [714ebd2]
- Updated dependencies [180923d]
- Updated dependencies [b8f9e6f]
- Updated dependencies [9afd6a0]
- Updated dependencies [d45441e]
- Updated dependencies [4d5f2a2]
- Updated dependencies [95f5a26]
- Updated dependencies [dec63c6]
- Updated dependencies [ea9f219]
- Updated dependencies [941c67e]
- Updated dependencies [ab20522]
- Updated dependencies [2b9b8b5]
- Updated dependencies [89cb4c4]
- Updated dependencies [0b461fa]
- Updated dependencies [b378fb9]
- Updated dependencies [1c9dbe0]
- Updated dependencies [0388bd7]
- Updated dependencies [68cbb70]
- Updated dependencies [df7a430]
- Updated dependencies [b7f964a]
  - @korajs/core@1.0.0-beta.15

## 1.0.0-beta.14

### Patch Changes

- 99cedc4: Smaller fixes from the beta.13 rollout:

  - `defineSchema` refuses a unique or capacity constraint whose `where` holds an operator object,
    an array, or an unknown field: none could ever match, so the constraint was silently disabled
    (F2).
  - `PostgresUserStore.close()` ends the connections of a store made by `createPostgresUserStore`,
    so scripts exit (F11).
  - `/health` and `getStatus()` report the real `@korajs/server` version instead of
    `1.0.0-beta.0` (F13).
  - A `sqlite3.wasm` download or compile failure fails the store open within seconds with a
    `WorkerInitError` naming the binary, instead of waiting out the 60-second init timeout, and a
    failed SQLite load is not cached, so the next open tries again (F15).
  - `undefined` inside a `t.json()` value is written the way JSON writes it (a member is absent, an
    array element is `null`), as the server already stored it, instead of failing the write on the
    device (F12a).

- 7e3df2f: One default location for the template databases (F8, F10): every template, the Tauri one
  included, now uses `./.kora/kora-server.db` and `./.kora/kora-auth.db` in `server.ts`,
  `.env.example` and its README (the Tauri server used `./kora-server.db`, and two different
  auth paths). `createSqliteServerStore`, `createSqliteUserStore` and `createSqliteOAuthStores`
  create the directory of their database file, so these defaults work on a fresh checkout.
- Updated dependencies [99cedc4]
- Updated dependencies [4ec1bc5]
  - @korajs/core@1.0.0-beta.14

## 1.0.0-beta.13

### Major Changes

- **Breaking. Security:** the default sync provider derives scopes from verified identity
  (`scopeValues`, `resolveScopes`) instead of the client's handshake; one `authenticateAccess`
  check guards every route; device and user revocation take effect immediately across instances;
  refresh rotation is atomic and safe across tabs.
- OAuth state is bound to the browser and purpose (linking starts at
  `POST /auth/oauth/:provider/link/start`); invitations require the verified invited email; MFA is
  enforced at sign-in (`MfaRequiredError`, `verifyMfa`); reset tokens are never disclosed; sign-in
  timing and rate limiting no longer reveal accounts; webhooks are signed `t=…,v1=…` and refuse
  private targets; passkeys require user verification.
- Offline users stay signed in (`authenticated-offline`); network failures never destroy tokens.
- Persistent user and revocation stores are required in production (`allowInMemory` to opt out);
  custom `TokenRevocationStore` and `OrgStore` implementations have new methods.
- Security fixes are described in the [security advisory](https://github.com/ehoneahobed/kora/blob/main/docs/releases/security-advisory-beta13.md).

See the [1.0.0-beta.13 release notes](https://github.com/ehoneahobed/kora/blob/main/docs/releases/v1.0.0-beta.13.md) and the [upgrade guide](https://github.com/ehoneahobed/kora/blob/main/docs/guide/upgrading-to-beta13.md) (servers first, then clients).

## 1.0.0-beta.11

### Minor Changes

- Make `createKoraAuthSync()` expose explicit loading, signed-out, anonymous, and
  authenticated states. Signed-out synchronization now suspends by default;
  anonymous synchronization requires `anonymous: 'allow'`.

## 1.0.0-beta.9

### Patch Changes

- b657130: Harden the framework paths surfaced by production-style E2E usage.

  - Fix generated app templates so auth routes proxy correctly, dev database writes do not trigger Vite full reloads, and cross-origin isolation can be configured for embedded media.
  - Keep React auth subscriptions stable through StrictMode remounts, and keep `useQuery` from transiently reporting an empty result while a replacement query subscription is still settling.
  - Add query-store snapshot readiness so adapters can distinguish "not emitted yet" from an authoritative empty result.
  - Serialize `json`, `object`, and `blob` fields during server materialization, and fail loudly instead of acknowledging an operation whose persistence failed.
  - Serialize sync start/stop transitions and retry pending outbound operations when an auth/session transition leaves the connection idle.
  - Register broad and unsupported-only live queries as collection-wide sync subsets, so mixed narrow and `where({})` subscriptions cannot starve admin-style broad views.
  - Invalidate a client's delivery watermark when the server resolves a different authoritative scope than the client requested, forcing a scoped backfill instead of skipping operations hidden under the old view.
  - Treat retryable per-operation rejections as unacknowledged on the client, and have the server acknowledge only through the last safely processed operation. Stale-scope pushes now remain queued for rescope/retry instead of being silently dropped.
  - Make delivery-stream retransmission stale-aware so slow or large server-to-client batches are not re-sent on every retry tick while the original ack is still in flight.
  - Add a serialized `sync.reconnect()` control and use it for auth-driven scope refreshes and query-subset reconnects, avoiding app-level disconnect/connect races during permission changes.
  - Load local `.env` files in `kora dev` and generated sync servers before auth/server setup, so first-run auth configuration mounts consistently whether the app is started by the CLI or the server is run directly.
  - Update generated template docs to use `/kora-sync` WebSocket endpoints for `VITE_SYNC_URL`, avoiding noisy root-path WebSocket retries from copied defaults.
  - Pin `create-kora-app` template dependencies to the exact Kora prerelease when the CLI itself is a prerelease, avoiding accidental stable-range resolution or split beta installs.
  - Improve JSON schema validation errors by reporting the exact invalid nested path, including `undefined`, non-finite numbers, and circular objects.
  - Fix IndexedDB fallback persistence so logical dumps are durable when binary SQLite export is unavailable, stale binary snapshots cannot shadow newer dumps, and dump-only databases restore correctly.
  - Allow production server COEP policy configuration and document route access to the owned Kora data plane.

- Updated dependencies [b657130]
  - @korajs/core@1.0.0-beta.9

## 1.0.0-beta.5

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @korajs/core@1.0.0-beta.5

## 1.0.0-beta.0

### Patch Changes

- Package export hygiene and auth secret-handling hardening.

  - Every published package now exposes `./package.json` in its `exports` map. Previously `require.resolve('@korajs/core/package.json')` (and the same for every other package) failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`, which breaks tooling that reads a package's manifest or version at runtime.
  - `createKoraAuthServer` now warns loudly when it falls back to an ephemeral random JWT secret outside production, so a deployment that never set `NODE_ENV=production` no longer silently regenerates its signing key on every restart (which invalidates all existing tokens) without any signal.
  - `KORA_AUTH_SECRET` set to an empty or whitespace-only string is now treated as unset rather than as an invalid secret, so it triggers the intended dev fallback / production guard instead of crashing `TokenManager` with a "secret too short" error.

- Fix `createProductionServer` silently dropping POST/PUT/PATCH request bodies for `httpRoutes` handlers on some Node.js versions, and stop a single throwing route handler from crashing the entire server process.

  - `readBodyBuffer` now explicitly calls `req.resume()` (guarded by `req.readableFlowing`) after attaching its `data`/`end` listeners, and handles stream `error` events, so the request body reliably reaches `httpRoutes` handlers instead of resolving as an empty buffer.
  - The HTTP request listener passed to `http.createServer` is no longer an unawaited `async` callback. A thrown or rejected error inside a route handler is now caught and turned into a clean `500` response instead of becoming an unhandled promise rejection that takes down the whole process.
  - `@korajs/auth`'s built-in auth routes (`handleSignIn`, `handleSignUp`), `isValidEmail`, `sanitizeName`, `verifyJwt`, and the org routes' email validation now guard against non-string/undefined fields at runtime instead of assuming the compile-time `string` type holds for real network input, returning `400`/`401` responses instead of throwing.

  Reported by the KoraForms team: signup/signin requests built on `httpRoutes` were reaching handlers with `body: undefined`, causing `TypeError`s that crashed the server.

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @korajs/core@1.0.0-beta.0

## 0.6.0

### Minor Changes

- Public beta 0.6.0: Vue 3 and Svelte 5 bindings with shared QueryStore, sync-status controller, and richtext controller; `@korajs/core/bindings` shared types; `@korajs/auth` org hooks and providers for React/Vue/Svelte; presence/collaboration hooks; CLI scaffolds; `korajs/vue` and `korajs/svelte` meta-package re-exports; Svelte component precompile and KoraProvider context bridge fix.

### Patch Changes

- Updated dependencies
  - @korajs/core@0.6.0

## 0.5.0

### Minor Changes

- b909e5a: v0.5 internal beta: structured apply results and sync apply-failure events, audit trace export, benchmark gates in CI, release-gate script, and E2E fixture hardening (SQLite worker + local multi-tab Playwright project).

### Patch Changes

- Updated dependencies [b909e5a]
  - @korajs/core@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [ff155cd]
  - @korajs/core@0.4.0

## 0.3.1

### Patch Changes

- fix(server): use BIGINT for PostgreSQL timestamp columns to prevent overflow

  - **server**: Fixed critical bug where PostgreSQL `INTEGER` columns overflowed for millisecond timestamps (wall_time, received_at, last_seen_at). Now uses `BIGINT`.
  - **server**: Added `/health` endpoint to production server.
  - **auth**: Added `UserStore` interface with `createSqliteUserStore` and `createPostgresUserStore` factory functions.
  - **core**: Added `sync:auth-failed` event for detecting stale auth tokens.
  - **sync**: Sync engine now emits `sync:auth-failed` when the server rejects authentication.
  - **cli**: Added AWS ECS Fargate and Lightsail Container deploy adapters.
  - **cli**: Docker builds now use `--platform linux/amd64` for Apple Silicon compatibility.
  - **cli**: Lightsail adapter forwards `DATABASE_URL`, `AUTH_SECRET`, `PUBLIC_URL` environment variables to containers.
  - **cli**: Fixed trailing slash in Lightsail URLs causing double-slash in sync endpoint.

- Updated dependencies
  - @korajs/core@0.3.1

## 0.3.0

### Minor Changes

- 6a05e88: Performance: Replace O(n²) topological sort with binary heap in @korajs/core (19x faster sync for large operation sets).

  New: @korajs/auth package with sessions, TOTP MFA, organizations, RBAC, passkeys, encrypted tokens, and E2E operation encryption (912 tests).

  New: Full Preact-based DevTools UI panel with sync timeline, conflict inspector, operation log, and network status.

  Docs: Comprehensive documentation refinement — added API references for merge, sync, auth, and devtools; added authentication guide; expanded sync configuration guide; updated all package descriptions.

### Patch Changes

- Updated dependencies [6a05e88]
  - @korajs/core@0.3.0
