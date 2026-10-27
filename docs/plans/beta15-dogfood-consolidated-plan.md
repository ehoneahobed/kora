# Beta.15 Dogfood Consolidated Plan

Status date: 2026-10-27
Canary under test: `0.0.0-canary-20261026104444`
Framework source: `main` at `82d33fd9`, plus the release-candidate fixes recorded below

This is the release plan derived from the current framework code and four real products, not from documentation claims. The north star is unchanged: Kora should make a secure, production-grade offline-first application as straightforward to create and operate as Next.js makes a web application.

## Product evidence

| Product | Workload | Canary state | Verification | Important evidence |
|---|---|---|---|---|
| KoraDocs | collaborative rich text, access rules, blobs, anonymous and signed-in sharing | exact published canary | typecheck, production build, production doctor, and 262/262 tests pass | The last failure was a v7 fixture that read a remote row without advancing its device HLC. Modeling the causal observation removed its random node-id ordering. |
| KoraForms | form builder, responses, analytics, webhooks | exact published canary | typecheck, build, 167/167 tests, and 13/13 real-Chromium end-to-end scenarios pass | Server-authoritative roles, sync scopes, operation validation, production configuration checks, and role-aware UI now make the shared deployment fail closed. Schema duplication remains application debt. |
| Bozoma Learn | large scoped LMS, auth, PWA, recovery, long-lived offline data | exact published canary | production build, full sanity, store safety, and focused real-browser critical recovery 15/15 pass | Production deployment invariants are now enforced. Recovery uses Kora's lock-safe public export API; the broader legacy browser matrix still contains stale tests that expect private pre-manifest storage enumeration. |
| KoraPOS | Tauri POS, inventory, payments, registers, multi-operator workflows | exact published canary | typecheck, full Tauri production build and macOS bundles, 87/87 tests, and production doctor pass | Compatibility is green. Doctor correctly reports the missing worker, access rules, and authentication. Plaintext local PIN/password data remains application architecture debt. |

All direct Kora dependencies in the products are exact pins. A green dependency migration is not treated as a security or production-readiness sign-off.

## Inclusion rule

A request enters Kora core only when it protects or simplifies a cross-domain invariant that most offline-first applications need. Reusable but optional capabilities belong in a package. Domain policy stays in the product or a recipe.

| Owner | Qualification | Examples from this dogfood round |
|---|---|---|
| Core | Universal correctness, durability, convergence, diagnostics, schema or transport contract | pending writes cannot disappear; durable rejection; schema compatibility; multi-tab ownership; typed operation-size errors |
| Optional package | Reusable capability with meaningful policy or weight that many, but not all, products need | auth, spaces/access membership, blobs, encrypted local secrets |
| Recipe/template | Correct integration pattern with app-owned policy | local operator unlock layered on an authenticated POS identity; webhook outbox; recovery/support UI |
| Product | Business workflow or product-specific authorization | document passwords; certificate approval; form analytics; register closing, receipts, tax and promotions |

No item is promoted merely because one product needs it. Promotion requires at least two independent product use cases, or a universal safety invariant demonstrated by a reproducible failure.

## Beta.15 release blockers

### Resolved during dogfood: causal invitation fixture

Kora's existing contract is correct: updates without an insert do not materialize a record, reordered delivery materializes it when the insert arrives, and a client that observes a remote operation advances its HLC before writing. The KoraDocs v7 helper read the server row but omitted `clock.receive(observedTimestamp)`, allowing an acceptance to sort before the invitation it had read. The fixture now models the observation and the migration suite passes without weakening framework semantics.

### Resolved on main: backend-independent local database export

Bozoma's support recovery previously read sqlite-wasm's shared SAH pool bytes. Per-database pools correctly broke that private coupling. `exportLocalDatabase(dbName, options)` now sits beside `listLocalDatabases()` and `deleteLocalDatabase()` and:

- acquire the database's exclusive lock and refuse while open;
- export the authoritative backend, whether OPFS or IndexedDB;
- produce a valid SQLite file or a documented Kora backup;
- never delete, migrate, or mark the copy verified;
- emit typed `STORAGE_IN_USE`, `NOT_FOUND`, and export failure errors;
- test old shared-pool migration, current OPFS, IndexedDB, quota pressure, and another open tab.

This is broadly useful for support, legal export, disaster recovery, and diagnostics across products, so it is framework-level.

Real-Chrome verification covers live adapter export, closed OPFS, closed IndexedDB, an open database, and a missing database.

### 1. Finish the release matrix on the published tarballs

Source tests are necessary but do not prove package exports, worker assets, CLI templates, or peer dependency resolution. The beta.15 candidate gate must install exact packed artifacts into clean fixtures and run:

The release validator now packs all 16 publishable packages, rejects unresolved workspace ranges or missing declared files, installs the candidate CLI with candidate-package overrides, exercises its executable and ESM/CommonJS public entries, scaffolds a clean React app, installs that app from the same tarballs, and requires a production app shell plus service worker. The canary workflow now waits until every exact package version is publicly readable from npm before it can report success, closing the propagation window observed during this dogfood round. A fresh PostgreSQL cluster also passes all 163 server test files and 1,618 tests. This closes the package/CLI baseline and source-level SQLite/PostgreSQL parity; the remaining packed/deployed matrix is:

- browser React app with auth-bound namespacing, offline write, refresh, reconnect, blob and access rules;
- Tauri template compile and smoke startup;
- packed Node server startup and smoke contracts with SQLite and Postgres;
- `kora doctor` against production SQLite and Postgres, plus worker loading from a non-root base path;
- upgrade from beta.12 and the latest prior canary without deleting local data.

### 2. Keep security fail-closed

The POS findings do not justify embedding retail roles or PIN workflows in core. They do justify a documented security boundary:

- sync servers must require authenticated sessions before any multi-device production deployment;
- tenant/access rules must be present for shared data;
- local convenience unlock is not an account credential and must use a salted password KDF if persisted;
- CLI/doctor should warn when a production server has no authentication or a schema has no access rules.

The warnings are framework DX. `kora doctor --production` now verifies canary coherence and reports absent access rules and authentication; KoraDocs is clean, while the other products surface their expected application-owned gaps. Reworking KoraPOS identities, tenant boundaries, seed credentials, and factory reset is product work.

### Resolved on main: CLI module-format compatibility

Template, version, and optional-driver resolution now uses stable Node resolution anchors in both module formats. The side-effect `@korajs/cli/create` entry is ESM-only, matching the executable, while the main and Vite programmatic entries retain verified ESM and CommonJS exports. The build has no empty-`import.meta` warnings, and the packed-artifact gate executes the installed paths.

### Resolved for the next canary: Node 24 Web Locks detection

Node 24 exposes `navigator.locks`, but it is not a browser-tab coordination environment. Treating that surface as browser Web Locks caused shared-browser upgrade repair to take the wrong locking path. Kora now excludes Node's `Node.js/*` navigator while retaining Web Locks in browsers and workers. The regression test and all 15 beta.12 shared-browser repair cases pass. The Vite build-id fixture also canonicalizes macOS temporary-directory symlinks so it verifies behavior rather than `/tmp` versus `/private/tmp` spelling.

## Beta.15 quality gates

### Correctness and durability

- Full monorepo build, unit, production-path, fuzz/property, browser storage, SQLite server, and Postgres suites pass.
- Pending count is derived from durable state and survives refresh, compaction, reconnect, and process loss.
- Every terminal rejection is durable, queryable, and actionable through a stable code.
- Multi-tab and per-user databases never silently fall back to a divergent writable copy.
- Migration never deletes an old copy before the new copy is durably opened and verified.

### Security

- Access-rule isolation tests cover reads, writes, blobs, scopes, authorship stamping, revoked grants, and stale offline clients.
- Auth flows cover verification, reset, session revocation, rate limits, shared-browser user changes, and anonymous suspension.
- Server defaults fail closed; insecure development modes are explicit and visibly diagnosed.
- Dependency and secret scans run on packed release artifacts.

### Developer experience

- A new developer reaches a locally durable synced CRUD app in under ten minutes using only documented public APIs.
- Schema-derived insert, update and record types have compile fixtures across optional/default/json/richtext fields.
- Upgrade diagnostics explain nullable legacy/default values, schema-ahead/schema-behind, worker asset problems, and rejected operations.
- `doctor` verifies package version alignment, server version, worker/WASM delivery, isolation headers, authentication, access rules, storage durability and exact canary pins.
- Examples contain no `as any` around ordinary collection mutations; where escape hatches are necessary, the reason is documented.

### Efficiency

- Publish browser bundle contribution reports per package and enforce regression budgets on the minimal app.
- Benchmark cold open, 10k/100k records, 1k offline writes, reconnect, scoped initial sync, blob resume, and two-tab contention.
- Measure memory and transfer bytes, not only operation latency.
- Product bundles remain product work unless the minimal fixture proves framework-level weight or poor tree shaking.

## Sequenced work

### P0 — before beta.15

1. ~~Publish a canary containing local database export and migrate Bozoma recovery off private OPFS internals.~~ Completed in the current canary line; focused critical real-browser recovery passes 15/15.
2. Complete the packed-artifact cross-product matrix beyond the now-green CLI/scaffold baseline.
3. ~~Expand `doctor` with auth/access/package production checks.~~ The first production audit is shipped; worker delivery, runtime storage and deployed-server probes remain part of the release matrix rather than static inference.
4. Run and archive the complete beta.15 release matrix; publish no beta while a safety gate is red.

### P1 — immediately after beta.15

1. Create a security-first authenticated Tauri/POS recipe with tenant access rules and local unlock guidance.
2. Add a framework webhook/outbox recipe proven by KoraForms, without placing webhook business policy in core.
3. Add recovery UI primitives driven by stable notice/error codes, not storage internals.
4. Add codemods or diagnostics for legacy JSON serialization and nullable default normalization.
5. Establish minimal bundle and runtime performance budgets in CI.

### P2 — adoption and refinement

1. Generate one schema module consumable by browser and server so products do not duplicate schema definitions.
2. Add end-to-end examples for collaborative rich text, scoped learning content, forms/outbox, and authenticated desktop data.
3. Turn repeated product integration patterns into documented recipes first; promote them to optional packages only after a second independent implementation proves the abstraction.
4. Track time-to-first-offline-write, recovery success, diagnostic resolution time, and upgrade failure rate as DX product metrics.

## Product-owned follow-ups

### KoraDocs

- Keep the corrected v7 fixture's HLC observation so migration evidence remains causally valid.
- Split the large editor/application bundle and retain the current access isolation tests.

### KoraForms

- Replace the remaining browser/server schema duplication with one shared schema module.
- Keep JSON values structured inside Kora; serialize only at external HTTP boundaries.
- Retain server-owned role and scope enforcement; product webhook policy remains outside Kora core.

### Bozoma Learn

- Keep manifest-managed recovery on the supported export API; remove the read-only beta.12 fallback only after the supported upgrade window ends.
- Rewrite browser scenarios that expect silent OPFS-to-IndexedDB divergence; the current framework deliberately waits or migrates one authoritative copy.
- Keep the sqlite-wasm non-deleting fail-safe until upstream sqlite-wasm provides the same guarantee.
- Retain the production deployment validator so shared deployments cannot start with placeholder secrets, insecure auth, or missing public configuration.

### KoraPOS

- Replace plaintext PIN/password fields with a real account identity plus a separately derived local-unlock verifier.
- Require authenticated sync, tenant partitioning and schema access rules before multi-device deployment.
- Remove hard-coded administrator credentials and direct `localStorage` usage.
- Make factory reset an explicit, authenticated, scoped, recoverable operation with unsynced-data checks.
- Add real Kora sync/access integration tests; the current 87 tests are predominantly domain-unit tests.

## Release decision

The exact published canary demonstrates major progress in storage durability, migration safety, auth, typed schemas, server diagnostics and access control. All four products install and build against it; their automated suites pass, KoraPOS produces native bundles, KoraForms proves scoped shared authoring in real Chromium, and Bozoma proves the supported recovery path in real Chromium with OPFS. Package visibility is now a checked release invariant rather than an assumption. The next canary adds the Node 24 locking correction and will be installed back into every product before beta.15. Beta.15 should wait only for that dogfood pass, the remaining packed-artifact browser/Tauri/server/Postgres/upgrade matrix, and an archived green release record. KoraPOS identity/tenant remediation remains mandatory before its shared deployment, but domain-specific remediation must not block or bloat the framework release.
