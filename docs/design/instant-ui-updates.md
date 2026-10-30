# Design: instant UI updates (tab-local overlay of pending writes)

Status: IMPLEMENTED behind `instantUpdates` (opt-in, default off; beta.15, section A of `docs/plans/beta15-dogfood-consolidated-plan.md`, "Instant UI updates"). Stages S0 to S5 are merged or in review; the kora-repo half of S5 (browser gates, crash and two-tab tests) is described in "S5 result" in section 13; the dogfood week is outside this repository. Stage S6a (transactions as one entry group) is designed in "S6a design" and reported in "S6a result" (section 13); S6b to S6f are not built. Internal design doc (not published). Written against `main` at `19cd5d9`; the sections before 13 are the design as proposed, and the stage results in 13 record where the build departed from it.

## 0. Summary

A local write today becomes visible to this tab's live queries only after its storage transaction has committed and every affected subscription has re-run its SQL through the SQLite worker. Measured in Chromium on OPFS that is about 34 ms for a single insert, 61 ms p95 until a reactive query notices it, and 96 ms p95 with 1,000 subscriptions (that last figure came from a harness that overcounted; with the harness corrected in S2 it is 58 ms p95, see "S2 result"). The target is one frame (16 ms).

The design adds a **read-side overlay of pending writes**, kept in memory in each tab:

1. The write path is **not changed**. Operations are still built inside the storage transaction, content-addressed, appended and materialized in the same order, with the same ids. The overlay is never read by the write path, by sync, or by the operation log.
2. Before the transaction starts, a **predictor** computes what the write will do to the record, from the same validated, defaulted, stamped input that the write path will use (`prepareInsert` runs once and its result is shared). The prediction is registered as a **pending entry**: a field patch for an update, a full record for an insert, a tombstone for a delete.
3. The `SubscriptionManager` **patches each affected subscription's last authoritative result in JavaScript**, in the same task, without touching the worker. Only queries on a strict allowlist of shapes are patched; anything else keeps today's behavior (wait for the commit).
4. When the transaction commits, the entry is retired and the **normal SQL re-run still happens**. Its result replaces the patched one, so after commit the UI always shows what SQLite holds. If the write fails, the entry is removed and the query falls back to its base result.

The decision that matters most: the overlay is a prediction layer that is **always overwritten by the database**, never a second store. Everything that cannot be predicted exactly is excluded (allowlist, not denylist), and a differential test against real SQLite is the arbiter of what "exactly" means.

Two findings from reading the code shape the design and should be read first (section 1.2):

- Showing a result as soon as the last statement of the write has run, before COMMIT, saves only the COMMIT (about 11 of the 34 ms) and cannot meet a frame. The prediction has to exist **before the first worker round trip**.
- The reactive gate's 61 ms is not only the write. A re-run of a 1,000-row result costs about 24 ms by itself. A faster commit alone could not meet the gate; patching the previous result without re-reading it is what removes that cost from the critical path.

## 1. Problem and measurements

### 1.1 What the numbers say

From `docs/benchmarks/baseline.md` (headless Chromium 141, OPFS `opfs-sahpool`, the harness in `packages/store/benchmarks/browser/store-browser-bench.mjs`):

| Measurement | Value | Target |
|---|---|---|
| OPFS single insert (own transaction) | 34.1 ms | none (reported) |
| OPFS query 1,000 rows WHERE | 23.9 ms | under 50 ms |
| OPFS reactive notification p95 | 61.0 ms | under 16 ms |
| OPFS 1,000 subscriptions, mutation to notification p95 | 96.2 ms (old harness; 58.5 ms corrected in S2) | under 16 ms |
| 1,000-subscription check per mutation | not among the gates the plan lists as missed | under 1 ms |

Profile of 500 sequential single inserts (same document): `COMMIT` 11 ms, op-log row 9 ms (the first write to a page after a commit pays OPFS I/O), sequence reservation 5 ms, fold state 4.5 ms, materialized row 4.5 ms. Worker round trips and main-thread JS were under 1 ms per insert.

### 1.2 Where the latency is, from the code

Write path (`packages/store/src/mutations/run-local-write.ts`, `write-ops.ts`):

```
insert(data)
  prepareInsert           validate, defaults, .auto(), stamp('userId'), secrets, UUIDv7 id   [main thread]
  adapter.transaction
    mutex.acquire         one transaction at a time per tab; reads wait for it too
    BEGIN                 worker round trip
    sequence reservation  UPSERT ... RETURNING on _kora_version_vector (in the transaction)
    build operation       clock.now(), createOperation (SHA-256), size check
    append op row, fold state, materialized row   (write-behind batches, one `batch` request)
    COMMIT                OPFS journal + database writes
    mutex.release
  causal.publish, notifyWriteObserver
  publishOperations       subscriptionManager.notify, operation:created   <- subscribers hear here
  ensureDurable           IndexedDB fallback only
  resolve
```

Subscriptions (`subscription-manager.ts`): `notify` queues a microtask `flush`, which finds the affected subscriptions (every subscription on the collection, or including it) and runs them **one after another** (`for ... await this.run(sub)`). Each run is `QueryBuilder.exec()`, a `SELECT *` through `adapter.query`, which first waits for the adapter mutex.

Consequences:

1. **Nothing is observable before the commit.** The notify happens after `adapter.transaction` resolves. That is deliberate (STORE-15: nothing observable ever points at a rolled-back operation).
2. **A read cannot be answered during a write.** The adapter's `query` takes the same mutex as `transaction`, and the SQLite worker is single-threaded and busy with the batch and the fsync of the COMMIT. Even a read that skipped the mutex would queue behind the worker's current message.
3. **The 61 ms reactive figure is about 34 ms (write) plus about 25 ms (re-reading a result of about 1,000 rows, the harness's `completed = true` query over 10,000 todos) plus a few ms.** This was an inference from the baseline numbers; stage S0 measured it (see "S0 result" in section 13): the write is confirmed (about 28 ms to resolve) but the re-read of a 1,000-row result is about 8 ms, not 25 ms, so the split is about 75% write and 22% re-read, not 55/40. The conclusion survives: the commit alone (about 9 ms) plus one re-read (about 8 ms) already exceeds 16 ms, so no change to the commit path alone can reach the gate.
4. **The 96 ms fan-out figure is about 34 ms plus about 50 sequential re-runs** (1,000 subscriptions over 20 collections, so a write affects 50) at roughly a worker round trip each. S0 first read this as about 96 ms for the 50 re-runs (1.9 ms each); that was inflated by a harness bug (warm-up re-runs still in flight, see "S1 follow-up: the fan-out oddity" in section 13). Corrected: the write is about 30 ms and the 50 re-runs about 36 ms (0.7 ms each), so the last callback arrives about 66 ms after the call, and the re-runs are about half of the fan-out cost, not three quarters.

So two costs are on the critical path: the transaction, and the re-read. The overlay removes both from the path to the first callback, and leaves them in place, off the path, to settle the result.

## 2. Goals and non-goals

### Goals

- G1. A local `insert`, `update` or `delete` is reflected in this tab's reactive queries (`subscribe`, and through `QueryStore`: `useQuery`, Vue, Svelte) in the same task or the next microtask, for supported queries and writes. Target: p95 under 16 ms in the browser harness for the single-insert, reactive and 1,000-subscription fan-out gates, measured at the subscriber callback, plus an end-to-end DOM gate (section 12.5).
- G2. No change to what is stored: operations, ids, order, sequence numbers, timestamps, the outbound queue, upload timing.
- G3. No new way to lose or fabricate data. After a write settles, every query shows exactly what a fresh `SELECT` shows.
- G4. Anything not provably predicted behaves exactly as today.
- G5. Honest signals: the overlay never says "saved". The write's promise stays the only "saved" signal. The app can tell that a write is shown but not yet committed from the mutation's `isLoading` (a public count of pending writes is internal until the default flips, decision 6).
- G6. Bounded memory and bounded CPU on the main thread.
- G7. Works in every binding without binding changes (the patch happens in `@korajs/store`).

### Non-goals

- N1. Making the commit faster (journal mode, `locking_mode = EXCLUSIVE`, group commit of separate awaited inserts). Measured and not adopted in `docs/benchmarks/baseline.md`; orthogonal.
- N2. Showing one tab's pending writes in another tab. The overlay is tab-local (section 8).
- N3. Changing when a write's promise resolves (durable commit, plus the fallback barrier). `mutateAsync` and `await insert()` keep their meaning.
- N4. Optimistic display of remote operations, sync state, or anything not a local write.
- N5. Patching one-shot reads (`exec()`, `count()`, `findById`). They already see earlier writes because they queue behind the write's transaction on the mutex (section 5.8).
- N6. Becoming a general in-memory query engine. The JS evaluator exists only for the allowlisted subset and is never the source of truth.
- N7. Replacing `useMutation`'s `onMutate`/`onRollback` for UI state that is not in the local database.
- N8. Server-side rejection UX. A server may refuse a committed write later (`sync:operation-rejected`); that path exists and is unchanged.

## 3. Alternatives considered

| Option | Latency to first callback | Verdict |
|---|---|---|
| A. Cheaper durable commit (journal mode, EXCLUSIVE locking) | 34 ms to about 27 ms at best (15 to 20% on single inserts) | Does not reach a frame, changes file locking. Not adopted (baseline.md). |
| B. Notify before COMMIT (read through the open transaction; the worker's connection sees its own uncommitted rows) | about 23 ms (everything but the COMMIT) plus the read | Exact SQL semantics for free, but misses a frame, and a read inside the write's span changes the transaction's I/O pattern. Rejected as the main mechanism. Kept as a possible stage-S6 refinement for queries the patcher cannot handle. |
| C. Re-run SQL against base plus overlay (`WITH overlay AS (VALUES ...)` merged with the table) | one worker round trip, queued behind the in-flight commit | Reuses SQLite's predicate and sort semantics, but the read waits for the mutex and the worker, so it cannot beat the commit. Rejected for latency. |
| D. Make an in-memory structure the primary store and SQLite a write-behind log | sub-millisecond | Changes the durability model and the single write path that the rest of the system depends on. Out of scope, and contradicts the "data is sacred" ordering. Rejected. |
| E. **Predict, patch the last result in JS, let SQL overwrite** | microtask | **Chosen.** The only option that removes both the transaction and the re-read from the critical path. Its cost is a second implementation of query semantics for a small subset, contained by an allowlist, a differential test against SQLite, and a runtime self-check at every settle. |

Option C's analysis is the answer to "re-run against overlay plus base": it is simpler to get right, and it cannot meet the frame, because the work it needs from the worker is serialized behind the work it is meant to hide.

## 4. Design overview

### 4.1 Timeline

Today (OPFS, one subscriber on the collection):

```
t=0      insert() called
t=0..1   prepareInsert
t=1      BEGIN ................ statements ............ COMMIT        (about 34 ms)
t=35     notify -> flush -> SELECT (queued, runs, returns)            (about 3 to 25 ms)
t=40-60  subscriber callback
t=40-60  insert() resolves (OPFS has no barrier)
```

With the overlay:

```
t=0      insert() called
t=0..1   prepareInsert  (once; the result is shared with the write path)
t=1      overlay.add(entry)  ->  patch affected subscriptions in JS  ->  callbacks (same task)
t=1      BEGIN ................ statements ............ COMMIT
t=35     retire entry (committed, epoch++), notify, operation:created
t=35+    SELECT re-run per affected subscription; result replaces the patched one; callback only if different
t=35+    insert() resolves (after ensureDurable on the fallback)
```

Failure at any point after `overlay.add`: the entry is removed, each affected subscription recomputes from its base and calls back with the base result.

### 4.2 Components

| Component | Where | Role |
|---|---|---|
| `PendingWrites` registry | new `packages/store/src/overlay/pending-writes.ts` | Entries, lifecycle, caps, epochs, events. Pure data structure plus clock-free logic. |
| Predictor | new `overlay/predict.ts` | Pure functions: `predictInsert`, `predictUpdate`, `predictDelete`. Share code with `write-ops.ts` (section 5.3). |
| Query evaluator | new `overlay/query-eval.ts` | `isPatchable(descriptor, definition)`, `matches(descriptor, record)`, `compare(descriptor, a, b)`. The allowlist (section 5.4). |
| Patcher | new `overlay/apply.ts` | `applyOverlay(base, entries, descriptor)` returning the displayed rows with structural sharing. |
| `SubscriptionManager` | changed | Keeps `base`, `baseIssuedAt`, `displayed` per subscription; new entry point `overlayChanged(collection)`; settles on SQL results. |
| Write entry points | `execute-insert.ts`, `execute-update.ts`, `execute-delete.ts`, `run-local-write.ts` | Predict before the transaction, report the outcome after it. |
| Config and API | `createApp({ store: { instantUpdates } })`, `{ durable: true }`; `app.storage.writes.pending` and `onRollback` exist but are internal (decision 6) | Section 10. |

The write path gains three calls (`overlay.add`, `overlay.commit`, `overlay.rollback`) and **reads nothing from the overlay**. Invariant I1.

## 5. Semantics

### 5.1 Vocabulary: four states of a local write

| State | Meaning | Visible where | Survives tab death | Claimed to the user as |
|---|---|---|---|---|
| pending | Predicted by the overlay; no statement has necessarily run | This tab's patched queries only | No | nothing (may show "Saving...") |
| committed | The SQLite transaction committed (on the IndexedDB fallback: committed in the in-memory database) | Every tab, after its next read | OPFS: yes. Fallback: only after the barrier | nothing |
| durable | The write's promise resolved (OPFS: equals committed; fallback: the `ensureDurable` barrier passed) | Same | Yes | "Saved" |
| stored | The server acknowledged the operation | Same | Yes | "Synced" |

The overlay owns only the first state. `docs/design/offline-readiness.md` 8.1 already notes that on the fallback a write is visible (committed in memory) before it is durable; the overlay adds one earlier, weaker tier in front of that and must never be presented as a stronger one.

### 5.2 Which writes are predicted (allowlist)

A write is predicted only if **all** of these hold, decided by `predict*` synchronously before anything is registered. Otherwise the write runs exactly as today and no entry is created (a "miss", counted).

Common:
- instant updates are enabled for the app, the write has not passed `{ durable: true }`, and the write gate is open (`assertLocalWriteAllowed`, `writeGate.isClosed()`), and the adapter is not refusing writes (`StorageDurabilityError` state). The checks run **before** registration (F1, F2).
- the registry has room (section 11), and the write touches at most `maxRecordsPerWrite` records (default 100). Larger writes (a 10,000-row `insertMany`) are not predicted.
- the collection has no secret fields (hashed or encrypted at rest; the stored form is not the value the app passed) and no `richtext` field in the written fields.
- for an update, every written field is a scalar kind (`string`, `number`, `boolean`, `enum`, `timestamp`); `array`, `object` and `richtext` fields are written only by inserts in this design (their merge semantics make "the written value is the materialized value" unproven for updates, so they move to S6). An insert may carry any field kind except `richtext` and secrets; its value comes from the fold itself (5.3c).

Per kind:
- **insert**: always predictable once the common conditions hold (a fresh UUIDv7 record has no prior state; `foldRecord` starts from `createFoldState`).
- **update**: the record is present in the current base or in a pending entry (section 5.6); no atomic op descriptor (`op.increment`, `op.append`, ...) among the values; no field with a non-default merge strategy (`counter`, `max`, `min`, `append-only`, `server-authoritative`) and no schema `resolve` function on a written field; the state machine allows every written field (the predictor runs `validateUpdateStateMachine` on the base record, the same function the write path runs). Atomic ops and merge strategies need exact base accounting and move to stage S6.
- **delete**: the collection is not the target of a relation whose `onDelete` is `cascade`, `set-null` or `restrict`. A cascade writes operations on other collections (their rows are found by SQL inside the transaction), and a `restrict` can refuse the delete after the row was already hidden (F4). Static per schema.

`app.transaction` and `app.mutation` are not predicted in stages S1 to S5; stage S6a predicts them as one atomic entry group (section 13, "S6a design").

### 5.3 Prediction: the optimistic row must equal the committed row

Three mechanisms keep the predicted record equal to what a later `SELECT` returns. The overlay never invents a value.

**(a) Prepare once, share.** `prepareInsert` validates, applies defaults, fills `.auto()` timestamps (`Date.now()` at that call), fills `stamp('userId')`, and generates the UUIDv7. Today `executeInsert` calls it and passes the result to `writeInsertInTx`. The overlay hooks the same call: the `PreparedInsert` object that the predictor reads is the object that the transaction writes. Therefore id, defaults, auto fields and stamped fields are identical by construction, and the record id (the React key) never changes between pending and committed.

**(b) Same shape as a read.** The record `insert()` returns is built from the prepared data and can differ in shape from a row read back (an optional field that was not given is absent from the returned record and `null` in a `SELECT` row; richtext is shaped by `toRichtextReadShape`). The predicted record is therefore produced by the **read-side functions**: `serializeRecord(data, fields)` to the raw row shape, then `deserializeRecord(row, fields)`, the pair every read uses. The predictor does not reuse the returned record.

**(c) Same fold for state, same code for the patch.** For an insert the predicted state is `mergeOp(createFoldState(...), op, schema, options)` followed by core's `materialize`, the pure functions that `RecordFolder.applyInTx` runs for a fresh local insert (it skips the state load for exactly this case: "A local insert has a fresh UUIDv7 record id"). The predictor builds a synthetic operation for this (provisional timestamp, placeholder sequence number); materialized values do not depend on either for a single-operation state. For an update the prediction is the written values over the base record for plain LWW fields. That is exact because the local operation is the newest writer of every field it touches: the HLC is advanced past every timestamp the device has received (`write-ops.ts` states this where it stamps field versions). Fields where that argument does not hold are excluded by section 5.2. A refactor extracts `recordForInsert` and `patchForUpdate` out of `write-ops.ts` so the write path and the predictor call one function (S2).

**(d) Metadata.** `createdAt` and `updatedAt` are `operation.timestamp.wallTime`, assigned when the operation is built, after the sequence number is reserved inside the transaction. The overlay does not allocate timestamps early (that would risk the invariant that HLC order equals sequence order within a node; see F9). The predicted value is `max(Date.now(), clock wall time)`, which is at least every timestamp this device has seen, so ordering by `createdAt` places the new record where the committed one will land. The committed value differs by a few milliseconds. At settle the SQL result replaces the patched one, and because `createdAt` differs, subscribers get a **second callback** with the same rows and the committed metadata. This is accepted (section 14, risk 6) and is the only expected, benign difference. The equality property in section 12.2 is "equal modulo `createdAt` and `updatedAt` of records that had a pending entry".

**(e) Verification at commit.** When the transaction returns, the predictor's record is compared with `WriteResult.record` deserialized the same way. Any difference outside `createdAt`/`updatedAt` emits `store:overlay-diverged` (collection, field names only, no values) and counts toward a circuit breaker (section 6, I10). In test builds it throws.

### 5.4 Which queries are patched (allowlist) and how

A subscription is **patchable** when its `QueryDescriptor` passes `isPatchable` (re-evaluated when the descriptor is created, so it costs nothing per write):

- no `include` (relations resolve parents or children by further SQL; see below),
- every `where` field is a schema scalar field or `id`/`createdAt`/`updatedAt`, with kinds `string`, `number`, `boolean`, `enum`, `timestamp`; operators `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`; operand type equal to the field's type (no mixed-type comparisons, which depend on SQLite type affinity),
- every `orderBy` field is of those kinds,
- `offset` is absent or zero,
- and the data-dependent rules below hold for the particular change.

Everything else (`include`, `array`/`object`/`richtext` fields in `where` or `orderBy`, offsets, mixed types) keeps today's behavior: the subscription is untouched until the commit and the SQL re-run. This list is an allowlist: a new query feature is unpatched by default.

The evaluator mirrors SQLite for the allowlist. The places where SQL and JavaScript differ, and what the evaluator does:

| Behavior | SQLite | Evaluator |
|---|---|---|
| `$ne: v` on a NULL column | `col != ?` is NULL, row excluded | Excluded |
| `$eq: null` / `$ne: null` | `IS NULL` / `IS NOT NULL` | Same |
| `$gt`, `$lt`, ... on NULL | NULL, row excluded | Excluded |
| Text comparison | BINARY collation, UTF-8 byte order | Code point order (equal to UTF-8 byte order; not UTF-16 code unit order) |
| NULL in `ORDER BY` | NULL sorts first in ASC, last in DESC | Same |
| Boolean | stored 0/1 | Compared as 0/1 |
| Ties in `ORDER BY` | Row order unspecified; in practice rowid order | `compare` returns 0; data-dependent fallback below |
| Text holding U+0000, U+FFFF or a lone surrogate (`string` fields) | Column holds the stored-text codec's form (RT-65), so it sorts and compares by the escape (U+FFFF at the first such unit) | Same: both sides go through `encodeStoredText`, then code point order. Exact, not refused |
| Operand text with a lone surrogate or U+0000 against an `enum` or `id` column (stored verbatim, no codec) | The driver binds a lone surrogate as U+FFFD; WASM reads TEXT up to a NUL | Refused (`unsafe-text-operand`) |
| `$gt`, `$gte`, `$lt`, `$lte` with a `null` operand | `col > NULL` is never true | Refused (`operand-type-mismatch`); the query is a dead letter, not worth a branch |
| `$in` containing `null` | `x IN (NULL, ...)`: the NULL member never matches | NULL members ignored. `$in: []` matches nothing |
| `NaN` or `Infinity` operand | `NaN` binds as NULL; `Infinity` is a real | Refused (`non-finite-operand`). A `NaN` in a record is read as NULL |
| `-0` against `0`; doubles beyond 2^53, near 1e308 or 5e-324; fractions in an `INTEGER` (`timestamp`) column | Equal / numeric comparison, integer against real exact | Same (JS doubles; tested at those values) |
| Operand type differs from the field's (`'5'` against a number, `1` against a boolean) | Depends on column affinity | Refused (`operand-type-mismatch`) |
| `array`, `object`, `json`, `blob`, `richtext`, `secret` fields; unknown fields; raw `_created_at` / `_updated_at` | JSON text, bytes, or hashed/encrypted values; not the value the app sees | Refused (`unsupported-field-kind`, `unknown-field`) |
| Schema field named `createdAt` / `updatedAt` | The field's column wins over the virtual column (STORE-11) | Same (the record property is the field's value) |
| `$in` list longer than 256 | Valid | Refused (`in-list-too-long`), to bound main-thread work |
| Unknown operator, non-plain `where` value (a `Date`) | Builder throws / binding error | Refused (`unknown-operator`, `invalid-where`) |
| `orderBy` direction | Lower-cased, then `ASC` or `DESC` | Same; anything else refused (`invalid-direction`) |

Patch rules, per change to a record `r` (applied against the subscription's current list, in entry order):

- **insert** (`r` new): if `r` matches `where`, insert it at its sorted position; with no `orderBy`, append, but only when the `where` has no conditions or only `$eq`/`$ne` (the planner can then return rowid order; a range or `$in` over an indexed column returns index order, so append would be wrong and the insert is not patched).
- **update** (`r` present or not): compute match-before and match-after. Entered the result: insert at position. Left the result: remove. Stayed: replace in place if the sort key is unchanged, else remove and reinsert.
- **delete**: remove if present.
- **`limit`**: with `limit n`, an insert or reposition into a full page (`length === n`) is exact (the new row either lands inside the first `n` or not). Any change that **removes** a row from a full page, or moves a row out of it, is **not patched**, because the row that should take its place is not in memory (it is beyond the limit). The subscription waits for the SQL result.
- **ties**: if the changed record's sort key is equal to another row's key in the result, the change is not patched (SQLite's tie order is its rowid order, which the evaluator does not know). With a total order (for example `orderBy('createdAt')` where keys differ, or an `id` tie-break) this never triggers.
- **count and aggregates**: there is no reactive count or aggregate API today (`QueryBuilder` offers `exec`, one-shot `count`, and `subscribe`; verified in `query-builder.ts`). One-shot `count()` is not patched (5.8). A future reactive aggregate must define its own patch rules and is unpatched by default.
- **include**: not patched in this design. A stage-S6 extension can patch a many-to-one include when the parent record is in the same result's included data or a pending entry. Otherwise the subscription waits for the commit.

If any rule says "not patched" for a change, that subscription's display stays as it was (it still shows earlier patches) and the write completes through the normal path. The patched display of one subscription never depends on another's.

### 5.5 Base, display, epochs, settling

Each subscription keeps:

- `base`: the last SQL result and `baseIssuedAt`, the overlay epoch at the moment that read was **issued** (synchronously, before it waits for the mutex);
- `displayed`: what the callback last received (either `base` or `base` with entries applied).

The registry has a monotonic `epoch`. An entry has `retiredAt: number | null`: `null` while it is pending, and the epoch value assigned when its transaction committed.

> An entry applies to a subscription's result iff `entry.retiredAt === null || entry.retiredAt > base.issuedAt`.

That is: a read issued before the entry's commit may not contain it, so the entry is applied on top; a read issued after the commit contains it, so the entry is skipped. Entries are **idempotent upserts of the predicted field values** (never deltas), so applying one to a result that already contains it (a read issued just before the commit but executed after it) changes nothing but the two metadata fields. Atomic operations would need deltas and break this property, which is why they are excluded from the first stages.

Displayed state is always **recomputed from `base` plus the applicable entries in registration order**, never mutated incrementally. A rollback therefore needs no special case for dependent or later entries: remove the entry and recompute (F10).

Lifecycle of the displayed list for one write:

1. `overlay.add` -> every patchable affected subscription recomputes `displayed`; if it differs (structurally, with `resultsEqual`) the callback fires, once per subscription, in one synchronous pass.
2. Commit: the entry gets `retiredAt = ++epoch`; the existing `notify` schedules the SQL re-run. **`displayed` does not change at this point**: it keeps the patched rows until the SQL result arrives. This avoids a flicker where the row disappears between commit and re-read (F3).
3. The SQL result arrives with `issuedAt >= retiredAt`: `base := result`, the entry no longer applies, `displayed := base (+ other pending entries)`. A callback fires only if it differs from the previous `displayed` (normally only the metadata).
4. Settled entries are dropped when every affected subscription has a `base.issuedAt >= retiredAt` (tracked per collection), or after a bounded wait (section 11) with a forced re-run.

If a subscription has no base yet (its first SQL result is outstanding), nothing is patched; when the first result arrives the applicable entries are applied on top.

### 5.6 Same-record sequences and base rows for updates

An update needs the record's current values: first from the newest pending entry for that record in this tab (typing into a field produces a chain of updates), otherwise from a small per-store committed-row cache. The cache is filled from `WriteResult.record` of committed local writes and from rows the store itself read, keyed by `(collection, id)`, stamped with the epoch, and **invalidated by any remote apply, invalidation or cross-tab change that names the collection or record** (the same `recordsChanged` funnel the cross-tab bus uses). On a miss the predictor makes one `findById` read; if that read has not completed within 4 ms (it is queued behind another transaction) the write is not predicted. A bad guess never reaches storage: previous values and atomic results for the real operation are read inside the transaction from the committed row.

Chains: the entry for an update lists `after: writeId` for the pending entry it was derived from. If that entry rolls back, the dependent update is removed with it at once (it cannot succeed: the record will not exist or will have its old values), without waiting for its own transaction to fail. Because `displayed` is recomputed from entries, a middle rollback is simply a recomputation.

An update of a record that is absent from the subscription's list is applied only if the change makes the record match (an update-in-place needs the row).

### 5.7 Ordering against concurrent remote deliveries

Remote operations are applied by `applyRemoteOperation` / `applyRemoteBatch` on the same adapter mutex, so a remote commit and a local commit never interleave, and each triggers a SQL re-run. The overlay does not hold remote data. Cases:

- Remote commits first, local pending: the re-run returns `base` with the remote change and the entries are still applied on top ("local on top of remote"). The real outcome is the same for fields the local write touches (its HLC is later than anything received before it was stamped) and the remote values stay for other fields, because entries are **field patches**, not whole-record snapshots (F5).
- Local commits first, remote later: the fold decides by HLC; the remote value may win a field. The SQL settle shows it. This flip is the same one a user sees today, 34 ms earlier or later.
- The remote operation deletes the record while an update is pending: the update patch finds no record, is a no-op, and the transaction fails with `RecordNotFoundError`: rollback of an already invisible entry.

The overlay never reorders anything stored, and the settle makes the final state a function of the database only.

### 5.8 One-shot reads

`exec()`, `count()` and `findById` are not patched. They queue on the mutex behind any in-flight write transaction, so an `await query.exec()` issued after a not-awaited `insert()` already returns the post-commit state. This keeps one-shot results exact. The cost is that they wait for the write, which is today's behavior.

Consequence to document: inside one handler, a subscriber can show a pending row (patched) while an `await exec()` is still waiting for the commit. If the write then fails, both agree afterwards (the row disappears from the subscriber and is absent from the `exec` result).

## 6. Correctness invariants

Each is testable and each has a section 12 test.

- **I1. The overlay is never the source of truth.** The write path, sync, the outbound queue, version vectors, the operation log, `findById`, `exec` and `count` never read it. Deleting the overlay at any instant changes nothing stored.
- **I2. Same operations, same order, same ids.** With instant updates on or off, the sequence of operations a program produces (ids, sequence numbers, timestamps modulo wall time, causal dependencies, hashes) is identical. Tested by running a recorded workload twice with a fake clock and comparing logs byte for byte.
- **I3. Stored only after commit.** `operation:created`, `pushOperation`, the unsynced tracker, the cross-tab bus message, `recordOperationSequence` and the outbound queue happen after the commit, exactly as before. The overlay emits only its own events (`store:write-pending`, `store:write-settled`).
- **I4. Prepare once.** The object the predictor reads is the object the transaction writes (section 5.3a).
- **I5. After settle, the UI equals the database.** For every patchable subscription, once all entries are settled and its post-commit SQL result is delivered, `displayed` equals that result (deep equality). Differences found at settle are reported (`store:overlay-diverged`).
- **I6. Rollback restores the base.** Removing any subset of entries yields `displayed = f(base, remaining entries)`; with none left, `displayed = base` exactly.
- **I7. Allowlist, not denylist.** A write or query shape not named in 5.2 and 5.4 is not predicted or not patched. Adding a field kind, operator or query feature to the store changes nothing until the evaluator and the differential test learn it.
- **I8. Bounded.** Entries, bytes, per-write records and settle time are capped (section 11). Over a cap, writes are not predicted (they behave as today); nothing is dropped from an existing entry.
- **I9. No write claim.** No API returns or implies "saved" before the promise resolves.
- **I10. Self-checking.** Every settle compares the patched display with the SQL result. Divergence beyond the two metadata fields emits `store:overlay-diverged`; after 3 divergences for a collection in a session, prediction for that collection is disabled for the session (circuit breaker) and `store:overlay-disabled` is emitted.
- **I11. Tab-local.** Overlay state is never serialized, broadcast, or placed in storage, and never feeds `records-changed` listeners (the cross-tab bus). Other tabs hear about a write only through the normal post-commit path.
- **I12. Clears with the data.** The overlay is cleared on store close, `rebindToNode`, `reloadFromDisk`, backup restore, sign-out or user switch (per-user isolation), and `forceFullResync`, before the subscriptions re-run (F8).

## 7. Outcomes and failure matrix

The write has exactly one outcome; the overlay follows it.

| Event | When | Overlay | What the UI sees | Promise | Events |
|---|---|---|---|---|---|
| Success, OPFS / native | COMMIT answered | `retiredAt = ++epoch`, display kept until SQL settle | patched row, then committed row (maybe metadata update) | resolves | `store:write-settled committed`, `operation:created` |
| Success, IndexedDB fallback | COMMIT answered, then barrier | same; promise waits for `ensureDurable` | same | resolves after the barrier | same |
| Refused before the transaction (`BuildSupersededError`, `StorageDurabilityError`, validation, `StampedFieldError`) | before `overlay.add` | no entry | nothing ever shown | rejects | none |
| Fails inside the transaction (`RecordNotFoundError`, state machine, `OperationTooLargeError`, `REFERENTIAL_INTEGRITY`, statement error, quota) | before COMMIT | `rollback`: entry and dependents removed, display recomputed from base | row disappears (or the old values return) | rejects with the original error | `store:write-settled rolled-back`, `store:quota-exceeded` if quota |
| Leader change / bridge terminated mid-transaction (`BridgeTerminatedError`) | any statement | same as above: nothing committed, the transaction rolls back | row disappears | rejects (retriable) | same |
| COMMIT rejected but the commit landed (M2, "commit outcome unknown") | at COMMIT | entry becomes `unknown`: kept displayed, the outcome is looked up by the content-addressed id of the write's last operation (known to `runLocalWrite`: `result` is assigned inside the transaction callback). Found: treated as committed (and M2 publishes `operation:created` / `operation:applied`). Absent: rolled back. Lookup fails: stays `unknown` until the next successful SQL read, which decides. | row stays while unknown; correction when decided | per M2: resolves if found, rejects otherwise | `store:write-settled unknown` then the final outcome |
| Committed, barrier fails (`WriteNotDurableError`) | after COMMIT | already retired | the row stays (committed; same as today's visible-but-not-durable) | rejects `WriteNotDurableError` ("exists, do not retry") | `store:write-durability failing` |
| Transaction never settles (hung worker, frozen tab; RPC timeout 30 s) | `pendingTtl` (default 2x the worker response timeout) | entry becomes `unknown` (same lookup) | row stays until decided | rejects when the adapter's timeout fires | `store:write-settled unknown` |
| Tab killed or navigated away | any time | gone with the tab | after reload the database decides: the row is there if the commit landed, absent if not | never resolves | none |
| Constraint or validation rejection after optimism | n/a locally | Local writes have no cross-record constraint check; the server decides and refuses later | existing path (`sync:operation-rejected`, re-fold) | already resolved | existing |
| Schema transform | n/a | Local operations are authored at the current schema version, so no transform applies to them; transforms act on older remote operations at fold time | unchanged | unchanged | unchanged |

Two rules behind the table: a commit that cannot be confirmed is **never silently rolled back in the UI** (that would hide a stored row and make it pop back), and a rollback never touches stored data (nothing was committed).

## 8. Multi-tab

Kora runs one leader tab per database (its worker owns OPFS); other tabs are followers whose requests are relayed to the leader (`sqlite-wasm-adapter.ts`, STORE-6). Writes from any tab are routed to the leader's worker and committed there; the committing tab publishes `kora-local-operation` / `kora-records-changed` on the `BroadcastChannel` (`local-operation-bus.ts`), and other tabs re-run their queries.

Decisions:

- **Other tabs do not see the overlay.** It is tab-local state of the tab that made the write (I11). Reasons: pending entries are not committed, so broadcasting them would announce writes that may roll back, which the bus is built never to do (STORE-15, RT-98); a follower tab's pending state has no durable owner if that tab dies; and the cost of broadcasting every keystroke is not justified by the gate we are addressing.
- The overlay uses its own entry point on `SubscriptionManager` (`overlayChanged`) and **does not call `recordsChanged`**, which would reach the cross-tab listeners.
- A follower's write has more latency (a relay hop on top of the 34 ms), so followers gain the most.
- Two tabs with conflicting pending writes to one record each show their own prediction until both commit; the SQL settle in each converges them (F7).
- A leader change in the middle of a transaction fails it retriably (`BridgeTerminatedError`): the entry rolls back and the row disappears from the writing tab. The app sees the rejection.
- A follower that is retired by a newer build (version gate) stops writing; its entries are cleared with the write gate closing.

## 9. Interactions

### 9.1 Offline readiness and pending counts

The overlay does not change `app.offline.status()`, `useOfflineReady`, `app.sync.getStatus().pendingOperations`, the unsynced tracker or the storage-eviction evidence. All of those read committed state (`operation:created`, the outbound queue, the manifest) and the overlay is upstream of none of them. A write that is pending in the overlay is not "unsynced" yet because it is not stored yet.

New, tab-local and **internal** (decision 6, 2026-10-30): `app.storage.writes.pending` (number of write entries not yet committed) and `onRollback` exist next to the public `status()` (`durable | failing`) and `subscribe()`, for DevTools and the framework's own tests, and are not part of the public API until the default flips to on. In beta.15 an app shows "Saving..." from the mutation's `isLoading` (true until the write's promise settles, section 9.2) and may listen to the `store:write-pending` / `store:write-settled` events; it should warn on `beforeunload` while its own mutations are loading. `useStorageWrites()` (React, Vue, Svelte) is deferred with the public `pending` (S4 deviation 1); a public surface is a later-stage decision.

### 9.2 `useMutation`: `mutate` and `mutateAsync`

- `await app.todos.insert(data)` and `mutateAsync` **resolve at durable commit**, as today: after the transaction, and after `ensureDurable()` on the fallback. The resolved value is the committed record. The promise from `insert()` is not resolved early; the overlay is invisible to it.
- `mutate` (fire and forget) returns immediately as today; the visible effect now arrives from the overlay in the same frame. A failure sets `error` (and `rejected` for later server refusals) exactly as now; in addition the row vanishes, which is the visible symptom of a rollback. Apps that call `mutate` without reading `error` would see a row appear and disappear with no message. In development builds the first rollback with no `useMutation` error consumer and no `store:write-settled` listener logs a warning pointing at `error`/`onError`.
- `isLoading` stays true until the promise settles. It covers the "pending until durable" window, and is the signal to disable "Saved" labels.
- `onMutate`/`onRollback` remain for state outside the local database. They are not used for local rows any more, and the docs say so.

### 9.3 Sync outbound queue

Nothing uploads before it is durable on the device (CLAUDE.md, sync rules; `awaitUploadDurability`). The overlay sits before any of that: `operation:created` still fires after the commit, `pushOperation` still enqueues after it, and the upload barrier is unchanged (I3). A pending entry cannot be uploaded because no operation exists yet.

### 9.4 Events and ordering

Existing order on success, unchanged: commit -> `notifyWriteObserver` -> `causal.publish` -> per operation `recordOperationSequence`, `subscriptionManager.notify`, `operation:created` -> `ensureDurable` -> resolve.

Added around it:

```
store:write-pending   {writeId, collection, recordIds, kind}        before BEGIN, at overlay.add
  ... transaction ...
store:write-settled   {writeId, outcome, operationIds?, pendingMs}   immediately before `notify` on commit,
                                                                      on rollback after the removal, on unknown
operation:created     (unchanged, after the commit)
store:overlay-diverged {collection, fields}                          at settle, only on divergence
store:overlay-disabled {collection}                                  circuit breaker
```

`operation:applied` is for remote operations and is unchanged. M2 (separate item in the same section) fixes its absence after a commit whose outcome was unknown; this design only reuses its lookup.

### 9.5 DevTools

Two new panel rows under Sync Timeline: a pending bar from `store:write-pending` to `store:write-settled` (the user-visible latency saved, `pendingMs`), and a divergence marker. `query:executed` is not emitted for patched deliveries; a new `query:patched {queryId, collection, resultCount, durationMs}` is, so the Conflict Inspector and query list can tell which results came from SQL and which from the overlay. `KoraEvent` in `packages/core/src/events/events.ts` and `docs/api/devtools.md` get the new types.

### 9.6 Sync-applied remote changes

A delivery batch that touches a collection invalidates it and re-runs queries as today; pending entries stay applied on top. Delivery batches are one transaction and are not predicted (N4).

## 10. API surface

Opt-in first, default later.

```ts
createApp({
  schema,
  store: {
    instantUpdates: true, // or { maxPendingWrites?: number, maxPendingBytes?: number, maxRecordsPerWrite?: number }
  },
})

// Per-write escape hatch: no overlay for this write; visible at commit as today.
await app.todos.insert({ title: 'x' }, { durable: true })
await app.todos.update(id, { done: true }, { durable: true })
await app.todos.delete(id, { durable: true })
const { mutate } = useMutation(app.todos.insert)
mutate({ title: 'x' }, { durable: true }) // arguments pass through
```

Internal until the default flips (decision 6; not in the public types, may change): `app.storage.writes.pending` (a number) and `app.storage.writes.onRollback(cb)` (`cb({ writeId, collection, recordIds, error })`). Apps use `useMutation`'s `isLoading` and `error` instead (9.2).

- `{ durable: true }` is a second parameter on `Collection.insert/update/delete`, `LocalMutationHandler.insert/update/delete`, and the typed collection API. It skips prediction only; the write is otherwise identical. (`durable` names the user-visible promise: "show this only when it is stored".) Writes that fail the allowlist behave the same way and report a miss reason in `store:write-pending {predicted: false, reason}` for DevTools.
- **Default:** `instantUpdates: false` in beta.15 (feature ships, off), flipped to `true` in the release after the dogfood apps (koraforms, koradocs) have run it with `store:overlay-diverged` at zero. Open question 1.
- `useQuery` is unchanged. `useQueryState().ready` keeps its meaning (first SQL result).
- Public types: `InstantUpdatesOptions`, `WriteOptions { durable?: boolean }`, the events above. Everything else (registry, predictor, evaluator) stays in `internal.ts`.

## 11. Memory and CPU bounds

| Limit | Default | When exceeded |
|---|---|---|
| Pending (uncommitted) entries per tab | 256 | New writes are not predicted (counted miss) |
| Estimated bytes of pending and settling entries | 8 MiB (JSON size of values, estimated on add) | Same |
| Records per write | 100 | The write is not predicted |
| Settling (committed, not yet read) lifetime | 2 s, then a forced re-run of the lagging subscriptions | Entries dropped after the forced re-run |
| Pending TTL | 2 x `workerResponseTimeoutMs` (60 s) | Entry becomes `unknown` and is decided by lookup / next read |
| Committed-row cache | 512 rows, LRU | Eviction; a miss costs one `findById` |
| Patch work per change | O(affected patchable subscriptions x result size); a pass over 1,000 subscriptions of 100 rows is expected at 1 to 3 ms of main-thread time (to be measured in S3) | If a pass exceeds 8 ms, the remaining subscriptions fall back to the commit path |

Patch passes are coalesced: several `overlay.add` calls in one task (typing, a loop of inserts) produce one recomputation per subscription per task (a microtask), so a burst does not multiply callbacks.

The SQL re-runs that settle the result are unchanged work, now off the critical path. They still queue in the worker ahead of the next write's `BEGIN`, so sustained write bursts do not get cheaper in total (section 14, risk 5).

## 12. Test strategy

All tests are deterministic: fake clock, controllable adapter, no timers except in the browser latency gates.

### 12.1 Differential tests against SQLite (S1)

fast-check generates a schema (field kinds from the allowlist, optional and required fields, declared indexes), rows (NULLs, empty strings, non-BMP characters, large and negative numbers, integers vs fractions, duplicates for ties), and descriptors (`where` with every operator, 0 to 3 `orderBy` keys, `limit`). Each case runs the real `buildSelectQuery` on `better-sqlite3` (in-process, same SQL builder) and the JS evaluator, and asserts equal membership, equal order, and for ties equal sets. A second run uses the same cases against the SQLite WASM mock bridge to catch affinity differences. Cases the evaluator refuses (`isPatchable` false) are asserted to be refused for the right reason. 10,000 cases per CI run, a longer nightly. Zero mismatches is the S1 gate.

### 12.2 Overlay equals post-commit (S2, S3)

The central property (`overlay-equivalence.test.ts`): generate a workload of 1 to 30 steps over 1 to 4 records and 1 to 5 patchable subscriptions: insert, update, delete, remote apply (via `applyRemoteOperation` with a generated remote operation), commit-order permutations, with a **fake adapter whose commits are resolved by the test** (delayed, reordered across writes where the mutex allows, failed, ambiguous). After every step assert the model `displayed == f(base, entries)` (an independent, slow reference implementation); after all writes settle assert `displayed` deep-equals a fresh `SELECT` modulo `createdAt`/`updatedAt` of records with an entry, for every subscription. Run on `better-sqlite3` with `materialization: 'fold'` (default) and `'legacy'`.

### 12.3 Fault injection (S4)

A fault adapter wraps the real adapter and throws or hangs at each of: before BEGIN, after sequence reservation, after each statement of the write, at COMMIT (not landed), at COMMIT (landed, rejected), during `ensureDurable`, bridge terminated, quota. For each, assert: the promise outcome, the entry's end state, `displayed == SELECT` after settle, no `operation:created` for a rolled-back write, exactly one `operation:created` for a committed one (including the M2 path), `storage.writes` state, and that sync never receives an operation for a rolled-back write.

### 12.4 Invariant tests

- I2: replay one recorded workload with instant updates on and off with a fake clock; the logs are identical (ids, sequence numbers, timestamps, deps).
- I1: a static test that the module graph has no import of `overlay/*` from `mutations/write-ops.ts` or `packages/sync`.
- I8: caps; filling the registry degrades to commit-wait, never to an error.
- I10: a deliberately wrong evaluator (test double) triggers the breaker after 3 divergences.
- I12: sign-out, user switch, `reloadFromDisk`, restore, `forceFullResync` each clear the overlay before re-running queries.
- Same-record chains: insert, update x N, delete without awaits; a middle rollback; reordering by an async secret hash is excluded by the allowlist (no secret fields).

### 12.5 Browser latency gates (S5)

In `packages/store/benchmarks/browser/store-browser-bench.mjs` (the write and reactive gates live there; `packages/test/bench/browser` is the first-sync harness and is reused only for its long-task and heap sampling), with `instantUpdates` on:

- OPFS reactive notification p95 under 16 ms x 1.1 (the existing gate, now with the overlay).
- OPFS 1,000-subscription mutation-to-notification p95 under 16 ms x 1.1.
- New: single-insert call to subscriber callback p95 under 16 ms; and "write to settled" (commit plus SQL settle) reported, not gated.
- New: a React gate in `e2e/` with Playwright: click -> the new row is in the DOM before the next `requestAnimationFrame` (measured with `performance.now` in-page and a `PerformanceObserver('event')`), p95 under 16 ms, with a 1,000-row list.
- New: crash tests: `Page.crash` immediately after a write was shown; after reload the row exists iff the commit had landed (the harness holds the COMMIT with a gate in the worker to test both), and nothing shows "saved" in between.
- New: two-tab test: the follower writes; the leader does not show the row until the post-commit bus message; both converge.

Gate variance on shared hosts is handled as in the existing harness (10% buffer, medians of alternating runs).

## 13. Staged implementation plan

PR-sized steps; each is mergeable and behavior-neutral until S4 turns the feature on behind the flag.

| Step | Work | Acceptance |
|---|---|---|
| **S0. Measure** | Phase timers in the browser harness for a single insert (prepare, BEGIN, sequence, statements, COMMIT, notify to callback, re-run) and for the reactive and fan-out gates; confirm or correct the inferences in 1.2 (3 and 4); add a repeatable "write to callback" metric and an `instantUpdates` switch to the harness (no-op until S4). Record results in `baseline.md` and this document. | Harness prints the phase breakdown; section 1.2 updated with measured numbers. No product code change. |
| **S1. Query evaluator + differential test** | `overlay/query-eval.ts`: `isPatchable`, `matches`, `compare`; the differential suite of 12.1 against `better-sqlite3` and the WASM mock. Not wired. | 10,000 random cases, zero mismatches; refusals asserted; documented table of SQL/JS differences matches 5.4. |
| **S2. Predictor + registry** | Extract `recordForInsert` / `patchForUpdate` / tombstone from `write-ops.ts` so the write path uses them (behavior-neutral refactor, existing tests unchanged); `overlay/predict.ts`; `PendingWrites` (entries, epochs, caps, TTL, events, dependency chain); prepare-once plumbing in `execute-*.ts` behind an internal flag; the committed-row cache. | Predicted record equals the post-commit `SELECT` row (modulo metadata) for generated inserts, updates, deletes on `better-sqlite3`; registry lifecycle unit tests; write-path tests and benchmarks unchanged (no regression beyond noise). |
| **S3. Subscription patching** | `SubscriptionManager`: `base`, `baseIssuedAt`, `displayed`, `overlayChanged`, settle on SQL results, coalesced pass, 8 ms pass budget; `applyOverlay` with structural sharing; `QueryStore` untouched. | Overlay-equivalence property (12.2) on a controllable fake adapter; ordering, limit-boundary, tie, rollback, same-record chain, remote-interleave unit tests; Node gate: write-to-callback under 2 ms with a 50 ms fake commit; fan-out with 1,000 subscriptions patched in under 8 ms. |
| **S4. Wire-up and lifecycle** | `executeInsert/Update/Delete` (+ `insertMany` within caps) register, commit, roll back; M2 unknown-outcome lookup; clear points (I12); `createApp({ store: { instantUpdates } })`; `{ durable: true }`; `app.storage.writes.pending/onRollback`; `useStorageWrites`; events and DevTools rows; docs page; circuit breaker. | Fault-injection matrix (12.3) green; I2 log-identity test; every row of section 7 has a test; flag off is byte-identical in behavior (existing suites unchanged). |
| **S5. Browser gates and dogfood** | The gates and tests of 12.5; flip the three gates in `store-browser-bench.mjs` to enforced for the on-mode; update `baseline.md` and the plan's status row; enable in koraforms and koradocs canaries with `store:overlay-diverged` logged. | Reactive and fan-out p95 under 16 ms in the browser harness; React DOM gate green; crash and two-tab tests green; zero divergences across a dogfood week. |
| **S6. Extensions (separate PRs, each optional)** | (a) `app.transaction` / `app.mutation` as one atomic entry group; (b) atomic ops and counter-like merge strategies with exact epoch accounting; (c) many-to-one `include` patching; (d) cascade deletes via the relation graph; (e) pre-commit read-through for queries that cannot be patched (Option B); (f) flip the default. | Each with its own equivalence property and fault cases; (f) needs open question 1 answered. |

### S0 result

Measured 2026-10-30 with `node packages/store/benchmarks/browser/store-browser-bench.mjs` (headless Chromium 153, OPFS `opfs-sahpool`, journal mode `delete`, shared CI-class container; the whole bench run also printed the usual failing gates, unchanged by S0). The timers are internal (`@korajs/store/internal`: `PhaseTimers`, `installPhaseTimers`), cost one null check per hook when not installed, and change no ordering. Setup: 5,000 todos, one active subscription `completed = true` returning 1,000 rows, 40 samples per kind after a warm-up, p50 (p95 in brackets).

| Phase (ms) | insert | update | delete |
|---|---|---|---|
| prepare (validate, id) | 0.03 | 0.01 | 0 |
| tx open (mutex + BEGIN) | 0.25 | 0.33 | 0.40 |
| body (sequence, op build, buffered statements) | 18.4 | 21.8 | 20.5 |
| of which sequence reservation | 4.7 | 4.3 | 4.4 |
| commit (flush of buffered statements + COMMIT) | 9.2 | 10.0 | 9.9 |
| publish, notify to flush start, find affected, diff and callback | under 0.1 | under 0.1 | under 0.1 |
| subscription re-read (one SELECT of 1,000 rows) | 8.3 | 8.4 | 8.4 |
| **write to resolve** | **28.2** | **32.3** | **30.7** |
| **write to subscriber callback** | **37.0 (52.2)** | **41.6 (50.3)** | **39.0 (47.6)** |

Fan-out (1,000 subscriptions over 20 collections, 100 rows per collection, 50 affected per write, insert): write to resolve about 30 ms; the 50 re-runs sum to about 36 ms at p50 (44 ms at p95); the first callback (subscription 0, ordered first) arrives at about 31 ms, the last about 30 + 36 = 66 ms after the call. Exactly 50 re-runs are counted per write. (The first S0 publication read 96 ms p50 and 390 ms p95 for the re-runs, with about 54 counted per write; that was a warm-up bug in the harness, fixed in S1, see "S1 follow-up: the fan-out oddity".)

Findings:

1. **Notify and render machinery is negligible.** `notify` to flush start, the affected-subscription search and the diff plus callback are each microseconds. Nothing to optimize there.
2. **Single subscription: the write is about 75% of write-to-callback, the re-read about 22%.** The inference in 1.2 (3) of a 25 ms re-read was too high; a 1,000-row SELECT through the worker is about 8 ms here. The commit path is the larger cost, and within it the sequence reservation (about 4.5 ms) is notable: it is a worker round trip inside the transaction body.
3. **Fan-out: the re-runs are about half** (corrected in S1): about 36 ms of re-runs against about 30 ms for the write, 0.7 ms per sequential re-run. The inference in 1.2 (4) was right in kind and overstated in size.
4. **Neither cost can be removed alone for the single-subscription gate.** Free re-read: 28 to 32 ms remains. Free write: 8 ms remains, but a durable OPFS commit alone is about 9 ms plus the sequence reservation. Only skipping both on the path to the first callback (the overlay) can reach 16 ms.

**Does the split support proceeding to S1?** Yes. The write dominates the single-write gates and the re-runs are about half of the fan-out gate, so the overlay's design (answer the subscriber from a prediction, leave the commit and the SQL settle off the critical path) removes the right two costs and the cheaper alternatives (a faster commit alone, or the pre-commit read-through of Option B alone) cannot reach 16 ms. One caution for S3: the settle (the SQL re-read after commit) still runs and still queues behind the next write on the worker, so rapid typing will see settle latency of about 8 ms per 1,000-row query, and about 0.7 ms per additional affected subscription, off the critical path but on the worker.

The harness also accepts `--instant-updates`; it is recorded in the output and has no effect until S4.

### S1 result

Implemented 2026-10-30: `packages/store/src/overlay/query-eval.ts` (`checkPatchable`, `isPatchable`, `matches`, `compare`; internal, not exported from the package, not wired into anything) and `query-eval.test.ts`. Signature notes against 4.2: `isPatchable(descriptor, definition)` returns a boolean and `checkPatchable` returns the refusal reason; `matches(descriptor, record)` and `compare(descriptor, a, b)` need no definition because they compare the read-shape values generically (booleans as 0/1, text through the stored-text codec); a descriptor's compiled plan is cached in a `WeakMap`.

Differential suite (12.1): fast-check generates a collection (field kinds `string`, `number`, `boolean`, `enum`, `timestamp`, plus `array`, `json`, `richtext` that must be refused), up to 22 rows (NULLs, empty strings, non-BMP text, lone surrogates, NUL, U+FFFF, `-0`, 2^53 and 1e308 doubles, ties, soft-deleted rows), and 5 patchable descriptors per dataset (all seven operators including `null`, 0 to 3 sort keys in both directions, `limit`, `id`/`createdAt`/`updatedAt`, a schema field shadowing `createdAt`). Each descriptor runs through the real `buildSelectQuery` on `better-sqlite3`, and the same seeded cases run again through `SqliteWasmAdapter` over `MockWorkerBridge` (the adapter's real DDL and bind path). Asserted: same row count, SQLite's own order satisfies `compare` pairwise, tie groups equal as sets, and under `limit` the group the limit cuts through is a subset. 10,000 cases per engine per CI run; `KORA_QUERY_EVAL_CASES` and `KORA_QUERY_EVAL_SEED` raise the count (nightly) or pin a seed. 35 refusal cases assert the exact reason (and that the real builder also throws where it does), every reason is exercised, and a mutation check (reversing NULL order, dropping the codec, UTF-16 order, `$ne` including NULL, inverted booleans, ignored `desc`, NULL in ranges) is caught by the suite.

Result: **zero mismatches** across 600,000 cases per engine (six seeds) plus the 10,000-case CI run. No genuine SQLite/JS difference was found beyond the ones in the 5.4 table, so nothing was emulated; the allowlist was narrowed only by design (the refusal rows of the table). The real SQLite WASM build has no Node entry point in this repository's pinned `@sqlite.org/sqlite-wasm` (3.51.0-build1 ships no `sqlite3-node.mjs`), so the "WASM" arm is the mock bridge over `better-sqlite3`, as 12.1 specifies; the browser path stays covered by the S5 gates (risk 14).

### S1 follow-up: the fan-out oddity

The S0 fan-out numbers (about 54 re-runs per write instead of 50, a 390 ms p95) came from the harness, not from the timers or the product. `window.B.phases` warmed up with `insert` then `SubscriptionManager.flush()`, but `flush()` returns at once when a flush is already running (its pending set was already taken), so about 150 warm-up re-runs were still in flight when the timers were installed. They were counted into the first measured records (56 to 63 re-runs, 200 to 460 ms of re-read time each) and the measured writes queued behind them on the adapter mutex, decaying over the first 16 of 30 samples until each write showed exactly 50 re-runs at about 36 ms. The p50 over 30 samples landed inside the contaminated half. Fix: install the timers before the warm-up and drain each warm-up write with the same `drainRecord` the measurements use (both the single-subscription and the fan-out warm-ups). After the fix, 40 of 40 writes show 50 re-runs and about 35 ms of re-read. The `PhaseTimers` themselves needed no change.

The same `flush()` misuse is in the older gated `fanout()` harness (`await manager.flush()` between mutations), which inflates its mutation-to-notify numbers: with a 300 ms drain in place of that call, the gate's p50 was 44.5 ms and p95 67.1 ms, against the 96.2 ms p95 in `baseline.md`. That harness and `baseline.md` are left unchanged here (the gate still misses 16 ms either way); fixing it moves a gated metric and is the owner's call.

### S2 result

Stage S2 (predictor, registry, prepare-once plumbing) is implemented and not wired to anything a user can see. What exists:

- `mutations/write-shapes.ts`: `PreparedInsert`, `insertOperationData`, `recordForInsert`, `patchForUpdate`, `tombstone`, extracted from `write-ops.ts`. The write path and the predictor call the same functions (behavior-neutral; `write-ops.test.ts` and the rest of the store suite are unchanged).
- `overlay/predict.ts`: `predictInsert`, `predictUpdate`, `predictDelete` (pure; `serializeRecord` then `deserializeRecord`; the insert goes through `mergeOp` and `materialize` on a provisional operation), the 5.2 allowlist as counted miss reasons, `divergentFields`.
- `overlay/pending-writes.ts`: `PendingWrites` (entries, monotonic epoch, `retiredAt` rule of 5.5, caps of section 11, TTL to `unknown`, settle window, `rollback` with transitive dependents, committed-row LRU cache with invalidation, `store:write-pending`, `store:write-settled`, `store:overlay-diverged` events).
- `overlay/write-overlay.ts` plus `onCommitted` in `runLocalWrite` and calls in `execute-insert/update/delete.ts`: the prepared object the predictor reads is the object the transaction writes (I4); registration and the write start in one synchronous step, so overlapping writes register in transaction order. Off unless `installWriteOverlay()` is called (tests and benchmarks only); `insertMany` and `app.transaction` are not predicted.
- Tests: differential property against `better-sqlite3` in both materialization modes (200 generated insert, update-chain and delete workloads per mode, including `-0`, lone surrogates, NUL, clearing optional fields; a mutation of the predictor fails it), registry lifecycle unit tests, plumbing tests through the `Collection` API (chains, rollback with dependents, barrier failure after commit is not a rollback, base-read timeout, refused writes), a burst property with overlapping writes asserting zero `store:overlay-diverged`, and the I1 static module-graph test.

Browser benchmark, base (`main` at a4ac584) against this change (headless Chromium 153, OPFS, 2-core container; medians of runs alternated base / head, three base and four head runs, range in brackets; both with the corrected harness):

| Measurement | Base | S2 |
|---|---|---|
| OPFS insert 10,000 (one `store.transaction`) | 1,397 ms (1,300 to 1,409) | 1,391 ms (1,345 to 1,421) |
| OPFS `insertMany` 10,000 | 1,371 ms (1,351 to 1,388) | 1,301 ms (1,300 to 1,354) |
| OPFS single insert (own transaction) | 27.1 ms (25.2 to 28.2) | 26.7 ms (26.5 to 28.6) |
| OPFS query 1,000 rows WHERE | 17.9 ms (16.3 to 20.3) | 15.5 ms (15.5 to 15.9) |
| OPFS reactive notification p95 | 50.2 ms (48.7 to 50.9) | 48.9 ms (47.9 to 54.4) |
| OPFS 1,000 subscriptions: mutation to notification p95 | 58.5 ms (56.8 to 61.5) | 58.1 ms (56.5 to 71.4) |
| Single insert, write to callback p50 | 37.8 ms (35.9 to 46.4) | 40.2 ms (39.6 to 41.7) |
| Single insert, body / commit p50 | 18.8 / 9.2 ms | 20.1 / 9.8 ms |
| IndexedDB 10,000 rows, resolved write p95 | 827 ms | 833 ms |

No regression beyond noise: with the overlay off, the entry points pay one module-level null check per write, and the shared shape functions are the same code moved. Harness correction and why the fan-out baseline moved: `docs/benchmarks/baseline.md`, "Fan-out harness correction".

Deviations from the sections above, taken so S2 could be built without touching core or the subscription manager:

1. Predicted wall time is `max(Date.now(), highest createdAt/updatedAt this registry saw committed)`, not the HLC's wall time: the HLC has no non-advancing read, and adding one to `@korajs/core` would change a public class. Remote timestamps are not in the floor; a device whose HLC is ahead because of remote operations may predict a `createdAt` slightly below the committed one. Metadata only.
2. The flag is a process-wide installer (`installWriteOverlay`), like the S0 phase timers, not a store option. S4 replaces it with per-store wiring (a global cannot serve two stores).
3. `runLocalWrite` gained an optional `onCommitted` callback, called right after the transaction commits and before the operations are published. The commit signal cannot be inferred from the entry point's promise, because that also rejects when the durability barrier fails after the commit (section 7: the entry is retired then, not rolled back).
4. Commit-time verification (5.3e) compares against `WriteResult.record` reshaped by the same read-side functions (an insert returns absent optionals, a `SELECT` returns `null`) and emits `store:overlay-diverged`. Throwing in test builds and the circuit breaker (I10) are S4. The overlay event types live in `overlay/pending-writes.ts`; `KoraEvent` gets them in S4.
5. Cache invalidation (`PendingWrites.invalidate`) exists and is tested but is not yet called from `recordsChanged`/remote apply/cross-tab changes (F21): nothing reads the cache outside an installed overlay, and the hookup belongs with the `SubscriptionManager` changes in S3.
6. An explicit `.merge('lww')` field is treated as the default strategy (predicted); every other strategy is a miss.
7. A pending update that rolls back removes the not-yet-committed entries derived from it (5.6). One that was derived from a transient failure may still commit; its commit then finds no entry and is a no-op, and its result reaches the UI through the normal notify and re-run.

### S3 result

`SubscriptionManager` patches a subscription's displayed rows from its SQL base plus the pending entries, behind the internal install flag (off by default; with no overlay installed the manager behaves as before and the existing suites are unchanged). `overlay/apply.ts` holds the patch rules of 5.4 with structural sharing (unchanged rows keep identity; the base array is returned as is when nothing changes). Display is always recomputed from `base` and the entries applying under the epoch rule (`retiredAt === null || retiredAt > issuedAt`), never mutated incrementally. A coalesced microtask pass runs on registry changes with an 8 ms budget; subscriptions it does not reach fall back to the commit path. `QueryStore` is untouched. Cache invalidation (F21) is now hooked into `recordsChanged` and the peer-invalidation path.

Tests: 40 unit tests for `applyOverlay` (ordering, NULL order, no-orderBy append, limit boundary, ties, rollback by recomputation, same-record chains, structural sharing, idempotence), 26 subscription tests (controllable reads, coalescing, settle, the F6 window, rollback, remote interleave, F21, budget, detach, flag-off), 4 end-to-end tests through the Collection API on a gated adapter, and the overlay-equivalence property (12.2) on a real `Store` pair (gated device plus an ungated peer supplying real remote operations) with commits delayed, reordered, failed and ambiguous, in fold and legacy modes. After every step displayed equals an independent model of base plus entries; after settle it equals a fresh SELECT modulo `createdAt`/`updatedAt`. 2,000 runs pass; a 500-run fold report exercised soundness checks on 107 runs, skips on 222, failed commits on 78 and remote interleaves on 306. Nothing sleeps: gates and `setImmediate` turns only.

Node gates (`src/benchmarks/overlay-patching-gates.test.ts`, benchmark config, commit held at a gate for the whole window):

| Gate | Limit | Measured |
|---|---|---|
| Write to callback, 1,000-row result, commit pending | 2 ms | p50 0.14 ms, p95 0.25 ms |
| Same, ordered by `createdAt` | 2 ms | p50 0.13 ms, p95 0.15 ms |
| 1 write patched into 1,000 subscriptions x 100 rows, write to last callback | 8 ms | p50 4.2 ms, p95 5.1 to 6.9 ms (pass alone p50 about 4 ms) |

The fan-out gate is closer to its limit than the design's 1 to 3 ms estimate: the pass costs about 4 ms on cache-cold id scans. It passed in every run, with no budget skips, but p95 can approach the 8 ms budget on a slow runner (advisory on shared runners). A per-subscription id index would cut it; not done, since it is an optimization the evidence does not yet demand.

Deviations and findings:

1. The gate does not use a 50 ms fake commit. The commit is held at a gate for the whole measurement, which proves the callback arrives before any commit work for any commit duration and removes timing from the test.
2. The browser bench could not be run in this environment (esbuild failure starting the harness, no browser). With the overlay off the new code is one registry null check per notification, so no change beyond noise is expected; S5 will measure it in a browser.
3. `PendingEntry` gained `previous` (old values of the patched fields) and `operationIds`, and the registry gained `onChange`, `ownsOperation` and `hasSettling`. `previous` resolves the F21 versus 5.4 conflict: a row enters a page only if it did not already match before the write or the page is not full, so a cached stale row cannot be wrongly admitted.
4. Rows ordered by `createdAt`/`updatedAt` may sit in a different position within the same millisecond until settle, because predicted times are approximate (S2 deviation 1). Settle corrects it.
5. Committed entries in collections nobody patches are swept by a forced flush (lagging sweep) so the registry cannot leak.
6. `installWriteOverlay` is still process-wide; the equivalence test uninstalls it around peer writes. S4 replaces it with per-store wiring.
7. S2 deviation 5 (F21 hookup) is closed here.

### S4 result

The overlay is wired per store. `new Store({ instantUpdates })` (and `createApp({ store: { instantUpdates } })`, which the IndexedDB fallback store also receives) builds one `OverlayController` per store: the `PendingWrites` registry, its events, the circuit breaker, the M2 unknown-outcome lookup, the TTL sweep and the clear points. The process-wide `installWriteOverlay` is gone from the store paths. Default is off; with the flag off no controller exists and the write path is the same code as before (every existing suite is unchanged). `execute-insert/update/delete` (and `insertMany` within the caps) register an entry before the transaction, commit it on COMMIT and roll it back on a failed body. `{ durable: true }` on any write skips the prediction for that write only. `app.storage.writes.pending` and `onRollback` exist but are internal (decision 6). Module-graph test (I1): nothing on the write path or in `@korajs/sync` imports `overlay/*` at runtime.

Failure handling. A COMMIT that is rejected after the body finished runs M2: `lookupCommit` reads `_kora_ops_<collection>` by the content-addressed operation id and answers committed (publish once, keep the entry as committed), absent (roll back) or unknown (entry stays shown until a later read decides, bounded by the TTL sweep). Clear points (I12): close/dispose, `rebindToNode`, a different user binding, `clearSignedInUser`, backup import, `reloadFromDisk`, `requestSnapshotResync`, and a delivery watermark reset to 0.

Self-check. Every settle compares the SQL base with what the last crossed entry per record predicted. A difference emits `store:overlay-diverged` (field names only); three for one collection emit `store:overlay-disabled` and stop prediction for it for the session; with `NODE_ENV=test` the divergence also throws `OverlayDivergedError` (microtask throw, so it cannot be swallowed). The check is deliberately conservative (see deviation 7). New events: `store:write-pending`, `store:write-settled`, `store:overlay-diverged`, `store:overlay-disabled`, `query:patched`; DevTools lists them (category and description rows, filter tests, `docs/api/devtools.md`).

Tests.

| Area | Where | Count |
|---|---|---|
| Fault-injection matrix (12.3): body failure per statement, COMMIT rejected with the operation present, absent and unreadable, close/reopen mid-write, TTL expiry of unknown entries, circuit breaker, strict mode, every clear point, durable option, caps, flag off | `overlay/overlay-faults.test.ts` | 53 |
| I2 log identity: the same workload with instant on and off under a fake clock produces identical operation logs (ids, order, content) and identical rows | `overlay/overlay-log-identity.test.ts` | 1 workload set |
| Store wiring, settle, equivalence property (now through `new Store({ instantUpdates })`, counting `store:overlay-diverged` as 0 on clean workloads) | `overlay-store.test.ts`, `overlay-equivalence.test.ts`, `src/benchmarks/overlay-patching-gates.test.ts` | migrated |
| Module graph (I1) | `overlay/module-graph.test.ts` | updated |
| App level, including the IndexedDB fallback | `kora/src/instant-updates.test.ts` | 5 |
| Type test for `{ durable }` | `kora/tests/typecheck/typed-api.test-d.ts` | 1 |
| Core fold with Object.prototype-named keys | `packages/core/src/fold/fold-prototype-keys.test.ts` | 6 |

Every row of section 7 has a test except the constraint and schema-transform rows, which are not applicable on the device (cross-record constraints are decided by the server; transforms run at fold time on the SQL result). The "tab killed mid-write" row had no test in S4 (the registry dies with the tab, so the property is on the database, not the registry); S5 added them (`overlay/overlay-crash.test.ts`, see "S5 result"). Nothing sleeps: gates, injected `now`/`schedule` and `setImmediate` turns only.

Browser bench (`packages/store/benchmarks/browser/store-browser-bench.mjs`, Playwright Chromium, OPFS, 5,000 rows, one subscription over 1,000 rows, n=40):

| Write to first callback | Flag off | Flag on |
|---|---|---|
| insert | p50 33.8 ms, p95 44.1 ms | p50 0.12 ms, p95 0.31 ms |
| update | p50 33.8 ms, p95 42.6 ms | p50 1.2 ms, p95 2.0 ms |
| delete | p50 33.7 ms, p95 39.0 ms | p50 1.1 ms, p95 2.1 ms |
| insert, 50 subscriptions re-reading | p50 25.7 ms, p95 28.4 ms | p50 0.09 ms, p95 0.11 ms |

`write->resolve` is unchanged (25 to 29 ms both ways), as intended: the promise resolves at the same point. The flag-off run passes and fails the same gates as the pre-change baseline (three pre-existing failures: reactive notification p95 about 45 ms, 1,000-subscription mutation to notify p95 about 55 ms, IndexedDB resolved write p95 about 750 ms; all three measure the committed path, which the flag does not change). Those gates deliberately stay on the default configuration.

Harness findings fixed in this stage (Obed's note on misleading metrics):

1. S3 deviation 2 ("esbuild failure starting the harness") was not an esbuild problem. The harness builds and runs; what failed was Playwright looking for its own pinned Chromium revision when `PW_CHROMIUM_PATH` is unset and only a different revision is installed. The bench now discovers an installed Chromium itself (`findChromium()`).
2. The write-to-callback metric ignored any callback before the commit publish (`PhaseTimers.noteCallback` required `publishedAt`), and fell back to 0 when no callback was recorded. With the overlay on, that timed the post-commit re-run (first on-run: insert 27.9 ms, update 38.9 ms) and printed delete as 0 µs, so the feature looked like it did nothing. The first callback is now timed whenever it happens, and writes with no callback are left out of the sample instead of counted as 0. With the flag off the numbers are the same as before, because no callback precedes the publish.

Deviations and findings:

1. `useStorageWrites` is deferred. Decision 6 keeps `pending` and `onRollback` internal, and sections 9.1 and 10 of this document still describe them as public; decision 6 wins, and those sections should be read as the later-stage design.
2. An entry whose outcome stayed unknown until the TTL has no witness operation id; it is decided when its transaction settles (committed or rolled back), not by lookup.
3. The M2 lookup is gated on a tracker being present, which now includes the miss trackers for update and delete (writes the predictor declined still need their window guarded).
4. In the deferred "unknown, then found committed" path the operation is not republished as `operation:created`; only the immediate-lookup path publishes. The operation is in the log either way, and sync reads the log.
5. Rollback after a rejected COMMIT becomes visible only after the M2 lookup, which queues behind in-flight transactions on the adapter mutex.
6. Unpredicted writes now hold their record out of the base (`PendingWrites.holdUnpredicted`): a delete predicted from a stale `tags` value after an unpredicted write was found by the I2 test. Earlier-stage correction.
7. Settle check conservatism: it does not judge limit-page membership or time-sensitive queries, can collide within the same millisecond, and races with remote commits it did not count (the foreign-count guard skips those). It under-reports rather than raising false alarms.
8. The watermark-0 clear is a heuristic (a watermark that goes back to 0 means a resync from scratch).
9. `StorageAdapter` implementations may expose `refusesWrites()` (SQLite WASM does) so a durability-lost store never shows a prediction for a write it will refuse.
10. System writes (internal tables) are excluded from prediction.
11. Transactions (S6a) and cascade deletes (S6d) are still not predicted; they take the commit path.
12. `@korajs/core` fold fix found on the way: json or object values with keys named like `Object.prototype` members (`toString`, `constructor`) made `insert` throw because the fold kept keys in plain objects with prototype lookups. Own-property helpers fix it (`__proto__` stays refused by validation). It also explained a rare `predict.test.ts` flake.

### S5 result

The kora-repo half of S5: the browser gates are enforced for the instant-updates path, the React DOM gate exists, and the crash and two-tab tests of sections 7 and 8 exist. Enabling the flag in koraforms and koradocs and the dogfood week (zero `store:overlay-diverged`) are outside this repository and not done here.

**Harness and gates** (`packages/store/benchmarks/browser/`). The bench now runs the scenarios with the flag on and off. Five gates are enforced, each at one frame with the 10% buffer (16 ms x 1.1 = 17.6 ms), and each also fails the run if the overlay was not active (`store.getOverlayController() === null`), so a harness that built a flag-off store cannot pass by accident:

1. OPFS reactive notification p95 (10,000 rows, a 1,000-row live query).
2. OPFS 1,000-subscription mutation to notification p95.
3. OPFS single insert, call to subscriber callback p95 (the new gate of 12.5).
4. IndexedDB fallback insert, call to subscriber callback p95 at 10,000 rows (replaces the old IndexedDB resolved-write gate as the on-mode gate for the fallback, see below).
5. React click to DOM p95 through `@korajs/react` (`useQuery`, `useMutation`, a 1,000-row list) on OPFS.

The same metrics on the default (committed) path are printed as `INFO` lines against their old limits and no longer fail the run. That is a deliberate change to three gates that were red by construction: with the flag off a subscriber cannot hear about a write before its durable commit (about 30 ms on OPFS, about 850 ms of snapshot barrier on the IndexedDB fallback at 10,000 rows), so a 16 ms or 250 ms limit there could only be met by changing the commit path, which the flag deliberately leaves alone (S4 finding). The old IndexedDB "resolved write p95 under 250 ms" gate measured the durability barrier, not a UI latency, and `instantUpdates` must not move it (the promise resolves at the barrier, N3); it stays visible as an `INFO` line and, with the flag on, as `write resolves (barrier) p95`. Every other gate (bulk inserts, the 1,000-row query, the 1,000-subscription check per mutation) is unchanged and still fails the run. If the committed-path numbers should stay blocking, move them from `COMMITTED_PATH_INFO` back into `GATES` in `store-browser-bench.mjs`; the run will then be red until the commit path itself gets faster.

**Metric fixes found on the way** (Obed's note on misleading gates). The reactive and fan-out harnesses recorded the latest callback time of a subscription. With the overlay on, a write produces two callbacks (the prediction at once, the settled row after the commit and re-read), and the late one could land during the next `await` and overwrite the first, which inflated the on-mode latency to the settle time. Both now record the first callback after the call of the write and drain the write completely (commit, re-run, settle callback) before the next one starts; the flag-off figures are unchanged by this (no callback precedes the commit there). The harness also tallies the writes the overlay declined (`store:write-pending` with `predicted: false`) per kind and reason, so a slow sample can be attributed.

**Measured** (headless Chromium 153, OPFS `opfs-sahpool`, 2-core container; three full runs, median with the range of the three in brackets; flag on and flag off in the same run):

| Measurement | Flag off (committed path) | Flag on |
|---|---|---|
| Reactive notification p95 (gate 1) | 49.2 ms (49.0 to 50.3) | **0.21 ms** (0.19 to 0.25) |
| Reactive notification p50 | 37.9 ms (35.3 to 40.1) | 0.14 ms (0.13 to 0.17) |
| 1,000 subscriptions, mutation to notification p95 (gate 2) | 57.6 ms (52.4 to 70.6) | **0.22 ms** (0.21 to 0.50) |
| 1,000 subscriptions, mutation to notification p50 | 39.5 ms (37.3 to 39.9) | 0.17 ms (0.16 to 0.18) |
| 1,000 subscriptions, call to all 50 affected settled, p50 | 71.8 ms (S2 figure) | 65.4 ms (60.3 to 68.6) |
| Single insert, call to callback p95 (gate 3) | 53.4 ms (51.8 to 69.2) | **0.17 ms** (0.14 to 0.19) |
| Single insert, call to callback p50 | 37.4 ms (36.6 to 37.7) | 0.12 ms (0.11 to 0.13) |
| Single insert, call to resolve p50 | 28.6 ms (27.8 to 28.6) | 25.1 ms (24.3 to 26.3) |
| Update, call to callback p50 / p95 | 39.8 / 51.7 ms | 1.2 / 2.2 ms |
| Delete, call to callback p50 / p95 | 36.8 / 48.1 ms | 1.2 / 2.5 ms (one run: p95 45.6 ms, see finding 1) |
| IndexedDB fallback, 10,000 rows, call to callback p95 (gate 4) | not measured | **0.77 ms** (0.72 to 0.78) |
| IndexedDB fallback, 10,000 rows, call to resolve p95 (the barrier) | 833 ms (827 to 859) | 843 ms (816 to 888) |
| React, 1,000-row list, click to DOM p95 (gate 5) | 58.3 ms (57.5 to 63.9) | **9.8 ms** (9.0 to 10.1) |
| React, click to DOM p50 | 44.6 ms (43.3 to 52.0) | 6.1 ms (6.0 to 6.2) |
| React, click to next animation frame p95 | 62.8 ms (58.5 to 64.6) | 10.7 ms (10.4 to 10.8) |

All five enforced gates passed in all three runs. The write's own resolution is unchanged by the flag (resolve p50 25 to 29 ms, the IndexedDB barrier about 830 ms), as intended: only what the user sees moves.

The fan-out gate is not marginal in the browser (0.2 ms against 17.6 ms; the patch pass touches only the 50 subscriptions on the written collection here), so the per-subscription id index that S3 suggested was not built. The S3 Node gate (1,000 subscriptions all patched, about 4 ms) is the one that would profit from it; it is unchanged.

The React figure is the one with the least margin (9.8 ms p95 against 17.6): about 6 ms of its median is React rendering and reconciling a 1,000-row list after the store has already published the patch (the store side is 0.1 ms), so it scales with the list, not with Kora. The click is dispatched with `button.click()` so React's event path and `useMutation`'s state updates are included; the DOM time is read at the first line of the `MutationObserver` callback that sees the new `<li>`, and the frame time at the next `requestAnimationFrame`.

**Tests** (nothing sleeps: held COMMITs, latches and counted event-loop turns).

| Area | Where | Count |
|---|---|---|
| Crash: killed with the COMMIT held (shown while alive, absent after reopen, no phantom row, no operation, no sequence gap on the next write), killed before BEGIN, killed after the COMMIT landed and before the SQL settle (present exactly once), flag on and off leave the same durable state | `packages/store/src/overlay/overlay-crash.test.ts` | 4 |
| Two tabs (real leader election over mock Web Locks, real follower RPC, real `wireLocalOperationBus`): the other tab never sees an uncommitted write and nothing is announced on the bus before the commit, in both directions (follower writes, leader writes); a write failing at COMMIT is taken back in the writing tab and never reaches the other; concurrent writes in both tabs converge | `kora/src/instant-updates-two-tabs.test.ts` | 5 |
| React DOM against a real store with the commit held: the row is in the DOM before the commit and keeps its node after it, the same write with the flag off is not, a failed commit takes the row out again, an update and a delete leave the list before their commits | `packages/react/tests/integration/instant-updates-dom.test.ts` | 4 |

Findings and deviations:

1. **Updates and deletes of a record the tab has not written can miss.** The prediction needs the record's current values; when neither a pending write nor the committed-row cache knows it, the store reads it, and a read slower than 4 ms (`BASE_READ_TIMEOUT_MS`) gives up and the write takes the committed path (`update:base-timeout`, `delete:base-timeout`). In the three runs 7 of the 240 updates and deletes were declined (1, 6 and 0), which shows as a delete p95 of 45.6 ms in one run while p50 stays at 1.2 ms. Inserts never need a base and never missed. This is first-touch behavior of the design (5.6), and in a real app the record being edited is almost always already on screen, so the natural fix is to seed the committed-row cache from the rows a subscription has just delivered (with the F21 invalidation it already has). Not done here; the update and delete figures are reported, not gated, for this reason. Open question for Obed.
2. **The React gate lives in the store bench, not in `e2e/`.** 12.5 asked for a Playwright test in `e2e/`. The store bench already builds the real store, a real OPFS worker and a Chromium launcher, and a React page there needed only a bundle of `@korajs/react` (the bench needs `pnpm --filter @korajs/react build`), so the gate sits beside the others and shares their statistics. The jsdom test above covers the "before the commit, keeps its node after" behavior; the browser run covers the 16 ms.
3. **No `Page.crash`.** The crash tests kill the storage worker (the mock worker's `terminate` semantics: the open transaction rolls back, the connection answers nothing more) and reopen a store on the surviving database. That exercises the same property in Node without timers. It does not test OPFS recovery of a half-written journal after a real process kill; that is SQLite's and the browser's job, not the overlay's. The IndexedDB fallback was not crash-tested here: a write committed in memory and not yet through the barrier is lost by design (5.1), independent of the overlay.
4. **The two-tab test is in `kora/src/`** because the cross-tab bus (`wireLocalOperationBus`) lives in the `korajs` package and the store package may not import it. It uses the store's mock browser fixtures (`packages/store/tests/fixtures/browser-sim.ts`) and the real store, adapter and bus.
5. **A follower does not hear a leader's commit while its own transaction is open.** In the concurrent-writes test the follower keeps showing only its own prediction after the leader's commit is announced, because the re-read that would show the leader's row queues behind the follower's open transaction on the one worker. It converges when that transaction commits. This is existing read-after-write queueing (5.8), not an overlay behavior, and is asserted in the test so a change to it is noticed.
6. **`--instant-updates` is gone.** The bench always runs both modes; the flag only switched one scenario.

### S5 follow-up: seeding the row cache from subscriptions

S5 found that an update or delete of a record this tab has not itself written needs one base-row read (5.6), and that when the read waits longer than 4 ms (queued behind another transaction) the write is declined: 7 of 240 updates and deletes in one browser run were not instant, one delete with a p95 of 45.6 ms. Inserts never miss. The common case is a user editing a row they are looking at, and a subscription has already read that row.

Change. The committed-row cache (512 rows, LRU) is now also filled from the SQL results of patchable subscriptions (`PendingWrites.seedFromRead`, called from `SubscriptionManager.settleRun`). Optimistic inserts needed no change: an insert's entry is the base while it is pending and its committed row fills the cache at commit. A record found in the cache, or in a pending entry, needs no read.

Why a seeded row is never staler than the registry's own knowledge. A result is seeded only if the collection's `seedStamp` is unchanged between the moment the read was issued and the moment it was delivered. The stamp is the sum of three counters that only grow: foreign changes to the collection (`invalidate` from a remote apply, a cross-tab change or any untracked `recordsChanged`, and `holdUnpredicted`), commits of the registry's own predicted writes, and clears (user switch, restore, resync). So any change the registry heard of after the read began suppresses the whole seed. Changes it hears of after delivery drop the seeded rows through the existing F21 invalidation. Within an accepted result a record is skipped when it already has a cached row (the cache is exact), a pending or settling entry (the entry is the base), or an unpredicted write in flight. Seeds are copies, at most `rowCacheSize` per result, taken from the top of the result and inserted so the first rows are the most recently used. Only patchable subscriptions seed (no `include`), so the rows have the shape a base read returns. A commit that reports no row (an outcome decided later by lookup) now also drops the cached row, because the seeded row would be older than the database.

Tests. `overlay/overlay-seed.test.ts`: registry rules (stamp mismatch for invalidate, record invalidate, unpredicted hold, own commit, clear; other collections do not spoil a read; entry, held and cached rows are skipped; cap and LRU order; copies; zero-size cache), the store path (an update and a delete of a displayed row make zero base reads and the prediction equals the stored row modulo `createdAt` and `updatedAt`; a remote change after the seed forces a fresh read and is not predicted from the stale row; a held re-run overtaken by a registry change seeds nothing; a pending chain still wins over the seed; the cap holds for a 10-row result with a cache of 4), flag off (no controller, no extra statements), and a property over random local updates and deletes interleaved with remote updates and deletes, with and without settling between steps, comparing each prediction with the post-commit `SELECT`. The stamp check was verified by removing it (six tests fail). The equivalence property (1,500 runs per mode) passes unchanged. Nothing sleeps.

Browser bench (Chromium, OPFS, 5,000 rows, a 1,000-row subscription, n=40 per kind, `--instant-updates`, three runs each):

| | Before (3 runs) | After (3 runs) |
|---|---|---|
| declined updates / deletes (of 240) | 1 (all in one run: a delete) | 0 |
| update write to callback p50 | 1.1 to 1.2 ms | 0.15 to 0.18 ms |
| update write to callback p95 | 1.6 to 2.0 ms | 1.4 to 1.5 ms |
| delete write to callback p50 | 1.1 to 1.2 ms | 0.09 to 0.13 ms |
| delete write to callback p95 | 1.7 to 2.1 ms | 1.3 to 1.6 ms |

The environment that produced the S5 figure (7 of 240) was noisier than this one; the declines are timing-dependent by nature (a read queued behind a commit), which is why the fix removes the read instead of raising the budget. The p50 drop is the read itself no longer happening on every update and delete. The harness now prints the number of declined writes per kind, and with `--instant-updates` it enforces write-to-callback p95 under 16 ms for insert, update and delete (these were report-only before). The default configuration keeps its three known failures, since it commits before it notifies.

Residual risks. A row outside the first 512 of a larger result, or one the user reaches after the cache turned over, still takes the read and can still be declined. A seeded copy is shallow: nested array or object values are shared with the objects handed to subscribers, as they already are for predicted records.

### S6a design: transactions as one entry group

Written before the S6a code (decision 7, revised: S6a ships in beta.15). Scope: `app.transaction`, `app.mutation` and the store-level `store.transaction` they both call. `insertMany` already registers its records together (`addMany`) and is left as it is; atomic ops, merge strategies, cascades and `include` stay excluded exactly as for single writes (S6b to S6d).

**Where the group is predicted.** A transaction buffers intents while its callback runs (`TransactionContext`: inserts are prepared, updates validated, nothing is written) and writes them all at `commit()`, inside one storage transaction, through the single local write path. The group is therefore predicted at `commit()`, after the callback has returned and the buffer is sealed (`commit()` already refuses further writes from that point), and never while the callback runs. Nothing of a transaction is shown before its callback has finished, and a callback that throws registers nothing.

**Group lifecycle.**

1. The callback runs exactly as today. Reads inside it (`tx.<collection>.findById`, and the reads `update` and `delete` make) see the committed row with the transaction's own buffered writes applied (`getEffectiveRecord`), and never the overlay (I1).
2. `commit()` seals the buffer, then, only on a store with the overlay:
   - a. gates: every collection the group touches passes the single-write gate (`durable` is not offered for transactions, the write gate, the durability-lost state, the circuit breaker), and the group has at most `maxRecordsPerWrite` writes. Otherwise the group is a miss.
   - b. bases: an update or delete of a record the group has not written earlier takes its base from the registry (pending chain, settling entry, committed-row cache), else from the committed row the callback itself read (`update` and `delete` read it inside the callback, before the transaction's own writes are applied), else from one base read with the 4 ms budget (5.6), all such reads in parallel. The callback's read is used only if it is still as fresh as everything the registry knows: the registry's seed stamp for the collection (foreign changes, its own commits, clears) taken before the read was issued must still hold, and no unpredicted write may hold the record, the rule the subscription seeding already uses. This is the only asynchronous step, and it is usually empty.
   - c. predict, synchronously, every buffered write in buffer order against a group-local view: a write of a record the group already wrote derives from the group's own earlier prediction (insert then update, update then update, insert then delete); any other record derives from the registry or the read of step b. One declined write (any 5.2 reason, a missing base, a timed-out read) makes the whole group a miss: no entry is created for any of its writes, the miss is reported once, and the records it updates or deletes are held (`holdUnpredicted`) until it settles, as for a single unpredicted write.
   - d. register all entries with one `addGroup` call, which checks the pending, byte and record caps for the whole group: all entries or none. One registry change, so one coalesced patch pass shows all of them.
   - e. start the storage transaction in the same synchronous step as d, so registration order is transaction order (as for single writes).
3. Display. Each subscription applies a group's entries for its collection together or not at all: when the patcher would skip one member (a page removal, a tie, an unordered entry, a record poisoned by an earlier skip), it skips every member of the group in that subscription and poisons their records, so later writes of those records are skipped too. Groups can cascade (a group skipped because a record of an excluded group is poisoned); the recomputation repeats until no new group is excluded.
4. Outcome. Members share one state at every moment:
   - committed: every entry retires with ONE epoch value, the committed records replace the predictions, each entry is verified against its own `WriteResult` (5.3e), one `store:write-settled committed` with every operation id;
   - failed (refused before BEGIN, any statement of any write, COMMIT not landed): the group and everything derived from any member is removed at once;
   - commit answer lost (M2): the witness is the first operation of the transaction (atomic, so its presence proves every write landed). Found: committed, published once, the promise resolves. Absent: rolled back. Unreadable: the whole group becomes `unknown` and stays shown until a later read decides, as one group;
   - TTL: members are registered at the same instant and expire together; `markUnknown` on any member marks the group;
   - durability barrier fails after COMMIT: already committed; not a rollback (section 7).
5. Settle: unchanged per entry. Members share `retiredAt`, so one SQL read either contains the whole group or none of it.

**Invariants.**

- **T1. All or nothing at registration.** A group is registered in full or not at all. No code path creates a subset of a group's entries (caps, misses and refused base reads are checked before any entry exists).
- **T2. Shared fate.** `commit`, `markUnknown` and `rollback` of any member act on every member; a group is never part committed, part pending.
- **T3. Atomic per subscription.** At every instant, a subscription shows either all of a group's entries for its collection or none (modulo entries a later write of the same record supersedes). Two subscriptions are independent, as for single writes (5.4).
- **T4. Dependent closure.** A rollback removes the group, every not-committed entry derived (transitively) from any member, and every group that contains such an entry.
- **T5. Same operations.** The buffer `commit()` writes is the buffer the predictor read (sealed first); the overlay reads nothing back. I1 and I2 hold for transactions: the log is identical with the flag on and off.
- **T6. Reads inside the callback are unchanged.**
- **T7. One event per group.** `store:write-pending` and `store:write-settled` are emitted once per group, with `kind: 'transaction'`, `writeId` the group's id, `recordIds` every record, `collection` the first collection and `collections` all of them. A declined group reports one `store:write-pending` with `predicted: false` and the reason.

**Failure rows for groups** (section 7, extended).

| Event | Overlay | What the UI sees | Promise |
|---|---|---|---|
| Callback throws, or a write is refused at its call (validation, `RecordNotFoundError`, state machine) | nothing registered | nothing ever shown | rejects |
| A collection of the group is gated (write gate, durability lost, breaker), a write is declined, a base read times out, a cap would be exceeded | no entry; one counted miss; updated and deleted records held | the group appears at commit, as today | as today |
| Refused before BEGIN, or a statement of any write fails, or COMMIT not landed | group and dependents removed | every row of the group disappears (old values return) in one pass | rejects |
| COMMIT landed, answer lost (M2) | lookup by the transaction's first operation: committed | stays, then committed rows | resolves; operations published once |
| COMMIT lost, log unreadable | whole group `unknown` | stays until a later read decides | rejects |
| Group without any operation (every write was a no-op) and COMMIT rejected | rolled back (nothing could have changed) | old values | rejects |
| Never settles | TTL: whole group `unknown` | stays | rejects when the adapter's timeout fires |
| Barrier fails after COMMIT | committed | stays | rejects `WriteNotDurableError` |
| An earlier single write the group derived from rolls back | the group is removed with it; if its transaction still commits, the commit finds no entries (no-op) and the SQL settle shows it | the group's rows vanish, then appear at commit | as its transaction decides |

**Red team** (each answered in the design or accepted, with where).

1. *Half a group on screen across lists.* One list shows the group's part in collection A while another list (a full page, a tie, the 8 ms budget) waits for the commit. Accepted: T3 is per subscription, as every patch decision is (5.4); the settle converges both.
2. *Half a group inside one list.* A group that updates A out of a full page (not patchable) and inserts B into it would show B without A leaving. Answered by the group skip in step 3.
3. *Writes added after the callback returned* (a leaked promise calling `tx.insert`). `commit()` seals the buffer before predicting (step 2), so the prediction and the write see the same list (T5).
4. *A stale base.* The callback read a row, a remote change landed, the group predicts from the registry's view. The transaction computes from the committed row; the settle corrects a transient wrong value (risk 9, unchanged).
5. *A group derived from a pending single write that rolls back.* T4 removes the whole group, never part of it; if its transaction commits anyway, the normal notify and re-run show it (S2 deviation 7, same rule).
6. *Unknown without a witness.* A group whose writes produced no operation has nothing to look up; nothing it wrote can have changed the database, so it is rolled back rather than left `unknown` forever.
7. *Same-millisecond `createdAt`.* Inserts of one group get one predicted wall time, and the committed rows share a millisecond too: a query ordered by `createdAt` alone ties, and the group is skipped in that list (waits for the commit). Order by `createdAt` and `id` for a total order.
8. *Base reads add latency.* The callback has already read every record it updates or deletes, so the group reuses those rows (step 2b) instead of reading again. Only when something changed the collection after that read (the stamp moved) does a base read run, and with a busy worker it can time out and make the whole group wait for the commit. Inserts never read.
9. *Event consumers.* A `kind` switch over `insert | update | delete` meets `transaction`: an additive union member, called out in the changeset.
10. *Cascades.* A delete with an enforced `onDelete` in the group declines the whole group (`cascade-target`, S6d).
11. *Flag off.* `commit()` without the overlay runs the same statements in the same order and keeps its error handling (no M2 lookup); the existing transaction suites are unchanged.

### S6a result

`store.transaction` (what `app.transaction` and `app.mutation` call) is predicted as one entry group on a store built with `instantUpdates`, as designed in "S6a design". With the flag off nothing changes: the commit runs the same statements with the same error handling, and the existing transaction suites are unchanged.

What exists:

- `PendingWrites`: `groupId` on every entry; `addGroup` (all members or none, caps checked for the whole group, one `store:write-pending` with `kind: 'transaction'`, one change notification); `commitGroup` (one epoch for every member, one `store:write-settled`); `rollback`, `markUnknown` and `commit` act on the whole group, and the rollback closure takes dependents of any member and every group holding one, to a fixed point (T2, T4); `noteGroupMiss`, `groupMembers`, `isHeld`.
- `applyOverlay`: a member that cannot be placed in a result (tie, page removal, unordered entry, poisoned record) excludes its whole group from that result, with its records poisoned; the passes repeat until no further group is excluded (T3). New skip reason `group`.
- `write-overlay.ts`: `readGroupBasesIfNeeded` and `trackGroup` (gates for every collection of the group, the record cap, prediction in buffer order against the group's own earlier writes, one miss for the whole group with holds on its updated and deleted records), and the group tracker (commit, rollback, unknown as a group; an unknown outcome without a witness rolls back, since a transaction without an operation changed nothing).
- `TransactionContext.commit(options)`: seals the buffer, calls `prepare` (the overlay's registration) and starts the storage transaction in one synchronous step after it, and, only with a tracker, runs M2 on a rejection after the body finished (witness: the first operation). The callback's committed-row reads are recorded with a freshness token when the store has the overlay (`readToken`), so the group reuses them as bases instead of reading again (see deviation 1).
- Events: `KoraEvent` `store:write-pending.kind` gains `'transaction'`, and both overlay write events gain an optional `collections`. DevTools shows one row per transaction. Guide, DevTools API page and a changeset updated.

Tests (no real-time sleeps: gates, latches, `setImmediate` turns; the one base-read budget in a test is 0 ms):

| Area | Where | Count |
|---|---|---|
| Registry groups: all-or-nothing caps (records, pending headroom, bytes), one event per group, one epoch, member commit commits the group, rollback closure across groups and singles, committed groups untouched, unknown and TTL per group, base lookup | `overlay/pending-writes.test.ts` | 12 |
| Patcher: group applied whole or skipped whole (tie, page removal), poisoning after a skipped group, cascading exclusion, a 500-run property | `overlay/apply.test.ts` | 6 |
| Store level with held commits: two collections in one pass before the commit, one-pass rollback, reads inside the callback unchanged, insert/update/delete of one record inside a group, a declined write (atomic op) and a cascade decline the group, record cap and pending headroom, callback reads reused as bases (zero extra reads), a change after the callback's read forces a read (declined on timeout), T4 in both directions (a group derived from a failing single write, a single write derived from a failing group), flag off | `overlay/overlay-transactions.test.ts` | 13 |
| Fault-injection matrix for groups (below) | `overlay/overlay-faults.test.ts` | 12 |
| Equivalence property with transactions | `overlay/overlay-equivalence.test.ts` | 2 properties |
| I2 log identity with a named mutation and a bulk insert in transactions | `overlay/overlay-log-identity.test.ts` | extended |
| `app.mutation` through `createApp` | `kora/src/instant-updates.test.ts` | 1 |
| DevTools rows | `packages/devtools/src/ui/panel-state.test.ts` | 1 |

**Equivalence property.** The S3 harness (real `Store` on a gated better-sqlite3 adapter, a peer store supplying real remote operations, commits delayed, reordered behind the mutex, failed and marked unknown) gained a transaction step: 1 to 4 writes (insert, update and delete of known records, update and delete of the group's own insert, and an atomic increment that declines the whole group), mixed with single writes, in fold and legacy modes. The reference model is group-aware (a skipped member excludes its group, repeated to a fixed point). Asserted after every step: displayed equals the model of base plus entries, and the callback received exactly that; after the drain: displayed equals a fresh SELECT for every subscription and the registry is empty; for clean runs (every write predicted and every transaction announced, no failure, no remote): what was shown before the commits equals the stored rows modulo `createdAt`/`updatedAt`, with zero divergences. Coverage guards fail the test if groups were not predicted, declined and rolled back. Default 150 runs per mode in CI (raised from 60, about 2 s per mode). Result: 2,000 runs per mode passed twice, once before and once after deviation 1 (fold: 1,044 groups predicted, 279 declined, 83 runs with a group rollback, 328 soundness-checked runs; legacy similar).

**Fault-injection matrix for groups**, one transaction that inserts, updates and deletes (one write of each kind): the group predicted as one (one pending event, all writes shown at once); refused before BEGIN; a failure after every statement of every write of the group (each a single clean rollback, nothing published, no operation stored, only the before or the whole-group display ever delivered); COMMIT not landed (lookup absent, rollback); COMMIT landed but rejected (committed, three operations published once, resolves); flag off with the same fault (still rejects: no M2 without the overlay); COMMIT lost with the log unreadable (whole group unknown, then a read rolls it back) and landed with the log unreadable (unknown, then committed); bridge terminated; quota; durability barrier failing after COMMIT (`WriteNotDurableError`, group stays committed); a hung transaction becoming unknown at the TTL as a group, then decided by its commit. All pass.

**Browser bench** (`store-browser-bench.mjs`, new scenario `window.B.mutation`): 5,000 todos, one live query over 1,000 of them, 40 samples, each one `store.transaction` named like an `app.mutation` that inserts a row into the result, updates one of its rows and deletes another, timed from the call to the first subscriber callback, fully drained before the next. New enforced gate: on-mode p95 under 16 ms (no 10% buffer), valid only if every measured mutation was predicted as a group. Headless Chromium, OPFS `opfs-sahpool`, shared container, three full runs alone on the machine:

| Mutation of 3 records, call to first callback | Flag off (committed path) | Flag on |
|---|---|---|
| p50 | 63.5 ms (59.5 to 86.5) | **2.3 ms** (2.2 to 2.4) |
| p95 (gate: under 16 ms) | 98.0 ms (71.2 to 169.9) | **5.0 ms** (4.8 to 7.0) |
| call to resolve p50 | 54.8 ms (51.0 to 74.5) | 59.0 ms (58.4 to 68.4) |
| predicted as one group | 0 of 40 | 40 of 40 in each run |

Median of the three runs, range in brackets. The container was noisier than the one behind the S5 figures (flag-off single-insert resolve about 31 to 52 ms here against 28 ms there).

All enforced gates passed in the three runs. The callback includes the transaction's own two reads (its `update` and `delete` read their rows through the worker inside the callback); that is most of the on-mode median. The write's own resolution is unchanged by the flag.

Deviations and findings:

1. **The callback's reads are reused as bases (not in the design as first written).** The first bench run declined 2 of 40 mutations (`base-timeout`): the group read each updated and deleted row a second time after the callback had already read it, and the committed-row cache did not hold the targets (finding 2). The transaction now records the committed row each `update`, `delete` and `findById` read, with the registry's seed stamp taken before the read; the group uses it as a base when the stamp is unchanged and no unpredicted write holds the record (the subscription seeding rule). After the change: 40 of 40 predicted, no base reads in the scenario. Step 2b of the design and red-team item 8 were updated.
2. **Seeded rows at the top of a large result are evicted first (pre-existing, S5 follow-up).** `seedFromRead` adds only rows not yet cached, as most recently used; on a 1,000-row result with a 512-row cache each later re-run seeds the rows below the first 512 and so evicts the top rows seeded earlier. The rows a user is most likely to edit (the top of the list) are then the ones that need a base read. Single updates and deletes show it as the occasional `base-timeout` in the phase table (3 of 240 in the three runs). Not changed here (outside S6a); the fix is to refresh the recency of already-cached rows of an accepted result in result order. Open for Obed.
3. **No `{ durable: true }` for transactions.** `app.transaction` and `app.mutation` take no options; a transaction that must not be shown early has no per-call escape hatch other than turning the flag off. Adding one is a public API change, not made here.
4. **Bulk transactions show up as a declined group.** A `store.transaction` with more writes than `maxRecordsPerWrite` (the bench's 5,000 and 10,000-row setup transactions) is now reported as one `transaction` miss with reason `records-cap` (with every record id in the event, as `insertMany` misses already were). Before S6a transactions were invisible to the overlay events.
5. **Cross-list atomicity is per subscription** (red-team 1): accepted as designed.
6. **`insertMany` is unchanged** (one entry per record, `addMany`, per-record events); it already shares one fate through its tracker. Folding it into the group mechanism would change its events; not done.

## 14. What could go wrong

1. **The evaluator disagrees with SQLite** in a case the differential test did not generate (collation, affinity, planner order). The user briefly sees a wrong membership or order. Mitigation: allowlist, generated differential tests, the settle-time self-check (I10) and the breaker. Residual: a divergence is possible and visible for one SQL round trip; it is never persisted.
2. **A user sees a row that is then lost.** Closing the tab inside the window (queue depth x about 34 ms, or longer if the leader is busy), a leader change, a crash. Before this change a row was never visible before it was committed. `isLoading` lets the app show "Saving..." and warn on unload (the internal `pending` count is the same signal tab-wide); the doc must say so plainly. This is the main behavioral cost, and it is the point of the feature.
3. **Rollback flicker.** A row appears and disappears (restrict, record deleted remotely, quota). Mitigated by predicting only writes that rarely fail (5.2); inherent to optimism.
4. **`mutate` without error handling** shows a row vanish silently. Dev warning; docs; the mutation's `error` (the internal `onRollback` feeds the warning).
5. **Total work does not fall.** Settle re-runs the same SQL after commit and queues ahead of the next write in the worker. Under a sustained burst, writes may get slower by the re-run cost. Mitigations: coalescing, the budget, and a later "verify by sampling" option (settle by re-running SQL for a sample of subscriptions) which is explicitly not in this design because it trades away I5.
6. **Second callback for metadata.** `createdAt`/`updatedAt` change by a few ms at settle, so React re-renders once more with the same visible rows. Cosmetic cost. A future "ticket" scheme (allocate the HLC timestamp when the write is called and enter transactions in ticket order) would remove it, but touches the HLC-order = sequence-order invariant and is not worth the risk for a metadata blip (F9).
7. **Tie order and no-`orderBy` order** may differ from SQLite's rowid/index order for shapes the differential test did not cover. The ties rule and the append rule are conservative; coverage grows with the test.
8. **Two query semantics to maintain.** Every future query feature needs an evaluator decision. Mitigation: unpatched by default and the differential test, but the maintenance cost is real.
9. **Stale prediction base** (cache, or a base fetched before a remote change) gives a transient wrong prediction. The transaction computes the real values from the committed row, and the settle corrects the display.
10. **A hung transaction** leaves an entry for up to the TTL. It becomes `unknown`, never "saved".
11. **Interaction with the IndexedDB fallback's 250 ms barrier.** The row is pending, then committed in memory, then durable 200+ ms later. Three tiers on one screen; the vocabulary in 5.1 and `isLoading` cover it. If an app cannot tolerate that, `{ durable: true }`.
12. **Main-thread cost** of a large patch pass (1,000 subscriptions x large results). The pass budget makes the remainder fall back to the commit path; measured in S3.
13. **Version skew between tabs.** A tab on an older build is a follower of a newer leader or reverse; the overlay is tab-local and adds no wire messages, so there is no protocol skew. Events are additive.
14. **Wrong confidence from tests on `better-sqlite3`.** The browser path (WASM, OPFS, followers) differs in timing and affinity. The browser gates and the WASM-mock differential run are there for that.

## 15. Adversarial self-review

Method: every way the UI could (a) show state that never becomes durable, or (b) differ from the database after commit, was enumerated by walking the write path of section 1.2 from the call to the resolve, and by testing each overlay operation (add, patch, retire, settle, remove) against everything that can happen concurrently (remote batch, other tab, leader change, sign-out, schema, sync). The hazards below were found by that pass; the "Change" column says how the design above already answers each one, so the body and this table agree.

| # | Hazard found | Change | Section |
|---|---|---|---|
| F1 | If the entry were registered at the top of `insert()`, a write refused by the write gate (`BuildSupersededError`) or by `assertLocalWriteAllowed` would show and then roll back for a write that could never have run. | Every synchronous refusal check runs before `overlay.add`. | 5.2, 7 |
| F2 | A store in the durability-lost state (`StorageDurabilityError`, no OPFS and no IndexedDB) refuses every write at transaction entry, which is after any prediction. | The predictor checks that the adapter accepts writes first. | 5.2 |
| F3 | On commit the entry was removed at once. The display would drop the row until the SQL re-run returned: a flicker from "appears" to "disappears" to "appears". | Retire keeps the display until the SQL result with `issuedAt >= retiredAt`; epochs decide which results contain the entry. | 5.5 |
| F4 | If a delete were predicted for collections with `restrict` relations, the restrict check runs inside the transaction (`beforeLocalDelete`) after the row was hidden, so a common refusal would flicker. Cascades touch other collections found by SQL. | Deletes are predicted only for collections that no relation with `restrict`, `cascade` or `set-null` points at. | 5.2 |
| F5 | If entries were whole-record snapshots, a remote change to another field of the record, applied while the local write was pending, would be overwritten on screen by the stale snapshot until the settle. | Updates are field patches over the base; inserts are the only full records. | 5.4, 5.7 |
| F6 | If entries were applied to every SQL result regardless of when the read ran, a read executed after the commit would have the write twice. | `issuedAt` / `retiredAt` epochs; entries are idempotent upserts, never deltas, so the narrow window of a read issued before the retire but executed after the commit is harmless. | 5.5 |
| F7 | Two tabs could keep conflicting predictions indefinitely if either trusted its overlay past the commit. | The settle is mandatory for every entry (I5) and the overlay is tab-local; convergence is by SQL. | 8, 6 |
| F8 | After sign-out, user switch, restore or `reloadFromDisk`, surviving pending entries of the previous identity would apply over the new user's results. | The clear list I12, ordered before query re-runs. | 6 |
| F9 | To make `createdAt` match exactly, one option is to allocate the HLC timestamp when `insert()` is called. Two calls whose transactions run in a different order than their calls (for example through an async secret hash) would give a node timestamps in the opposite order of its sequence numbers, so a later write could lose a same-field conflict to an earlier one. | No early allocation. Predicted metadata is approximate and corrected at settle; equality is stated modulo those two fields. | 5.3d, 14 |
| F10 | On a middle rollback (insert ok, update 1 fails, update 2 depends on it), incrementally mutated state would leave later patches computed from the failed one. | Display is recomputed from entries each time; dependents are removed with the entry they were derived from. | 5.5, 5.6 |
| F11 | A COMMIT whose answer was cut by a leader change (M2), if treated as a failure, the row would vanish from the UI although it is stored, and reappear on the next read. | The `unknown` state with the content-addressed lookup; never silently rolled back. | 7 |
| F12 | A transaction that never settles would keep a row on screen forever. | `pendingTtl`, then `unknown`; decided by lookup or next SQL read. | 7, 11 |
| F13 | Atomic ops (`op.increment`) and counter merges predicted as absolute values would come from a possibly stale base, and applying them as deltas breaks the idempotency that F6 relies on. | Excluded from S1 to S5; S6(b) requires exact epoch accounting. | 5.2, 13 |
| F14 | Secret fields: the at-rest form (hash, ciphertext) is what a read returns, computing it is async and can be slow, and predicting the plaintext would be wrong. | Collections with secret fields are excluded. | 5.2 |
| F15 | The insert's returned record is not the shape of a `SELECT` row (absent optionals vs `null`), so using it as the prediction would trigger a spurious second callback for every optional field. | The predictor goes through `serializeRecord` then `deserializeRecord`. | 5.3b |
| F16 | Patching a `limit` page when a row is removed or leaves would need the next row, which is not in memory; guessing would show a short page. | Removal from a full page is not patched. | 5.4 |
| F17 | Routing the overlay change through `recordsChanged` would reach the cross-tab bus: other tabs would be told about writes that had not committed, and the bus message announces committed operations. | Own entry point; the registry is never wired to the bus (I11). | 8 |
| F18 | A subscription created while a write is pending has no base and could patch onto an empty list. | No patching before the first SQL result; entries applied when it arrives. | 5.5 |
| F19 | Skipping the settle for subscriptions with no visible change would be tempting. | Mandatory: it is the self-check (I10) and the only thing that makes I5 true. | 6, 5.5 |
| F20 | A very large `insertMany` would otherwise pin megabytes of entries and make every patch pass slow. | Per-write record cap and byte cap; larger writes are not predicted. | 11 |
| F21 | An update of a record that a remote operation just deleted could be predicted from a stale cached row and shown. | Cache invalidation by every remote apply and cross-tab change; an update patch applies only to a record present in the subscription's list. | 5.6, 5.7 |

Findings that remain open (not fixed, only bounded): the tab-close window (risk 2), the tie order of uncovered shapes (risk 7), and a divergence that the differential test did not generate (risk 1).

## 16. Decisions and open questions

**Decided 2026-10-30** (recommended defaults, taken so the build can start; Obed can overturn any of them):

1. Default: `instantUpdates` is **opt-in in beta.15**, enabled in the dogfood products (koraforms, koradocs). Flip the default after a clean dogfood week, in the release candidate or beta.16.
2. Per-write option: `{ durable: true }`, documented as "wait for the commit before showing", with a note that it adds no durability.
3. Metadata second callback: **accept** the extra render with the same rows; the timestamp-ticket scheme is not built.
4. Caps: the proposed defaults.
5. Verify-by-sampling: **not now**; every settle re-runs SQL.
6. `app.storage.writes.pending` and `onRollback`: **internal** until the default flips.
7. Transactions (S6a, `app.transaction`/`app.mutation`): **in beta.15** (2026-10-30, Obed: everything ships in beta.15, tested, irrespective of time). The interim deferral, on the grounds that no dogfood product used `mutation` yet, is withdrawn. Design: "S6a design" in section 13; result: "S6a result".
8. Cascade deletes (S6d): **in beta.15**, with S6b (atomic ops and counter-like merges), S6c (many-to-one `include`) and S6e (pre-commit read-through for unpatchable queries). S6f (flip the default) after the dogfood week.
9. Test builds (`NODE_ENV=test`) throw on `store:overlay-diverged`: yes.
10. IndexedDB fallback uses the same flag.

Original questions, kept for the record:

1. **Default.** Ship `instantUpdates` off in beta.15 and flip after a clean dogfood week (recommended), or on in beta.15? The LMS and form apps are the first exposures to "a row can disappear".
2. **Name of the per-write option.** `{ durable: true }` (as proposed in the request) reads as "wait for durable". Alternatives: `{ optimistic: false }`. The semantics are identical; the first is shorter but could be read as additional durability, which it is not (it only skips the overlay).
3. **The second callback for metadata.** Accept the extra render with the same rows (recommended), or build the timestamp-ticket scheme (F9) to remove it?
4. **Cap defaults** (256 entries, 8 MiB, 100 records per write, 2 s settling, 60 s TTL). Reasonable, or should they track device class?
5. **Verify-by-sampling.** Today every settle re-runs SQL (I5). Skipping the re-run for subscriptions whose prediction has been exact for N writes would remove the extra worker load (risk 5) but makes the database no longer the arbiter for them. Recommended: not now.
6. **`app.storage.writes.pending` and `onRollback` as public API** in beta.15, or internal until the flag is default-on?
7. **Transactions.** Is S6(a) (`app.transaction`/`app.mutation`) required for beta.15? Koradocs and koraforms use `mutation` for multi-record edits; those writes stay at today's latency until it lands.
8. **Cascade deletes (S6d).** Worth the work, given deletes of parents are rarer than inserts and updates?
9. **Dev-time strictness.** Should test builds (`NODE_ENV=test`) throw on any `store:overlay-diverged` so app test suites catch prediction bugs? Recommended: yes.
10. **IndexedDB fallback.** The barrier makes a resolved write 200+ ms at 10,000 records; the overlay hides the visible part of that. Confirm the fallback should use the same flag rather than a separate default.

## 17. Appendix: code map

| Concern | Today | Touched by |
|---|---|---|
| Local write entry | `packages/store/src/collection/collection.ts`, `mutations/execute-insert.ts`, `execute-update.ts`, `execute-delete.ts` | S2, S4 |
| Single write path | `mutations/write-ops.ts`, `mutations/run-local-write.ts`, `mutations/write-context.ts` | S2 (extract pure helpers), S4 (lifecycle calls) |
| Fold and materialization | `fold/record-folder.ts`, `packages/core/src/fold/` | read only (reuse `mergeOp`, `materialize`) |
| Read shape | `serialization/serializer.ts` (`serializeRecord`, `deserializeRecord`) | read only |
| Queries | `query/query-builder.ts`, `query/sql-builder.ts` | S1 (mirror semantics), S3 (`isPatchable` at build) |
| Subscriptions | `subscription/subscription-manager.ts`, `reactivity/query-store.ts`, `query-store-cache.ts` | S3 |
| Publication after commit | `store/store.ts` (`publishLocalOperation`, `transactionNow`), `kora/src/local-operation-bus.ts` | read only (I3, I11) |
| Durability | `adapters/indexeddb-adapter.ts` (`ensureDurable`), `store.ts` (`reportWriteDurabilityError`), `kora/src/storage-accessor.ts` | S4 (`pending`, `onRollback`) |
| Adapter mutex and worker | `adapters/sqlite-wasm-adapter.ts` (`transaction`, `query`) | read only |
| Sync | `packages/sync/src/engine/sync-engine.ts` (`pushOperation`, `awaitUploadDurability`) | read only (I1, I3) |
| React and other bindings | `packages/react/src/hooks/use-query.ts`, `use-mutation.ts` | `useStorageWrites` only (S4) |
| Gates | `packages/store/benchmarks/browser/`, `packages/store/src/benchmarks/subscription-fanout-gates.test.ts`, `docs/benchmarks/baseline.md` | S0, S5 |
