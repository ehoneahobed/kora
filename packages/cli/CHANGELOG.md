# @korajs/cli

## 1.0.0-beta.15

### Minor Changes

- df8133e: `kora deploy --platform kora-cloud` deploys to Kora Cloud, and `kora login`, `kora logout` and `kora whoami` sign the CLI in and out. Login uses a short code approved in the Kora Cloud console (works over SSH); the sign-in is kept in `~/.config/kora/cloud.json` with owner-only permissions, or comes from `KORA_CLOUD_TOKEN` in CI. Deploying uploads the source git would commit (never `node_modules`, `.git`, `.kora` or `.env` files), links the directory in `.kora/cloud.json`, and follows the build and each deployment stage until the app is live, printing the build log's end when a build fails. Kora Cloud deploys to production from the CLI; previews come from pull requests. Nothing changes for self-hosting or the other platforms. Also fixes `kora deploy --platform <name>` (and `--app`, `--region` with a separate value), which was read as an unknown subcommand, and prints an expected error once, without a stack trace.
- b1866e3: New `kora upgrade` (D2): bumps every Kora package in a project (`korajs`, `@korajs/*`) to one version, so versions never drift apart. It detects the package manager (the `packageManager` field, else the lockfile), finds the specifiers in `dependencies`, `devDependencies`, `optionalDependencies`, `overrides`, `pnpm.overrides`, `resolutions` and a `pnpm-workspace.yaml` `catalog`/`catalogs`/`overrides`, resolves a target (`--tag latest|beta|canary`, default `beta` for a project on a prerelease, or an exact `--to <version>`; every package must resolve to the same version), and rewrites each specifier in its own `^` / `~` / exact style while keeping the file's formatting. `--dry-run` prints the plan and diagnostics and changes nothing; `--yes` skips the confirmation (a non-interactive shell without it refuses); a downgrade needs `--allow-downgrade`. After rewriting it runs the package manager's install, then `kora doctor --skip-network` from the upgraded CLI, and exits non-zero with a clear message if either fails. Lockfiles and `node_modules` are never edited directly.

  A small codemod registry (`src/upgrade/codemods/`, interface `Codemod`) reports what a release changed in your source. The first three are report-only diagnostics with documentation links: removed or no-longer-negotiated protobuf serializers (`wire-format-serializers`), `t.json()` / `t.object()` values written or read as JSON strings (`json-field-string-values`, pointing at `findJsonStringValues`), and null tests on fields that now read their schema default on the server (`defaulted-field-null-checks`). `--apply-codemods` applies edits a codemod marks safe; none of the built-in ones rewrite code.

- af8f0a5: `kora doctor` grows the rest of D1 and D6. A new `schema-duplicates` check warns, with file paths and lines, when more than one `defineSchema()` call declares the same collection names (a client schema and a server schema written twice drift apart); the fix is to export one schema and import it from the client, the sync server and `kora.config.ts`, which every bundled template already does and now a test enforces for all 13. `kora doctor --db <database> --dry-run-migrations` runs the migrations the database has not recorded against a copy of the file (SQLite) or inside a transaction that is rolled back (Postgres, with `statement_timeout` and `lock_timeout` guards), and reports each step, the rows it touches, the measured duration and, on Postgres, the locks held (ACCESS EXCLUSIVE on ALTER) and for how long; it warns, never refuses. `kora doctor --production` adds `production-worker-delivery` (SQLite worker and `assets/sqlite3.wasm` in the build output, `.wasm` media type rules), `production-isolation-headers` (COOP/COEP are required only when the app itself needs `SharedArrayBuffer`; the `sqlite-wasm` adapter does not) and `production-runtime-storage`, and with `--url` a credential-free probe of the deployed server (`production-server-health`, `production-server-protocol`, `production-server-auth`) that times out cleanly and treats an unreachable network as a warning. `kora doctor --json` prints every check (`id`, `title`, `status`, `message`, `fix`) as one JSON document.
- 1643ce5: `kora doctor --db <url>`: a read-only preflight of the sync server's production database
  (Postgres URL, SQLite path, or `env:NAME`) before a deploy. It reports schema drift (column types
  a field kind change left behind, a schema rollback), constraint `where` clauses that can never
  match, json/object values stored as encoded strings (F14), ownerless device nodes, devices still
  on protocol 1, quarantined operations and generated migrations that change field kinds, and a
  dry run of the startup migration: what the next start re-folds and rebuilds, with a rough
  duration, warning when it exceeds 60 seconds. The database is opened in a read-only transaction
  and the URL's password is never printed. Exits non-zero on a failure; `--strict` also fails on
  warnings.
- ba4eaa7: Things apps had to work out for themselves now work out of the box, found by running Kora apps on Kora Cloud:

  - **File storage without code.** `createProductionServer` keeps the bytes behind `t.blob()` fields where the host says (`KORA_BLOB_STORE_URL`, or `KORA_BLOB_DIR`), and sweeps unused bytes daily. Set `blobStore` to choose a store in code, or `false` to keep none. An app that wires blob callbacks itself is unchanged.
  - **Unused-file sweeps never take a new upload.** `collectBlobGarbage` keeps unreferenced blobs written within the last day (`graceMs`), because a device uploads a blob before the record that points at it. This applies to stores that know write times: `FilesystemBlobStore` now does, and a re-upload refreshes it. `@korajs/store/blob-object` exports the server-side helpers (`toServerBlobCallbacks`, `collectBlobGarbage`).
  - **Settings declared in `.env.example`.** Tags in comments mark what production needs (`[required]`), credentials (`[secret]`) and local-only settings (`[development]`). `parseEnvExample` and `missingRequiredEnv` in `@korajs/core` read them, `kora doctor` reports them (`--production` fails on a missing required one), and templates ship a tagged file with the file-store settings.
  - **Testing access rules across users.** `new TestServer(schema, { auth: true })` and `new TestDevice({ user: 'alice', ... })` sign devices in, so access rules apply as in production, without assembling devices from internals.
  - **Quieter logs.** The Postgres auth stores no longer print "already exists, skipping" notices on every start.
  - **Generated `AGENTS.md`** covers file storage, settings, multi-user tests and deploying.

- d8fbc4e: First-visit parity, stage S4a: `KoraProvider` (React, Vue, Svelte) renders its children before `app.ready`, and the SQLite WASM and the store runtime load after the first paint. New `waitForStorage` prop restores the old gate (the provider renders `fallback` until the store is open). Until the store opens, `useQuery` and its siblings return empty values (`useQueryState().ready` is `false`) and `app.<collection>.where(...)` returns a deferred query with the same descriptor and `queryKey` as the real one. Writes made through `useMutation` before the store opens are queued, saved to a small IndexedDB journal first, and applied in order once the store opens; a tab closed in between does not lose them, and the next visit applies what is left (per user, with Web Locks so two tabs never apply an entry twice). A direct `await app.todos.insert(...)` before `app.ready` still throws `AppNotReadyError`; writes that use atomic helpers, writes to a collection with a `t.secret()` field and every write when `sync.encryption` is enabled wait in memory only and are not journaled (the journal would hold them before the store's at-rest transform could run). Each journaled insert gets its record id and time when the user acts, so a replay after a crash never creates a second record. A store that fails to open rejects waiting and later hook writes with `WRITE_NOT_APPLIED` (saying whether the write was kept for the next start), and `close()` before the deferred start rejects them too. A recovered write that fails is retried at the next start when the cause is transient and reported with the new `journal:write-failed` event when it is not. Entries made by another user, or before anyone was signed in, wait for their owner. `await app.ready` keeps its meaning, and a connection requested with `autoConnect` or `app.sync.connect()` now starts in parallel with the store open.

  `korajs`'s `createApp` is a small shell that loads the runtime with a dynamic import after the first paint (or at once outside a browser). New `lite` entries (`@korajs/core/lite`, `@korajs/store/lite`, `@korajs/sync/lite`) hold the few modules the first paint needs so bundlers do not pull the runtime in with them; the packages declare `"sideEffects"` (the SQLite worker entry stays listed). The templates drop the startup `fallback`, call `app.sync?.connect()` without waiting for `ready`, and show their empty state only once `useQueryState().ready`; the offline-shell registration script is minified. `KoraAppLike` gains an optional `collections`, and `SyncTransport` an optional `warmUp(url)`.

  Access-rule validation no longer runs on the critical path of a production browser bundle: `defineSchema` validates `access` eagerly when the compiler is loaded (development builds of `korajs`, a server, the Kora runtime) and otherwise on the first read of `schema.access`, which the runtime forces while it opens, so a bad rule still surfaces as an `app.ready` rejection with the same error. `@korajs/core` exports `registerAccessCompiler` and `AccessNotLoadedError`; `@korajs/server` registers the compiler itself. The sync engine's query-subset reconnect is avoided at startup: the queries subscribed before the store opens are registered with the sync engine before it starts. `WriteOptions` gains internal `recordId`, `recordIds` and `writtenAt` (used by the journal). `bundle-budget` reports gzip per package. A write held in memory only raises the new `journal:memory-only` event. `sync.authClient` can be wrapped in the new `lazyAuthSync(() => import(...))` to keep the sign-in client out of the first paint, and `WriteOptions` no longer carries the journal's internal `recordId`, `recordIds` and `writtenAt` fields.

  The Vue, Svelte and Tauri sync templates load the sign-in client after the first paint, like the React ones. The K3 budget is a no-growth ratchet (CI compares head with the merge base measured on the same runner; the template adds 25.3 KB gzip, 22.5 KB brotli, the floor the first screen needs; ratchet 26,330 bytes). The absolute first-paint values (1.0 s on Slow 4G, 250 ms on broadband) are the nightly dedicated-host contract and are reported, not enforced, in CI.

  The write journal now identifies each write (`opKey`) and `@korajs/store` records it in a local table (`_kora_journal_applied`) in the same transaction as the write, exposed as `Store.hasJournalApplied` and `Store.forgetJournalApplied`, so a replay never applies a write twice or reverts a later edit. New events: `journal:discarded` (unsent writes thrown away by `deleteDatabase`) and `journal:write-expired` (raised with the count before unclaimed entries are removed). The sign-in client of every sync template loads behind an error boundary, so a failed chunk load leaves the app working. `lazyAuthSync` keeps its subscribers across a failed load. Listeners added before the app opened are told only when a status actually changed.

  `defineSchema` returns a lightweight schema synchronously; its full validation, access rules and the merge fold load with the runtime. Development builds, servers and tests validate at `defineSchema` as before; in a production browser build a schema error rejects `app.ready` (and `schema.access` before the runtime loaded throws the new `AccessNotLoadedError`). `@korajs/core` exports `finalizeSchema`. `createApp` validates its configuration (sync URL, encryption options, `store.workerUrl`, the schema) at the call in development builds and, in production builds, when the runtime loads: a bad option then rejects `app.ready` with the same `KoraError` and its fix. `@korajs/store/lite` splits `QueryError` out of the store's error module. Held journal writes (entries with no owner yet, or another user's) are reported through the held-writes contract (`sync.unassignedWrites`, `sync.assignHeld`, `sync.discardHeld`, `heldOperations`) and never expire. A runtime chunk that cannot be loaded is retried three times and then rejects `app.ready` with `RUNTIME_LOAD_FAILED`; the sign-in client chunk of the React, Vue and Svelte templates is retried the same way (`retryImport`).

  Review fixes: a failed chunk import (the lazy runtime, journal or recovery chunk after a deploy) recovers with one guarded page reload; `assignHeld` refuses a mismatched owner (`HELD_ASSIGN_USER_MISMATCH`, `NO_USER`, `NOT_READY`, `TARGET`); the journal claim runs in `BEGIN IMMEDIATE` (native SQLite too); CJS builds split the lite entries; the bundled server finalizes its schema explicitly; an unfinalized schema serializes with `unfinalized: true` instead of throwing. Fixed a race in which a query subscribing while `start()` was still reading the stored delivery watermarks saved 0 over them and left the offline status `data-incomplete` after a reload (`SyncEngine.watermarksPending`). New: the `journal:delete-blocked` event and `HeldNodeInfo.oldestWrittenAt`. CI runs the offline smoke test on the React, Vue and Svelte sync templates.

- 622e628: `/health` on the sync server now reports `authRequired` (a boolean: an auth provider guards the sync handshake) and `protocolVersion` (the highest sync protocol the server speaks), and `getStatus()` carries both. They are additive and leak no secret. `kora doctor --production --url` uses them: `authRequired` lets its credential-free probe verify handshake authentication, and `protocolVersion` replaces the protocol it derived from the version string (a malformed value is ignored, and servers that do not report either field keep the old behavior).
- 3e61c2f: `kora deploy --platform kora-cloud` honours a `.koraignore` (`.gitignore` syntax) at the repository root, or in the project's folder in a monorepo, for files the repository keeps but the app doesn't need, such as design sources and recordings.
- a5b3933: The offline app shell reports whether it is really there. The worker generated by `koraServiceWorker()` answers `KORA_SW_STATUS` after checking every precached URL, and when online refetches a missing one past the HTTP cache and stores it only if its SHA-256 equals the digest recorded at build time (a newer deployment's bytes are never stored, the entry stays missing); it also compares the page's hashed scripts and styles with its own build (`other-build`) and records the URLs it could not serve (`misses`, bounded). The registration script publishes `globalThis.__KORA_SHELL__ = { v: 1, state, version, misses }` and a `kora:shell` event (checked at start, on `updatefound`, `controllerchange` and `visibilitychange`, never polled), and `app.offline.status().shell` reads it: `installing`, `installed`, `not-installed`, `other-build`, `unsupported`, `bundled` (a native-storage desktop build) or `none` (no plugin, `vite dev`, or an older `@korajs/cli`: update both). All 13 templates, `tauri-react` included, render an `<OfflineBadge />` built on `useOfflineReady()` ("Available offline", "Preparing offline copy... 40%", "Not available offline yet"; first reason as the tooltip), on by default and not rendered in `vite dev`.
- dabd17d: `TestServer` exposes `access` (`grant`, `revoke`, `transfer`) and takes `accessSweepIntervalMs`, so a test can add and remove collaborators and check what their devices receive. `TestDevice.sync()` now flushes writes made before the first sync, as it does on later syncs. After `kora deploy --platform kora-cloud`, the CLI lists settings production still needs (with what each is for, from `.env.example`) and any problems Kora Cloud found in the code, with where to fix them.

### Patch Changes

- 0c1f8f3: New guide, [Offline Readiness](https://korajs.dev/guide/offline-readiness): what Kora guarantees (a `ready` app opens offline, a write whose promise resolved is never lost) and what the app is responsible for, with `app.offline.status()`, `keep`, the app shell and `<OfflineBadge />`, offline sign-in, storage-loss reporting and durable writes on the IndexedDB fallback.

  Upgrade notes for `1.0.0-beta.15`:

  - Update `korajs`, `@korajs/auth` and `@korajs/cli` together. An older `@korajs/auth` cannot report offline sign-in (`auth-unknown`, never `ready`); an older `@korajs/cli` plugin publishes no shell status (`shell-none`).
  - A custom `AuthTokenStorage` that does not declare `durability` reads as `unknown` and is never `ready`. Pass `durability: 'durable'` to `createAuthTokenStorage` for a store that survives a restart, or declare `offline.auth`.
  - A custom `ContentAddressedBlobStore` that does not declare `durable` counts as not durable: a pin that keeps files reports `storage-non-durable`. Declare `readonly durable = true` on a store whose bytes survive a restart.
  - On the IndexedDB fallback a write can now reject with `WriteNotDurableError` (it used to resolve even when its snapshot failed). The write exists; do not retry it.
  - An app with a bare `sync.auth` token function reads `not-ready` until it declares `offline.auth`.

- 0c1f8f3: Two bugs found by running every bundled template through the new offline-readiness suite (`pnpm test:e2e:offline`):

  - `koraServiceWorker()`: the generated worker looked up its precache with `Vary` taken into account. A host that sends `Vary: Origin` (`vite preview`, and CDNs with CORS rules) made the page's own `<script type="module" crossorigin>` requests miss the install-time copies, so a reload of an app that reported `ready` failed offline with the shell blank. Lookups now ignore `Vary` (every precached URL is exactly one file of the build), and the cache check the status reads uses the same rule.
  - `@korajs/vue` `KoraProvider` held the store in a deep `ref`, handing every composable a reactive Proxy of it. The store compares its query subscriptions by identity, so the first result of every `useQuery` was discarded as stale: after a reload the list stayed empty until the next write. It now uses `shallowRef`.

- 5bc62cf: Change the sign-in secret without signing anyone out. `KORA_AUTH_SECRET` signs and the comma-separated secrets in `KORA_AUTH_SECRET_PREVIOUS` are still accepted; sessions move to the new secret at their next refresh. `createKoraAuthServer` reads both when `jwtSecret` is left out, and `authSecretFromEnv()` (from `@korajs/auth/server`) returns the same for apps that pass `jwtSecret`. Templates use it and list `KORA_AUTH_SECRET_PREVIOUS` in `.env.example`.
- 9a31b72: Resolve bundled templates, the CLI package version, and optional database drivers without relying on `import.meta.url` in CommonJS output. The `@korajs/cli/create` side-effect entry is now ESM-only, matching the published `create-kora-app` executable, while the documented main and Vite programmatic entry points retain both ESM and CommonJS exports.
- 5742b40: `kora deploy --platform kora-cloud --prod --confirm` no longer asks for `--app` in a folder linked to a Kora Cloud project: the link says where it deploys. Failures print their message once; unexpected ones no longer print twice with a stack trace (set `KORA_DEBUG=1` to see it).
- accd433: `kora import --platform kora-cloud --accept-unverified <count>` accepts exactly the operations a refused import reported as not matching their content hashes (written by the app's own scripts around the server's checks). Kora Cloud keeps checking them for later changes.
- 166d7e0: On Kora Cloud, `kora deploy status` says how the running version is doing (healthy or failing, why, and when Kora Cloud last checked), not only whether the latest deployment finished. New: `kora deploy restart` starts the running version again with the same release and data.
- 4dabd38: `kora doctor` no longer warns about things that aren't problems, found by running it on Bozoma Learn:

  - **One schema:** once the app's schema has loaded, only definitions that repeat its collections are reported. A self-contained script or test harness with its own throwaway schema is no longer flagged.
  - **Runtime storage:** an adapter chosen in one branch of a conditional (`backend === 'indexeddb' ? { adapter: 'indexeddb' } : {}`, to reopen a fallback copy) no longer counts as the app forcing that adapter, so the worker and WASM delivery check still runs.
  - **Insecure sync URL:** only sync settings (`SYNC_URL`, `syncUrl`, `sync:`, a bare `url:`) are read as sync endpoints, not other settings ending in URL (`KORA_BLOB_STORE_URL`, `PUBLIC_URL`), and reserved test hosts (`*.example`, `*.invalid`, `*.localhost`) are skipped.

- 6a6267c: Add `kora doctor --production` diagnostics for server-enforced schema access and authentication boundaries, and fail diagnostics when Kora canary packages are pinned to different releases.
- 5803f43: A Vite build that fails before writing its output folder now shows its own compiler error. `koraBuildId()` and `koraServiceWorker()` no longer throw a missing-directory error from `closeBundle` on top of it.
- d36239c: First-visit parity, stage S1: the offline shell's precache no longer competes with the app's first data, and no longer downloads the app a second time.

  - `koraServiceWorker()`: on a first visit (a page no service worker controls yet) the worker is registered, and the shell precached, only after the app's first data (the new `kora:first-data` event), at most `firstDataTimeoutMs` (new option, default 10 s) after `load`, then at an idle moment. A page a worker already controls registers at `load`, as before.
  - The install takes each file from the HTTP cache first (`only-if-cached`, then `cache: 'default'`), keeping it only when its SHA-256 equals the build's digest, and falls back to `cache: 'reload'` as before. Byte-identical files (the unhashed `sqlite3.wasm` copy of the hashed WASM) are downloaded once and stored under every URL; previously both were precached and downloaded, because Vite's hash `1f8bVu-G` contains `-` and was not recognised as one. On the default template's cold first load this takes the requests that reach the server from 26 to 17 and the body bytes from 1.53 MB to 0.81 MB: the main bundle and the WASM are each downloaded once.
  - `korajs`: `createApp` publishes `globalThis.__KORA_FIRST_DATA__` (`pending`, then `done`) and dispatches `kora:first-data` once the first data is in: at `app.ready` for a local-only app; for a syncing app when the first delivery batch is applied, the session is caught up, or sync stops until someone acts (signed out, locked, blocked) or an attempt ends offline.

- f088f34: `kora import` restores into a PostgreSQL server older than its client tools. pg_restore 17 opens every restore with `SET transaction_timeout`, which PostgreSQL 16 refuses, so an import with newer tools failed on its first line. The import now leaves out only the opening settings the server doesn't know and restores through psql in one transaction. Schema and data pass through untouched.
- 8952e90: Add `kora export` and `kora import --platform kora-cloud`. `kora export` bundles an app's whole PostgreSQL database (through `pg_dump`) and the files in `KORA_BLOB_DIR` into one `.tar`, in the format Kora Cloud's backup downloads use; nothing in the app is changed. `kora import` uploads such a bundle straight to a Kora Cloud project's own backup storage, where it is verified like a backup and can then be loaded into production or opened as a recovery environment.
- 89d06f5: `kora import <bundle>` without `--platform` loads a bundle (`kora export`, or a backup downloaded from Kora Cloud) into your own PostgreSQL database and files folder (`--database-url`/`DATABASE_URL`, `--blob-dir`/`KORA_BLOB_DIR`). It checks the whole bundle first (the dump's checksum, every file against its name), refuses a database that already holds tables, restores in one transaction, compares row counts with the bundle's, and copies files last. The backup guide shows the whole restore with Docker Compose.
- 39c24c6: Desktop apps can sign in to a remote sync server. A Tauri WebView loads pages from `tauri://localhost` (or `http(s)://tauri.localhost`), so its calls to the server's auth routes are cross-origin, and the server answered no preflight: sign-in failed with a network error. `createProductionServer` now allows native app shell origins, the comma-separated `KORA_ALLOWED_ORIGINS`, an `allowedOrigins` option and, outside production, `http://localhost` on any port, for `httpRoutes` and `/health`, never with credentials. `kora doctor` no longer asks a Tauri app for the SQLite WASM worker.

  `createProductionServer` reads the settings a host sets when the app passes none: `KORA_TRUST_PROXY` (a hop count or comma-separated ranges) and the operational tokens `KORA_ADMIN_TOKEN`, `KORA_METRICS_TOKEN` and `KORA_BACKUP_TOKEN`. Apps no longer parse them by hand.

- aa834a9: Two fixes found by the packed-artifact release matrix. `createPostgresServerStore` no longer prints a screenful of `relation ... already exists, skipping` notices on every start against an existing database (the store's DDL is idempotent and postgres.js logs each skipped statement by default). `kora doctor --production` no longer reads a `0.0.0-canary-<datetime>` snapshot as a 0.x release that speaks sync protocol 1, which hid a protocol-1 server behind a canary client; a canary build now maps to no protocol, like `1.0.0-canary-*` did.
- fdebfac: A schema change re-folds only the collections whose merge rules changed. The server stores (SQLite and Postgres) record each collection's fold plan (`fold_plan_fingerprints`) and stamp each fold state with its collection's plan, as client stores already did, so changing one field's merge strategy in a 50-record collection re-folds those 50 records, not every record of the database (0.1 s instead of 2.6 s for 20,000 others on a laptop). Scope snapshots are dropped and rebuilt per collection too, and access rules are held for a membership-index rebuild only when a re-planned collection feeds the index. Transforms and explicit authorities still re-plan every collection.

  Upgrading is free: on the first start, a database whose plan is unchanged is restamped (one statement per collection) and nothing is re-folded; one whose plan changed in the same deploy is fully re-folded once. Rolling deploys keep working across versions: a state stamped with the current whole-schema plan is current, any other stamp is re-folded by the existing sweep. `getFoldMigrationReport().replanned` names the re-planned collections, and `kora doctor --db` estimates only their records and snapshots.

- d2650f3: Remove the beta.12 pairwise merge pipeline. `experimental.legacyMerge` and `ExperimentalOptions` are gone, a database that ran with the option re-materializes with the fold on its next open, and `MergeAwareSyncStore` no longer takes a merge engine.

  `@korajs/merge` no longer exports `MergeEngine`, `mergeField`, `lastWriteWins`, `addWinsSet`, `mergeObject`, `mergeAtomicOps`, the `.merge()` strategy functions, or the `MergeInput`, `MergeResult` and `FieldMergeResult` types, and `korajs` no longer re-exports `MergeEngine`. The cross-record constraint checks, referential integrity and rich-text helpers stay.

- f03e493: Remove sync protocol 1 (Kora 1.0.0-beta.12 and earlier). A server now refuses such a client at the handshake, before authentication, with the non-retriable `PROTOCOL_VERSION_UNSUPPORTED` and logs `session.protocol_refused`. Update those apps before upgrading the server. Operations those versions wrote keep their version-1 ids and stay valid: an updated device can still upload them, and any id the server cannot verify is refused with `INVALID_OPERATION_ID`.

  Removed with it: `PROTOCOL_V1_DEPRECATED`, the `sync:protocol-deprecated` and `sync:unverified-legacy-operation` events, the `unverifiedLegacyOperations`, `legacyProtocolSessions` and `lastLegacyProtocolSessionAt` metrics, the `kora_legacy_protocol_sessions_total` and `kora_last_legacy_protocol_session_timestamp_seconds` gauges, and the protocol line in `kora status`.

- 4f1cbb0: Operator insights report sign-in activity and file delivery. `createKoraAuthServer` counts what its routes do (sign-ins, sign-ups, second factors, OAuth, refreshes and verification or reset emails, by outcome and failure code, plus server errors) for the last hour and day, in memory, never an email or id: `auth.activity()`, and `auth.httpRoute` mounts the routes and reports these under `http.auth` in `/__kora/insights` (`httpRoutes: [auth.httpRoute]`; templates use it). Any production HTTP route may report counts through `insights`, sanitized to numbers. Insights also add `files`: file chunk requests served, found nowhere, throttled, and errors since start. `collectBlobGarbage` documents that its grace applies to dry runs (`graceMs: 0` lists everything).
- 39c24c6: Desktop sign-in sessions live in the operating system's credential store. `createTauriCredentialStore()` keeps credentials in Keychain (macOS), Credential Manager (Windows) or the Secret Service (Linux) through new commands of the `kora-sqlite` plugin, included in its default permission. Pass it to `createAuthTokenStorage` for `createKoraAuth({ storage })`; the Tauri template now does. A session saved in WebView storage by an earlier version moves to the keychain on first read; where no credential store exists it falls back to WebView storage and warns once. The plugin needs Rust 1.88 or newer.
- 9ba9573: The Tauri template is ready for Tauri's iOS and Android targets: it has a mobile entry point, and the updater (desktop only) is left out of mobile builds in code, dependencies and capabilities. Its README says how to add mobile and how to deploy the sync server. `FilesystemBlobStore` reports its directory as `location`, so the production server's startup log names where files are kept.
- ab5e75b: Accepting a new version never loses a write on screen, and apps share one honest sync summary. Found redesigning KoraPOS.

  - The offline shell's update (`koraServiceWorker()`) waits until no write is still committing before the new version takes over and the page reloads. It dispatches `kora:update-waiting` meanwhile. Before, tapping "Reload" during a sale's commit could lose the sale. The store exposes the count it waits on: `store.pendingWriteCount()` and `store.whenWritesSettled()`, published to the page as `__KORA_WRITES__`.
  - `summarizeSyncStatus()` (`@korajs/sync`, `korajs`) and `useSyncSummary()` (`@korajs/react`) summarize a sync status for an indicator: tone, title, one honest line of detail, pending writes, and `downloading` while the first download runs. Four Kora apps had each written their own version.

- ad6fce2: Version gate, stage 3: a build id for every Vite build. `koraServiceWorker()` now stamps `<meta name="kora-build" content="<id>">` into built pages (opt out with `buildId: false`), and the new standalone `koraBuildId()` plugin (from `@korajs/cli/vite`) does the same for apps without the offline shell. The id is a hash of every deployed file once the build is written (chunks, HTML pages with the id itself normalized, files copied from `publicDir`, files other plugins wrote), except the worker `koraServiceWorker()` generates (a `sw.js` the app ships itself is hashed by `koraBuildId()`), sourcemaps, precompressed copies of another emitted file (a standalone `.gz`/`.br` asset is hashed and precached) and dotfiles; each file is hashed separately and combined with length-prefixed paths. In `vite dev` it is `dev-<server start>` (a dev-server restart prompts open tabs to reload). With both plugins, the meta tag is injected once and both stamp the same id. An authored `kora-build` tag has its content replaced; only that tag's placeholder is stamped (the same string elsewhere in a page stays); precompressed copies of a stamped page (`.html.gz`, `.html.br`) are regenerated; every page is stamped, multi-page and nested entries included. `createApp()` reads it when no `build` option is given (an unstamped placeholder is ignored), so tabs of two deployments never write the local database at the same time, including deployments that change only application code. Every web template already uses `koraServiceWorker()`; Tauri templates need none (native SQLite is not gated).
- b7f964a: Version gate, stage 5: every template drafts its new-task field with `useFormDraft` (React, Vue, Svelte; the only drafted field, cleared once the write is stored, kept when a write is refused), and the templates with sign-in pass the user only once the session has loaded (`userId: undefined` while it loads, so the reload's draft survives the session restore) and clear every draft on sign-out and when a known signed-in user changes, never on the first load (`clearFormDrafts(app)`, which now also accepts the app). New guide: [App updates and multiple tabs](https://korajs.dev/guide/app-updates) (deployments, build ids, the reload prompt and its states, frozen and background tabs, the beta.15 upgrade note, HTTPS and test environments, form drafts and their privacy rules); API pages for the new errors, events, `useFormDraft` and the Vite plugins.
- Updated dependencies [24f5531]
- Updated dependencies [6c72c04]
- Updated dependencies [6fd998a]
- Updated dependencies [946dd42]
- Updated dependencies [8667762]
- Updated dependencies [003d7bf]
- Updated dependencies [0b461fa]
- Updated dependencies [8411be3]
- Updated dependencies [714ebd2]
- Updated dependencies [ba4eaa7]
- Updated dependencies [180923d]
- Updated dependencies [b8f9e6f]
- Updated dependencies [d8fbc4e]
- Updated dependencies [ebf38cd]
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
- Updated dependencies [7775735]
- Updated dependencies [f03e493]
- Updated dependencies [c893d28]
- Updated dependencies [0b461fa]
- Updated dependencies [b378fb9]
- Updated dependencies [22f5d75]
- Updated dependencies [a9726dc]
- Updated dependencies [1c9dbe0]
- Updated dependencies [0388bd7]
- Updated dependencies [68cbb70]
- Updated dependencies [df7a430]
- Updated dependencies [b7f964a]
  - @korajs/core@1.0.0-beta.15

## 1.0.0-beta.14

### Patch Changes

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

- Scaffolded web apps open offline: the `koraServiceWorker()` Vite plugin (`@korajs/cli/vite`)
  precaches the app shell and SQLite WASM files and serves one build per active worker.
- `kora migrate` changes only what the schema changed (`--kora:evolve-table`,
  `--kora:relax-value-domain`), works on Postgres and never touches Kora's internal tables.
  **Breaking:** table-rebuild migrations generated by earlier versions are refused on Postgres;
  regenerate them.
- The production static server uses content-derived ETags, real 404s for missing assets and
  correct MIME types (`.webmanifest`, `.wasm`).
- `kora deploy` refuses Render and Docker ("coming soon") before writing anything.
- Templates use the typed hooks; the desktop template pins `@korajs/tauri` to its own version.

See the [1.0.0-beta.13 release notes](https://github.com/ehoneahobed/kora/blob/main/docs/releases/v1.0.0-beta.13.md) and the [upgrade guide](https://github.com/ehoneahobed/kora/blob/main/docs/guide/upgrading-to-beta13.md) (servers first, then clients).

### Patch Changes

- `kora migrate` table rebuilds keep hand-written CHECK constraints (except one that reads a dropped column).

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

### Minor Changes

- Add a `kora agents-md` command that writes an AGENTS.md with Kora conventions
  (data-plane rules, the corrected hook API, anti-patterns, and the machine-readable
  docs endpoints) into an existing project. It detects the UI framework from the
  project's dependencies, refuses to overwrite an existing file without `--force`,
  and accepts a `--framework` override. This extends the guardrail that scaffolded
  apps already ship to the manual-setup path.

### Patch Changes

- SQL identifiers are now quoted everywhere they are generated, so a collection or
  field name that is valid JavaScript always produces valid SQL. camelCase
  (`formResponses`), PascalCase (`UserProfiles`), and names that happen to be SQL
  reserved words (`order`, `select`) now work end to end across the client store,
  both server stores, migrations, and CLI-generated migration files. Previously a
  camelCase collection was rejected at `defineSchema` and a reserved-word name
  produced a runtime SQL syntax error.

  A new `quoteIdent` helper is exported from `@korajs/core`. Schema validation
  still fails fast for genuinely malformed names (empty, or containing characters
  that are not letters, numbers, or underscores). Existing all-lowercase schemas
  are unaffected: quoting a lowercase identifier is a no-op in both SQLite and
  Postgres.

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @korajs/core@1.0.0-beta.5

## 1.0.0-beta.0

### Minor Changes

- New command: `kora studio` — the visual window into Kora's data plane, in two
  modes.

  FILE mode (`kora studio --db path/to/db.sqlite`) inspects any Kora database,
  strictly read-only: records with each field's LAST WRITER (which device
  changed it, and when), the full operation history behind every record, a
  causal DAG that makes concurrency visible as parallel device lanes, TIME
  TRAVEL (scrub to any operation and see the exact state at that causal cut,
  with animated replay), tombstones, the outbound sync queue, the version
  vector, and the merge audit trail. Live-updates via server-sent events when
  the database changes. No schema file needed; no extra dependencies; the UI is
  fully self-contained and offline.

  LAB mode (`kora studio --lab`) is an interactive multi-device sync
  laboratory: real Kora clients (own store, sync engine, merge pipeline)
  against a real in-process sync server. Create devices, edit records on each,
  disconnect them, make conflicting edits, watch the convergence banner flip to
  DIVERGED, reconnect, and watch every device converge — with a live event feed
  showing each operation, sync message, and merge decision as it happens.
  Chaos controls per device (drop, duplicate, reorder, latency) and atomic
  increment buttons demonstrate composition: +1 on two offline devices merges
  to +2, never lost. Everything in the Lab is throwaway; it can never touch
  real data. Optionally bring your own schema with `--schema`.

  SPECTATOR mode (`kora studio --connect wss://… --schema ./kora/schema.ts`)
  attaches to a LIVE production sync server as a real, read-only Kora client
  over the real WebSocket protocol: full history on connect (production time
  travel), live operation streaming, per-field writers, causal DAG, and merge
  audit — with no mutation surface, so it can never write to production.

  Studio answers the hardest question in a synced app — "why does this record
  look like this on this device?" — with evidence, not logs.

### Patch Changes

- Every scaffolded app now includes an AGENTS.md file: framework rules, data API
  cheat sheet, and project conventions written for AI coding agents (and humans),
  so agents build Kora apps correctly instead of reaching for fetch calls and
  hand-written types.
- Clock integrity: protection against wrong device clocks at every layer.

  - HLC now validates remote timestamps BEFORE adopting them (`RemoteClockDriftError`),
    so a far-future timestamp can no longer poison a replica's clock.
  - Local timestamp generation never throws and never blocks writes: drift is
    reported through callbacks and `sync:clock-skew` events instead.
  - The sync handshake now carries `serverTime`; clients measure their own skew,
    pause sync with a new `clock-error` status when the device clock is more than
    60s fast (local writes keep queuing), and warn via events when it is very slow.
  - `SyncStatusInfo` gains `clockSkewMs`; the store's HLC receives the measured
    offset so remote validation works even on devices with wrong clocks.
  - Scaffolded templates render a plain-language banner telling end users how to
    fix their device clock. See the new Clock Integrity guide.
  - Automatic timestamp rebase: after the clock is corrected, the next handshake
    clears the clock block on its own and re-stamps queued never-acknowledged
    operations (new content-addressed ids, causal deps remapped, original order
    preserved) so sync resumes immediately instead of waiting for real time to
    catch up. A new `sync:clock-rebase` event reports `rebasedCount` and
    `maxSkewMs`. Safe because unacknowledged operations are private to the
    device — like rewriting unpushed git commits.
  - Bounded logical counter with carry: the HLC logical counter is capped at
    99,999 (`MAX_LOGICAL`, exported from `@korajs/core`) so serialized timestamps
    always sort lexicographically identically to `HybridLogicalClock.compare`.
    Overflow carries into wallTime (+1ms, counter resets) in `now()`, `receive()`,
    and `advanceTo()`; malformed timestamps (non-integer/negative fields, logical
    past the cap) are rejected with `InvalidTimestampError`
    (`INVALID_TIMESTAMP_FIELDS`) before any clock state changes, both at the
    replica and at server ingest.
  - Canonical binary encoding in op payloads: richtext `Uint8Array`/`ArrayBuffer`
    values are normalized to a tagged `{ $koraBytes: base64 }` form in
    `op.data`/`op.previousData` at operation creation, BEFORE content hashing, so
    the hash input, persisted JSON, and wire payload are the identical value and
    operation ids survive persistence round-trips. Plain-string richtext values
    are untouched (existing operation ids are unaffected); apply paths decode the
    tagged form (and tolerate the pre-fix numeric-key shape from dev databases)
    back to bytes.

- Package export hygiene and auth secret-handling hardening.

  - Every published package now exposes `./package.json` in its `exports` map. Previously `require.resolve('@korajs/core/package.json')` (and the same for every other package) failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`, which breaks tooling that reads a package's manifest or version at runtime.
  - `createKoraAuthServer` now warns loudly when it falls back to an ephemeral random JWT secret outside production, so a deployment that never set `NODE_ENV=production` no longer silently regenerates its signing key on every restart (which invalidates all existing tokens) without any signal.
  - `KORA_AUTH_SECRET` set to an empty or whitespace-only string is now treated as unset rather than as an invalid secret, so it triggers the intended dev fallback / production guard instead of crashing `TokenManager` with a "secret too short" error.

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

## 0.3.4

### Patch Changes

- 3abd604: fix(tauri): add required `links` field and rename plugin to tauri-plugin-kora-sqlite for Tauri 2.x compatibility. Add tauri-react desktop template to CLI with --platform flag.

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

### Patch Changes

- 6a05e88: Performance: Replace O(n²) topological sort with binary heap in @korajs/core (19x faster sync for large operation sets).

  New: @korajs/auth package with sessions, TOTP MFA, organizations, RBAC, passkeys, encrypted tokens, and E2E operation encryption (912 tests).

  New: Full Preact-based DevTools UI panel with sync timeline, conflict inspector, operation log, and network status.

  Docs: Comprehensive documentation refinement — added API references for merge, sync, auth, and devtools; added authentication guide; expanded sync configuration guide; updated all package descriptions.

- Updated dependencies [6a05e88]
  - @korajs/core@0.3.0

## 0.2.0

### Minor Changes

- 6fb50fd: Add `kora deploy` command for one-command deployment to Fly.io and Railway.

  Features:

  - Full Fly.io and Railway adapters with provision, build, deploy, rollback, logs, and status
  - Dockerfile generation with native dependency handling (better-sqlite3)
  - Server bundling via esbuild with CJS compatibility shims
  - Client build with SQLite WASM asset patching (OPFS proxy + unhashed wasm)
  - Deploy state persistence for subsequent deploys
  - Platform config generation (fly.toml, railway.json)
  - Subcommands: `kora deploy status`, `kora deploy logs`, `kora deploy rollback`
  - Non-interactive `--confirm` mode for CI/CD

## 0.1.11

### Patch Changes

- Add Tailwind CSS templates, polished dark-themed UI, --yes/--tailwind/--sync flags, devtools enabled by default, and persistent SQLite server stores in sync templates.

## 0.1.3

### Patch Changes

- Fix Windows compatibility for kora dev command (resolve .cmd shims, spawn with shell)

## 0.1.2

### Patch Changes

- Fix template path resolution in create-kora-app and add package READMEs
- Updated dependencies
  - @korajs/core@0.1.2

## 0.1.1

### Patch Changes

- Add create-kora-app package for npx support

## 0.1.0

### Minor Changes

- Initial release

### Patch Changes

- Updated dependencies
  - @korajs/core@0.1.0
