# Design: first-visit parity

Someone opening a Kora app for the first time, or on a new device, should see no difference from
a regular web app that fetches from a server. The first screen should paint as early, data should
arrive as early, and navigation and writes should feel the same. The offline benefits come on top
of that, and they never make the first visit slower.

Related: [durable delivery](durable-delivery.md) (the delivery watermark),
[offline readiness](offline-readiness.md) (completion marks, `app.offline.status()`),
[instant UI updates](instant-ui-updates.md) (the query evaluator),
[fast first sync](fast-first-sync.md) (server delivery, record snapshots), and the read endpoint
in [`docs/api/server.md`](../api/server.md).

## 1. The problem

A first visit used to be serial, with the UI gated on its end: the entry chunk carried all of
Kora; `KoraProvider` showed its fallback until `app.ready` (SQLite WASM fetched and compiled,
OPFS opened); sync connected only after that; the first row followed the handshake and first
batch. The service worker meanwhile re-downloaded the entry chunk and the WASM (twice), and
replication applied each batch in a journaled OPFS transaction that held the worker.

On the benchmark below (Slow 4G, cold, 20,000 operations) first data took about 15 s against about
1 s for a plain REST app, dominated by the WASM download in series with first paint, then the OPFS
open. A benchmark that started its clock at `connect()` had hidden this.

## 2. The parity contract

The goal is a benchmark that compares two real programs. The harness is
`packages/test/bench/parity/` (see its README), and
[`contract.ts`](../../packages/test/bench/parity/contract.ts) is the source of truth for every
margin, allowance and ratchet value.

### 2.1 Baseline and Kora app

Both apps render the same LMS screens (home, course, lesson, a "mark done" write) from the same
React components, built with `vite build`. The baseline reads a plain REST/JSON API served by the
**same server process and database** as Kora's sync endpoint, through `RouteContext.query` under
the token's scope. That way the server read cost, the grant and the rows are identical. It
behaves like a well-built SPA: it fetches on route enter, keeps an in-memory per-session cache,
has no service worker, and does not write optimistically. The Kora app uses `useQuery`,
`useMutation`, `createApp` defaults plus the sync URL, `KoraProvider` and `koraServiceWorker()`.

### 2.2 Metrics

Every time is measured in Chromium from navigation start, never from `connect()`.

| Id | Metric |
|---|---|
| P1 | First paint of the app (a node marked `data-app-shell`; a placeholder does not count) |
| P2 | First data: first row of the screen's primary list in the DOM |
| P3 | Screen complete: every row present with the server's values |
| P4 / P5 | Cold / warm navigation: click to first row of a new / previously opened screen |
| P6 | Write: click to the written row in the DOM |
| P7 | P4 and P6 while Kora is still preparing for offline |
| P8 | Total blocking time, 0 to 30 s (from a 10 ms timer; `longtask` reports nothing in headless Chromium) |
| P9 | Bytes received before first data |
| K1 | Kora only: time to `app.offline.status().state === 'ready'` (includes the installed shell) |
| K2 | Kora only: longest main-thread task while preparing |
| K3 | Kora only: critical-path JavaScript added over the baseline (gzip bytes) |

### 2.3 Conditions

- **Network.** Page-level CDP throttling does not reach service workers or dedicated workers in
  Chromium, so it would understate Kora's cost. The harness shapes one shared link with a TCP
  proxy instead. Profiles: `slow-4g` (150 ms, 1.6 Mbit/s), `4g` (60 ms, 9 Mbit/s), `broadband`
  (20 ms, 50 Mbit/s).
- **Temperature.** `cold` is a new browser context. `warm` is the same context reopened after the
  first session. `warm-stale` is a warm device whose server log grew by 10,000 operations.
- **CPU.** 1x and 4x (`Emulation.setCPUThrottlingRate(4)`, a mid-range phone) are both gated.
- **Runs.** The two apps alternate per run. Each cell reports the median and the tail: the
  second-slowest run below 20 runs (the nightly runs 5, and one shared-runner spike must not
  decide a cell), the nearest-rank p95 from 20 runs up.

### 2.4 Pass rule

```
kora.p50 <= baseline.p50 + max(0.10 * baseline.p50, 100 ms) + allowance
kora.tail <= baseline.tail + max(0.15 * baseline.tail, 150 ms) + allowance
```

P8 uses a flat +50 ms instead of the percentage margin, and P9 uses a byte allowance. A step that
timed out counts as infinitely slow, and any timed-out run fails the cell (the tail ignores one
outlier, never a timeout). A cell passes only if both quantiles pass. The floors
(100 ms, 150 ms) exist because a worker-backed store pays a message round trip per query (30 to
60 ms) where an in-memory cache answers in a few milliseconds, and 100 ms is below what users
perceive. For the same reason, warm visits get the same margin as cold ones instead of having to
beat the baseline.

### 2.5 Ratchets

Some limits are **ratchets**: each is set at the measured level plus a margin, and may only go
down, in a commit that explains why. A limit is a ratchet when the original target is not
reachable with the current architecture, the remaining cost has a known cause, and there is a
known way to remove it. Freezing the limit keeps it from growing while that work happens.

| Limit in `contract.ts` | Engineering reason |
|---|---|
| `P9_ALLOWANCE_KIB` | The bytes before first data are spread over about a dozen small modules. Nothing that keeps a synchronous public contract closes the remaining gap. |
| `cpuAllowanceMs`, `k2LimitMs` (4x only) | At 4x CPU the staged first sync leaves a burst of 55 to 105 ms main-thread tasks: worker round trips of the fold, message clone and decode. Closed by fewer worker calls per batch, or by moving the fold off the main thread (blocked while app resolvers and transforms run in the page). |
| `WARM_FIRST_DATA_ALLOWANCE_MS` (warm P2, P3) | A returning device renders from its own database and never reads through, because a server answer would miss its unsent writes, so its first data waits for SQLite WASM to load and the local database to open. Closed by first data that does not wait for the store, such as a local snapshot of the first screen's answers. |
| `WARM_NAVIGATION_BOOT_ALLOWANCE_MS` | On a warm `4g` visit the runtime boots at about the time first data arrives, so the first navigation measures part of start-up. |
| `K1_TARGET_MS`, `k1TargetMs` | Staged replication spends several seconds of JavaScript applying the stream and a few more merging it. |
| `K3_BUDGET_BYTES` (parity app; the template's budget and margin are in `scripts/bench/bundle-budget.mjs`) | The floor is what the first screen needs: schema builders, the `korajs` shell, the deferred query and write queue, and the store and React lite entries. There is no lower target. |

`P1_ABSOLUTE_MS` (absolute cold paint) is enforced only on a dedicated host
(`KORA_PARITY_DEDICATED_HOST=1`). On shared runners absolute times move with the runner, so they
are only reported there. At Slow 4G, about 29 KB of gzip costs about 137 ms of transfer.

### 2.6 Where it runs

- **Nightly** (`.github/workflows/parity-nightly.yml`): read-through on, `4g` and `broadband`, 1x
  and 4x. `KORA_PARITY_ENFORCE=1` fails the job on any failing relative cell or Kora target. On
  `main`, the run of 2026-11-19 dispatched after #333 (44511902726) and the scheduled run that
  followed (44520051982) passed every cell and K3 (22.5 KiB against the 23,100-byte, 22.6 KiB
  ratchet).
- **Every PR** (`e2e.yml`, bundle budget): K3 as a no-growth check. The `react-tailwind-sync`
  template is built at the merge base and at the head on one runner, with the scaffold's tooling
  pinned (`PINNED_TOOLING`). The job fails when the head exceeds the base by more than
  `K3_MARGIN_BYTES`.
- **Correctness.** After a cold Kora visit is offline-ready, the harness compares a
  per-collection count and sum with the server's and prints `CORRECTNESS` on a difference.
- **Manual:** `pnpm --filter @korajs/test bench:parity`, with `KORA_PARITY_*` variables to choose
  the matrix.

## 3. Design overview

1. **Render before the store opens.** A small critical path paints; the runtime loads after.
2. **Read-through.** Queries made before the store opens are answered by the server under the
   delivery grant and rendered from memory.
3. **Seeds.** When the store opens, those answers become temporary row snapshots, so local
   queries, writes and an offline reload work on them.
4. **Staged replication.** A large first sync applies into an in-memory replica, merged into the
   live database once; the merge deletes every seed.
5. **Deferred precache** after first data, from the HTTP cache.
6. **Honest status.** `ready` waits for the replica, the completion mark, the shell and auth.

Once the store exists the UI always reads it; whatever the server fills on demand is a disposable
cache the real replica replaces. That keeps the correctness argument short (I2, I3) and leaves the
delivery watermark, the fold and the access-rule stream unchanged.

## 4. Read-through endpoint

`POST <syncPath>/read` (`packages/server/src/read/`; wire types shared in
`packages/sync/src/read/read-types.ts`) is on by default on the server (`readThrough: { enabled:
false }` makes it answer 404). It uses HTTP because it must run before the store, node id and
handshake exist.

**Wire.** A request holds up to 8 queries in the local query language (`where`, `orderBy`,
`limit`, `offset`, `include` of depth 1, optional `known` ids and `cursor`). The response carries
`frontier` (F), `grantKey`, and per query a `status` (`ok`, `partial`, `unsupported`, `denied`,
with a `reason` unless `ok`), records in query order (values, per-field HLC versions, `created`,
`latest`), included records with their own status, `refreshed`/`absent` for `known` ids, and a
signed cursor. `ok` means complete. A denied collection is `denied` for that query, not a request
error.

**Grant.** The token is authenticated and the downlink scope computed by the code the handshake
uses (`computeReadGrant`; `ClientSession` calls the same helpers). The request `where` is ANDed
with it. Reads refuse retriably (409 `ACCESS_RULES_CHANGED`) wherever a session send path would.
After reading, the grant basis (index generation, rules and interval fingerprints, scopes) is
recomputed; a change retries once, then answers 409. A record with any encrypted operation is
never served (that record is left out, `partial`, `encrypted-records`); a store that cannot tell
answers `unsupported` (fail closed).

**Execution.** Equalities are pushed into the store as an id-ordered read capped at
`maxCandidates + 1` (an optimization, never the access check). Filtering and ordering run in
JavaScript with the shared evaluator (`packages/core/src/query/query-eval.ts`), which matches
the client's SQLite and is differential-tested against it, so SQLite and Postgres cannot differ
on collation, `NULL` placement or affinity. A refused shape returns the scoped superset
(`unsupported-shape`); a read that fills its cap is `unsupported` (`too-many-candidates`), never
a truncated prefix. Includes use their own collection's grant. Cursors are HMAC-signed keysets
bound to shape, principal and grant; one that does not verify answers `cursor-invalid`. Values
and versions are paired by re-reading the row, which is judged against the grant again.

**Frontier.** Rows are read first, then the delivery counter, so every operation a returned row
reflects is at or below F: the only property seeds need.

**Limits.** Defaults in `read-limits.ts` (rows, bytes, candidates, work budget, rate and
concurrency, auth-provider calls); over a limit answers 413 or 429. Responses are `no-store,
private` with `Vary: Authorization, Cookie`; cookie credentials need the `x-kora-read` header.
Logs hold shapes and counts, never values.

## 5. Answers before the store opens, and seeds

The client side is opt-in: `createApp({ sync: { firstVisit: { readThrough: true } } })`. The read
client (`packages/sync/src/read/read-through-client.ts`) has no store, engine or transport
dependency, so it ships in the lite entry. It coalesces the requests of one turn into a single
POST, shares identical queries, refreshes the token once after a 401, retries with backoff, and
remembers a 404 for the session. Its credential is `sync.auth`, or `sync.authClient` while a user
is signed in (`kora/src/read-through-auth.ts`).

**The early read.** The read client lives in the answers chunk, one more round trip on a first
visit. So the first screen's queries leave from the first paint (`kora/src/early-read.ts`): the
first turn's queries go out in one request built exactly as the client would build it, and the
client takes that response over when the chunk arrives. The chunk waits up to 300 ms for that
first request to be sent, so on a slow device the read takes the open connection instead of racing
the chunk on a second one. With `sync.authClient` there is no early read (asking a lazily loaded
sign-in client for its session would download it during the first paint); the chunk's client
reads then. A navigation read still waiting for its answer holds back the store's storage
downloads for at most a second (`READ_YIELD_MAX_MS`).

### 5.1 In-memory answers

A subscription made before `app.ready` is a deferred query (`kora/src/deferred-query.ts`). It has
the same API and the same descriptor, so hook keys do not change when the store takes over.
`kora/src/pre-ready-answers.ts` sends the descriptor and shows the answer only if it is `ok`.
Relational queries, rich-text collections and over-long descriptors are not read through. When
the store opens, held answers are seeded, subscriptions attach to the store, and the store's
first result replaces the in-memory one. An answer that arrives after that is discarded.

A device whose replica has completed does not read through. It opens its store and catches up
from the stream, because otherwise a fresh server answer would be replaced by an older local row
and the page would go fresh, stale, fresh. The completion mark is inside the not-yet-open
database, so its existence is mirrored in `localStorage` and tied to the database epoch
(`kora/src/replica-marker.ts`).

### 5.2 Seeds

A seed is a row snapshot in `_kora_fold_snapshot` marked in `_kora_seed (collection, record_id,
frontier, grant_key)` (`packages/store/src/seed/seed-store.ts`). It is no operation: no log
entry, no sequence number, never uploaded. Seeding receives the record's newest stamp into the
clock (so later local edits win last-write-wins), builds the state with `createSnapshotState`,
re-folds and materializes, in one transaction per answer. A record is skipped, with a reported
reason, when its collection is unknown, it already has local history, an array holds duplicate
values, the clock refuses its stamp, a seed at an equal or newer frontier exists, or the database
does not fold.

**Why a row snapshot.** It is exact up to F and approximate only for an older operation arriving
later, which only the stream can bring and which never folds onto a seed (I3). It needs no
fold-plan negotiation and discloses only what scope entries already do.
`packages/core/src/fold/seed-fold.property.test.ts` finds differences from the full fold only in
arrays (order after remove and re-add; which duplicate a removal targets). Replicas converge
anyway; records with duplicate array elements are not seeded so a user's own edit never changes
silently.

**Lifetime.** Local writes fold on top of a seed as usual. Seeds are deleted by the staging merge
(all, in its transaction), on the direct path per record before the first remote operation folds
(`Store.releaseSeedFor`), and at clear points (sign-out, user switch, full resync, restore,
reload). A seed the device wrote to keeps its snapshot, since the record has no local insert,
until its insert arrives; otherwise it is reported (`SEED_ORPHANED`).

## 6. Staged replication

Code: `Store.beginStaging()`, `packages/store/src/staging/`, `SyncEngine`.

**The replica** is a second SQLite WASM worker in memory (no OPFS, no journal) in the browser, or
`:memory:` on native SQLite (`StorageAdapter.createStagingAdapter`): an ordinary `Store` without
developer indexes, so apply, fold, quarantine and the chained watermark run unmodified. Queries
never read it. The browser first-sync cost was one journaled OPFS transaction per batch; in memory
that cost is gone and the live database sees a few hundred large commits. The engine stages a
view's first stream (from watermark 0, more than one batch) when the server frontier is between
`minOperations` (2,000; below about 1,000 the setup costs more than the journal it saves) and an
upper bound (150,000 operations plus a byte cap, because the replica is in memory).
`sync.bulkReplication: false` turns it off.

**The merge** (`mergeStagingInto`) copies whole records (row, log, fold state, base, snapshot,
provisional effects, retraction marker) in chunks of about 150 ms of live-worker time, which
bounds write latency during a merge. A record the live database already holds (a local write, an
operation under this node id) is never overwritten: its staged operations replay through the
deduplicating apply pipeline. The watermark, quarantine rows and completion mark are written in
the last transaction; replica events are buffered and replayed after commit. What copying cannot
reproduce makes the merge `unmergeable`, and the stream is replicated directly.

**Mid-stream.** A retracting or narrowing batch needs live records: the clean staged prefix (equal
by construction to the direct apply) merges, and the rest applies directly on the same connection,
chaining from the new watermark. A failed apply does the same. A view change, `stop()`,
revocation, rollback or full resync drops the replica. Until the merge nothing staged is live and
the live watermark has not moved, so a crash or failed merge loses only time; committed chunks hold
whole records and re-delivered operations are duplicates.

**One writer for the delivery position.** Watermark, view cache, rules key and acknowledgments
are written only by `SyncEngine.commitDeliveryProgress(context, change)` through `DeliveryPosition`
(`#private` fields, `delivery-position.ts`). The batch's `DeliveryContext` (epoch, connection,
signature, user, replica, watermark, drop counter, rules key) is re-checked synchronously before
each write. Mutations that wait for the database carry an `isCurrent` check into their storage
transaction and roll back with `StaleStoreWrite`, so a scope change during a wait cannot reject
unsent writes. A syntax-tree scan (`delivery-progress-scan.ts`) fails on any other writer or
unguarded mutator; a hop injector (`packages/test/tests/staged-replication-hops.test.ts`) fires
scope changes, stops, reconnects, user switches and resyncs at every await. CI runs the commit
points; the full sweep runs nightly.

## 7. Render before ready, and the first-load payload

`createApp` (`kora/src/create-app.ts`) is a shell: schema validation, early accessors and
facades. The runtime (`kora/src/runtime-app.ts`) loads by `import()` after first paint, or when
something needs it (`app.ready`, `getStore()`). The shell imports the `lite` entries of core,
store and sync, because bundlers include a whole published module; `sideEffects` is declared and
lists the worker entry (imported only for its effect). Guard tests bundle the published entries.
`KoraProvider` renders at once with a pending store that throws `AppNotReadyError` for anything
but early accessors; `waitForStorage` restores the gate. An early `connect()` is remembered and
the WebSocket warmed before the store opens.

The service worker (`packages/cli/src/vite/service-worker.ts`) on an uncontrolled page registers
after first data, then at idle, bounded by `firstDataTimeoutMs` (10 s after `load`); controlled
pages register at `load`. The signal comes from `kora/src/first-data-signal.ts`
(`__KORA_FIRST_DATA__`, `kora:first-data`): first delivery batch, caught up, sync stopped until
someone acts, an attempt ended offline, `app.ready` for local-only apps, or a failed `app.ready`.
Files with a build digest come from the HTTP cache first and are stored only on a SHA-256 match;
byte-identical files are fetched once (shortest URL) and stored under every URL.

## 8. Writes before the store opens

A `useMutation` write before the store opens queues; a direct `app.<collection>.insert(...)`
still throws `AppNotReadyError`, because only a hook can promise a later confirmation. The queue
(`kora/src/pre-ready-writes.ts`, `pre-ready-journal.ts`, `pre-ready-recovery.ts`) saves each
write to an IndexedDB journal first and applies the queue in call order before `ready`; the next
session applies what a closed tab left. Each entry's `opKey` is recorded in
`_kora_journal_applied` inside the write's transaction, so replays apply exactly once. Entries
carry their owner; another user's or an unknown owner's entries wait in the held-writes API and
never expire. Atomic helpers, `t.secret()` collections, everything under sync encryption, and
closure-based transactions are held in memory only (`journal:memory-only`). Every journal call
is time-bounded and recovery never blocks `ready`.

## 9. Invariants

- **I1. One query engine after open.** Once the store is open, every result is the local SQL
  result. Read-through only writes seeds.
- **I2. Seeds are a cache.** Deleting every seed at any instant leaves operations, logs, fold
  state of records with remote history, watermarks, version vector and completion marks unchanged.
- **I3. Seeds never meet the stream.** No remote operation folds in the live database while its
  record has a seed. The staged stream stays out until the merge, the merge deletes all seeds, and
  the direct path releases a record's seed first.
- **I4. Convergence.** After replication, every record equals the fold of all delivered operations
  and unsent local writes, minus terminal rejections, exactly as on a device that never read
  through.
- **I5. Never more than delivery.** Every record a read returns is in the principal's downlink
  scope at the time of the read.
- **I6. Reads never move positions.** Read-through never touches a watermark or a completion mark.
- **I7. Staging is disposable.** The replica is never read and never outlives its worker.
- **I8. Offline principle.** After `ready`, nothing needs the network. Before `ready`, every
  network step has an offline outcome, and none blocks a local write.
- **I9. No early claims.** `ready`, `complete` and "saved" follow the existing rules.

## 10. Status and API surface

- `useQueryState()` in React (and the Vue composable and Svelte store) exposes `source`
  (`pending | server | local`) and `complete`. `server` is a complete read-through answer from
  memory. `local` is the store's result, with `complete` following the completion mark.
- `app.offline.status()` reports `storage-opening` while the store opens. `ready` still requires
  the merged replica, the shell and restorable auth. Seeded screens do not count.
- Options: `sync.firstVisit.readThrough` (off by default), `sync.bulkReplication`, server
  `readThrough` (on by default), `firstDataTimeoutMs`, `waitForStorage`.
- Events: `sync:staging-started`, `sync:staging-merged`, `sync:staging-discarded` and `journal:*`.
  Seed problems are reported as store notices (`READ_SEED_SKIPPED`, `READ_SEED_FAILED`,
  `SEED_ORPHANED`, `SEED_PURGE_FAILED`).

**Multi-tab.** There is no replicator lock: each cold tab stages its own replica. This is
correct because the leader serializes live writes, merges are whole-record transactions, and a
record an earlier merge made live replays through the deduplicating apply path.

## 11. Alternatives considered

- **Faster replication alone** leaves first data waiting for the runtime, the WASM, OPFS and the
  handshake. It survives inside this design as staging.
- **A whole-scope record snapshot before the first row** still waits for WASM and OPFS, and its
  correctness surface is large (watermark jumps, tombstones, restarts).
- **Query subsets or priority lanes:** a new subset is a new delivery view that reconnects and
  backfills from zero, and out-of-order delivery would break the gap-free watermark.
- **Display-only answers** cannot fold writes and show nothing after an offline reload. They
  survive as the pre-ready phase.
- **Seeding the server's fold state** needs plan negotiation and discloses more, and the merge
  throws away its only gain anyway.
- **A server-built database image** couples the server to the client schema and cannot hold
  unsent writes. **SSR** would need a route-to-query manifest, which a UI-agnostic framework
  does not have.
- **Bulk loading the live database:** with the journal off, a crash can corrupt unsent writes.
  With large journaled transactions, the worker is held for seconds.

## 12. Testing

- Read-through security: `packages/server/tests/integration/read-through-property.test.ts`
  (fast-check; every returned record is held by a fresh device caught up on the stream, and every
  reflected operation is at or below F; memory, SQLite, Postgres with `KORA_PG_TEST_URL`; both
  properties fail under mutation).
- Evaluator parity: `packages/store/src/overlay/query-eval.test.ts`,
  `packages/core/src/query/query-eval.test.ts`, per-store read-through tests.
- Seeds: `seed-fold.property.test.ts`, `packages/store/src/staging/seed-merge.property.test.ts`,
  `kora/src/pre-ready-seeds.test.ts`.
- Staging: `packages/test/tests/staged-replication.test.ts` (staged equals direct over random
  operation sets, crash injection at every batch and merge transaction),
  `batched-delivery-apply.test.ts`, `staged-replication-e2e.test.ts`.
- Delivery position: the writers scan, the hop injector, mutation testing of the guards.
- Browser: the parity benchmark and the offline e2e suite.

## 13. Known limits

- **Warm first data waits for the local store.** A returning device shows its first screen only after SQLite WASM loads and the database opens, on a shared runner about 200 ms after the baseline's first fetch at 1x CPU and about 500 ms at 4x (nightly 44343962064, 2026-11-18), with run-to-run swings of a similar size. `WARM_FIRST_DATA_ALLOWANCE_MS` holds the measured level until a local snapshot of first-screen answers (or an equivalent) removes the wait.

- **Client read-through is opt-in and pre-ready only.** After the store opens, a query on data not
  yet replicated renders from the store and waits for replication. Post-open read-through,
  periodic refresh, `known`/`absent` reconciliation and background paging exist on the server but
  not in the client. Partial answers, relational queries and rich-text collections get no early
  answer.
- **The seed window.** Others' concurrent edits to seeded records appear only when replicated.
- **No frontier check at the merge.** The merge does not wait for the staged watermark to pass the
  largest seed frontier, so a seed read after the handshake can briefly show older values after
  the merge until the live stream catches up.
- **Grant changes.** `Store.purgeSeedsExceptGrant` exists but nothing calls it on a new grant key;
  seeds of a narrowed grant leave by replication or at a clear point.
- **Query subsets default to `reactive`.** Opening a screen while preparing can narrow the
  delivered view (and drop a just-started replica); `ready` then means complete for the views the
  app asked for, which the benchmark's correctness check flags by design.
- **Replayed journal writes take a fresh HLC stamp** (the clock must stay monotonic), so one can
  beat an unseen earlier edit of the same field from another device; the old value stays in the log.
- **Memory and tabs.** Scopes above the staging caps apply directly; several cold tabs duplicate
  work. **4x CPU** allowances remain until the fold needs fewer worker round trips or leaves the
  main thread. **Encrypted collections** are never read through. **Warm but stale replicas** show
  stored rows and catch up from the stream.
