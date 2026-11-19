---
title: Upgrading to beta.15
description: "Upgrade a Kora.js app from 1.0.0-beta.14 to 1.0.0-beta.15: what kora upgrade does for you, the server first-start work, every behaviour change with what to do about it, and what to watch afterwards."
---

# Upgrading to 1.0.0-beta.15

> **Draft until 1.0.0-beta.15 is published.** This page is written from the changes merged to
> `main` after 1.0.0-beta.14. Nothing here is released yet, and the release notes list what is still
> open ([release notes draft](https://github.com/ehoneahobed/kora/blob/main/docs/releases/v1.0.0-beta.15.md)).

beta.15 is the offline-readiness, access-rules and fast-sync release. It keeps **sync protocol 2**
(the handshake and delivery messages gain optional fields; a beta.14 client still syncs with a
beta.15 server and the other way round). It adds tables, columns and indexes to the server's
database and to the browser database, and it changes some behaviour you may rely on. This page
takes an app from beta.14 to beta.15 step by step.

Which guide to read:

| You are on | Read |
|---|---|
| beta.14 | This page. |
| beta.13 | [From beta.13 to beta.14](/guide/upgrading-to-beta13#from-beta-13-to-beta-14), then this page. |
| beta.12 or earlier | [Upgrading to beta.13](/guide/upgrading-to-beta13) (breaking, with a security advisory), then this page. Move every client to beta.13 or later before the server goes to beta.15: beta.15 servers refuse protocol 1 (beta.12 and earlier). |

**Order: servers first, then clients**, as for every beta since beta.13. The new handshake and
delivery fields are optional, and the server cuts delivery batches for a client that does not
declare them, so a mixed fleet keeps syncing during a rollout. The exceptions are a schema that
declares access rules and a grant that uses `$or`: both refuse a beta.14 client with `CLIENT_TOO_OLD`
(below).

## 1. Let `kora upgrade` do the mechanical part

```bash
npx kora upgrade --dry-run          # the plan and diagnostics; nothing is written
npx kora upgrade --yes              # bump every Kora package, install, run kora doctor
npx kora upgrade --to 1.0.0-beta.15 # an exact version instead of the beta tag
```

What it automates (full reference: [`kora upgrade`](/api/cli#upgrade)):

- **Moves every Kora package to one version**: `korajs`, `@korajs/*`, in `dependencies`,
  `devDependencies`, `optionalDependencies`, `overrides`, `pnpm.overrides`, `resolutions` and a
  `pnpm-workspace.yaml` catalog. This matters this release: `korajs`, `@korajs/auth` and
  `@korajs/cli` must move together, or the app reads `auth-unknown` or `shell-none` and is never
  offline-`ready` ([section 4](#offline-readiness)).
- Runs your package manager's install, then `kora doctor --skip-network`.

What it does **not** do:

- **Run codemods for this release.** The three registered codemods describe beta.13 changes, and a
  codemod runs only when an upgrade crosses the release that introduced it. From beta.14 to beta.15
  none runs. (From beta.12 or earlier, all three do: wire-format serializers, json string values,
  defaulted-field null checks.) beta.15 has no source rewrite that can be proven safe, so none was
  added: see [Not covered by `kora upgrade`](#not-covered-by-kora-upgrade).
- Order your rollout (server first), back up the database, or edit your templates' code.
- Upgrade the server and the client together: run it in each project, server first.

## 2. Before you start

- **Back up the server.** `kora backup create --url https://sync.example.com --token "$KORA_BACKUP_TOKEN"`
  (see [Backup and Restore](/guide/backup-restore)).
- **Preflight the production database.** `kora doctor --db env:DATABASE_URL --dry-run-migrations --strict`
  reads the database (it never writes to it), estimates what the next start will rebuild, and
  runs the pending migrations against a copy (SQLite) or in a rolled-back transaction (Postgres).
  See [`kora doctor --db`](/api/cli#production-preflight-db). To check a server that is already
  deployed, `kora doctor --production --url https://sync.example.com` needs no credentials.
- **Read the custom code you own** against the tables below: a custom `AuthTokenStorage`,
  `ContentAddressedBlobStore`, `ServerStore`, `SyncStore`, `UserStore`, `TotpStore`,
  `PasswordResetManager` or `EmailVerificationManager`, and calls to `AdminApi` or
  `RbacEngine.resolveScopes`.
- **Check the server's environment** for the `KORA_*` names `createProductionServer` now reads
  ([below](#behaviour-changes-on-the-server)).
- **Install the beta tag everywhere**, and keep `korajs`, `@korajs/auth` and `@korajs/cli` in the
  same release as the rest.

## 3. Upgrade the sync server

### What the first start does

The server adds its own structures and fills them in the background. There is no new flag to set.

| Added on first start | Why | What to expect |
|---|---|---|
| `kora_delivery_partitions` table, `idx_collection_delivery (collection, delivery_seq)` and `idx_node_delivery (node_id, delivery_seq)` on `operations` | The delivery visibility index: handshake, resume and live delivery read the operations a session can see instead of scanning the whole log. | The index is built in the background in chunks of 5,000 operations and is resumable. Until it is complete, sessions read through the global scan, exactly as in beta.14. On Postgres the two composite indexes are built with `CREATE INDEX CONCURRENTLY` after startup; an index a crash left `INVALID` is dropped and rebuilt. |
| `kora_record_live_views` table and fold-state columns | Deletes and stale writes are delivered by what each session's view held of the record, so a record deleted while outside a device's view no longer comes back. | Filled by a background backfill after start, in short transactions. While a record's summary is unknown, a delete is delivered as in beta.14. |
| `kora_fold_state.plan` column | Each fold state records the plan it was folded with, so a rolling deploy that changes transforms or merge rules re-folds records the older instance wrote. | An empty stamp (every existing row) is not treated as outdated, so adding the column does not re-fold your database. |
| `_kora_access_memberships` table, `role_seq` column | The membership index for access rules. | Used by schemas that declare `access` ([section 5](#_5-access-rules-new-opt-in)). |

A rolling deploy is supported: an instance still on beta.14 appends operations without index rows;
the delivery poll of a beta.15 instance indexes the gap, and until then sessions that need those
operations only read more slowly.

Nothing about the startup *re-fold* changes for a beta.14 database. If you are unsure what the
next start will rebuild, `kora doctor --db` prints the estimate before you deploy
([Startup re-materialization](/guide/production-server#startup-re-materialization-upgrading-from-beta-12-or-changing-merge-rules)).

### Rolling back

Rolling back to beta.14 on a database beta.15 has used is **not supported**, on the server or on
devices:

- **Server.** beta.15 adds the tables and columns above, and beta.14 has never been tested on a
  database that holds them. To go back, restore the backup taken before the upgrade, and accept
  that operations uploaded since are lost from the server (devices that still hold them unsynced
  upload them again).
- **Devices.** beta.15 introduces the storage-format guard (`StorageFormatAheadError`,
  `store:format-ahead`): from now on, older code refuses a browser database a newer format wrote
  ([App updates](/guide/app-updates)). beta.14 predates the guard, so a beta.14 build reopened on
  a database beta.15 migrated would open it without that check. Do not redeploy a beta.14 build of
  the app once beta.15 has shipped to users; fix forward instead.

Rolling back between later releases (beta.15 onward) is covered by the guard: a release that does
not change the storage format can be rolled back by redeploying the previous build.

### Scopes that name fields the schema does not declare

The delivery index files each operation under the fields your scopes use: the schema's `scope`
and `sync` declarations and every field an access read rule names are included automatically. A
`TokenAuthProvider` scope is an arbitrary map, so the server cannot infer it. A scope on a field
outside the plan is still correct; it is read collection by collection and logged once as
`delivery.partition_miss`. Declare the field to get the fast path:

<!-- docs-check-prelude
import type { AuthProvider } from '@korajs/server'
declare const auth: AuthProvider
-->

```typescript
import { createProductionServer, createSqliteServerStore } from '@korajs/server'

const server = createProductionServer({
  store: createSqliteServerStore({ filename: './.kora/kora-server.db' }),
  syncOptions: {
    auth,
    // The collection name and the scope field your provider grants on.
    deliveryPartitions: { lessons: ['schoolId'] },
  },
})
```

Changing this list rebuilds the index in the background. The store remembers the list, so a restart, or a script that opens the store without being told it, keeps the index instead of rebuilding it.

### Behaviour changes on the server

| Change | Applies to | What to do |
|---|---|---|
| A **missing path requested as a page** (a link-preview crawler or search engine asking for `*/*`, no `Sec-Fetch-Mode`) for an extensionless route outside `/api/`, `/__kora` and `/assets/` now gets the app shell instead of a `404`. The default `spaFallback` is `'navigation'`; the beta.14 behaviour is `'strict'`. An app's own `fetch()` of a missing path still gets its `404`. | `createProductionServer` with `staticDir` | Nothing, or `spaFallback: 'strict'` to keep beta.14. New: `shellMeta` for per-URL title and Open Graph tags ([Link previews](/guide/production-server#link-previews-and-per-page-metadata)). |
| An **uploaded delete may carry no payload**: a delete with `data`, `previousData` or `atomicOps` is refused `INVALID_DELETE_PAYLOAD`, never stored or relayed. `fieldVersions` and `foldState` are stripped from every uploaded operation. Real client deletes are unaffected. | Custom clients that upload deletes built by hand | Send deletes with `data: null` and `previousData: null`. |
| An operation whose **atomic intent** has an unknown type, an invalid operand, names a field it does not write, sits on a delete, or disagrees with its `data` is refused `INVALID_ATOMIC_OP` (`data[field]` must be the intent applied to `previousData[field]`). | Hand-written operations | None for Kora clients, which already write them this way. |
| **Scope grants are validated more strictly.** A field predicate that is an object other than exactly `{ $in: [...] }` (for example `{ $in: [...], $ne: ... }` or `{ $ne: ... }`) is refused at the handshake (`SCOPE_PREDICATE_LIMIT`); before, it was reduced to its `$in` part. A `null` or non-object collection grant now denies the collection instead of reading as `{}`. | Custom `AuthProvider`s and `resolveScopes` | Return `{ field: value }` or `{ field: { $in: [...] } }` per field. A grant may now also be `{ $or: [...] }` (up to 8 branches); a beta.14 or older client is refused `CLIENT_TOO_OLD` when its grant contains one. |
| **Retractions apply in stream order** within a delivery batch, and an insert onto an existing record enters and leaves a device's view like an update. Before, a record that entered a view and left it again inside one batch could stay on the device. | Scoped apps, `scopeExit: 'retract'` | Nothing for new data. To repair devices that already hold such a record, call `server.forceFullResync({ userId })` (or `{ nodeId }`): their next handshake replays the stream from 0. It needs a store that implements `requestFullResync`, `getFullResyncState` and `completeFullResync` (the built-in ones do; a custom store without them gets `FULL_RESYNC_UNSUPPORTED`). |
| `kora.applyConditional` **runs as one transaction on every built-in store**: its whole set commits or nothing does (on SQLite and memory a failing `also` mutation used to leave earlier ones applied). On Postgres it is now checked against the schema, constraints and relations it used to skip, so a set that wrote invalid values is refused. Like the new `kora.transaction`, it holds the lock all operation writes take, on every instance, for the length of its decision. | Server routes that use `kora.applyConditional` | Keep decisions short; handle the refusal. On SQLite a transaction is decided again (up to five times) when another connection commits meanwhile, then throws `TransactionConflictError`. |
| `SqliteServerStore.close()` now closes the database connection `createSqliteServerStore` opened, and waits for running calls; calls after it fail with `SqliteServerStore is closed`. A store built on your own Drizzle connection leaves that connection to you. | Scripts and tests that closed a store and kept using the file handle | Close once, at the end. |
| Servers refuse sync protocol 1 (Kora 1.0.0-beta.12 and earlier) at the handshake: `PROTOCOL_VERSION_UNSUPPORTED`, logged as `session.protocol_refused`. The protocol-1 session counters, `sync:protocol-deprecated` and `sync:unverified-legacy-operation` are gone. | Anyone with beta.12 clients | Update every client before upgrading the server. |
| `/health` also reports `authRequired` and `protocolVersion` (booleans and numbers only). | Monitoring | `kora doctor --production --url` uses them to verify handshake authentication without credentials. |
| `createProductionServer` **reads host settings the app leaves out**: `KORA_TRUST_PROXY` (a hop count or comma-separated ranges), the operational tokens `KORA_ADMIN_TOKEN`, `KORA_METRICS_TOKEN`, `KORA_BACKUP_TOKEN` and `KORA_INSIGHTS_TOKEN` (the new `/__kora/insights`), `KORA_BLOB_STORE_URL` or `KORA_BLOB_DIR` (the server then keeps `t.blob()` bytes there and sweeps unused ones daily), and `KORA_ALLOWED_ORIGINS`. `httpRoutes` and `/health` answer CORS preflights for native app origins (`tauri://localhost`), `KORA_ALLOWED_ORIGINS`, the new `allowedOrigins` option and, outside production, `http://localhost` on any port, never with credentials. A value the app passes always wins. | Servers whose environment already sets one of these names | Check the environment. Remove a token you do not want to open its endpoint; pass `blobStore: false` to keep no file store. An app that wires blob callbacks itself is unchanged. |
| `trustProxy: 0`, a negative count or `trustProxy: []` now **count as unset**, as `KORA_TRUST_PROXY=0` already did, and the server warns at start that per-address protection is off. Before, every client behind a proxy shared one per-address slot and sign-in failure bucket. | `createProductionServer` behind a proxy | Set the real hop count or the proxy's address ranges. |
| `maxRequestBodyBytes`, `maxConcurrentRequestBodies`, `maxBackupBytes` and the new `routeBodyTimeoutMs` **must be positive whole numbers** (`routeBodyTimeoutMs` at most 2³¹−1 ms); anything else throws `InvalidServerConfigError` (`INVALID_SERVER_CONFIG`) when the server is created. Before, `NaN` turned a limit off and `0` refused every request it covered. | `createProductionServer` | Pass a positive whole number, or leave the option out for the default. |
| **New limits with defaults.** A custom route body (`httpRoutes`: auth, webhooks, app APIs) must arrive within 2 s plus 1 s per KiB, never longer than a ceiling that grows with `maxRequestBodyBytes` (66 s at the 1 MiB default; `routeBodyTimeoutMs` sets it), or it gets `408`; at most `maxConcurrentRequestBodies` (128) bodies are read at once, past which `503` with `Retry-After`. A session may queue 16 messages before its handshake is accepted and `maxQueuedMessages` / `maxQueuedBytes` (10,000 / 64 MiB) after, then it is closed with the retriable `INBOUND_QUEUE_FULL`. A handshake may carry at most `maxSyncQueries` (1,000) query views (`SYNC_QUERIES_LIMIT`, not retried). Live rich-text updates are capped at `maxYjsUpdatesPerMinute` (1,200) and `maxYjsUpdateBytes` (1 MiB). Delivery pauses at `deliveryMaxUnackedBytes` (2 MiB) sent and unacknowledged. | Servers with slow uploaders, custom clients, beta.14 clients that mount very many live queries | Nothing for Kora clients of this release: they stay under the query-view cap (they widen views past 500). A beta.14 client with more than 1,000 views is refused until it updates; raise `maxSyncQueries` during the rollout if you have one. Raise the other limits only for traffic you expect. |
| The memory, SQLite and Postgres **server stores answer queries the same way** (route queries, scoped route queries, constraint lookups, `countCollection`): `where { field: null }` matches null or absent fields (it matched nothing), `where { done: true }` works on SQLite (it threw), `orderBy` puts nulls last in both directions, strings compare by code point (Postgres no longer uses the database locale, `orderBy: 'id'` included), `id` breaks ties and is the default order, and SQLite accepts `offset` without `limit`. | Server routes that query | Re-check a route that relied on the old null match or a locale order. |

### Account flows in `@korajs/auth`

Password reset and email verification are now served by `createKoraAuthServer`:

- `passwordReset: { url, send }` serves `POST /auth/password/forgot` and `/auth/password/reset`;
  `POST /auth/password/change` is always served. A reset link is single-use, valid for an hour,
  stored hashed, and ends every session of the account.
- `emailVerification: { url, send }` sends a single-use link at sign-up and on
  `POST /auth/email/send-verification`; `POST /auth/email/verify` verifies. Sign-in is never blocked
  on verification; sharing, organization invitations and OAuth linking check `emailVerified`.
  `oauth.autoLinkVerifiedEmail` now also requires the existing account to have verified the address.
- The client gains `requestPasswordReset`, `resetPassword`, `changePassword`, `sendVerificationEmail`,
  `verifyEmail` and `currentUser.emailVerified` (also on `useAuth()` in React, Vue and Svelte).

**Breaking, only if you constructed these managers yourself** (`EmailVerificationManager` was
experimental):
`new PasswordResetManager(userStore, { url, send, ... })` replaces the beta.14 options
`onResetRequested`, `exposeTokenForDevelopment` and `maxRequestsPerEmail` and the
`PasswordResetError`, `ResetTokenExpiredError`, `ResetTokenNotFoundError` and
`ResetRateLimitedError` classes; `new EmailVerificationManager(userStore, { url, send, ... })`
replaces its previous constructor and `VerificationTokenExpiredError` / `VerificationTokenNotFoundError`
(results carry `VERIFICATION_TOKEN_EXPIRED` and `VERIFICATION_TOKEN_INVALID`). Tokens are never
returned in responses; your `send` receives them. A custom `UserStore` needs `updatePasswordIf` for
password reset, and `UserStore.update()` now writes the profile only (email, name, `emailVerified`).
TypeScript reports every one of these as a compile error. The password-reset row of the
[beta.13 guide](/guide/upgrading-to-beta13#auth-contracts) (`onResetRequested`) describes the old API.

Other changes in `@korajs/auth`:

| Change | Applies to | What to do |
|---|---|---|
| Every **`AdminApi` method takes the acting admin's id first** and checks it with `isAdmin`: `listUsers(adminId, query?)`, `getUserSessions(adminId, userId)` and `getStats(adminId)` skipped that check before, and each call is now audited. `deleteUser` and `revokeUserSessions` throw `AdminRevocationUnavailableError` (`ADMIN_REVOCATION_UNAVAILABLE`) before deleting anything when the user store has no revocation store and no `revokeAllForUser` is configured (the built-in stores have one). | Code that calls `AdminApi` | Pass the admin's id as the first argument. TypeScript reports the old calls. |
| **`RbacEngine.resolveScopes` and `OrgScopeResolver.resolve` return a directional `SyncGrant`** (`{ type: 'sync-grant', downlinkScopes, uplinkScopes }`) instead of one scope map, and the `__readonly` key is gone (it made viewers sync nothing). `resolveScopes` results are recognised by the `type` marker, not by key names. | RBAC users | Return the grant as is from `createKoraAuthServer({ resolveScopes })` or `ExternalJwtProvider({ resolveScopes })`: `(await rbac.resolveScopes(userId, orgId, collections)) ?? {}`. Read `grant.downlinkScopes` where you read the old map. A grant built by hand needs `type: 'sync-grant'`. |
| A custom **`TotpStore` needs `saveIf(secret, expectedRevision)`**, an atomic conditional update (for example `UPDATE ... WHERE user_id = ? AND revision = ?` that checks the affected row count). `TotpManager` refuses a store without it (`TOTP_STORE_NOT_ATOMIC`). | Custom TOTP stores | Implement `saveIf` and store the new `revision` field as is. `InMemoryTotpStore` has it. |
| **Passkey sign-in requires user verification by default**: `generateAuthenticationOptions` asks for `userVerification: 'required'`, matching `verifyAuthenticationResponse`. A new `requireUserVerification` option keeps the two in step. | Passkey users | Nothing, or pass `requireUserVerification: false` to both to accept sign-ins without user verification. |
| **`oauth.autoLinkVerifiedEmail` links only to an account that verified its address.** Before, an OAuth sign-in with a verified email was linked to any account holding that email, verified or not. Accounts created before email verification existed have not verified theirs. `AdminApi.updateUser` resets `emailVerified` when it changes the address (unless it sets `emailVerified` too). | Apps with OAuth auto-linking | Turn on `emailVerification` so existing users can verify. Until they do, an OAuth sign-in with their address is answered `409` ("Sign in and link this provider first"). |

## 4. Upgrade the clients

### Several tabs and several builds

beta.15 stops two builds of your app from writing one browser database at once (the version gate).
A tab of a newer build retires every tab of an older build: the old tab shows *"A new version of
this app is available. Reload to continue."*, then refuses writes with `BuildSupersededError`
(`BUILD_SUPERSEDED`, retriable). Read [App updates and multiple tabs](/guide/app-updates) once; the
points that affect an upgrade:

- **Close every tab of the app once after the first beta.15 deployment.** Builds from before beta.15
  do not take part in the gate. A gated tab waits for an old tab that leads the database
  (`store:legacy-build-detected`), but cannot see an idle old follower.
- **Apps built with `koraServiceWorker()` get a build id automatically** (a `<meta name="kora-build">`
  tag, hashed from the deployed files; opt out with `buildId: false`). Apps without the offline shell
  add `koraBuildId()` from `@korajs/cli/vite`, or pass `createApp({ build })`. With no id, the gate
  falls back to a schema fingerprint (`store:build-unidentified`), which separates only builds whose
  schemas differ.
- **The gate needs Web Locks, which need HTTPS or `localhost`.** On plain HTTP it is off (one console
  warning). A browser without Web Locks on HTTPS rejects `app.ready` with
  `TabCoordinationUnavailableError`; in jsdom or happy-dom tests set
  `store: { allowUncoordinatedTabs: true }`. Without `BroadcastChannel`, one tab at a time uses the
  database. Node and Tauri apps are not gated.
- **`app.close()` can now be refused** with a `PersistenceError` (`context.code: 'UNSAVED_WRITES'`)
  when a retiring tab cannot save writes it admitted, instead of closing without them.
- A database whose stored format or schema version is newer than the code refuses to open
  (`StorageFormatAheadError`, `SchemaVersionAheadError`); it is never answered with an in-memory
  database.
- **Own the prompt if you want to.** Call `preventDefault()` on the `app:build-superseded` event, set
  `store.onBuildSuperseded`, or set `store.buildPrompt: false`. `app.reloadForNewBuild()` reloads
  under the newer build's service worker.
- Keep what users were typing across the reload with `useFormDraft` (opt in per form; password
  fields and `t.secret()` fields are never drafted; nothing is drafted when `app.encryption` is on).

### `KoraProvider` renders before the store opens

`KoraProvider` (React, Vue, Svelte) renders its children before `app.ready`, and the SQLite WASM and
the store runtime load after the first paint. What to change:

- **Empty states.** Hooks return empty values until the store opens (`useQueryState(...).ready` is
  `false`). Render an empty state ("No tasks yet") only once `ready` is true, or the first paint
  shows it for a moment on every load.
- **The startup `fallback`.** It is used only with the new `waitForStorage` prop, which restores the
  old gate. Remove a `fallback` that only covered startup, or add `waitForStorage` to keep it. The
  Svelte provider with `waitForStorage` and no `fallback` now renders nothing until the store opens,
  as React and Vue do (it rendered `<div>Loading...</div>`); pass a `fallback` snippet to keep a
  message.
- **Writes before the store opens.** Writes made through `useMutation` are queued, saved to an
  IndexedDB journal and applied in order once the store opens. A direct `await app.todos.insert(...)`
  before `app.ready` still throws `AppNotReadyError`. `await app.ready` keeps its meaning.
- **Validation in production builds.** `defineSchema` and `createApp` validate when the runtime loads
  instead of at the call, so a schema or configuration mistake rejects `app.ready` with the same
  `KoraError` (reading `schema.access` before then throws `AccessNotLoadedError`). A runtime chunk
  that cannot load triggers one page reload (offline, once the connection returns); if it still
  cannot load, `app.ready` rejects with `RUNTIME_LOAD_FAILED`.
  Development builds, servers and tests validate at the call as before. Make sure your app handles a
  rejected `app.ready`.
- **Connect without waiting.** The templates call `app.sync?.connect()` without awaiting `app.ready`;
  a connection now starts in parallel with the store open.

### Other client changes

| Change | What to do |
|---|---|
| An **update whose values already match the record writes no operation** (`update(id, { title: 'same' })` returns the record untouched; a mixed update writes only the fields that changed). Atomic ops, rich text and secret fields are always applied. An **insert accepts `null`** for an optional field without a default and leaves it empty; a required or defaulted field still refuses `null`, with a clearer message. | Nothing, unless code counts operations or relies on an update always producing one. |
| **`count()` applies `limit` and `offset`** and returns what `exec()` would return. It ignored both before. | To count every match, leave `limit` and `offset` out of the counted query. |
| `store:write-pending` has a new **`kind: 'transaction'`** (with `collections`), emitted once per transaction when `instantUpdates` is on. | Handle the new member where you switch over `insert`, `update`, `delete`. |
| **protobufjs is opt-in.** The sync engine's default serializer is `JsonMessageSerializer` (the negotiated default already chose JSON), and `ProtobufMessageSerializer` and `NegotiatedMessageSerializer` are also exported from `@korajs/sync/protobuf`, so a bundle that does not use them drops them. | Nothing; a custom setup that passes a protobuf serializer keeps working. |
| `@korajs/devtools` loads with a dynamic `import()` only when `devtools` is on; events emitted before it loads are replayed. | Nothing. |

### Desktop apps (Tauri)

- **Update the Rust plugin and `@korajs/tauri` together, and rebuild.** Binary values (rich text,
  blobs) now travel as `{ $koraBytes: base64 }` in both directions, statements queue behind an open
  transaction, and the plugin's commands run off the main thread. The keychain commands need Rust
  1.88 or newer.
- **Import `@korajs/tauri` in your entry file** (`import '@korajs/tauri'` in `src/main.tsx`, as the
  `tauri-react` template does) so its adapter registers. Without it, storage auto-detection inside a
  built app fails and the error says what to add.
- Sign-in sessions move to the OS credential store when you pass `createTauriCredentialStore()` to
  `createAuthTokenStorage` (the template does); a session saved in WebView storage moves on first
  read.
- **Give the app its own identifier.** Apps scaffolded before beta.15 use `com.kora.app`, and Tauri
  keys the data folder on it, so two such apps share one database. `kora doctor` warns about it.
  Changing the identifier moves where data lives: do it before users have data under the old one,
  or plan a migration.
- Template-only changes that do not arrive with the package bump: the update banner (updates are
  offered, not forced), the release workflow that writes the tag's version into `package.json`,
  `tauri.conf.json` and `Cargo.toml`, the mobile entry point and the `.gitignore`.

### CLI

- `@korajs/cli/create` is ESM only (no `require` condition). Import it, or call `create-kora-app`.
- `create` refuses an unknown `--template`, `--pm` or `--framework` value (it used to fall back to
  the default) and exits 1.
- `DeployResult.liveUrl` can be `null` (`kora deploy --platform aws-ecs` with no service or no load
  balancer), with `pendingSetup` saying what is left.
- `kora doctor --production` now fails on a setting tagged `[required]` in `.env.example` that is
  not set, and on Kora canary packages pinned to different releases. A CI job that runs it may need
  the settings in its environment.
- `kora deploy --platform aws-lightsail` forwards `KORA_AUTH_SECRET` (it forwarded only
  `AUTH_SECRET`, so sign-in was off). Redeploy Lightsail apps.

### Offline readiness

`app.offline.status()` and `useOfflineReady()` report whether a reload with no network would open
the app with its data. Read [Offline Readiness](/guide/offline-readiness) first: it is new in this
release and the guarantee ("works offline after the first open, never loses your work") has
conditions. The upgrade-relevant points:

| Change | What to do |
|---|---|
| **Update `korajs`, `@korajs/auth` and `@korajs/cli` together.** An older `@korajs/auth` cannot report offline sign-in (`auth-unknown`, never `ready`); an older `@korajs/cli` plugin publishes no shell status (`shell-none`). | `kora upgrade` does this. |
| A custom `AuthTokenStorage` that does not declare `durability` reads as `unknown` and is **never `ready`**. | Pass `durability: 'durable'` (or `'session'`, `'memory'`) to `createAuthTokenStorage({ store, durability })`, or declare `offline.auth`. The default `localStorage` store is durable. |
| `createKoraAuth({ credentialStore })` (a desktop or mobile app keeping tokens in a custom store) reads `unknown` for offline sign-in, because a credential store declares no durability. | Pass `storage` with a declared durability instead (`createAuthTokenStorage({ store, durability })`, or `createTauriCredentialStore` on desktop). |
| An app with a bare `sync.auth` token function reads `not-ready` until it declares `offline.auth`. | `createApp({ offline: { auth: () => ({ restorable: true, until }) } })`. |
| A custom `ContentAddressedBlobStore` that does not declare `durable` counts as **not durable**: a pin that keeps files reports `storage-non-durable`. | Declare `readonly durable = true` on a store whose bytes survive a restart. (The member is optional; custom stores still compile.) |
| On the **IndexedDB fallback** a write waits for a snapshot that holds it before its promise resolves, and can reject with `WriteNotDurableError` (`WRITE_NOT_DURABLE`) if the snapshot cannot be saved. Before, it resolved anyway. OPFS and native SQLite pay no extra wait. | Treat the error as "saved here, not yet confirmed". **Do not retry the write**: it exists. Use `insertMany` or one `app.transaction` for bulk writes. `app.storage.writes.status()` reports `durable` or `failing`. |
| Native SQLite (`better-sqlite3`, the Tauri plugin) now sets `synchronous = FULL`, so a resolved write survives an operating-system crash or power loss. | Nothing. |
| `schema`, `offline`, `setReadOnly`, `readOnlyReason` and `reloadForNewBuild` are **new reserved app property names** (`app.schema` is the app's schema). A collection with one of these names is not exposed as `app.<name>`; it is `app.collections.<name>` and `tx.<name>`. `createApp` warns once in development. | Rename the collection, or use `app.collections.<name>`. |
| A database that existed and vanished is reported (`store:storage-evicted`, `app.storage.evicted`) instead of being mistaken for a new device. It is never reported after `app.storage.deleteDatabase()`, a move between IndexedDB and OPFS, a first open, a changed `store.name`, or when the user clears all site data. | Show it to the user and call `app.offline.acknowledgeEviction()`. |

Features that live in the **templates**, not in the libraries, do not arrive with the package
bump: `<OfflineBadge />` (`src/OfflineBadge.tsx` and its Vue and Svelte equivalents), the
`useFormDraft` call on the new-task field, and the single `src/schema.ts` imported by the client,
the server and `kora.config.ts`. Copy them from a fresh `npx create-kora-app@beta` if you want them.

### Fixes you get with the package bump

- **Service worker and `Vary`.** The worker `koraServiceWorker()` generates looked up its precache
  with `Vary` taken into account, so a host that sends `Vary: Origin` (`vite preview`, CDNs with CORS
  rules) made the page's `<script type="module" crossorigin>` requests miss the install-time copies:
  a reload of an app that reported `ready` failed offline with a blank shell. Lookups now ignore `Vary`.
  Rebuild the app with the new `@korajs/cli` to regenerate the worker.
- **Vue `KoraProvider`** held the store in a deep `ref`, handing every composable a reactive Proxy of
  it; the store compares query subscriptions by identity, so the first result of every `useQuery` was
  discarded and a list stayed empty after a reload until the next write. It uses `shallowRef` now.
- **Blob pulls no longer hang on a lost message.** Requests are re-sent (5 s, doubling to 30 s with
  jitter), re-sent on reconnect, and fail after 2 minutes without an answer with
  `BlobTransferError` (`BLOB_CHUNK_TIMEOUT`, `BLOB_CHUNK_UNAVAILABLE`, `BLOB_CHUNK_CANCELLED`).
  Before, a plain `Error` after 30 s. `timeoutMs` is a deprecated alias of `deadlineMs`; a custom
  `BlobChunkChannel.send` now returns whether it sent.
- **A write whose COMMIT answer was lost** is looked up by its operation id; one that landed is
  published once instead of being re-applied as duplicates (`operation:applied` and merge traces
  were never emitted for it).
- A follower tab no longer declares a live leader absent (`NoLeaderError`); a transaction in one tab
  can no longer be interleaved by another tab's write; IndexedDB snapshots from two tabs can no longer
  overwrite each other out of order.
- A stopped sync engine no longer emits `sync:diagnostics` every 5 s forever, so a Node process that
  used one can exit after `stop()`.

### Performance changes you do not have to act on

- Browser writes are batched to the SQLite worker; 10,000 inserts in one transaction on OPFS went from
  about 6.2 s to 1.8 s in Chromium. New OPFS databases use 16 KiB pages (existing ones keep theirs).
  Awaited single `insert` calls are unchanged (about 34 ms each on OPFS in that benchmark).
- A delivery batch is applied in one storage transaction (chunks of at most 500 operations; the
  server's default batch is 100), with its quarantine rows and watermark, and costs about one storage
  round trip per operation instead of about 18. A 20,000-operation first sync in Chromium on OPFS went
  from about 6.4 minutes to about 2.3 minutes. A crash leaves the whole batch with its watermark or
  none of it. Custom `SyncStore` and `SyncStatePersistence` implementations keep working through the
  per-operation path; the new methods are optional.
- Batches are decrypted and their operation ids verified before the transaction opens. Every operation
  is still verified exactly once.

### New and opt in

- **`insertMany(rows)`** on every collection (also `tx.<collection>.insertMany` and `useCollection`):
  one transaction, all or none, one operation per record.
- **Instant updates** (off by default): `createApp({ store: { instantUpdates: true } })` shows this tab's
  own writes in its live queries before the storage transaction commits.

<!-- docs-check-prelude
import { createApp, defineSchema, t } from 'korajs'
const schema = defineSchema({ version: 1, collections: { todos: { fields: { title: t.string() } } } })
-->

```typescript
const app = createApp({
  schema,
  store: { instantUpdates: true },
})
```

  Read [Instant Updates](/guide/instant-updates) before turning it on. A shown row is **not saved**
  until the write's promise resolves, and a row can disappear if the transaction fails. It predicts
  inserts, updates and deletes, atomic operations (`op.increment`, ...) and array fields, and
  `app.transaction` / `app.mutation` as one unit, on queries it can evaluate in memory. Writes that
  involve rich-text, secret, auto-computed, `server-authoritative` or custom-resolver fields,
  cascading deletes, and queries with `include` appear at commit, as with the flag off. `app.storage.writes.pending` and `onRollback` exist but are
  internal and may change; do not build on them. Pass `{ durable: true }` as the last argument of one
  write to skip the prediction for that write.
- **`useMutation(fn, { onRejected })`** and a `rejected` state tell the component that made a write
  when the sync server permanently refuses it, even hours later (React, Vue and Svelte; needs
  `<KoraProvider app={app}>`).
- **`app.offline.keep(query, { files })`** keeps data and its files on the device on purpose
  (at most 64 pins; `useOfflineKeep` in each framework binding).
- **`exportLocalDatabase()`** exports a closed local database from OPFS or IndexedDB as a SQLite file.
- **`onOperationsCommitted`** on the sync server reports each durably committed batch.
- **`@korajs/test/playwright`** has the offline helpers (`assertReadyMeansOffline`, `goOffline`,
  `killTab`, `skewClock`, `throttleNetwork`, ...).

## 5. Access rules (new, opt in)

A schema that declares `access` is enforced by the sync server, with no flag (`experimentalAccessRules`
and `accessRulesEnforced` are deprecated and do nothing; the server option logs a warning). An app
that does not declare `access` is unaffected. If you adopt it:

- Read [Access Rules](/guide/access-rules) and, for invitations and roles, [Sharing](/guide/sharing)
  (`@korajs/spaces`, new in this release).
- **Every client must be on beta.15.** The server refuses a client that cannot follow access rules
  with `CLIENT_TOO_OLD`, and a client without the delivery watermark likewise. A cached old bundle
  stops syncing until it updates.
- A custom server store must implement the membership index (`getMembershipIntervals`,
  `getAccessIndexState`) or the schema is refused `ACCESS_RULES_UNSUPPORTED_STORE`. The built-in
  stores do.
- Every insert is judged by the collection's `create` rule, even when every field has a field rule;
  leaving it out denies every client. (Canary builds before this release skipped it in that case.)
- Fields declared `t.string().stamp('userId')` are filled on insert from the signed-in user; naming
  another user throws `StampedFieldError`.
- A replace-mode backup restore, or a rebuild that opens memberships at sequence 0, re-scopes every
  device in full at its next handshake.

## 6. Checklist

1. Back up the server database; run `kora doctor --db <database> --dry-run-migrations --strict`.
2. In the server project: `npx kora upgrade --yes`. Fix compile errors from the tables above
   (custom auth managers, `AdminApi` calls, `SyncGrant`, `TotpStore.saveIf`, stores). Check the
   server's environment for the `KORA_*` names it now reads, `trustProxy`, and the size options.
   Deploy the server. Watch the first start ([section 7](#_7-what-to-monitor)).
3. If you use `TokenAuthProvider` scopes, add `deliveryPartitions` for the fields you grant on.
4. In each client project: `npx kora upgrade --yes`. Rebuild so `koraServiceWorker()` regenerates the
   worker and stamps the build id. Desktop apps: update the Rust plugin, import `@korajs/tauri`, and
   rebuild.
5. Add `durability` to a custom `AuthTokenStorage`, `offline.auth` to an app with its own sign-in, and
   `durable` to a custom blob store.
6. Search for a collection named `schema`, `offline`, `setReadOnly`, `readOnlyReason` or
   `reloadForNewBuild`, for code that chains `limit` or `offset` before `count()`, and for empty
   states rendered before `useQueryState(...).ready`.
7. Decide how your app handles `WriteNotDurableError` (do not retry), a rejected `app.ready`, and
   the reload prompt.
8. Deploy the client. Ask users to close old tabs once (or accept the prompt).
9. Run `kora doctor --production --url https://sync.example.com`.

## 7. What to monitor

On the server (structured log events):

| Event or metric | Meaning |
|---|---|
| `delivery.partition_miss` | A scope field is outside the partition plan; sessions read that collection whole. Add it to `deliveryPartitions`. |
| `session.protocol_refused` | A protocol-1 client tried to connect and was refused. |
| `session.tombstone_delivery_undetermined`, `server:tombstone-delivery-undetermined` | A delete's delivery point could not be decided yet; only that write is held, and withheld from the device if the hold cannot resolve (`action: 'withheld'`, counted in `withheldDeliveries`). |
| `operations.commit_hook_failed`, `server:commit-hook-failed` | An `onOperationsCommitted` handler threw. The commit is unaffected. |
| `CLIENT_TOO_OLD`, `ACCESS_RULES_CHANGED` session refusals | An old client reached an access-rules server, or rules were not in force for a session (it reconnects). |
| `SYNC_QUERIES_LIMIT`, `INBOUND_QUEUE_FULL`, `YJS_UPDATE_THROTTLED` | A client hit one of the new limits (a beta.14 client with more than 1,000 query views is refused until it updates). |
| `session.delivery_rewind` | A client stopped acknowledging and the server retransmitted from its last acknowledgment. |

On devices (forward these events to your telemetry):

| Event | Meaning |
|---|---|
| `store:storage-evicted` | A database that existed vanished. |
| `store:write-durability` | Resolved writes on the IndexedDB fallback are failing, or recovered. |
| `app:build-superseded`, `store:build-gate-waiting`, `store:legacy-build-detected` | The version gate retired this tab, or a new tab is waiting for an old one. |
| `sync:operations-acknowledged`, `sync:operations-rewritten` | The server stored operations; unsent operations were re-authored under new ids (clock rebase, node rotation, renumbering). |
| `store:overlay-diverged`, `store:overlay-disabled` | Only with `instantUpdates`: a prediction differed from the database. |

`kora doctor --json` prints every check for CI. See [Error Codes](/api/errors) for the codes above.

## Not covered by `kora upgrade`

No codemod was added for beta.15. The changes that could be detected in source are either reported by
the TypeScript compiler (the `PasswordResetManager` and `EmailVerificationManager` constructors, the
removed error classes, the `AdminApi` signatures, `SyncGrant`, `TotpStore.saveIf`, the removed
options) or are detections that source analysis cannot make safely:

- A custom `AuthTokenStorage` or `ContentAddressedBlobStore` without `durability` / `durable`: it can be
  any object or class, so a scan cannot tell a custom store from a wrapper that already declares it.
- A collection with a newly reserved name: `createApp` already warns once in development.
- Behaviour changes on the server (`spaFallback`, scope validation, `INVALID_DELETE_PAYLOAD`, the
  environment settings, the new limits, the query contract) and `count()` with `limit`: they depend
  on runtime data.

If a diagnostic for one of these would help your fleet, it fits the existing report-only `Codemod`
interface in `packages/cli/src/upgrade/codemods/`.

## Removed: the beta.12 merge pipeline

`experimental.legacyMerge` is gone, along with `ExperimentalOptions` and the deprecated pairwise
exports of `@korajs/merge` (`MergeEngine`, `mergeField`, `lastWriteWins`, `addWinsSet`, `mergeObject`,
`mergeAtomicOps` and the `.merge()` strategy functions). `korajs` no longer re-exports `MergeEngine`.
A database that ran with the option re-materializes with the fold on its next open. Remove the option
from `createApp`; TypeScript reports it, and JavaScript callers have it ignored.

## Removed: `store.sharedWorkerUrl`

Ignored since beta.6: SharedWorker-hosted SQLite cannot use OPFS and was never durable, so Kora uses
the dedicated-worker leader/follower path for several tabs. The option is gone from `createApp`'s
`store` options and from `SqliteWasmAdapter`. Remove it; TypeScript reports it, and JavaScript
callers have it ignored (without the old warning).

## Deprecations kept

The `allowLegacyAnonymousClaims` default of `true` is still present in beta.15, deprecated. The
release that removes it will say so in its notes.
