# Beta.15 Consolidated Plan

Status date: 2026-10-28
Canary under test: `0.0.0-canary-20261027061527` (built from `main` at `357c11ca`; all 16 packages carry the same tag)
Framework source: `main` at `357c11ca`

This is the release plan derived from the current framework code, four real products and the original beta.15 plan (`kora-beta15-plan`, 2026-10-08), not from documentation claims. The north star is unchanged: Kora should make a secure, production-grade offline-first application as straightforward to create and operate as Next.js makes a web application.

## Release definition

Beta.15 is one release that ships everything in the scope ledger (section "Scope ledger") together, so the whole system is tested as one and shows where Kora stands. This replaces the narrowed scope of the 2026-10-27 revision of this document, which waited only for the dogfood pass and the packed-artifact matrix. That revision dropped workstreams the release was defined by. Nothing is dropped here: every item planned originally, every item found since, and every outstanding item is listed with its status.

Rules that hold for this release:

- Scope is closed to the ledger below. Anything new goes to beta.16, unless it is a security or data-loss fix (those ship in beta.15; there is no beta.14 patch, decided 2026-10-20).
- Beta.15 ships only when every exit criterion (section "Exit criteria") is met. No beta is published while a safety gate is red.
- Every merged step publishes a canary. koraforms and koradocs dogfood canaries; the LMS moves on its own track (section "LMS track").

## Goals for the next build phase

Three workstreams are committed goals and are the critical path. They were the largest unbuilt part of the original plan.

| Goal | What it delivers | Status on main | Design |
|---|---|---|---|
| **A. Offline readiness** | `app.offline.status()`, `useOfflineReady()`, `keep()`, storage-loss detection, durable fallback writes, offline-restorable auth, service-worker status, "Available offline" badge, the promise "works offline after first open, never loses your work" | Design only (revision 5). No `app.offline`, no completion marks, no service-worker status protocol, no durable-write wait on the IndexedDB fallback, no `synchronous = FULL` | `docs/design/offline-readiness.md` |
| **C2. Visibility index** | A `(partition_key, delivery_seq)` index so handshake, resume and live delivery cost O(visible operations), not O(log) | Not built. Only the global `idx_delivery_seq` exists | `docs/design/fast-first-sync.md`, section 2 |
| **C1. Cold start from current state** | Record snapshots (fold state per visible record) with a watermark jump, so a new device renders from the first page and applies per record instead of per operation | Not built. Designed, with a red-team table of 15 cases | `docs/design/fast-first-sync.md`, section 3 |

Decision (Obed, 2026-10-28): A, C1 and C2 are in beta.15. C1 is no longer conditional on the browser measurement (this supersedes the 2026-10-19 decision that built C1 only if the measurement showed it was needed). The measurement stays, with a different job: it sizes the win, validates the targets, and finds the per-operation costs C1 does not remove (section C1).

Targets these three goals must meet, measured in the beta.15 release record:

| Metric | Today | Target |
|---|---|---|
| First usable data on a new device (LMS fixture, 20,000 operations, 30 scoped collections, Slow 4G) | 3.29 s (node, pre-#71) | under 2 s |
| Full scope on the same fixture | 14.15 s (node, pre-#71) | under 10 s |
| Same, in Chromium with OPFS | not measured | the two targets above |
| Offline reload of a `ready` app on every template | no such check exists | passes the Playwright suite |
| A write whose promise resolved, on every backend | at risk on the IndexedDB fallback (up to 500 ms window) | never lost, except whole-site wipe |

### Work order and dependencies

```
Track 1 (client, store, CLI):  A0 -> A1 -> A2 -> A3 -> A4 -> A5 -> A6 -> A7
Track 2 (server, sync):        C2 -> browser measurement -> C1
Shared:                        batch-level verification (before the measurement)
                               D8 @korajs/test/playwright (A7 uses it)
Integration:                   C1 must set completion marks and honor unit markers (below)
```

Tracks 1 and 2 run in parallel; they meet in `sync-engine.ts` (`handleOperationBatch`, `commitDeliveryProgress`), so each PR rebases on the other's merges and runs the other's tests.

**A and C1 integration requirement (found while planning, not yet in either design).** Offline readiness marks completion when a delivery batch with `isFinal` is fully applied. A C1 snapshot run ends with a final snapshot ack that commits the watermark jump to B, and the stream from B then delivers ordinary batches. Without a rule, a device that finished a snapshot has no completion mark and reads `incomplete` forever, or worse, a snapshot restart leaves a stale mark. Before C1 is built, `offline-readiness.md` section 4.1 is revised: the snapshot's final ack sets the mark in the same transaction as the watermark jump; a snapshot run opens a unit marker (`base 0`, `upTo B`) and clears it with the final; a `snapshotRestart` clears every mark of the view like a watermark reset. The C1 design gets the matching sentence.

## A. Offline readiness

Build order follows the design (section 10): the fixes that make today's promise true come first and are independent of the API.

| Step | Work | Acceptance |
|---|---|---|
| **A0** | Durable fallback writes. The local write path awaits `adapter.ensureDurable()` after commit and before the promise resolves (only `IndexedDbAdapter` implements it). Group commit, strict IndexedDB durability for barrier snapshots, follower barrier routed to the leader, `WriteNotDurableError` (`WRITE_NOT_DURABLE`), `storage.writes: 'failing'`, `store:write-durability`. `synchronous = FULL` explicitly in the `better-sqlite3` adapter and the Tauri plugin. Merged already: #52 (snapshot ordering, compare-and-put, `SNAPSHOT_SUPERSEDED`) | Fallback write p95 under 250 ms at 10k records (benchmark in `packages/store/src/benchmarks`); crash-after-resolve test keeps the row; control run with the barrier disabled loses it |
| **A1** | Storage-loss detection. Manifest `epoch`, `unsynced`, `unsyncedAt`; `localStorage['kora:db:<name>']` marker carrying the backend; `store:storage-evicted`; `storage.evicted`; `app.offline.acknowledgeEviction()`; the no-false-positive table (design 6.2) | Every row of 6.2 tested; delete OPFS and IndexedDB copies, keep the manifest: event with correct `lostWrites.count`; clear all site data: no event |
| **A2** | Completion marks (`offline_complete:<signature>`), per-unit open markers (`offline_unit_open:<signature>:<unitId>`), clear-before-apply on narrowing, retractions and every watermark reset (`forceFullResync` included), `data.state`, `kora-offline-meta-changed` on the local-operation bus, `app.offline.status()` and `subscribe()`, `useOfflineReady()` (React, Vue, Svelte), `offline` added to reserved app properties | Unit tests of design section 9 (marks, unit marker, concurrent units, tabs, no-`BroadcastChannel`); a crashed or stalled unit is never `complete` after reload |
| **A3** | Auth restorable offline. `AuthSyncBinding.resolveOfflineRestore`, `AuthTokenStorage.durability`, `createKoraAuthSync` implementation, `offline.auth` override, clock-rollback watchdog, `ready` flips at `offlineUntil` | Every row of the 8.2 tables; `unknown` is never `ready` |
| **A4** | Shell. `KORA_SW_STATUS` message, digest-verified heal, same-build check, `__KORA_SHELL__` contract (`v: 1`), `bundled` state for Tauri, `<OfflineBadge />` in all 13 templates (on by default, hidden in `vite dev`) | Worker tests (hashed heal, newer-build bytes never stored); badge in every template |
| **A5** | `keep(query, { files })`, `useOfflineKeep`, pins table and per-component holds, 64-pin limit, one pin per collection, blob presence and integrity, quota failure, single fetcher lock, `ContentAddressedBlobStore.durable`, background persistence request | Pin and holder tests (StrictMode, two tabs, killed tab pruned through the shared-lock watcher, bfcache); file and quota tests |
| **A6** | Wording and docs. `docs/guide/offline-readiness.md` (guarantees, app responsibilities), "What offline-first means in Kora", templates and korajs.dev say "works offline after first open, never loses your work"; upgrade notes for the `WriteNotDurableError` behavior change, `offline.auth`, and updating `korajs`, `@korajs/auth` and `@korajs/cli` together | Docs build green; docs check passes |
| **A7** | Playwright suite on every web template through one helper `assertReadyMeansOffline(page)`, with the negative tests of design section 9 (service worker blocked, handshake final held, blob chunks aborted, precache entry deleted, second build deployed, refresh token cleared, grace elapsed) plus fallback crash tests (`Page.crash` after a resolved write, follower tab, leader killed mid-barrier) and eviction tests | All green on packed artifacts; every negative test proves `ready` is never observed |

Also in A's scope, from the design and the recommendations on record:

- **M2, commit outcome unknown.** When `adapter.transaction()` rejects although its commit landed, the per-operation fallback re-applies the batch as duplicates and `operation:applied` and merge traces are never emitted (a DevTools gap, widened by C3 batching). Fixed by a content-addressed id lookup after a rejected commit (recommended 2026-10-20, in the plan unless Obed objects).
- **Instant UI updates** (tab-local overlay of pending writes; recommended 2026-10-20, in the plan unless Obed objects). This addresses the single-insert, reactive and fan-out gates that still miss the one-frame target in the browser because each write waits for a durable OPFS commit (34 ms on the measured host).
- Open design questions the build answers with code and tests (design section 14): unit `upTo` for streams whose frontier moves, watcher fan-out cap, badge copy for a tab waiting for the exclusive lock, and the IndexedDB fallback latency target (if missed, incremental IndexedDB snapshots move into beta.15 rather than weakening the promise).

Decisions on record (Obed, 2026-10-19 and 2026-10-20): `ready` does not require persistent storage; the strong promise stays; quarantined operations are reported only; auth is in beta.15; `keep` has one pin per collection and at most 64 pins; the whole-site wipe signal is beta.16; the badge is on by default; a Tauri file blob store follows beta.15; a newer build retires older tabs with a reload prompt.

## C2. Visibility index

The index only narrows what is read. `filterDeliveryChunk` stays the single authority on what a session receives. The index must return a superset of what the filter acts on below a known frontier: a false positive costs one judgment, a false negative is a lost operation.

| Step | Work | Acceptance |
|---|---|---|
| **C2.1** | Partition derivation. `P(c)` from schema scope, sync-scope bindings and every field an access read rule names (recursively through `or` and `and`); memberships `userId` and group field; group `id` and owner field; `deliveryPartitions` option on `KoraSyncServer` for provider scopes the schema cannot show. Fingerprint stored in `kora_server_meta` | Property test that `P(c)` covers every field the filter reads |
| **C2.2** | Tables and indexes: `kora_delivery_partitions (partition_key, delivery_seq)` on Postgres, SQLite (`WITHOUT ROWID`) and the memory store; `idx_collection_delivery` and `idx_node_delivery`. Postgres `CREATE INDEX CONCURRENTLY` after `ensureTables`, `INVALID` indexes treated as absent | Both stores and the memory store create and repair the index |
| **C2.3** | Writing. Index rows in the same transaction as the operation and its scope snapshot (`applyRemoteOperation`, conditional apply, route apply, side effects); keys from pre and post snapshots; `c \0 ?` for snapshot-less operations and snapshot gaps; contiguous `delivery_partitions_through` counter; compaction, quarantine and replace-mode restore delete the rows they remove | A reader never sees an operation without its rows |
| **C2.4** | Reading. `getOperationsAfterDeliveryIn(sources, after, limit)` returning operations, `complete` and `coveredThrough`; Postgres LATERAL statement, SQLite per-source queries merged in JS; `MAX_DELIVERY_SOURCES` (256 proposed) with `$in` collapse and global-scan fallback | Equals the global scan on every case below |
| **C2.5** | Session integration. `DeliverySources` from the downlink scope, recomputed after `refreshAccessGrant` and each re-scope unit; `streamDelivery` and `collectVisibleNodeIds` read through the index to `coveredThrough`, then the global scan for the tail; membership keys for each case of `operationTouchesMemberships`; `delivery.partition_miss` logged once per collection and field | The membership-case test returns the same re-scope unit as the global scan, including a group transferred to a user who held nothing in it |
| **C2.6** | Migration and backfill. Fingerprint change resets `through`; background backfill in chunks of 5,000 (idempotent, resumable, final catch-up lock on Postgres); rolling-upgrade gap indexed on every delivery poll; backup restore rebuilds, exports skip | A restart mid-backfill resumes; an older instance appending without rows only slows sessions |
| **C2.7** | Tests and measurement. Superset invariant as a property test against the global scan over generated logs (cases 1 to 6 of the design); access-rules fixture variant (schools as groups, membership changes during sync); Postgres baseline nightly (`KORA_PG_TEST_URL`); first-sync benchmark re-run | Handshake and first home row near the 1-school bound (0.44 to 1.0 s handshake; 1.33 s first home row on Slow 4G, node) |

Expected effect: reads cost O(visible operations plus sources per chunk) for first sync, resume, the handshake pre-pass and live pushes. The global scan costs about 2.4 s before the first byte against a 100,000-operation log; C2 removes it.

Decisions needed (Obed), with recommendations:

1. **Partition fields.** Require `scope: [...]` in the schema or `deliveryPartitions` on the server for the fast path. Recommended: yes. A session with an undeclared field logs `delivery.partition_miss` and reads by collection, so nothing breaks.
2. **Handshake pre-pass.** Let a protocol-2 client opt out of `collectVisibleNodeIds` with a handshake flag. Recommended: yes. It removes a log read from every handshake.

## C1. Cold start from current state

For a view the device has never synced, the server sends each visible record's fold state instead of its history, then jumps the watermark to a baseline B. The client stores each state as the record's base and folds later operations on top. Synthetic operations were rejected (they beat older offline edits and fail id verification).

| Step | Work | Acceptance |
|---|---|---|
| **C1.0** | Preconditions, run first. (a) Batch-level content-id verification: verify a whole batch before its transaction (one digest pass, overlapped, still verifying every operation), because content-id verification is about a third of device apply time (114 µs per operation). (b) The Chromium and OPFS browser variant of the first-sync benchmark at Slow 4G, at an operations-per-record ratio of 1.8 and the real LMS ratio. (c) Re-review of the C1 design against `main` (C2, C3, version gate, access, #54), with Codex and an independent red team before code | Measurement recorded in `docs/design/fast-first-sync.md`; design review findings closed |
| **C1.1** | `@korajs/core`: `encodeFoldStateCompact` and `decodeFoldStateCompact` (one stamp table per record, no cached `val` for `reg`, full operation ids once per distinct stamp). The gating property test, with `fast-check`: `fold(snapshot at B with read lag L, then O after B with duplicates, plus unsent U, minus rejected R) == foldRecord(O ∪ U - R)`, compared after the compact round trip, covering every field kind, tombstones, revivals and server-authoritative fields | Round trip deep-equals for every field kind; the property test passes before any protocol work. Payload estimate re-run with the compact encoding (target about 0.6 KB of JSON per once-written record) |
| **C1.2** | Two-phase negotiation within protocol v2: handshake `recordSnapshot { foldStateVersion, schemaPlan }`; server offer with the full plan and authoritative node ids only for a view that never had a delivery run, with no end-to-end encrypted collection and no access rebuild; client `record-snapshot-accept` or `record-snapshot-decline`; answer timeout is a decline. A reset view (`forceFullResync`, restore) never negotiates C1 | Old clients and old servers run unchanged; plan mismatch falls back to operations |
| **C1.3** | Server snapshot builder. Read B first (on Postgres, after taking and releasing the counter lock), compile the grant after B, page with `recordsMatching` and an id cursor reading row and fold state in one statement, freshness check (`covered_seq`, `covered_op_id`, plan) with tail merge or re-fold before sending, primary only, tombstones included, access run state (`run.held`, `run.asOfSeq` null, `rulesChanged` false) | Property and integration tests for each read-order argument in the design |
| **C1.4** | `record-snapshot` message with `snapshotId`, `baseline`, `batchIndex`, `cursor`, `isFinal`; per-batch acks; final ack commits the watermark jump to B in the same transaction as the last records; snapshot records take delivery position B for the delivery-order visibility rule (#54); completion mark and unit marker per the integration requirement above | A crash between batches leaves no half-visible view that reads `complete` |
| **C1.5** | Client apply: one storage transaction per batch; `joinIntoBase` into `_kora_fold_base`; re-fold the record from base, snapshot and local log so unsent edits survive; `_kora_snapshot_records` tracking (with the pre-run base saved on first join); records visible as each batch commits | Unsent offline edits and terminal rejections converge exactly as the property test states |
| **C1.6** | Resume and restart: `snapshotResume { snapshotId, baseline, cursor }` continues with the same B; `snapshotRestart` removes every contribution of the run (snapshot bases, remote operations received above B by delivery position, never local edits) in one transaction and resets the view to 0. Quarantine: an unstorable record state is not acked; after `MAX_SNAPSHOT_ATTEMPTS` the view persists `recordSnapshot: disabled` and syncs from operations | A rules deploy mid-snapshot ends in a clean restart; no record from run 1 outside run 2's scope remains |
| **C1.7** | Field kinds and exclusions: Yjs `rt` sent as the server's update set (not collapsed), blob refs only (bytes pulled as today), scopes with an encrypted collection do not negotiate C1 | Rich text byte-identical to replay; blob access index unchanged |
| **C1.8** | End-to-end convergence test in `packages/test`: one device from operations under `retract`, one from a snapshot, with injected scope moves, deletes and revivals, membership grants and revokes, rules deploys, reconnects mid-snapshot, under the chaos transport. Under `retain` the snapshot device's records are a subset of the operation device's, and the difference is exactly the records that left scope before first connect | Identical rows and states; red-team cases 1 to 15 each have a test |
| **C1.9** | Browser benchmark with C1 on: first usable data under 2 s and full scope under 10 s on the LMS fixture in Chromium at Slow 4G; payload bytes and memory recorded | Both targets met, or the miss is reported with the remaining cost named |

Decisions needed (Obed), with recommendations:

3. **Fold-state disclosure.** A snapshot carries removal markers, resolver logs and Yjs structure written before a device joined. Late joiners already receive this through scope entries (RT-29); C1 widens it from "records entering a scope" to "every record". Recommended: accept for beta.15, document it, and design redaction for both paths in beta.16.
4. **`retain` policy.** A snapshot device cannot match `retain` (it never saw records that left scope). Recommended: document "a new device holds its current scope" as intended behavior, pinned by the C1.8 test.
5. **Real ratio.** Obtain the operations-per-record ratio and scope size from the LMS. It no longer decides inclusion but sets the expected win and the C1.9 fixture.

## Scope ledger

Every item from the original plan, the execution plan and the dogfood rounds. Status is checked against `main` at `357c11ca` unless stated.

### B. Access from data (original workstream B)

Done and in production in koraforms and koradocs: access engine steps 1 to 7, `@korajs/spaces` with email verification and password reset, capability grants for share links (#42), member-only rules (#43), `onOperationsCommitted` and the atomic-op security fix (#44), rolling re-fold (#41, #47), restore atomic clear (#40), `server.access.backfill` (#31). Security fixes found by dogfood and merged: out-of-view delete resurrection (#65), per-user device identity on shared browsers (#76), `previousData` gating on updates and uploaded deletes (#79).

Outstanding in B: the known limitations listed in `kora-beta15-status` (invitations pending at an index rebuild fail closed; one admin operation at a time across instances); koraforms v22 removes the legacy `form_collaborators` collection; `@korajs/spaces` npm `latest` dist-tag; DX metric "per-user isolation with sharing in under one day and under 100 lines of app code" measured on koraforms and koradocs.

### C. Fast at scale

| Item | Status |
|---|---|
| C1 cold start | Goal, section C1 |
| C2 visibility index | Goal, section C2 |
| C3 browser write throughput | Done (#55). 10,000 inserts in 1.8 s in Chromium against 2 s. `insertMany`, write-behind statement batches, 16 KiB pages for new OPFS databases |
| C3 batched device apply | Done (#71, #73, #75). One storage transaction per delivery batch (chunks of 500), constraint reports per operation. Native device apply ratio 0.80 against per-operation |
| Cheaper device-side verification | Outstanding, step C1.0(a) |
| Browser first-sync measurement (Chromium, OPFS) | Outstanding, step C1.0(b) |
| C4 trustworthy benchmarks | Partial. `benchmark-gates` and `chaos-nightly` fixed, insert gates relative on shared runners. Outstanding: publish results per release (a public bench page), bundle budgets, memory and transfer bytes |
| Reactive and single-write browser latency | Outstanding. Single insert, reactive notification (61 ms p95) and 1,000-subscription fan-out (96 ms p95) miss the one-frame target; addressed by instant UI updates (section A) |
| C2 revived-record stale fields | Outstanding (execution plan wave 2) |

### D. Production DX

| Item | Status |
|---|---|
| D1 `kora doctor --db` preflight | Done (#58). Outstanding: migration dry run with time estimate (learned from the koradocs upgrade) |
| D1 `kora doctor --production` audit | First audit shipped (auth, access rules, canary coherence). Outstanding: worker delivery, isolation headers, runtime storage and deployed-server probes |
| D2 `kora upgrade` | Not built. Bumps every Kora package together, runs codemods for renamed APIs, then runs `kora doctor`. Includes diagnostics or codemods for legacy JSON serialization and nullable default normalization |
| D3 HTML routes and per-URL shell meta | Done (#16) |
| D4 crawler fallback | Done (#16) |
| D5 deploy that cannot miss files | Partial. `kora deploy` and templates bundle the server with esbuild. Outstanding: a Dockerfile COPY list can no longer omit an import (verify on every deploy template) |
| D6 one schema on client and server | Not built. Templates import one schema module; `kora doctor` warns on a second `defineSchema` for the same collections. koraforms still duplicates its schema |
| D7 rejected writes in the hook | Done (#57) |
| D8 `@korajs/test/playwright` | Not built. Offline helpers from koraforms (first visit offline, kill tab mid-write, profile restart, clock skew, slow network). A7 depends on it |
| D9 release automation | Not done. `release.yml` still publishes with `NPM_TOKEN`; the canary workflow requests `id-token: write` but also still uses `NPM_TOKEN`. Move both to npm trusted publishing (OIDC). Needs Obed to configure it on npm |

### E. Cleanups promised for "a later release"

| Item | Status |
|---|---|
| Remove protocol 1, the `legacyMerge` engine; flip `allowLegacyAnonymousClaims` to false | Gated on two weeks of zero protocol-1 sessions in koraforms, koradocs and the LMS. Clock for koraforms and koradocs started 2026-10-21 (earliest 2026-11-04). The LMS clock cannot start until the LMS runs protocol 2 and every learner device has updated. Proof is the logged `session.protocol_deprecated` event over 14 days (the in-memory counter resets on deploy) |
| Decide RT-104 (a new device cannot detect a key-record revision it never saw) | Open. The lost-key-record fork was fixed in beta.13; the revision case remains: document or fix |
| Update the protocol line in `CLAUDE.md` | Open, human edit |

### Correctness, security and data-loss work merged since beta.14

Version gate (#67 to #72, one build writes a database at a time, drafts, reload prompt); multi-tab transaction isolation (#59); IndexedDB snapshot ordering and false durability (#52); retraction ordering and `forceFullResync` (#54, #64); inbound batch transaction (#71); follower liveness (#66); Postgres startup deadlock (#74); deterministic server tests (#77); shared-browser node identity (#76); out-of-view delete (#65); previous-data gating (#79); constraint attribution per operation in batched apply (#75); `exportLocalDatabase` for support recovery; Node 24 Web Locks detection (#87); release hardening (#84 to #86).

### Remaining small items

- Beta.12 server reports its version as `beta.0` (cosmetic, affects `kora doctor` coherence output).
- Yjs pending-content encoding nondeterminism noted in #46.
- Server-side reads inside transactions use the active fold plan during a rolling deploy (done in #47; keep the test).
- Open PRs: #19 "Version Packages (beta)" must not merge before the release candidate; #18 can be merged or closed.
- `kora doctor` wrongly reports "runs without authentication" right after first start (Kora issue from the LMS rehearsal).
- Initial-sync reconnect storm for large views (14 reconnects, about 7x retransmission), also on beta.12 (Kora issue from the LMS rehearsal). C1 and C2 reduce the exposure; confirm with the rehearsal fixture.

## Product evidence

| Product | Workload | Canary state | Verification | Important evidence |
|---|---|---|---|---|
| KoraDocs | collaborative rich text, access rules, blobs, anonymous and signed-in sharing | exact pin at last verification: `…20261026104444`; re-verify on `…20261027061527` | typecheck, production build, production doctor, and 262/262 tests pass | The last failure was a v7 fixture that read a remote row without advancing its device HLC. Modeling the causal observation removed its random node-id ordering. |
| KoraForms | form builder, responses, analytics, webhooks | exact pin at last verification: `…20261026104444`; re-verify | typecheck, build, 167/167 tests, and 13/13 real-Chromium end-to-end scenarios pass | Server-authoritative roles, sync scopes, operation validation, production configuration checks, and role-aware UI make the shared deployment fail closed. Schema duplication remains application debt. |
| Bozoma Learn | large scoped LMS, auth, PWA, recovery, long-lived offline data | exact pin at last verification: `…20261026104444`; re-verify; production still on beta.12 | production build, full sanity, store safety, and focused real-browser critical recovery 15/15 pass | Production deployment invariants are enforced. Recovery uses Kora's lock-safe public export API; the broader legacy browser matrix still contains stale tests that expect private pre-manifest storage enumeration. |
| KoraPOS | Tauri POS, inventory, payments, registers, multi-operator workflows | exact pin at last verification: `…20261026104444`; re-verify | typecheck, full Tauri production build and macOS bundles, 87/87 tests, and production doctor pass | Compatibility is green. Doctor correctly reports the missing worker, access rules, and authentication. Plaintext local PIN/password data remains application architecture debt. |

All direct Kora dependencies in the products are exact pins. A green dependency migration is not treated as a security or production-readiness sign-off. The newest canary adds the Node 24 locking correction; every product is re-pinned to it and re-run before the release candidate.

## Inclusion rule

A request enters Kora core only when it protects or simplifies a cross-domain invariant that most offline-first applications need. Reusable but optional capabilities belong in a package. Domain policy stays in the product or a recipe.

| Owner | Qualification | Examples from this dogfood round |
|---|---|---|
| Core | Universal correctness, durability, convergence, diagnostics, schema or transport contract | pending writes cannot disappear; durable rejection; schema compatibility; multi-tab ownership; typed operation-size errors; offline readiness; cold start |
| Optional package | Reusable capability with meaningful policy or weight that many, but not all, products need | auth, spaces/access membership, blobs, encrypted local secrets |
| Recipe/template | Correct integration pattern with app-owned policy | local operator unlock layered on an authenticated POS identity; webhook outbox; recovery/support UI |
| Product | Business workflow or product-specific authorization | document passwords; certificate approval; form analytics; register closing, receipts, tax and promotions |

No item is promoted merely because one product needs it. Promotion requires at least two independent product use cases, or a universal safety invariant demonstrated by a reproducible failure.

## Resolved during dogfood

- **Causal invitation fixture.** The KoraDocs v7 helper read a server row but omitted `clock.receive(observedTimestamp)`, so an acceptance could sort before the invitation it read. The fixture now models the observation; framework semantics are unchanged.
- **Backend-independent local database export.** `exportLocalDatabase(dbName, options)` sits beside `listLocalDatabases()` and `deleteLocalDatabase()`: it takes the database's exclusive lock and refuses while open, exports the authoritative backend (OPFS or IndexedDB), never deletes, migrates or marks the copy verified, and emits typed `STORAGE_IN_USE`, `NOT_FOUND` and export failure errors. Verified in real Chrome.
- **CLI module-format compatibility.** Template, version and optional-driver resolution use stable Node resolution anchors in both module formats; the packed-artifact gate executes the installed paths.
- **Node 24 Web Locks detection (#87).** Node exposes `navigator.locks`, which is not browser-tab coordination. Kora excludes the `Node.js/*` navigator and keeps Web Locks in browsers and workers.

## Release gates

### Correctness and durability

- Full monorepo build, unit, production-path, fuzz/property, browser storage, SQLite server, and Postgres suites pass (163 server test files and 1,618 tests pass on a fresh PostgreSQL cluster today).
- Pending count is derived from durable state and survives refresh, compaction, reconnect, and process loss.
- Every terminal rejection is durable, queryable, and actionable through a stable code.
- Multi-tab and per-user databases never silently fall back to a divergent writable copy.
- Migration never deletes an old copy before the new copy is durably opened and verified.
- A write whose promise resolved is never lost on any backend, except a browser deleting the whole site's storage (documented).

### Security

- Access-rule isolation tests cover reads, writes, blobs, scopes, authorship stamping, revoked grants, and stale offline clients.
- Auth flows cover verification, reset, session revocation, rate limits, shared-browser user changes, and anonymous suspension.
- Server defaults fail closed; insecure development modes are explicit and visibly diagnosed. Sync servers require authenticated sessions before any multi-device production deployment; tenant and access rules are present for shared data; a local convenience unlock is not an account credential and uses a salted password KDF if persisted. `kora doctor --production` warns on all three.
- Dependency and secret scans run on packed release artifacts.
- External security review of the trust boundary, findings closed.

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

### Packed-artifact release matrix

Source tests do not prove package exports, worker assets, CLI templates, or peer dependency resolution. The validator packs all 16 publishable packages, rejects unresolved workspace ranges or missing declared files, installs the candidate CLI with candidate-package overrides, exercises ESM and CommonJS public entries, scaffolds a clean React app, installs it from the same tarballs, and requires a production app shell plus service worker. The canary workflow waits until every exact package version is publicly readable from npm. Done: that baseline, plus source-level SQLite and PostgreSQL parity. Remaining, on exact packed artifacts:

- browser React app with auth-bound namespacing, offline write, refresh, reconnect, blob and access rules;
- every web template through the offline-readiness suite (A7);
- Tauri template compile and smoke startup;
- packed Node server startup and smoke contracts with SQLite and Postgres;
- `kora doctor` against production SQLite and Postgres, plus worker loading from a non-root base path;
- upgrade from beta.12 and the latest prior canary without deleting local data;
- a C1 snapshot device and an operations device converging on packed artifacts.

## Exit criteria

Beta.15 ships only when all hold (the original criteria, with current status):

| Criterion | Status |
|---|---|
| The four DX metrics meet their targets, measured and published: isolation with sharing under one day and 100 lines; zero upgrade incidents per release caught by `kora doctor`; first usable data under 2 s and full scope under 10 s; 10,000 browser inserts under 2 s | One of four measured as met (inserts, 1.8 s). Others unmeasured or missed |
| Every web template passes the offline-readiness suite, including eviction and first-visit cases | Not started (A7) |
| koraforms and koradocs ran the release candidate in production for two weeks with zero incidents | No release candidate exists |
| The LMS staging trial met the first-sync target | LMS not on a canary in production; rehearsal done on an earlier canary |
| Full gate, chaos (10 clients, 10% loss) and benchmark suites green | Gates exist; run on the release candidate |
| External review findings closed | Review not yet booked |
| Competitive bake-off: one reference app (shared documents with roles, offline edits, images, presence) built in Kora, Zero and PowerSync, timed from empty repo to deployed, with lines of code, offline behavior and failure handling compared; results in the release notes including where Kora loses | Not started |
| Archived green release record | Not started |

## LMS track

Runs independently of the release: the LMS is on Kora beta.12 (the only release that speaks protocol 1), has a shared-browser blocker that #76 fixes, and nothing deploys without Obed's go-ahead.

1. bozoma-learn #1, #3, #4 merged (never wipe unsynced writes, generation ledger, release safety). PR B (findings 4 to 6, export after journal rollback, IndexedDB export, review follow-ups) in progress, then independent review.
2. Move the LMS to the latest canary: bump `korajs`, drop `patches/`, adopt per-user device identity, `auth_password_resets` fix; re-run server-first, client-first, shared-browser, two-devices and default-identity scenarios. A dress rehearsal on a copy of the production database needs a `pg_dump` from Obed (`kora doctor --db`, timed start, all scenarios).
3. Production, with Obed's go-ahead: backups; server first; monitor uploads, refusals, `session.protocol_deprecated`, `node_claim.handover`; clients via the app's update prompt; no generation bump; recover writes compacted since 2026-10-01 by comparing local records with the hub.
4. The E gate's LMS clock starts when every learner device has updated.

## Sequenced work

**Wave 1 (now).** A0 to A2 and C2.1 to C2.4 in parallel. C1.0(a) batch-level verification. D8 `@korajs/test/playwright`. Re-pin the four products to the newest canary. Revise the offline-readiness and C1 designs for the integration requirement.

**Wave 2.** A3 to A5, C2.5 to C2.7, the Chromium first-sync measurement (C1.0(b)), the C1 design re-review (C1.0(c)). D2 `kora upgrade`, D6 one schema, D9 trusted publishing, D1 additions. M2 and instant UI updates. koraforms v22 and the `@korajs/spaces` dist-tag.

**Wave 3.** C1.1 to C1.9 (the property test and compact encoding first). A6 docs, A7 Playwright suite. C4 publish benchmark results and bundle budgets.

**Wave 4.** E removal once the gate holds for all three apps (or moved to beta.16, see decisions). Upgrade guide and release notes. Packed-artifact matrix complete. Competitive bake-off. Release candidate: two weeks of production in koraforms and koradocs, LMS staging trial, chaos and benchmark suites, external review closed. Archived green release record. Ship.

## Decisions

Decided (Obed, 2026-10-28: go with the recommendations above; build proceeds on this basis):

1. Partition fields required for the C2 fast path.
2. Handshake pre-pass opt-out for protocol-2 clients.
3. Fold-state disclosure accepted for beta.15, redaction designed for beta.16.
4. `retain` semantics for snapshot devices.
5. Real operations-per-record ratio from the LMS.
6. **Protocol-1 removal timing** (decided: the recommendation stands, so the removal stays in beta.15 only if the LMS is on a canary in production by the start of the release candidate, otherwise it moves to beta.16). Its critical path depends on every LMS learner device updating, which is outside the framework's control. Recommended: keep it in beta.15 only if the LMS is on a canary in production by the start of the release candidate; otherwise ship beta.15 with protocol 1 still deprecated and move the removal to beta.16. This is a re-scope and needs an explicit decision, because the original plan lists it in beta.15.

On record: one release with canaries (2026-10-08); full access design including in-stream re-scoping (2026-10-08); access rules in the framework with spaces as an optional kit (2026-10-13); beta.13 may ship breaking security fixes; offline readiness decisions (2026-10-19, 2026-10-20); no beta.14 patch release (2026-10-20); multi-tab newer-build-retires-older (2026-10-20); merge when CI is green and findings are answered, without waiting on Codex indefinitely (2026-10-20); an intermittent test failure gets a root cause before a rerun (2026-10-21); A, C1 and C2 in beta.15, C1 unconditional (2026-10-28).

## Obed only (lead time)

- Book the external security review of the trust boundary for the release candidate window.
- Agree the LMS staging trial with Bozoma; provide the LMS operations-per-record ratio and scope size.
- Configure npm trusted publishing (D9).
- In Azure (Log Analytics) for koraforms and koradocs: the 14-day query for `session.protocol_deprecated`; check the one-time resync log line (marker `kora-full-resync-2026-10-20`; remove that startup task after a few weeks).
- For the LMS dress rehearsal: a `pg_dump` of the production Postgres database, restored to a non-production server.
- Provide the `CLAUDE.md` protocol-line edit when E ships.

## After beta.15

### beta.16

- Whole-site wipe signal: the device reports its unsynced count and commit counter at each handshake; the server flags a node that returns empty after reporting outstanding writes. Detection only.
- Durable file blob store for Tauri through the Tauri plugin, the default in `tauri-react`.
- Incremental IndexedDB snapshots (changed tables only), if the fallback latency target is missed.
- Fold-state redaction for scope entries and snapshots.
- C1 for plaintext collections alongside operations for encrypted ones; revival entries so dead records are sent only when a later revival exists.

### P1, immediately after

1. Security-first authenticated Tauri and POS recipe with tenant access rules and local unlock guidance.
2. Framework webhook and outbox recipe proven by KoraForms, with webhook business policy outside core.
3. Recovery UI primitives driven by stable notice and error codes, not storage internals.
4. Minimal bundle and runtime performance budgets in CI.

### P2, adoption and refinement

1. End-to-end examples for collaborative rich text, scoped learning content, forms and outbox, and authenticated desktop data.
2. Turn repeated product integration patterns into documented recipes first; promote them to optional packages only after a second independent implementation proves the abstraction.
3. Track time-to-first-offline-write, recovery success, diagnostic resolution time, and upgrade failure rate as DX product metrics.

## Product-owned follow-ups

### KoraDocs

- Keep the corrected v7 fixture's HLC observation so migration evidence remains causally valid.
- Split the large editor and application bundle and retain the current access isolation tests.

### KoraForms

- Replace the remaining browser and server schema duplication with one shared schema module (D6 gives it the framework half).
- Keep JSON values structured inside Kora; serialize only at external HTTP boundaries.
- Retain server-owned role and scope enforcement; product webhook policy remains outside Kora core.
- v22: remove the legacy `form_collaborators` collection.

### Bozoma Learn

- Keep manifest-managed recovery on the supported export API; remove the read-only beta.12 fallback only after the supported upgrade window ends.
- Rewrite browser scenarios that expect silent OPFS-to-IndexedDB divergence; the current framework deliberately waits or migrates one authoritative copy.
- Keep the sqlite-wasm non-deleting fail-safe until upstream sqlite-wasm provides the same guarantee.
- Retain the production deployment validator so shared deployments cannot start with placeholder secrets, insecure auth, or missing public configuration.
- A learner who joins with a code and does not reload never gets lessons until reload or "Try again" (app issue).

### KoraPOS

- Replace plaintext PIN and password fields with a real account identity plus a separately derived local-unlock verifier.
- Require authenticated sync, tenant partitioning and schema access rules before multi-device deployment.
- Remove hard-coded administrator credentials and direct `localStorage` usage.
- Make factory reset an explicit, authenticated, scoped, recoverable operation with unsynced-data checks.
- Add real Kora sync and access integration tests; the current 87 tests are predominantly domain-unit tests.

## Release decision

The framework core is hardened: storage durability, migration safety, auth, typed schemas, server diagnostics, access control and the security fixes found by dogfood are on `main`, and all four products install and build against the canary. That is not the release. The release is the original plan plus what dogfood found, and the three largest pieces of it (offline readiness, the visibility index and cold start) are designed but unbuilt. Beta.15 waits for those, for the remaining packed-artifact matrix, for the exit criteria above (including two weeks of release-candidate production use, the external review and the bake-off), and for an archived green release record. KoraPOS identity and tenant remediation remains mandatory before its shared deployment, but domain-specific remediation does not block or bloat the framework release.
