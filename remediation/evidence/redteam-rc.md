# Final release-candidate red team (1.0.0-beta.13, 2026-10-04)

Independent adversarial review of `fix/phase4-rc` at 5b317e6 (Phases 1 to 4, as they ship
in 1.0.0-beta.13; the last published release is 1.0.0-beta.12). Scope: the ENC-1 key ring,
the late Phase 3 changes (transforms at fold time, value domain, canonical body), the
Phase 4 runtime (reactive queries, hooks, SSR, persistence), tooling (offline app shell,
static server, CLI scaffold), the W11 types, and the beta.12 compatibility fixes RT-88 to
RT-94.

Every finding has a repro under `tests/repro/` (or a tsc probe) that fails at 5b317e6. Each
is tracked in `remediation/tracker.json` as RT-95..RT-104 (status open, phase 4).

Method:
- Executable repros against the real `EncryptionKeyring` (WebCrypto, real wraps; the key
  service faked with the server's own rules: compare-and-set and append-only versions),
  `createApp` on better-sqlite3 (two apps on one file stand in for two tabs, with the real
  `BroadcastChannel` bus), `KoraSyncServer` over in-memory transports, the SQLite server
  store, `createStaticFileHandler` behind a real `http` server, and `tsc` probes.
- Own Postgres 16 (`initdb -E UTF8 --locale=C.UTF-8`, port 54440, data under /tmp).
- The real beta.12 build (`git archive v1.0.0-beta.12`, built in a private temp dir) for the
  compatibility scripts; real Chromium (`PW_CHROMIUM_PATH=/opt/pw-browsers/chromium`)
  through the existing harnesses.
- A scaffold with the built CLI (`create-kora-app --template react-sync --skip-install`).

## Findings

| ID | Sev | Finding | Location | Required fix | Repro |
|---|---|---|---|---|---|
| RT-95 | P1 (security) | The recovery public key in the key record is not authenticated. A device adopts any structurally valid record that keeps its versions, and `rotate()` wraps the NEW data key to `record.recovery.publicKey`. A malicious sync server adds or swaps in its own recovery key (push, fetch, or the `conflict` reply of the rotation's own compare-and-set) and unwraps every rotated key: in the repro it decrypts an operation sealed after the rotation. Contradicts "the server never sees a data key and cannot unwrap anything". | `sync/src/encryption/keyring.ts:349-365, 657-760`; `key-record.ts:131-159` | Bind the recovery public key to the passphrase holder (a KEK-keyed MAC or a KEK-wrapped commitment written by `enableRecovery`, verified on every adopt); never wrap to an unverified key; refuse a record whose recovery key changed without the proof. | `packages/sync/tests/repro/RT-95.test.ts` |
| RT-97 | P1 | A rotation racing a passphrase change on another device wraps the new data key under the STALE (old-passphrase) KEK into the record that carries the NEW salt. `rotate()` reads the KEK once, before its compare-and-set loop; the conflict adopt drops `this.kek` (salt changed) but the loop keeps the local copy. Every device with the current passphrase then fails `WRONG_PASSPHRASE` on that version (the passphrase-changing device locks on the push), and operations sealed under it are readable only on the rotating device. | `sync/src/encryption/keyring.ts:337, 373, 697-700` | Re-read the KEK inside the loop after every conflict adopt; before a put, check that the KEK's salt is `record.kdf.salt` and that it opens the current version. | `packages/sync/tests/repro/RT-97.test.ts` |
| RT-104 | P1 | After the server loses a key record (a restore from the server's own backup, which covers operations only, as the guide says), the FIRST device to reconnect decides the keys. A new device (fresh install, passphrase typed) creates a brand-new keyring; every device holding the old keys then stops syncing for good (`KEY_RECORD_ROLLBACK`, no API to resolve it) and the new device never decrypts the history. The guide promises the old record is re-uploaded "so nothing is lost while one device has synced". | `sync/src/encryption/keyring.ts:219-221, 606-654, 683-695`; `docs/guide/sync-encryption.md` (Server Requirements) | Never create a first record for an owner with encrypted history: the server remembers that a record existed (tombstone/fingerprint, or the owner's envelope ops) and refuses a create until a device re-uploads; the client stays locked `KEY_RECORD_MISSING`. Include `kora_encryption_keys` in the server backup. Document how to resolve a fork. | `packages/sync/tests/repro/RT-104.test.ts` |
| RT-101 | P1 (not a Phase 4 regression) | Value domain gap. An enum value added by a schema upgrade is valid on every replica, but existing tables keep the old `CHECK (col IN (...))`: an upgraded device's own insert throws (`CHECK constraint failed`), and the upgraded server refuses a fresh device's write terminally (`UNSTORABLE_VALUE`), so it is undone on its author. No migration step can change an enum's values. The same holds for the client's `NOT NULL` on a field made optional (by code). | `core/src/schema/sql-gen.ts:236-250, 294`; `server/src/store/materialization.ts:79-99`; `core/src/migrations/migration-sql.ts`; `postgres-server-store.ts:173-176`; `sqlite-server-store.ts:171-173` | Enforce enum membership and requiredness in the value domain only (no DDL constraints), or rebuild the constraints from the current schema on open (SQLite table rebuild, Postgres DROP/ADD CONSTRAINT) on client and server stores. Decide what a removed enum value means for existing rows and old ops. | `kora/tests/repro/RT-101.test.ts` |
| RT-96 | P2 (security) | A device accepts an OLDER revision of its key record: the rollback pin compares key versions only, never `revision`. After a passphrase change (typically because the old one leaked) a server that kept the old revision serves it again; the device drops its KEK, only the old passphrase unlocks, and the next rotation wraps the new key under it. The same rollback strips (or restores) a recovery key. | `sync/src/encryption/keyring.ts:247, 683-701`; `key-record.ts` (`isKeyRecordSuccessor`, server only) | Pin the highest accepted revision in the key cache and refuse lower ones (`KEY_RECORD_ROLLBACK`); authenticate the whole record (kdf, recovery, revision) under the KEK. A new device cannot detect a rollback it never saw (document). | `packages/sync/tests/repro/RT-96.test.ts` |
| RT-98 | P2 | Row changes the syncing tab makes WITHOUT a new operation never reach other tabs' live queries: terminal-rejection re-folds, scope retraction and narrowing, provisional-cascade settling, authority re-folds. The local operation bus carries only `operation:created` and `operation:applied`. In the repro the server refuses tab A's insert; both tabs' `findById` return null, tab B's live query keeps the refused todo. With scopes, records the user lost access to stay on screen in other tabs. | `kora/src/local-operation-bus.ts:52-53`; `store/src/store/store.ts:1299, 1359, 1424, 1457, 1507, 2991, 3016` | Broadcast a collection invalidation whenever the Store invalidates without an operation; receivers call `subscriptionManager.invalidate`. | `kora/tests/repro/RT-98.test.ts` |
| RT-99 | P2 | The production static server derives `ETag`, `Last-Modified` and its compressed-body cache from size and mtime only. `index.html` and `sw.js` keep their size across deploys (fixed-length hashes and `VERSION`), and reproducible or container builds normalise mtimes (SOURCE_DATE_EPOCH, Nix, Bazel). A redeploy is then answered `304`: the browser keeps the old shell pointing at deleted chunks, and the service worker update is never seen. A server left running while files are replaced serves the old compressed body. | `server/src/server/static-files.ts:245, 278, 311-327` | Content-derived validators for revalidated files (digest cached by path, size, mtime, inode, ctime) used for the ETag and the compressed-cache key; no 304 on `If-Modified-Since` alone for them. | `packages/server/tests/repro/RT-99.test.ts` |
| RT-102 | P2 | The query-store cache key and `useQuery`'s re-subscribe key are `JSON.stringify(descriptor)`, which drops `undefined` (and turns `NaN` into `null`). `where({ projectId: undefined })` (the usual "nothing selected yet" pattern) is a different query at runtime (`"projectId" = ?` bound to undefined) but shares one `QueryStore` with `where({})`: one of two mounted components renders the other's rows. The Vue and Svelte bindings use the same key. | `store/src/reactivity/query-store-cache.ts:62`; `react/src/hooks/use-query.ts:51`; `vue/src/composables/use-query.ts:49`; `svelte/src/stores/query-store.ts:62`; `store/src/query/sql-builder.ts:299-321` | Normalise the where clause once in `QueryBuilder.where` (decide what `undefined` means; refuse `NaN`) so the descriptor, the SQL and the key agree. | `kora/tests/repro/RT-102.test.ts` |
| RT-103 | P2 | Retiring an old schema transform (registering v2->v3 but no longer v1->v2) silently erases every v1 operation from the server's records at the next start: the transform list is in the fold plan fingerprint, so every record is re-folded; `operationSchemaView` returns null for an operation with no path, and `mergeOp` folds null as nothing. No error, log line or quarantine. Removing the whole list instead keeps the operations (they fold as written). The log is append-only, so "keep a transform registered as long as operations of its source version can exist" means forever, and nothing enforces it. | `core/src/fold/fold.ts:409-410`; `core/src/migration/operation-view.ts:55-60`; `server/src/store/record-fold.ts:130-139` | Refuse (at `setSchema` / open) a transform set with no path from a schema version present in the stored log; treat a null view of a stored operation as quarantine or keep-as-written, never as absent. | `packages/server/tests/repro/RT-103.test.ts` |
| RT-100 | P3 | After `include()`, `where()` and `orderBy()` accept the included relation property (`where({ project: null })`, `orderBy('project')`), which the runtime refuses (`Unknown field`). Auto fields in `insert`/`update` and `id` in `update` are correctly refused (kept as guards). | `kora/src/typed-api.ts:177-183`; `store/src/query/sql-builder.ts:419-434` | Keep the filterable/sortable type separate from the row type after `include()`. | `kora/tests/repro/types/RT-100.ts` (added to `TSC_PROBES`) |

## What held up

- **ENC-1, the parts that are bound.** Wraps carry AAD `["kora-key-wrap", 1, purpose, keyring, version, keyId]`, so the server cannot relabel a version or move a wrap between keyrings. A server cannot lower PBKDF2 below the app's floor (`KEY_RECORD_INVALID`). The server refuses records that drop or relabel a version, and devices refuse records missing a version they hold. The owner of a key record comes from the authenticated session only (`u:<userId>`; anonymous principals of a mixed provider get `KEY_SERVICE_FORBIDDEN`); key messages never name a user, and owner/keyring are separate columns (memory key uses `\0`), so no cross-user read or write was found. Data keys are kept non-extractable (exported only transiently to re-wrap); the KEK is usable only for wrap/unwrap. Envelope members use a fresh 96-bit IV each, AAD binds node, record, type, HLC, sequence, member, key version and hash version; the id is verified after decryption. Concurrent first devices converge on one record through compare-and-set; a principal switch drops the previous user's keys before loading. Key messages survive the explicit protobuf serializer (extension field 49).
- **Transforms at fold time, on the honest path.** The view is computed by one function on every replica, identity fields are checked, the body is canonical, and the server's duplicate check compares the as-uploaded operation (RT-84 holds).
- **beta.12 compatibility fixes.** RT-90: a Date-form (ISO string as `{}`) version-1 match is stored as not declarable, so peers never re-verify it, and it applies only to the session's own node; forging requires the same node, HLC and sequence, i.e. the author itself, and any second body under the same id is refused `FORGED_DUPLICATE`. The legacy `previousData` clear is applied only where the id proves it (`canonicalizeProvenLegacyClear`), so a protocol-2 client cannot smuggle a clear past a validator by omitting a key from `data`. RT-91: re-issuing a legacy anonymous node gives the claimant a NEW device key (`kora:anon-node:<hash(new token)>`); blob ownership and partitions follow that key, so the claimant gets no earlier device's blobs; anonymous sessions share one grant anyway.
- **Reactive queries.** Subscriptions are pruned by collection only (no field-level "provably unaffected" pruning exists), so no write within the tab can be missed by pruning; included collections invalidate too. The structural diff compares bytes, arrays, Dates and plain objects; it can only over-notify (`-0` vs `0`). Runs are numbered, so a slow older run never overwrites a newer result; a failure reaches `onError` / `query:error` and the next success is always delivered.
- **Hooks.** `useMutation` uses latest-ref callbacks (no stale closures) with a stable identity; `useQuery` reads through `useSyncExternalStore` with stable `subscribe`/`getSnapshot`.
- **SSR.** `createApp` is inert only without `window`; web and shared workers are clients; `ssr: false` and `better-sqlite3` opt out.
- **Static server.** No path escape (`%2e%2e`, `..%2F`, NUL, backslashes are refused by the resolve-and-prefix check); 404 for missing assets under `/assets/`, SPA fallback only for navigations; correct MIME types with `nosniff`; precompressed siblings used only when not older than the file.
- **Offline shell.** Precache dedupes the unhashed `sqlite3.wasm` copy; every template sets `__KORA_SQLITE_WASM_URL` to the hashed file, so offline opens find it. Sync, auth, `/__kora` and `/health` are bypassed; only content-hashed responses are cached at runtime. An older build opening a database a newer build migrated with a rename fails at `ready` (probe, not kept).
- **Types.** Auto fields are not insertable or updatable and `id` is not updatable (RT-100 guards).
- **CLI scaffold.** `create-kora-app --template react-sync --skip-install` writes a project whose `vite.config.ts` uses `koraServiceWorker()` from `@korajs/cli/vite`; dependencies pin the CLI's own version (the release bump comes from changesets in pre mode).

## Not filed (P3 or below, or unconfirmed)

- A malicious server can serve `kdf.iterations` up to 2^53-1 (only a floor is checked): an unlock never finishes. Cap it.
- Recovery wraps use the raw ECDH shared secret as the AES key (WebCrypto `deriveKey` with no KDF); prefer HKDF with the ephemeral and recipient public keys as info.
- Cleartext scope fields are still not authenticated against the sealed values (known since Phase 3).
- With `allowLegacyAnonymousClaims`, anyone who has seen a beta.12 anonymous device's node id (it is in every delivered op) can claim it first after the server upgrade; the beta.12 device, which cannot keep a token or rotate, is then refused for good until an admin releases the node.
- The immutable-cache heuristic treats `og-image-1200x630.png`-style public files as content-hashed (a year of `immutable`), and the service worker serves any same-origin GET whose last path segment looks hashed cache-first, including app API routes such as `/api/export-20241004.csv`.
- The static server ignores `Range` (Safari needs ranges to play video); the precache includes every file in `dist/` (large public media is downloaded on the first visit).
- `where({ field: { $ne: v } })` excludes rows where the field is NULL (SQL semantics); document it.
- Suspected, needs a browser repro: navigations are network-first while a new worker waits for consent, so after a deploy an online reload runs the new build while the old worker stays in control; an offline refresh of that still-open tab is then served the old cached shell. After a `renameField` migration the old build fails to open the migrated database.

## Not present in this tree

- Shared encryption scope rings (`authorizeScope`) and an HTTP `/kora/keys` route do not exist: key records are per authenticated user (or one shared anonymous owner) over the sync connection only. A keyring name is per user, so the guide's "use a separate keyring per encryption scope" does not give two users a shared key.

## Not attacked

- The two-device passphrase-change races on real Postgres instances (the compare-and-set itself was read: single-statement on Postgres and SQLite).
- HTTP long-poll specifics, DevTools, `kora deploy` beyond the existing DX-8 repro, and a full scaffold install and build (needs the unpublished beta.13 packages).
- Vue and Svelte bindings beyond reading their keying code.

## Gates (this round)

Run on a 2-core machine, Postgres 16 on port 54440, real Chromium, the real beta.12 build.

| Check | Result |
|---|---|
| `check.mjs --all` (Postgres, Chromium, `LMS_OPS=20000`), before RT-99..RT-104 existed | 203/211 fixed, 0 errors, 1 warning (DX-3 "looks fixed", as before). No regression, no guard failure; RT-95..RT-98 fail as owned. |
| `check.mjs --all`, final (every new repro and the RT-100 tsc probe mapped) | 203/214 fixed, 0 errors, 1 warning (DX-3). RT-95..RT-104 fail as owned (RT-100: 2 tsc errors); no regression, no guard failure, no unmapped failure. Browser suites: LMS-5-6-7 and NEW-DX-3 as before. |
| Fold gate, 400 new seeds (`KORA_FOLD_E2E_SEED_BASE=2210001`) plus fold-vs-legacy 40 seeds | pass (6/6) |
| `pnpm chaos:nightly` | pass (chaos 1/1, invariants 11/11) |
| `pnpm test:release-gate` | pass (production path, sync reconnect, real-path chaos, benchmark gates) |
| `compat-beta12.mjs` (12 seeds per server build, memory/SQLite/Postgres) | First run 22/24: `chaos/current-server/seed-4` and `seed-7` threw `WebSocket connection timed out` from an un-caught `connect()` in the harness; both passed on rerun. A rerun of seed 4 then failed `chaos/b12-server/seed-4` twice: once the same connect timeout, once a convergence timeout with all three current replicas in phase `blocked`, no rejection, apply failure or sync error event, and one unhandled `Cannot send message: WebSocket is not connected` (the beta.12 build's known crash path). Every other row passed, including every upgrade, shape and encryption row. Not filed: nondeterministic, current clients through a beta.12 server is the configuration the release notes say not to run, and 10 s localhost connect timeouts point at event-loop starvation on this machine. Worth one investigation on CI hardware (what leaves a current client in state `error` without retrying). |
| `compat-beta12-browser.mjs` | 2/2 (SQLite WASM/OPFS, IndexedDB) |
| `rt-legacy-id-probe`, `rt3-legacy-probe`, `rt3-upgrade-clear-probe`, `protocol-v2-compat` (beta.12) | all accepted and converged, nothing rejected or quarantined |

## Final verification (post-RC fixes, 2026-10-04)

Independent adversarial round over the fixes after the RC red team (`85b307f..9c0a2e1`:
key record format 2, recovery anchor `kora-rk2-`, ring merge, `startNewKeyring`, key
records in server backups, records-changed funnel, content-derived static validators,
include typing, value-domain evolution, one query key, transform retirement refusal,
`kora migrate --kora:evolve-table`, server default for added fields), plus a release
smoke. Branch `wip/phase4/verify-final` (on `private`). No production code was changed.

Method: executable repros against the real `EncryptionKeyring` (WebCrypto) with a
scriptable key service, `PostgresServerStore` on an own Postgres 16 (port 54440,
`initdb -E UTF8 --locale=C.UTF-8`, data under /tmp), the generated service worker run in
a fake `ServiceWorkerGlobalScope`, and real Chromium against an app scaffolded with the
built CLI and installed from the packed tarballs.

### Findings

| ID | Sev | Finding | Location | Required fix | Repro |
|---|---|---|---|---|---|
| RT-107 | P2 (security) | "Change the passphrase, then rotate" does not contain a leaked passphrase against the sync server. (1) Every device other than the one that changed the passphrase still holds the OLD master key, and the server decides what it forwards: it seals a successor revision under the old master (opened with the leaked passphrase from the old record it kept) that adds its own data key, the device authenticates it with the held master and encrypts every new operation under the attacker's key. (2) The recovery anchor fingerprints the ring's FIRST data key, which the old passphrase opens: a ring under an attacker master wrapped to the (public) recovery key and re-wrapping that key passes `holdsAnchor`, and the recovered device encrypts under the attacker's key. Needs the old passphrase plus the server; contradicts the guide's leak advice. | `sync/src/encryption/keyring.ts:898-970` (adopt via held master), `691-707`, `1226-1241`; `keyring-crypto.ts:364`; `docs/guide/sync-encryption.md:224` | (1) is inherent to a shared-secret ring: correct the guide and the `changePassphrase` JSDoc (after a leak, lock and re-unlock every device with the new passphrase, or start a new keyring); optionally stop adopting key-adding records under a held master once a newer unauthenticatable revision was seen. (2) Anchor recovery to a secret only the recovery-key holder has (an HMAC commitment keyed by a secret in the recovery key), not to a data key. | `packages/sync/tests/repro/RT-107.test.ts` (2 tests) |
| RT-108 | P2 | Value-domain relaxation on Postgres misses a beta.12 single-value enum CHECK: Postgres stores `IN ('x')` as `CHECK ((col = 'x'::text))`, which `isPostgresEnumCheckDefinition` (only `= ANY (ARRAY[...])`) does not match. After adding a value to a one-value enum ("start with `active`, add `archived` later"), the upgraded Postgres server still refuses the new value (RT-101 persists for this shape; the CLI's relax directive uses the same planner). | `core/src/schema/constraint-relaxation.ts:166-170, 263-277`; `server/src/store/postgres-server-store.ts:514-530` | Recognise the single-column equality form too, ideally by matching the schema's enum columns rather than the definition's shape; add the case to `value-domain-evolution.test.ts` and the directive tests. | `packages/server/tests/repro/RT-108.test.ts` (needs `KORA_PG_TEST_URL`) |
| RT-109 | P2 | Offline shell after a deploy: the old worker stays active and the new one waits for consent, but navigations are network-first, so an online reload already runs the NEW build (while the prompt says an update is available), and a later OFFLINE reload of the same tab runs the OLD build from the old cache against the database the new build opened and migrated. The store opens a newer-schema database silently (`stored >= target` returns). Verified in Chromium on a scaffolded app: v1 -> deploy v2 (schema version 2) -> online reload shows v2 with `{active, waiting}` -> offline reload shows v1, which writes schema-1 operations into the schema-2 database; with a `renameField` migration the old build fails at `ready` (RC probe), so the app does not open offline until online again. Confirms the RC "suspected" item. | `cli/src/vite/service-worker.ts:298-309`; `store/src/migrations/run-migrations.ts:45-50` | One build per active worker (serve the network document only when it is this worker's version, else the precached shell; or activate the new worker once a page of its build runs); refuse, with an event, a database whose stored schema version is newer than the code's. | `packages/cli/tests/repro/RT-109.test.ts`; browser script `packages/cli/tests/repro/RT-109-browser.mjs` (manual) |

Nothing at P0 or P1 was found.

### Release smoke

- `pnpm pack` of every publishable package (kora + 14 under `packages/`): every tarball
  holds its `dist` (ESM, CJS, maps) and type declarations (`.d.ts` and `.d.cts`) for every
  declared entry point; `@korajs/auth` and `@korajs/svelte` also ship `src` without tests;
  `@korajs/cli` ships `templates/`. Nothing secret or internal: no `tests/repro`, no
  `remediation`, no `.env` (templates carry only `.env.example` with empty secrets), no
  keys or tokens (scanned for private-key, AWS, GitHub and npm token patterns). One stray
  test file: `@korajs/tauri` ships `plugin/tests/integration.rs` (harmless). Versions are
  still `1.0.0-beta.12` (create-kora-app `0.1.25-beta.11`, tauri `0.4.3-beta.11`): the
  release bump is still to run.
- Scaffold: `create-kora-app myapp --yes --pm pnpm --skip-install` (built CLI; template
  react-tailwind-sync) writes `pnpm-workspace.yaml` with `onlyBuiltDependencies` and
  `allowBuilds`. Installed with pnpm 12.8.1 from the packed tarballs (overrides in
  `pnpm-workspace.yaml`), `pnpm build` (tsc + vite) passes and emits `sw.js`. Served by
  the template's own `server.ts` (production server): in Chromium the page is controlled
  by the worker on first load, a todo written online and one written offline both survive
  offline reloads (shell and data come up with the network off). Cross-device sync was not
  exercised: the template's sync waits for a signed-in user (`KORA_AUTH_SECRET` unset, so
  `/auth` is 404 and writes stay held, as documented). The template has no test script,
  so there were no app tests to run. Note: with `--yes` and no `--pm`, a direct `node`
  run picks npm and writes no `pnpm-workspace.yaml`; a later `pnpm install` on pnpm 11+
  then fails `ERR_PNPM_IGNORED_BUILDS` (the `pnpm` field of `package.json` is no longer
  read). `pnpm create kora-app` detects pnpm and is fine.

### What held up

- **Key record format 2.** The MAC (HMAC under a master-derived key) covers every field, so
  a server cannot add or swap a recovery key, relabel or drop a version, or change KDF
  parameters (iterations are also floored and capped at 10,000,000) without the passphrase
  or a held master. A forged successor under an unknown master is refused (or, for a
  device holding every key, ignored with `PASSPHRASE_REQUIRED`). Rollback: a lower revision
  of the pinned ring is refused and the pin re-uploaded; recovery also refuses a rolled-back
  record. `changePassphrase` creates a new master, so the old passphrase opens no later
  record on a device that learned of the change.
- **Ring merge and `startNewKeyring`.** A foreign ring is merged only after it authenticates
  (held master or passphrase); held keys are re-wrapped into the server's ring under the
  same key ids, never dropped (`commitLocked` invariant). `startNewKeyring` refuses when the
  server holds a record (`KEY_RECORD_EXISTS`) and only lets this device create a ring the
  server cannot read; a server that lies "missing" can fork or deny service, not read.
- **Cross-user isolation.** The key owner comes only from the session (`u:<userId>`, `*`
  without auth, none for anonymous principals of a mixed provider); messages cannot name a
  user; pushes go only to sessions of the same owner; compare-and-set is one statement on
  SQLite and Postgres. Backup restore inserts key records only where none exists
  (`ON CONFLICT DO NOTHING` / `INSERT OR IGNORE`) and refuses a malformed section whole.
  The `knownKeyIds` report is filtered to the owner's nodes.
- **Static validators.** ETags are SHA-256 of content, cached by dev/inode/size/mtime/ctime;
  revalidated files never send `Last-Modified` and ignore `If-Modified-Since`;
  precompressed siblings are used only when they decompress to the current digest;
  compressed bodies are keyed by digest; a file replaced between hash and compress is not
  cached under the old digest. Live server: `index.html` and `sw.js` are `no-cache` with
  content ETags.
- **Value-domain evolution (SQLite, multi-value Postgres).** The client and server SQLite
  rebuild keeps columns, defaults, primary and foreign keys, `UNIQUE`, indexes and
  triggers in one transaction with foreign keys off; Postgres drops only one-column enum
  checks and `NOT NULL` on schema fields, keeping hand-written checks. `kora migrate`
  checks `PRAGMA foreign_key_check` before committing, runs Postgres on one connection,
  refuses to drop Kora columns and refuses legacy SQLite-only rebuilds on Postgres.
- **Transform retirement.** Coverage is checked against `SELECT DISTINCT schema_version` of
  the whole log (no sampling) on every store; the session refuses an upload with no view
  (`SCHEMA_TRANSFORM_UNAVAILABLE`) instead of folding it as absent.
- **Scaffold.** Offline first out of the box (see above).

### Not attacked

- Records-changed funnel (RT-98), include typing (RT-100) and the one query key (RT-102)
  beyond reading their diffs and the checker's runs; Vue and Svelte bindings.
- `kora migrate --kora:evolve-table` kind changes (`ALTER COLUMN TYPE`) on real data: the
  server re-folds every record when the fold fingerprint changes, so the column projection
  is transient; an interrupted Postgres migration (DDL is transactional, not exercised).
- Server default for added fields against scope filters on a live multi-device run (read
  only: `materializedFieldValue` on all three stores).
- Static server under concurrent in-place file rewrites (a hash-then-stream race at deploy
  time; content-length from the earlier stat).
- Real-device Android, Safari; DevTools; `kora deploy`.

### Gates (this round)

GATES_PLACEHOLDER
