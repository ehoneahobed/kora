# Design: instant UI updates (tab-local overlay of pending writes)

Status: shipped behind the `instantUpdates` store option (opt-in, off by default). User guide: `docs/guide/instant-updates.md`. Code: `packages/store/src/overlay/`, the query evaluator in `packages/core/src/query/query-eval.ts`, the fold-based predictor in `packages/core/src/fold/local-update.ts`.

## 0. Summary

Without the overlay, a local write reaches this tab's live queries only after its storage transaction commits and every affected subscription re-runs its SQL through the SQLite worker: roughly 35 to 60 ms in Chromium on OPFS, well over one frame (16 ms).

The overlay is a **read-side prediction layer**, in memory, per tab:

1. The write path is unchanged. Operations are built inside the storage transaction exactly as with the option off. The write path, sync and the operation log never read the overlay.
2. Before the transaction starts, a **predictor** computes what the write will do from the same prepared input the write path uses and registers a **pending entry** (a field patch for an update, a full record for an insert, a tombstone for a delete).
3. The `SubscriptionManager` **patches each affected subscription's last SQL result in JavaScript**, in the same task, without the worker. Only an allowlist of query shapes is patched.
4. After the commit, the **normal SQL re-run still happens** and replaces the patched result. If the write fails, the entry is removed and the query falls back to its SQL result.

The overlay is always overwritten by the database; it is never a second store. Whatever cannot be predicted exactly is excluded, and a differential test against SQLite decides what "exactly" means.

## 1. Problem

A local write runs `prepareInsert` (validation, defaults, `.auto()`, `stamp('userId')`, UUIDv7) on the main thread, then under the adapter mutex: `BEGIN`, a sequence-number reservation, the operation build, buffered statements, `COMMIT`; then it publishes (`subscriptionManager.notify`, `operation:created`). Nothing is observable before the commit, on purpose: nothing observable may point at a rolled-back operation. Reads take the same mutex and the single-threaded worker is busy, so a read cannot be answered during a write.

Phase timers (`instrumentation/phase-timers.ts`) put a single-insert write at about 28 ms (COMMIT about 9 ms, sequence reservation about 5 ms) and a 1,000-row re-read at about 8 ms. With 1,000 subscriptions of which a write affects 50, sequential re-runs add about 36 ms. Removing either cost alone cannot reach a frame, and notifying before `COMMIT` saves only the commit. So the prediction must exist **before the first worker round trip**, and the previous result must be patched instead of re-read.

## 2. Goals and non-goals

Goals: local `insert`, `update`, `delete`, `insertMany` (within caps) and transactions appear in this tab's reactive queries (`subscribe`; through `QueryStore`, `useQuery`, Vue and Svelte) in the same task; nothing stored changes; after a write settles every query shows exactly what a fresh `SELECT` shows; anything not provably predicted behaves as with the option off; the overlay never claims "saved"; memory and main-thread CPU are bounded; no binding changes.

Non-goals: a faster commit (orthogonal, see `docs/benchmarks/baseline.md`); showing pending writes in other tabs; changing when a write's promise resolves; optimistic display of remote operations; patching one-shot reads; a general in-memory query engine.

## 3. Alternatives considered

- **Cheaper durable commit** (journal mode, exclusive locking): 15 to 20% at best, does not reach a frame.
- **Notify before `COMMIT`**, reading through the open transaction: exact SQL semantics, but saves only the commit.
- **Re-run SQL against base plus overlay** (`WITH overlay AS (VALUES ...)`): the read queues behind the in-flight commit it is meant to hide.
- **In-memory primary store** with SQLite write-behind: changes the durability model and the single write path.
- **Predict, patch in JS, let SQL overwrite** (chosen): the only option that removes both the transaction and the re-read from the path to the first callback. Its cost, a second implementation of query semantics for a small subset, is contained by the allowlist, the differential test and a self-check at every settle.

## 4. Design overview

### 4.1 Timeline

```
t=0      insert() called; prepareInsert once (shared with the write path)
t=1      register entry -> patch affected subscriptions in JS -> callbacks (same task)
t=1      BEGIN ......... statements ......... COMMIT
t=~30    retire entry (epoch++), notify, operation:created
t=~30+   SQL re-run per affected subscription replaces the patch; callback only if different
t=~30+   insert() resolves (after ensureDurable on the IndexedDB fallback)
```

### 4.2 Components

| Component | Where | Role |
|---|---|---|
| `PendingWrites` | `overlay/pending-writes.ts` | Entries, epochs, caps, events, dependency chains, committed-row cache |
| Predictor | `overlay/predict.ts`, `core/src/fold/local-update.ts` | `predictInsert/Update/Delete`; the allowlist as counted miss reasons |
| Evaluator | `core/src/query/query-eval.ts` | `checkPatchable`, `matches`, `compare` (also used by the sync server's read-through endpoint) |
| Patcher | `overlay/apply.ts` | `applyOverlay(base, entries, descriptor)` with structural sharing |
| Write wiring | `overlay/write-overlay.ts`, `overlay/write-order.ts`, `mutations/execute-*.ts` | Predict before the transaction, report the outcome after |
| Controller | `overlay/overlay-controller.ts` | One per store: public events, circuit breaker, unknown-outcome lookup, TTL, clear points |
| `SubscriptionManager` | `subscription/subscription-manager.ts` | Per subscription: `base`, the epoch its read was issued at, displayed rows; settles on SQL |

## 5. Semantics

### 5.1 States of a local write

| State | Meaning | Visible | Survives tab death | Claimed as |
|---|---|---|---|---|
| pending | Predicted by the overlay | This tab's patched queries | No | nothing ("Saving...") |
| committed | SQLite committed (fallback: in memory) | Every tab after its next read | OPFS yes; fallback after the barrier | nothing |
| durable | The promise resolved | Same | Yes | "Saved" |
| stored | Server acknowledged | Same | Yes | "Synced" |

The overlay owns only the first state.

### 5.2 Which writes are predicted

Otherwise the write runs as with the option off and is reported as a miss with a reason (`store:write-pending` with `predicted: false`). All checks run **before** registration, so a write that can never run is never shown.

- Common: the store has `instantUpdates`; no `{ durable: true }`; the write gate is open and the adapter is not refusing writes (`refusesWrites()`); the collection's circuit breaker has not tripped; the registry has room and the write touches at most `maxRecordsPerWrite` records; the collection has no secret fields (their stored form is computed asynchronously) and the write touches no `richtext` field; not an internal table.
- **insert**: always, once the common conditions hold.
- **update**: a base row is available (5.6); no written field is `server-authoritative` or folds through a resolver or other fold the predictor cannot run; the state machine allows it (`validateUpdateStateMachine` on the base, as the write path does). Atomic operations, `counter`/`max`/`min`/`append-only` fields and arrays go through the fold (5.10); with `legacyMerge` they are misses.
- **delete**: the collection is not the target of a relation with `onDelete` `cascade`, `set-null` or `restrict` (`cascade-target`). Cascades write rows found by SQL inside the transaction, and a `restrict` refusal would arrive after the row was hidden.

### 5.3 The predicted row must equal the committed row

- **Prepare once.** The `PreparedInsert` the predictor reads is the object the transaction writes, so id, defaults, `.auto()` and stamped values are identical and the record id (the React key) never changes. Registration and the start of the transaction happen in one synchronous step, so overlapping writes register in transaction order.
- **Same shape as a read.** The prediction goes through `serializeRecord` then `deserializeRecord`, the pair every read uses, not the record `insert()` returns (which omits unset optionals that a `SELECT` returns as `null`).
- **Same code.** The write path and the predictor share `mutations/write-shapes.ts` (`recordForInsert`, `patchForUpdate`, `tombstone`). An insert's state is `mergeOp` over a fresh fold state plus `materialize`, as the record folder runs. A plain LWW update is exact because the local operation is the newest writer of every field it touches (the HLC is past everything the device has received).
- **Metadata.** `createdAt`/`updatedAt` come from the HLC timestamp assigned inside the transaction. Allocating it early would let two writes whose transactions run out of call order get HLC order opposite to sequence order. The prediction uses `max(Date.now(), the highest committed createdAt/updatedAt seen)`; the settle corrects it, usually with one extra callback carrying the same rows. Equality is stated modulo these two fields.
- **Verification at commit.** The prediction is compared with the committed record reshaped the same way (base-dependent values are re-predicted first, 5.10). A difference emits `store:overlay-diverged` (field names, no values).

### 5.4 Which queries are patched and how

Patchable (decided once per descriptor): no `include`; `where` fields are scalars (`string`, `number`, `boolean`, `enum`, `timestamp`) or `id`/`createdAt`/`updatedAt`, with `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in` and an operand of the field's type; `orderBy` on those kinds, `asc` or `desc`; no `offset`. Everything else waits for the commit; a new query feature is unpatched by default.

The evaluator mirrors SQLite on this subset: comparisons with NULL exclude the row, `$eq: null`/`$ne: null` are `IS [NOT] NULL`; text compares in code point order (equal to SQLite's BINARY collation on UTF-8), with `string` values passed through the stored-text codec (`encodeStoredText`) as the column holds them; NULL sorts first ascending; booleans compare as 0/1; NULL members of `$in` never match. It refuses, with a named reason, what would depend on type affinity or driver binding: mismatched operand types, `null` with range operators, `NaN`/`Infinity`, unsafe text operands against `enum`/`id`, `$in` lists over 256, and non-scalar, secret or unknown fields.

Patch rules, per changed record, in entry order:

- **insert**: if it matches, insert at its sorted position; with no `orderBy`, append only when the `where` is empty or uses only `$eq`/`$ne` (otherwise SQLite may return index order).
- **update**: from match-before and match-after, enter, leave, replace in place, or remove and reinsert. A record absent from the list is applied only if the update makes it match.
- **delete**: remove if present.
- **`limit`**: inserting or repositioning into a full page is exact; removing a row from a full page is not patched, because its replacement is beyond the limit.
- **ties**: a change whose sort key equals another row's is not patched (SQLite's tie order is unknown). Add `id` to `orderBy` for a total order.

A change that is not patched leaves that subscription's display as it was until the settle. Subscriptions are independent.

### 5.5 Base, display, epochs, settling

Each subscription keeps `base` (its last SQL result), `baseIssuedAt` (the registry epoch when that read was **issued**, before it waited for the mutex) and its displayed rows. An entry's `retiredAt` is `null` while pending and the new epoch at its commit.

> An entry applies to a result iff `entry.retiredAt === null || entry.retiredAt > base.issuedAt`.

A read issued before the commit may lack the entry, so it is applied on top; a later read contains it. Entries are idempotent upserts, never deltas, so applying one to a result that already contains it changes nothing. The display is always **recomputed from `base` plus the applicable entries in registration order**, never mutated, so any rollback is a recomputation.

Lifecycle: registration triggers one coalesced microtask pass (several writes in a task cost one pass) and each patchable affected subscription calls back if its display changed (`resultsEqual`). At commit the entry retires but the display is **kept**, so the row does not blink out before the re-read. When a result with `issuedAt >= retiredAt` arrives it becomes `base`. Entries are dropped once every affected subscription has a newer base, or after the settle window with a forced re-run. A subscription without a first SQL result is not patched.

### 5.6 Base rows, chains and the row cache

An update or delete takes the record's current values from the newest pending entry for that record, then the committed-row cache, then one `findById` that must finish within 4 ms (`BASE_READ_TIMEOUT_MS`) or the write is not predicted. A wrong base never reaches storage: the transaction reads previous values from the committed row.

The cache (LRU) is filled by committed local writes and **seeded from patchable subscriptions' SQL results**, so editing a row on screen needs no read. A result seeds only if the collection's seed stamp did not move between issuing and delivering the read; the stamp grows with every foreign change (remote apply, cross-tab change, untracked `recordsChanged`, an unpredicted write), every own commit and every clear. Later changes invalidate cached rows. Records with an entry, a cached row or an unpredicted write in flight are skipped.

A declined write holds its records out of the base (`holdUnpredicted`) until it settles. An entry derived from a pending entry records it; if the parent rolls back, its dependents are removed at once.

### 5.7 Concurrent remote deliveries

Remote applies use the same mutex and trigger SQL re-runs; the overlay holds no remote data. If a remote commit lands first, pending entries apply on top of the new base, and because updates are field patches other remote values stay visible. If the local commit lands first, the fold decides by HLC and the settle shows it. A remote delete under a pending update makes the patch a no-op and the transaction fail with `RecordNotFoundError`.

### 5.8 One-shot reads

`exec()`, `count()` and `findById` are not patched; they queue behind any in-flight write and return the committed state. A subscriber can therefore show a pending row while an `await exec()` is still waiting for the commit.

### 5.9 Transactions as one entry group

`store.transaction` (behind `app.transaction` and `app.mutation`) buffers intents and writes them at `commit()`. The group is predicted at `commit()` after the buffer is sealed, never while the callback runs, and reads inside the callback never see the overlay. Writes are predicted in buffer order against a group-local view (insert-then-update of one record derives from the group's own prediction). Bases come from the registry, else the row the callback already read (if the seed stamp from before that read still holds), else a base read. One declined write declines the whole group. `addGroup` checks the caps for the whole group, and the storage transaction starts in the same synchronous step.

Invariants: a group is registered **all or nothing**; its members share **one fate** (commit, unknown, rollback) and one `retiredAt`, so one SQL read contains all or none of it; within a subscription it is shown **whole or not at all** (one unplaceable member excludes the group there, repeated to a fixed point); a rollback removes the group, everything derived from it, and every group containing such an entry; one `store:write-pending`/`store:write-settled` per group with `kind: 'transaction'`. The lost-commit witness is the first operation; a group with no operation is rolled back. `insertMany` keeps one entry per record sharing one tracker.

### 5.10 Atomic operations, merge strategies and arrays

Base-dependent writes (`op.increment`, `op.append`, `op.remove`, `op.max`, `op.min`; writes to `counter`, `max`, `min`, `append-only` fields) are predicted by **running the fold**: `predictLocalUpdate` builds a one-field state from the current value, merges the operation with the real `mergeOp` and materializes it.

Arrays cannot be predicted from values: an element's identity is the k-th copy ever added, and after concurrent edits the visible copy may be a later one while an earlier copy is a tombstone. Array writes read the record's fold state (`_kora_fold_state`) once and chain it through later pending writes; if it no longer matches the base record, the write is a miss (`fold-state-stale`).

Verification re-predicts from what the transaction really read (the committed `previousData`, and `WriteResult.priorFoldState` for arrays), so a remote change between prediction and commit is not a false divergence. When a same-collection remote apply overlapped the write or an ancestor has not settled, the check narrows to the written fields and is counted (`unverified`), not silenced.

**Write order.** A write that must read first holds its record's turn (`WriteOrder`); later writes of that record wait, so `update(id); delete(id)` unawaited keeps call order. Other records do not wait. A delete waits for every held turn and is a barrier, because cascades write other records. Consequence: when a write had to read, operations of **independent** records may be logged in a different order than with the option off. Per-record order is always call order, and every operation stays consistent because sequence numbers, timestamps, `causalDeps` and `previousData` are produced inside the transaction.

## 6. Correctness invariants

- **I1. Never the source of truth.** The write path, sync, the outbound queue, the operation log, `findById`, `exec` and `count` never read the overlay.
- **I2. Same operations** with the option on or off (ids, sequence numbers, timestamps modulo wall time, deps), except the cross-record ordering of 5.10.
- **I3. Published only after commit**: `operation:created`, the outbound queue, the unsynced tracker and the cross-tab message are unchanged.
- **I4. Prepare once** (5.3).
- **I5. After settle, the UI equals the database.**
- **I6. Rollback restores the base**: display is always `f(base, remaining entries)`.
- **I7. Allowlist, not denylist.**
- **I8. Bounded** (section 11); over a cap, writes are simply not predicted.
- **I9. No "saved" claim** before the promise resolves.
- **I10. Self-checking.** Every settle compares SQL with the prediction. A divergence emits `store:overlay-diverged`; 3 for one collection in a session stop prediction there (`store:overlay-disabled`). With `NODE_ENV=test` it also throws `OverlayDivergedError`, so an app's own tests catch prediction bugs. The check under-reports rather than raising false alarms.
- **I11. Tab-local**: never serialized, broadcast, stored, or passed to `records-changed` listeners.
- **I12. Clears with the data**, before queries re-run: close, `rebindToNode`, a different user, `clearSignedInUser`, backup import, `reloadFromDisk`, `requestSnapshotResync`, a delivery watermark reset to 0.

## 7. Outcomes and failure matrix

| Event | Overlay | UI | Promise |
|---|---|---|---|
| Success | Retires; display kept until the settle | Patched, then committed row | Resolves (after the barrier on the fallback) |
| Refused before the transaction | No entry | Nothing | Rejects |
| Fails in the transaction (not found, state machine, size, referential, statement, quota, `BridgeTerminatedError`) | Entry and dependents removed | Row leaves or old values return | Rejects with the original error |
| `COMMIT` rejected, outcome unknown | `unknown`, kept shown; the write's last operation id is looked up. Found: committed, published once. Absent: rolled back. Unreadable: decided later | Stays until decided | Resolves if found |
| Barrier fails after commit (`WriteNotDurableError`) | Already retired | Stays | Rejects ("exists, do not retry") |
| Never settles | `unknown` after `pendingTtlMs` | Stays until decided | Rejects on adapter timeout |
| Tab killed | Gone | After reload the database decides | Never resolves |

An unconfirmed commit is never silently rolled back in the UI (that would hide a stored row), and a rollback never touches stored data. Cross-record constraints are decided later by the server (`sync:operation-rejected`).

## 8. Multi-tab

Other tabs never see the overlay: the cross-tab bus announces only committed operations, and a follower's pending state has no durable owner if that tab dies. The overlay has its own `SubscriptionManager` entry point and never calls `recordsChanged`. Conflicting pending writes in two tabs each show their own prediction until both commit; the settle converges them. A leader change mid-transaction fails the write retriably and rolls back the entry.

## 9. Interactions and API

```ts
createApp({ schema, store: { instantUpdates: true } }) // or { maxPendingWrites, maxPendingBytes, maxRecordsPerWrite }
await app.todos.update(id, { done: true }, { durable: true }) // show only after commit
```

- `{ durable: true }` skips prediction only; it adds no durability. Transactions take no per-call option. The IndexedDB fallback store gets the same setting, since its barrier makes the visible latency largest there.
- `await insert()` and `mutateAsync` resolve at durable commit, as before. `mutate` shows its effect in the same frame; a failure sets `error` and the row leaves. `isLoading` is the "Saving..." signal.
- Offline status, `pendingOperations` and the unsynced tracker read committed state and are unaffected. The store exposes `pendingWriteCount()` and `whenWritesSettled()` for unload warnings.
- `useQuery` is unchanged; `useQueryState().ready` still means "first SQL result".
- Events: `store:write-pending` (`predicted`, `reason`, `kind`, `collections`) at registration; `store:write-settled` (`outcome`, `operationIds`, `pendingMs`) before notify on commit and after removal on rollback; `store:overlay-diverged`; `store:overlay-disabled`; `query:patched` instead of `query:executed` for patched deliveries. See `docs/api/devtools.md`.
- The registry, predictor and evaluator are internal (`@korajs/store/internal`). `app.storage.writes.pending` and `onRollback` exist for tests and DevTools but stay internal while the option is off by default, so the public surface is chosen once it becomes the default.

## 10. Memory and CPU bounds

| Limit | Default | When exceeded |
|---|---|---|
| `maxPendingWrites` | 256 | Not predicted |
| `maxPendingBytes` (pending and settling) | 8 MiB | Not predicted |
| `maxRecordsPerWrite` (write or group) | 100 | Not predicted |
| `settleMs` | 2 s | Forced re-run of lagging subscriptions |
| `pendingTtlMs` | 60 s | Entry becomes `unknown` |
| `rowCacheSize` | 512 rows | LRU eviction |
| Patch pass budget | 8 ms | Remaining subscriptions use the commit path |

Settle re-runs are the same work as before, now off the critical path; under sustained bursts they still queue ahead of the next write.

## 11. Testing and measurement

All tests are deterministic (held commits, latches, injected clocks, counted event-loop turns).

- **Differential tests** (`overlay/query-eval.test.ts`): generated rows (NULLs, non-BMP text, lone surrogates, NUL, U+FFFF, `-0`, 2^53, 1e308, ties) and descriptors run through the real `buildSelectQuery` on `better-sqlite3` and through `SqliteWasmAdapter` over the mock worker bridge; membership, order, tie groups and `limit` boundaries must agree. 10,000 cases per engine in CI (`KORA_QUERY_EVAL_CASES`, `KORA_QUERY_EVAL_SEED` for more or a pinned seed). Refusals are asserted by reason, and deliberately broken evaluators are caught.
- **Equivalence** (`overlay/overlay-equivalence.test.ts`, `overlay-atomic.test.ts`): a real `Store` on a gated adapter plus a peer supplying real remote operations, with commits delayed, reordered, failed and ambiguous, single writes and transactions, fold and legacy modes. After every step the display equals an independent model; after the drain it equals a fresh `SELECT` modulo metadata, with zero divergences and an empty registry. Coverage guards fail runs that skipped predictions, declines or rollbacks. `core/src/fold/local-update.test.ts` checks `predictLocalUpdate` against the real fold.
- **Fault injection** (`overlay/overlay-faults.test.ts`): a failure after every statement (of every group member), `COMMIT` lost, landed-but-rejected, unreadable log, bridge terminated, quota, barrier failure, TTL, breaker, strict mode, every clear point, caps, option off. Each asserts the promise, the entry state, display equal to `SELECT`, and exactly one `operation:created` per committed write.
- **Invariants**: `module-graph.test.ts` (I1), `overlay-log-identity.test.ts` (I2, byte for byte), `overlay-crash.test.ts` (worker killed before `BEGIN`, with the commit held, and after `COMMIT`: the row exists after reopen exactly when the commit landed), `kora/src/instant-updates-two-tabs.test.ts` (real leader election and bus: nothing uncommitted reaches the other tab), plus `write-order`, `overlay-seed`, `overlay-cascade-order` and `overlay-transactions` tests.
- **Node gates** (`src/benchmarks/overlay-patching-gates.test.ts`, commit held): write to callback on a 1,000-row result under 2 ms; one write into 1,000 subscriptions of 100 rows under 8 ms.
- **Browser gates** (`packages/store/benchmarks/browser/store-browser-bench.mjs`, Chromium, OPFS): every scenario runs with the option on and off. With it on, these fail the run above one frame (16 ms plus 10%) or if the overlay was inactive: reactive notification p95, 1,000-subscription mutation-to-notification p95, single-insert call-to-callback p95, IndexedDB fallback call-to-callback p95, React click-to-DOM p95 (1,000-row list), and a three-record `app.mutation` (valid only if every sample was predicted as a group). `--instant-updates` additionally gates per-kind write-to-callback p95. With the option off the same metrics are informational: they measure the durable commit and the fallback's barrier, which this feature deliberately leaves alone. The harness times the first callback after the call (a write yields a predicted and a settled callback), drains each write fully, and tallies declined writes by reason. Figures: `docs/benchmarks/baseline.md`.

## 12. Key design choices

- **Predict before the first worker round trip, and let SQL overwrite.** Anything later misses the frame; anything not overwritten becomes a second store.
- **Allowlist plus differential testing** bounds the risk and maintenance of a second query implementation.
- **Field patches, idempotent upserts, recomputed display** make remote interleaving, read races and mid-chain rollbacks need no special cases.
- **Run the fold** for base-dependent writes instead of restating merge semantics that could drift from `@korajs/core`.
- **No early timestamps**: one extra metadata callback is cheaper than breaking HLC order equals sequence order.
- **Settle every write**: skipping re-runs for "known good" subscriptions would save worker time but stop the database from being the arbiter.
- **Off by default, strict in tests.**

## 13. Known limits

- **A shown row can be lost** if the tab closes, crashes or loses its leader inside the pending window. Drive save state from the promise or `isLoading`, and warn on unload while `pendingWriteCount()` is non-zero.
- **Rollback flicker**: a row can appear and disappear (remote delete, quota). An app that calls `mutate` without reading `error` sees it vanish with no message.
- **An extra callback** at settle for corrected metadata, with the same visible rows.
- **Commit path only** for `include` queries, offsets, unpatchable field kinds, cascade/`restrict` delete targets, `richtext` and secret fields, `server-authoritative` fields and resolvers, `legacyMerge` atomic and array writes, writes over the caps, and transactions containing any of these. Patching many-to-one `include`, predicting cascades and a pre-commit read-through for unpatchable queries are not built.
- **Base reads can time out** for records outside the seeded part of the row cache (below the first 512 rows of a large result, or after turnover); re-seeding a large result can evict the rows seeded from its top first.
- **Same-millisecond order** by `createdAt`/`updatedAt` can differ until settle, and a group's inserts share a predicted millisecond, so a query ordered by `createdAt` alone ties and waits for the commit.
- **Untested divergences** (collation, affinity, planner order) are possible; they last one SQL round trip, are never persisted, and trip the breaker on repetition.
- **Total worker work does not fall**, and the differential test's WASM arm is a mock bridge over `better-sqlite3`; the real WASM build is exercised only by the browser gates.
