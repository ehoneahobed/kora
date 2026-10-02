# STORE verification results (STORE-1..16 + NEW-STORE-1..3)

Verifier: independent. All repro tests assert CORRECT behavior and FAIL today.
Run: `cd kora && npx vitest run tests/repro/<ID>.test.ts` or `cd packages/store && npx vitest run tests/repro/<ID>.test.ts`.

## Key routing fact (decides STORE-1..4 impact)

`app.transaction` / `app.mutation` -> `kora/src/transaction-executor.ts:27` -> `store.transaction()` -> `TransactionContext` (buffers ops; seqs from `TransactionSequenceAllocator`). Because `initialize-app.ts:148` installs `ApplyPipeline` as `localMutationHandler`, `TransactionContext.commit()` (transaction-context.ts:161-171) delegates to `ApplyPipeline.commitTransaction` (kora/src/apply-pipeline.ts:150-219), which executes the buffered commands but NEVER writes `_kora_version_vector` (the store-level `INSERT OR REPLACE` at transaction-context.ts:201-207 is skipped entirely). So the public path is worse than the register claimed: every app.transaction leaves the persisted sequence watermark stale.

| ID | Verdict | Sev | Effort |
|---|---|---|---|
| STORE-1 | CONFIRMED (worse than claimed) | P0 | M |
| STORE-2 | CONFIRMED | P0 (same root) | M (with STORE-1) |
| STORE-3 | CONFIRMED (insert/update); delete sub-claim UNPROVEN | P1 | S |
| STORE-4 | CONFIRMED | P0 | S |
| STORE-5 | CONFIRMED | P0 (op-log corruption via documented API) | M |
| STORE-6 | CONFIRMED (faithful simulation) | P1 | M |
| STORE-7 | CONFIRMED | P1 | S |
| STORE-8 | CONFIRMED | P2 | M |
| STORE-9 | CONFIRMED | P1 | S |
| STORE-10 | CONFIRMED | P2 | S |
| STORE-11 | CONFIRMED | P2 | S |
| STORE-12 | CONFIRMED | P2 | S |
| STORE-13 | CONFIRMED | P1 | M |
| STORE-14 | CONFIRMED (opt-in only) | P2 | M |
| STORE-15 | CONFIRMED (dedup race, index collision, quota, VV-before-commit by reading) | P3 | S |
| STORE-16 | CONFIRMED (gate mislabeled) | P3 | S |
| NEW-STORE-1 | CONFIRMED backfill transform receives raw SQLite row | P2 | S |
| NEW-STORE-2 | CONFIRMED tx updates bypass state machine | P1 | S |
| NEW-STORE-3 | CONFIRMED field-level `.transitions()` never enforced | P1 | S |

---

### STORE-1 sequence reuse via transactions — CONFIRMED, P0, M
- Test: `kora/tests/repro/STORE-1.test.ts` (3 cases, all fail).
  - insert, app.transaction(2 inserts), insert -> seqs `[1,2,2,3]`; persisted `_kora_version_vector` stays 1 after the tx (debug: in-memory 3, DB 1), next insert gets 2 (collision with tx op 'a').
  - 2 concurrent app.transaction -> both ops seq 1.
  - Server acked tx (vector=3); following `todos.insert` gets seq 2 -> `store.getUnsyncedOperations({node:3})` returns `[]`: **the write is never uploaded on reconnect/delta -> silent data loss**.
- Locations: `packages/store/src/transaction/transaction-sequence.ts:17-24` (reads watermark once, increments in memory); `kora/src/apply-pipeline.ts:201-211` (no VV write); `packages/store/src/transaction/transaction-context.ts:201-207` (store-only path: `INSERT OR REPLACE` with in-memory high-water mark can move VV backwards if a concurrent UPSERT advanced it); `packages/core/src/schema/sql-gen.ts:117` (ops tables only index `record_id`; no UNIQUE(node_id, sequence_number)).
- Root cause: transaction seqs are reserved in memory from a stale read and never durably reserved; public commit path omits the VV write.
- Fix: reserve seqs inside the commit's DB transaction. In `ApplyPipeline.commitTransaction` (and `TransactionContext.commit`) inside `adapter.transaction`: `INSERT ... ON CONFLICT DO UPDATE SET sequence_number = sequence_number + :n RETURNING sequence_number` to reserve a contiguous block, then stamp ops (create ops at commit, or re-stamp; op id hash excludes seq per CORE-1, verify) before writing op rows. Side-effect entries (`buildSideEffectEntry`) must allocate via `allocateNextSequenceInTransaction(tx)` in the same tx. Delete `TransactionSequenceAllocator`. Invariant: for self node, ops seqs unique and `max(seq) <= persisted VV[self]`; enforce with `CREATE UNIQUE INDEX ... ON _kora_ops_<c>(node_id, sequence_number)` (+ migration that renumbers existing duplicate local unsynced ops). Never `INSERT OR REPLACE` the VV with a value computed outside the tx; use `MAX(existing, new)`.
- Regression risk: medium (op construction order, causal deps, DevTools ordering; existing DBs with duplicates need repair).

### STORE-2 cascade seq collisions — CONFIRMED, P0 (same root), M
- Test: `kora/tests/repro/STORE-2.test.ts`: app.transaction {insert project, delete project with 2 cascading todos} -> 8 ops, 6 unique seqs.
- Public path: `ApplyPipeline.commitTransaction` -> `buildSideEffectEntry` (kora/src/build-side-effect-entry.ts:29) -> `store.allocateSequenceNumber()` (UPSERT on stale DB watermark, outside the commit tx) -> collides with buffered tx seqs; it then writes `INSERT OR REPLACE` VV = its own seq (build-side-effect-entry.ts:66-69), possibly below tx seqs. Store-only path: `relation-enforcer.ts:187` `allocateNextSequenceInTransaction` from DB watermark W while TransactionContext also handed out W+1.. .
- Fix: as STORE-1 (single in-tx block reservation covering buffered + side-effect ops).

### STORE-3 transactional writes skip per-field LWW stamps — CONFIRMED (insert/update), P1, S
- Test: `kora/tests/repro/STORE-3.test.ts` (both fail; control with non-tx writes passes).
  - Local tx update at T2 > remote update T1 on same field: after applying remote via the real `ApplyPipeline.applyRemote`, local row = 'remote' (server LWW keeps 'local') -> permanent divergence.
  - tx-inserted row (no `_field_versions`): newer remote update to `title` bumps `_version`; older remote update to untouched `count` is then rejected (falls back to row `_version`) -> local count=0, server count=5.
- Location: `packages/store/src/transaction/transaction-context.ts:277-285` (insert: no `_field_versions`), `:369-375` (update: `_version` only), `:432` (delete: `buildSoftDeleteQuery` without version).
- Fix: mirror `executeInsert`/`executeUpdate`: insert sets `_field_versions = fieldVersionsForFields(keys, version)`; update builds the update command at commit time (or reads current `_field_versions` inside the commit tx) and stamps each changed field; delete passes `version` to `buildSoftDeleteQuery`. Best: route buffered entries through the same `executeInsert/Update/Delete` builders with an injected `tx` so one code path exists.
- Delete sub-claim (stale-insert resurrection): UNPROVEN via public API; remote updates on tombstones go through log fold (`applyRemoteUpdateOnDeletedRow`), and same-id remote inserts are not reachable with UUIDv7 ids. Still fix (cheap).

### STORE-4 secret fields plaintext via transactions — CONFIRMED, P0, S
- Test: `kora/tests/repro/STORE-4.test.ts`: control `app.accounts.insert` passes; `app.transaction` insert and `app.mutation` update store `hunter2`/`correct-horse` in the row AND `_kora_ops_accounts.data` (which syncs). Default config (`t.secret().hashed()` needs no key).
- Location: `transaction-context.ts:244-277` (insert) and `:325-369` (update) never call `transformSecretFieldsForWrite` (used in `mutations/execute-update.ts:73`); `TransactionContextConfig` has no `secretKeyProvider` (`store.ts:1164-1178`).
- Fix: pass `secretKeyProvider` into `TransactionContextConfig`; apply `transformSecretFieldsForWrite(validated, definition, provider)` before `createOperation` in insert/update. Add a shared helper so all write paths share it.
- Regression: low.

### STORE-5 backup restore — CONFIRMED, P0, M
- Test: `kora/tests/repro/STORE-5.test.ts` (both fail).
  - Replace-mode self round-trip: restored op rows have `timestamp` = `JSON.stringify(hlc)`; `HybridLogicalClock.deserialize` then yields `{wallTime:null, logical:<wall>, nodeId:'0,"nodeId":...'}`; `__kora_atomic_ops__`, `__kora_tx_id__`, mutationName dropped (data `{"count":2}` instead of increment). Op log is corrupt -> LWW/folds/replay broken.
  - Merge import into device B: `_kora_meta.node_id` overwritten with A's id (B becomes a clone of A after restart); VV rows replaced (`INSERT OR REPLACE`), can move backwards.
- Location: `packages/store/src/backup/backup.ts:377-404` (merge), `:436-453` (replace) — hand-built rows instead of `serializeOperation`; `:365-372` merge imports all `_kora_meta` keys (node_id, schema_version, last-acked server vector, delivery watermarks); `:415-416` replace deletes meta; `store.ts:1237-1240` no reload of `nodeId`/`versionVector`/`sequenceNumber`/clock and no subscription invalidation; `readCollectionRecords` exports only `_deleted = 0` (tombstones lost).
- Fix: export ops via `serializeOperation` rows (or keep `Operation` JSON) and import with `serializeOperation(op)`; merge mode: never import `node_id`/sync meta, VV via `MAX(existing, incoming)`, ideally replay ops through `applyRemoteOperation`; replace mode: after commit call a `Store.reloadFromDisk()` (re-read node id, VV, seq, clock.receive(max ts)), invalidate all subscriptions; include tombstones. Bump BACKUP_VERSION.

### STORE-6 IndexedDB follower rewrites leader live DB — CONFIRMED (simulation), P1, M
- Test: `packages/store/tests/repro/STORE-6.test.ts` with fake-indexeddb and a bridge modelling the real browser worker (idempotent `open` per sqlite-wasm-worker-core.ts:170-173, `export` -> EXPORT_NOT_SUPPORTED per :326-332, follower relay forwards requests verbatim per tab-storage.ts:173-220). Leader writes 'unflushed' after a flush; second tab `open()` -> leader's live DB now `['flushed']` only.
- Location: `packages/store/src/adapters/indexeddb-adapter.ts:96-111` + `:186-213`. In browsers the worker cannot export, so `writeSnapshot` deletes the binary snapshot (:157-162) and every open uses `restoreFromDumpFallback`, which `DELETE FROM` + re-INSERTs every table (incl. `_kora_version_vector`, ops) on the leader's live DB, non-transactionally.
- Fix: only the storage leader may restore: `IndexedDbAdapter.open` must skip `importDatabase`/`restoreFromDumpFallback` when `inner` is a follower (expose `inner.isLeader()`); on promotion restore only if the worker DB is freshly created. Wrap restore in one transaction.
- Confidence: high (not run in a browser).

### STORE-7 flushNow re-entrancy — CONFIRMED, P1, S
- Test: `packages/store/tests/repro/STORE-7.test.ts`: flush of v1 in flight, write v2 + `schedule()`, then `flushNow()` (close / visibilitychange) clears the timer and only awaits the in-flight flush -> persisted v1; `dispose()` -> v2 never persisted.
- Location: `indexeddb-persistence-scheduler.ts:58-74`. Also `indexeddb-adapter.ts:215-238` `exportDump` reads tables with separate non-transactional queries (torn snapshot; can capture another caller's uncommitted rows, see STORE-8). 500 ms debounce loss window on crash is by design.
- Fix: track `dirty` flag; `flushNow` loops `while (dirty || inFlight) { await inFlight; if (dirty) run }`; `schedule()` sets dirty. Take dump inside one read transaction via `inner.transaction`.

### STORE-8 execute/query bypass adapter mutex — CONFIRMED, P2, M
- Test: `packages/store/tests/repro/STORE-8.test.ts`: independent `adapter.execute` during another caller's open tx is rolled back with it; `adapter.query` sees uncommitted rows.
- Location: `better-sqlite3-adapter.ts:76-98`, `sqlite-wasm-adapter.ts:283-298` (no mutex), tx mutex at :303.
- Public reach: non-tx writers include `StoreQueueStorage` (kora/src/store-queue-storage.ts:30,39), `StoreRejectedOperationStorage`, `_kora_meta` writes; readers include every subscription re-run during `ApplyPipeline.commitTransaction` (multi-await) -> UI can observe half-committed or rolled-back transactions.
- Fix: `execute`/`query` acquire the same mutex (query may skip only when no tx open); tx-internal calls use the `tx` handle, so no deadlock.

### STORE-9 concurrent increments lose updates — CONFIRMED, P1, S
- Test: `kora/tests/repro/STORE-9.test.ts`: 10 concurrent `update(id,{n:op.increment(1)})` -> n=1; 5 concurrent app.transaction increments -> n=1. Server sums atomicOps -> local/server divergence.
- Location: `packages/store/src/mutations/execute-update.ts:31-68` (read + resolve outside tx; absolute value written at :114); `transaction-context.ts:320-337` (same, via `getEffectiveRecord`).
- Fix: move the row read and atomic resolution inside `ctx.adapter.transaction` (read via `tx.query`); for TransactionContext resolve atomics at commit inside the tx (or emit `SET n = n + ?`).

### STORE-10 multi-tab duplicate not notified — CONFIRMED, P2, S
- Test: `packages/store/tests/repro/STORE-10.test.ts`: two Stores on one DB (shared leader model); tab A applies remote op, tab B gets `'duplicate'` and its live query stays `[]`, its VV lacks the peer.
- Location: `store.ts:285-308` returns 'duplicate' without `subscriptionManager.notify`/`recordOperationSequence`; `kora/src/local-operation-bus.ts:46` relays only `operation:created` (local ops), never remote applies. Shared node id + per-tab in-memory VV/seq confirmed by reading (`store.ts:125`, isolation default 'shared').
- Fix: on 'duplicate', call `recordOperationSequence(op)` and `subscriptionManager.notify(collection, op)` (cheap; diff suppresses no-op); also broadcast remote applies on the local-operation bus.

### STORE-11 createdAt/updatedAt queries — CONFIRMED, P2, S
- Test: `kora/tests/repro/STORE-11.test.ts`: documented `.orderBy('createdAt','desc')` (docs/api/store.md:153 etc., react.md:100, vue.md:82) throws `no such column: "createdAt"`; `where({updatedAt:{$gt:0}})` same. Inside `useQuery` the error is swallowed (STORE-12) -> empty UI.
- Location: `packages/store/src/query/sql-builder.ts:353-354` whitelists names; no mapping to `_created_at`/`_updated_at`.
- Fix: map virtual fields to columns in where/orderBy builders (`createdAt -> _created_at`, `updatedAt -> _updated_at`).

### STORE-12 subscription diff / error handling — CONFIRMED, P2, S
- Test: `packages/store/tests/repro/STORE-12.test.ts`: unchanged result with array field re-notifies (2 calls); failing query -> unhandled rejection.
- Location: `subscription-manager.ts:397-418` (`a[key] !== b[key]`), `:235-238` swallow, `:185-191` `.then` without `.catch`.
- Fix: structural equality for arrays/objects/Uint8Array (per field kind); add an `onError` channel (emit `query:error` event / pass error to callback) and `.catch` in registerAndFetch.

### STORE-13 migrations — CONFIRMED, P1, M
- Test: `kora/tests/repro/STORE-13.test.ts`: backfill#1 (qty*10) commits, backfill#2 throws -> schema_version not written; reopen re-runs backfill#1 -> qty=100 (expected 10). Backfill creates no ops (expected an update op).
- Location: `store.ts:1291-1327` (DDL via `adapter.execute` per statement, each backfill its own tx, `schema_version` written last); `:1344-1373` backfill writes rows only (no op, no `_field_versions`, no `_version`).
- Impact: crash mid-migration double-applies non-idempotent backfills or bricks open (non-tolerated DDL errors); backfilled values never reach the server; new devices (stored version 0 -> migration runs on empty tables) and server keep pre-backfill values -> divergence.
- Fix: run each version's DDL + backfills + `schema_version` write in one `adapter.migrate`/transaction (SQLite DDL is transactional). Backfills must emit update ops (via executeUpdate with a migration mutationName) or be documented local-only and re-run deterministically on apply of older-schema ops.

### STORE-14 compaction — CONFIRMED (opt-in), P2, M
- Test: `kora/tests/repro/STORE-14.test.ts`: local insert, local delete at T2, `store.compact({mode:'after-ack'})`, then concurrent older remote update (T1) via ApplyPipeline -> record resurrected (control without compact passes: stays deleted).
- Location: `compaction/compact-operation-log.ts:52-71` deletes acked ops; fold in `apply-pipeline.ts` `applyRemoteUpdateOnDeletedRow` (`getOperationsForRecord`) and dedup (`store.ts:286-289`) assume the full log. Callers: only `Store.compact` (public) and CLI `compact` command; never automatic. No index on (node_id, sequence_number) confirmed (sql-gen.ts:117).
- Fix: keep a per-record tombstone/last-op summary (or never compact delete ops and the latest op per record); keep a compacted-id bloom/set or rely on VV for dedup; add `(node_id, sequence_number)` UNIQUE index (also STORE-1).

### STORE-15 lows — CONFIRMED, P3, S
- Test: `packages/store/tests/repro/STORE-15.test.ts`: collections `a_b.c` and `a.b_c` both produce `idx_a_b_c` -> second index silently missing; two concurrent `applyRemoteOperation(sameOp)` -> one rejects (dedup check `store.ts:286` outside tx, PK violation inside).
- By reading: `store.ts:535-541` sets in-memory `versionVector` inside tx before COMMIT (stays advanced if COMMIT fails -> handshake under-requests); no `SQLITE_FULL` -> `store:quota-exceeded` mapping outside IndexedDB (`indexeddb-adapter.ts:165-183` only).
- Fix: dedup via `INSERT OR IGNORE` + changes() inside tx; update in-memory VV after commit; index names `idx_<len>_<collection>_<field>` or quoted unique scheme; map SQLITE_FULL/OPFS quota errors in adapters to the event.

### STORE-16 benchmark gates — CONFIRMED, P3, S
- `packages/store/vitest.benchmark.config.ts` runs `src/benchmarks/**`. `sqlite-wasm-performance-gates.test.ts:20-22` uses `MockWorkerBridge` (better-sqlite3 in-process, no worker, no OPFS, no structured clone) — measures better-sqlite3, not WASM. `indexeddb-performance-gates.test.ts` also MockWorkerBridge (export supported, so it never exercises the browser JSON-dump path) and debounce 0 with the flush fire-and-forget outside the timed window — persistence cost is not measured. Insert gates use `store.transaction` without `localMutationHandler` (not the app path). Subscription flush re-runs every subscription of an invalidated collection serially (`subscription-manager.ts:225-239`); only the single-subscription latency is gated.
- Fix: rename gates honestly or run them in a browser runner (Playwright + real worker/OPFS); await persistence in IDB gate; add N-subscriptions fan-out gate.

### NEW-STORE-1 backfill transform gets raw row — CONFIRMED, P2, S
- Test: `kora/tests/repro/NEW-STORE-1.test.ts`: boolean arrives as `1`, array as JSON string. `store.ts:1348-1356` passes `RawCollectionRow` to the transform. Fix: `deserializeRecord(row, definition.fields)` before transform; serialize output with `serializeRecord`.

### NEW-STORE-2 transactions bypass state machine — CONFIRMED, P1, S
- Test: `kora/tests/repro/NEW-STORE-2.test.ts`: collection-level `stateMachine` with `onInvalidTransition:'reject'`; direct update blocked (control passes), `app.transaction` update draft->delivered succeeds. `transaction-context.ts:325` lacks `validateUpdateStateMachine` (present in execute-update.ts:42). Fix: call it in `TransactionContext.update`.

### NEW-STORE-3 field-level `.transitions()` not enforced — CONFIRMED, P1, S
- Test: `kora/tests/repro/NEW-STORE-3.test.ts`: `t.enum(...).transitions({...})` (docs/guide/state-machines.md "simplest approach") — direct update draft->delivered succeeds. `core/src/schema/define.ts:285-291` builds `stateMachine` only from collection-level input; `validateUpdateStateMachine` reads only `collectionDef.stateMachine`. Fix: in `define.ts`, derive `stateMachine` from an enum field's `transitions` when no collection-level one exists (default mode per docs), or have the validator consult field descriptors.

## Files created
kora/tests/repro/: STORE-1,2,3,4,5,9,11,13,14, NEW-STORE-1,2,3 (.test.ts)
packages/store/tests/repro/: STORE-6,7,8,10,12,15 (.test.ts)
No existing files modified.
