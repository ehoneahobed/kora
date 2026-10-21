# Kora.js performance baseline

Targets from `CLAUDE.md` (repo root) with a **10% CI regression buffer** (`REGRESSION_FACTOR = 1.1`). Gates run on every PR via [benchmark-gates.yml](../../.github/workflows/benchmark-gates.yml).

## Run locally

```bash
pnpm benchmark:gates
```

## Shared CI runners: absolute targets locally, relative check on CI

GitHub-hosted runners differ in speed from run to run by more than the gates' 10% buffer.
The two "insert 10,000 records" gates sit inside that variance: on shared runners they
measured 2.22 to 2.44 s against the 2,200 ms limit on unchanged code (docs-only pull requests
and `main` failed alike), while the same code measures about 2.0 s on a developer machine.
Loosening the limit would hide real regressions, so the gates are enforced in two ways:

- **Absolute targets** (target x 1.1, the tables below) are enforced wherever the benchmarks run,
  locally and on dedicated runners. On a shared runner (`KORA_BENCH_SHARED_RUNNER=1`, set by the
  `ci` and `benchmark-gates` workflows) only the gates marked "relative on CI" below report a miss
  as a warning annotation instead of failing; every other gate stays blocking. Every gate reports
  its measurement as a `benchmark` annotation, so run-to-run variance is visible on the run.
- **Relative regression check** (blocking, `benchmark-gates` workflow): the workflow also builds the
  base revision (the pull request's base, or the previous commit on `main`) and runs
  `scripts/bench/ab-regression.mjs`, which measures the store's insert and query workloads
  alternately against base and head on the same runner (fastest of five each) and fails when the
  head is more than 10% slower (CLAUDE.md). Run it locally with
  `node scripts/bench/ab-regression.mjs --base <built checkout of main> --head .`.
- **Adapter protocol overhead** (blocking everywhere): the adapter-protocol gate also compares the
  `SqliteWasmAdapter` protocol path with the direct native adapter in the same process; the
  protocol may add at most 25% (measured -2% to 9%).

**Note:** Store benchmark files are excluded from `pnpm test` (they run via `pnpm --filter @korajs/store test:benchmarks` inside `benchmark:gates`) so dev machines are not blocked by insert timing while the full suite runs in parallel.

## Store (`@korajs/store`)

| Gate | Target | CI limit (×1.1) | Test file |
|------|--------|-----------------|-----------|
| Insert 10,000 records (relative on CI) | &lt; 2s | 2,200 ms | `performance-gates.test.ts` (better-sqlite3) |
| Insert 10,000 records (adapter protocol, native SQLite; relative on CI) | &lt; 2s | 2,200 ms | `wasm-adapter-protocol-gates.test.ts` |
| Adapter protocol overhead over the native adapter | -- | 25% | `wasm-adapter-protocol-gates.test.ts` |
| Query 1,000 rows (WHERE) | &lt; 50 ms | 55 ms | `performance-gates.test.ts`, `wasm-adapter-protocol-gates.test.ts` |
| Reactive notification | &lt; 16 ms (1 frame) | 17.6 ms | `performance-gates.test.ts` |
| Subscription check per mutation, 1,000 subscriptions | &lt; 1 ms | 1.1 ms | `subscription-fanout-gates.test.ts` |
| Mutation to notification p95, 1,000 subscriptions over 20 collections | &lt; 16 ms | 17.6 ms | `subscription-fanout-gates.test.ts` |
| Worst case: re-run of 1,000 subscriptions on the written collection | not a frame (see below) | 55 ms | `subscription-fanout-gates.test.ts` |
| Subscription bloom check (5000 subs) | &lt; 1 ms | 2 ms (dev/CI slack) | `subscription-manager.test.ts` |
| IndexedDB 1,000 inserts (1 txn) | &lt; 10s | 11,000 ms | `indexeddb-performance-gates.test.ts` |
| IndexedDB snapshot persistence, 1,000 rows (fake-indexeddb) | &lt; 1s | 1,100 ms | `indexeddb-performance-gates.test.ts` |

**What the node gates measure (STORE-16):** every node gate runs on native better-sqlite3 in-process. `wasm-adapter-protocol-gates.test.ts` (formerly `sqlite-wasm-performance-gates.test.ts`, which was labelled "SQLite WASM") runs the `SqliteWasmAdapter` request protocol over `MockWorkerBridge`: no WASM, no worker, no structured clone, no OPFS. It guards adapter-side overhead only. The browser path is measured by the browser benchmark below.

**Subscription fan-out:** a write re-runs and diffs every live query on the written collection, one after another. With 1,000 queries spread over 20 collections a write re-runs 50 of them and stays inside a frame. With all 1,000 queries on the written collection the full re-run takes about 20 to 40 ms in node (about 20 µs per query), so it is gated at its own ceiling and does not meet the one-frame target. Deduplicate identical live queries (the framework bindings' `QueryStoreCache` does) and avoid hundreds of distinct live queries on one hot collection.

Node measurements on the 2-core review container (October 2026, under load from parallel builds): check per mutation 0.18 to 0.30 ms; mutation to notification p50 1.2 to 3.1 ms, p95 4.4 to 8.4 ms; worst-case full re-run p50 20 to 38 ms; IndexedDB snapshot persist 10.8 to 17.3 ms.

## Store in a real browser (`benchmarks/browser/store-browser-bench.mjs`)

Runs the built `@korajs/store` in Chromium on Kora's dedicated worker, SQLite WASM and OPFS (`opfs-sahpool`), plus the IndexedDB fallback with its real snapshot persistence, and gates against the CLAUDE.md targets (×1.1). It also probes which journal modes `opfs-sahpool` accepts.

```bash
pnpm --filter @korajs/core --filter @korajs/store build
PW_CHROMIUM_PATH=/path/to/chromium pnpm --filter @korajs/store test:benchmarks:browser
```

It prints every measurement and exits 1 when a gate fails. It does not install a browser.

First measurements, headless Chromium 141 on the 2-core review container (October 2026). Runs 1 and 2 ran under load average 10 to 37 from parallel builds; run 3 under load average about 4.

| Measurement | Run 1 | Run 2 | Run 3 | Target |
|---|---|---|---|---|
| OPFS open | 799 ms | 1,644 ms | 815 ms | -- |
| OPFS insert 10,000 (one transaction) | 8,826 ms | 11,399 ms | 8,931 ms | &lt; 2 s |
| OPFS single insert (app path, own transaction) | 91 ms | 98 ms | 47 ms | -- |
| OPFS query 1,000 rows WHERE | 128 ms | 68 ms | 80 ms | &lt; 50 ms |
| OPFS reactive notification p95 | 150 ms | 320 ms | 133 ms | &lt; 16 ms |
| OPFS 1,000 subscriptions: check per mutation | 0.23 ms | 0.30 ms | 0.20 ms | &lt; 1 ms |
| OPFS 1,000 subscriptions: mutation to notification p95 | 253 ms | 297 ms | 124 ms | &lt; 16 ms |
| IndexedDB 1,000 rows: persist snapshot | 169 ms | 105 ms | 149 ms | -- |
| IndexedDB 10,000 rows: persist snapshot | 892 ms | 4,171 ms | 834 ms | -- |
| IndexedDB 10,000 rows: persist after one more write | 1,126 ms | 1,894 ms | 794 ms | -- |

Only the subscription check met its target on that host (before C3; current numbers in the next section). Each local insert was six worker round trips (begin, a read, three writes, commit; four since C3) plus one OPFS commit, and a raw one-row `opfs-sahpool` transaction alone took 11 to 38 ms there, so the reactive and fan-out latencies are dominated by the write itself. Every IndexedDB snapshot rewrites the whole database, so its cost grows with the database, not with the write. Record a baseline on CI hardware before making this gate blocking.

### Local write throughput (C3, beta.15)

**Where an insert's time went (before C3).** Profiled in Chromium 141 on the 2-core container (quiet, load average under 1) with an instrumented build: every worker request timed on the main thread (round trip) and inside the worker (SQLite time).

`store.transaction` with 10,000 inserts, 6.3 s:

| Cost | Count | Round trip | SQLite in worker |
|---|---|---|---|
| op-log row `INSERT INTO _kora_ops_*` | 10,000 | 1,594 ms | 694 ms |
| fold state `INSERT OR REPLACE INTO _kora_fold_state` | 10,000 | 1,349 ms | 547 ms |
| materialized row `INSERT INTO todos` | 10,000 | 1,260 ms | 488 ms |
| `COMMIT` (OPFS journal + database writes) | 1 | 1,265 ms | 1,264 ms |
| sequence reservation, begin, block end | 3 | 26 ms | 25 ms |
| main-thread JS outside requests (validation, op build and SHA-256, fold, publish) | | ~840 ms | |

So about 2.5 s of the 6.3 s was the worker message round trip itself (30,000 round trips of roughly 0.15 ms of message overhead each), 1.7 s SQLite statement work (each statement compiled again), 1.3 s the commit, 0.8 s main-thread work. Reactivity and the cross-tab broadcast were negligible: notifications are coalesced per microtask and published once after the commit. SHA-256 of the operation id is about 5 µs per operation.

A plain `insert` loop (each insert its own transaction), 500 inserts, 17.5 s (35 ms per insert): `COMMIT` 11 ms, the op-log row 9 ms (the first write to a page after a commit pays OPFS I/O), sequence reservation 5 ms, fold state and row 4.5 ms each, all of it SQLite and OPFS time in the worker; round-trip overhead and main-thread JS were under 1 ms per insert. A single insert is bounded by OPFS writes, not by Kora.

**What changed.**

1. *Write-behind statements* (`WriteBehindTransaction`, used by the local write path only). Inside a write's transaction the store buffers its write statements and sends them to the worker in batches of up to 256 statements, as one `batch` request each; reads first send what is buffered, and everything is sent before the commit. The worker runs a batch with cached prepared statements. 30,000 round trips become 118. The next batch is built while the worker runs the previous one (one batch in flight).
2. *16 KiB pages for new OPFS databases* (SQLite's default is 4 KiB). The commit of a large write is dominated by per-page OPFS writes; at 16 KiB it is about 40% cheaper (10,000-insert commit 1,150 ms to 690 ms), while a one-row commit costs the same. Existing databases keep their page size (changing it needs a full `VACUUM`). Larger pages measured: 32 KiB commit 440 ms but single inserts about 6% slower; 64 KiB commit 260 ms but single inserts about 10% slower. 16 KiB keeps the single-insert path unchanged.
3. *`collection.insertMany(rows)`*: one transaction for many records of one collection, atomic, one operation per record (see `docs/api/store.md#bulk-inserts`).

**Before / after, real browser** (headless Chromium 141, OPFS `opfs-sahpool`, `store-browser-bench.mjs`; base = `main` at 7a549aa, head = this change; runs alternated base, head, three times; load average 1.7 to 2.5 from other agents; medians):

| Measurement | Base | Head | Target |
|---|---|---|---|
| OPFS insert 10,000 (one `store.transaction`) | 6,192 ms (6,135 to 6,352) | **1,815 ms** (1,772 to 1,936) | &lt; 2 s |
| OPFS `insertMany` 10,000 | n/a | **1,675 ms** (1,634 to 1,716) | &lt; 2 s |
| OPFS single insert (own transaction) | 34.7 ms | 34.1 ms | -- |
| OPFS query 1,000 rows WHERE | 27.7 ms | 23.9 ms | &lt; 50 ms |
| OPFS reactive notification p95 | 73.1 ms | 61.0 ms | &lt; 16 ms |
| OPFS 1,000 subscriptions: mutation to notification p95 | 97.5 ms | 96.2 ms | &lt; 16 ms |
| IndexedDB fallback (in-memory SQLite WASM): insert 10,000 | 4,534 ms | 936 ms | -- |

Profile of the 10,000-insert transaction after the change (16 KiB pages, quiet host): 118 batches 0.9 s (SQLite 0.65 s), `COMMIT` 0.7 s, main-thread JS outside requests about 0.1 s (overlapped with the worker).

The single-insert, reactive and fan-out gates still miss their one-frame targets in the browser: each single write is its own durable OPFS commit (about 10 ms for the commit alone on this host, 34 ms in total), and the notification waits for that commit. Shortening it needs a cheaper durable commit (journal mode, `locking_mode = EXCLUSIVE`), measured below and not adopted here.

Not adopted, with measurements (10,000-insert transaction; 500 single inserts):

- `locking_mode = EXCLUSIVE`: about 7% on the large transaction and 15 to 20% on single inserts (no lock and change-counter work per transaction). It changes how the database file is locked, and a promoted leader's worker must reopen the file; not changed in a throughput PR.
- `journal_mode = persist` / `truncate`: about 5 to 10% on single inserts, within noise on large transactions, and keep the journal file (an OPFS pool slot) permanently. See NEW-STORE-11 below.
- `cache_size` up to 64 MiB: moved time from statements to the commit, no net change.
- Coalescing separate awaited `insert` calls into one transaction (microtask batching): refused. Each `insert` that resolves is durable on its own today, and a failure of one must not roll back another the app already saw succeed; merging them would change both. Bulk writes use `insertMany` or `app.transaction`, which say so explicitly.

**Node (better-sqlite3, in-process; not the browser path).** `scripts/bench/ab-regression.mjs` on the same container, fastest of 5, alternating: insert 10,000 base 1,161 ms, head 1,029 ms (-11%); query 1,000 rows base 2.9 ms, head 2.4 ms. better-sqlite3 has no worker hop, so the gain there is only the buffered statements' cheaper control flow.

**Journal mode (NEW-STORE-11):** `PRAGMA journal_mode = WAL` returns `delete` on `opfs-sahpool` (WAL needs shared memory, which that VFS does not implement). Kora no longer issues it; OPFS databases run with `delete`. One-row transaction cost on that host: delete 16 to 38 ms, truncate 11 to 24 ms, persist 11 to 14 ms. `truncate` or `persist` look 20 to 30% cheaper, but the numbers are noisy and both keep the journal file, which permanently holds an OPFS pool slot per database; re-measure on quiet hardware before switching.

### First sync: device apply of a delivery batch (C3, beta.15)

`pnpm --filter @korajs/test bench:first-sync` (fixture and method: `docs/design/fast-first-sync.md`).
With `KORA_BENCH_BREAKDOWN=1` it also replays the delivery batches the device received into fresh
devices with no server in the process, per operation and batched, and reports where the device's
time goes (every SQLite statement timed inside better-sqlite3).

20,000 operations, one school, batch 100, native SQLite, on the 2-core container under load
average 5 to 8 from other agents (ratios hold, absolute times do not):

| Device-only replay | per operation (pre-C3) | one transaction per batch | ratio |
|---|---|---|---|
| apply 20,000 operations, median of 4 | about 20.1 s | about 15.4 s | 0.80 |
| storage transactions | 20,003 | about 201 | |
| BEGIN / COMMIT | 6.1 to 7.0 s | 2.5 to 2.9 s | 0.42 |

After C3 the device's time is: content-id verification and other per-operation engine work about
a third, the fold about 30%, commits 16 to 18%, the rest under 20%. The live benchmark's full
scope (server in the same process) moved 0.56 to 0.95 per alternated round. The browser variant,
where each OPFS commit is a 10 to 15 ms fixed cost, is still to be measured.

## Merge (`@korajs/merge`)

| Gate | Target | Test file |
|------|--------|-----------|
| Merge 1,000 concurrent field ops | &lt; 500 ms | `packages/merge/src/benchmarks/performance-gates.test.ts` |
| LWW comparison | &lt; 1 µs | same |

## Sync (`@korajs/sync`)

| Gate | Target | CI limit (×1.1) | Test file |
|------|--------|-----------------|-----------|
| Initial sync 10,000 ops (mock store) | Completes | 38,500 ms | `performance-gates.test.ts` |
| Incremental sync 1 op | &lt; 200 ms | 220 ms | same |
| Version-vector delta (100 nodes) | &lt; 10 ms | 11 ms | same |

**Production target:** initial sync of 10,000 operations end-to-end in &lt; 5s with real `Store` + SQLite (CLAUDE.md). The CI gate uses in-memory mock stores and validates completion under a relaxed ceiling.

## Recording a new baseline

1. Run `pnpm benchmark:gates` on `main` after a clean `pnpm build`.
2. If a gate is consistently faster than the limit, tighten the constant in the test file (do not exceed 10% regression vs the recorded number).
3. Update this table and the plan checklist item **0.1.6**.

## Multi-tab storage

Leader election + `BroadcastChannel` RPC is covered by the multi-tab storage tests. SharedWorker-hosted SQLite is intentionally not a storage mode because OPFS SyncAccessHandle is dedicated-worker-only.
