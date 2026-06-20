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
| Insert 10,000 records (WASM path) | &lt; 2s | 2,200 ms | `sqlite-wasm-performance-gates.test.ts` |
| Query 1,000 rows (WHERE) | &lt; 50 ms | 55 ms | `performance-gates.test.ts`, `sqlite-wasm-performance-gates.test.ts` |
| Reactive notification | &lt; 16 ms (1 frame) | 17.6 ms | `performance-gates.test.ts` |
| Subscription bloom check (5000 subs) | &lt; 1 ms | 2 ms (dev/CI slack) | `subscription-manager.test.ts` |
| IndexedDB 1,000 inserts (1 txn) | &lt; 10s | 11,000 ms | `indexeddb-performance-gates.test.ts` |

**WASM / OPFS note:** CI exercises `SqliteWasmAdapter` + `MockWorkerBridge` (in-process SQLite). Real browser OPFS + worker latency is higher; record manual numbers when profiling templates (Chrome Performance, `kora doctor`).

## Merge (`@korajs/merge`)

| Gate | Target | Test file |
|------|--------|-----------|
| Merge 1,000 concurrent field ops | &lt; 500 ms | `packages/merge/src/benchmarks/performance-gates.test.ts` |
| LWW comparison | &lt; 1 µs | same |

## Sync (`@korajs/sync`)

| Gate | Target | CI limit (×1.1) | Test file |
|------|--------|-----------------|-----------|
| Initial sync 10,000 ops (mock store) | Completes | 22,000 ms | `performance-gates.test.ts` |
| Incremental sync 1 op | &lt; 200 ms | 220 ms | same |
| Version-vector delta (100 nodes) | &lt; 10 ms | 11 ms | same |

**Production target:** initial sync of 10,000 operations end-to-end in &lt; 5s with real `Store` + SQLite (CLAUDE.md). The CI gate uses in-memory mock stores and validates completion under a relaxed ceiling.

## Recording a new baseline

1. Run `pnpm benchmark:gates` on `main` after a clean `pnpm build`.
2. If a gate is consistently faster than the limit, tighten the constant in the test file (do not exceed 10% regression vs the recorded number).
3. Update this table and the plan checklist item **0.1.6**.

## Multi-tab storage

Leader election + `BroadcastChannel` RPC is covered by `packages/store/tests/integration/multi-tab-storage.test.ts`. **SharedWorker** (single worker per origin) remains a stretch goal; see `isSharedWorkerStorageSupported()` in `@korajs/store` multi-tab module.
