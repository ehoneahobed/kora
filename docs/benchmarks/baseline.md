# Kora.js performance baseline

Targets from `CLAUDE.md` (repo root) with a **10% CI regression buffer** (`REGRESSION_FACTOR = 1.1`). Gates run on every PR via [benchmark-gates.yml](../../.github/workflows/benchmark-gates.yml).

## Run locally

```bash
pnpm benchmark:gates
```

**Note:** Store benchmark files are excluded from `pnpm test` (they run via `pnpm --filter @korajs/store test:benchmarks` inside `benchmark:gates`) so dev machines are not blocked by insert timing while the full suite runs in parallel.

## Store (`@korajs/store`)

| Gate | Target | CI limit (×1.1) | Test file |
|------|--------|-----------------|-----------|
| Insert 10,000 records | &lt; 2s | 2,200 ms | `performance-gates.test.ts` (better-sqlite3) |
| Insert 10,000 records (adapter protocol, native SQLite) | &lt; 2s | 2,200 ms | `wasm-adapter-protocol-gates.test.ts` |
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

Node measurements on the 2-core review container (October 2026, under load from parallel builds): check per mutation 0.21 to 0.30 ms; mutation to notification p50 1.2 to 3.1 ms, p95 4.4 to 7.7 ms; worst-case full re-run p50 20 to 38 ms; IndexedDB snapshot persist 10.8 ms.

## Store in a real browser (`benchmarks/browser/store-browser-bench.mjs`)

Runs the built `@korajs/store` in Chromium on Kora's dedicated worker, SQLite WASM and OPFS (`opfs-sahpool`), plus the IndexedDB fallback with its real snapshot persistence, and gates against the CLAUDE.md targets (×1.1). It also probes which journal modes `opfs-sahpool` accepts.

```bash
pnpm --filter @korajs/core --filter @korajs/store build
PW_CHROMIUM_PATH=/path/to/chromium pnpm --filter @korajs/store test:benchmarks:browser
```

It prints every measurement and exits 1 when a gate fails. It does not install a browser.

First measurements (headless Chromium 141, 2-core review container with load average 10 to 37 from parallel builds, so absolute numbers are pessimistic; two runs):

| Measurement | Run 1 | Run 2 | Target |
|---|---|---|---|
| OPFS open | 799 ms | 1,644 ms | -- |
| OPFS insert 10,000 (one transaction) | 8,826 ms | 11,399 ms | &lt; 2 s |
| OPFS single insert (app path, own transaction) | 91 ms | 98 ms | -- |
| OPFS query 1,000 rows WHERE | 128 ms | 68 ms | &lt; 50 ms |
| OPFS reactive notification p95 | 150 ms | 320 ms | &lt; 16 ms |
| OPFS 1,000 subscriptions: check per mutation | 0.23 ms | 0.30 ms | &lt; 1 ms |
| OPFS 1,000 subscriptions: mutation to notification p95 | 253 ms | 297 ms | &lt; 16 ms |
| IndexedDB 1,000 rows: persist snapshot | 169 ms | 105 ms | -- |
| IndexedDB 10,000 rows: persist snapshot | 892 ms | 4,171 ms | -- |
| IndexedDB 10,000 rows: persist after one more write | 1,126 ms | 1,894 ms | -- |

Only the subscription check met its target there. Each local insert is six worker round trips (begin, a read, three writes, commit) and one OPFS commit, and a raw one-row `opfs-sahpool` transaction alone took 12 to 38 ms on that host. Every IndexedDB snapshot rewrites the whole database, so its cost grows with the database, not with the write. Record a baseline on CI hardware before making this gate blocking.

**Journal mode (NEW-STORE-11):** `PRAGMA journal_mode = WAL` returns `delete` on `opfs-sahpool` (WAL needs shared memory, which that VFS does not implement). Kora no longer issues it; OPFS databases run with `delete`. On that host a one-row transaction cost delete 19 to 38 ms, truncate 12 to 24 ms, persist 14 ms, too noisy to justify a change; re-measure on quiet hardware before switching modes (`persist` and `truncate` keep the journal file, which holds a pool slot permanently).

**WASM / OPFS note:** CI exercises `SqliteWasmAdapter` + `MockWorkerBridge` (in-process SQLite). Real browser OPFS + worker latency is higher; record manual numbers when profiling templates (Chrome Performance, `kora doctor`).

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
