# Design: first-visit parity (a Kora app is never slower than a regular web app)

Status: PROPOSED. Internal design doc (not published). Written against `main` at `aa834a9`
(2026-10-30). No product code is changed by this document; stage S0 (section 11) is a
measurement harness and is specified here exactly, not built. Every number in this document is
marked as **measured** (with its source) or **estimated** (with its arithmetic); S0 replaces the
estimates.

## 0. Summary

The goal, from Obed: someone opening a Kora-built product for the first time, or on a new
device, must not see any difference from a regular web app that fetches from a server. No slower
first screen, no waiting for data, no degraded feel. They get every offline benefit on top, and
never a degradation.

Today a first visit is serial. The browser downloads Kora's whole runtime with the app's entry
chunk, `KoraProvider` shows its fallback until `app.ready` (SQLite WASM fetched, compiled, OPFS
opened), the template connects sync only after that, and the first row of the home screen
arrives after the handshake and the first delivery batch. From the bytes and the recorded
component timings (section 1.2) the first home row on Slow 4G lands at an **estimated 7 to 9 s**
after navigation, against an estimated 1 s for a plain REST app rendering the same screen. The
C1.0(b) browser figure of 1.55 s does not contradict this: that harness starts its clock after
the database is open (finding F3).

The design makes the first visit behave like a regular web app first, and become an offline
app second, without the user waiting for the second:

1. **A parity contract** (section 2): a baseline app (plain React plus REST/JSON on the same
   server and data) and a Kora app render the same LMS screens; Kora must be within
   `max(10%, 100 ms)` of the baseline at p50 and `max(15%, 150 ms)` at p95 on every metric
   (first paint, first data, navigation, write latency, main-thread blocking), on Slow 4G, 4G
   and broadband, cold and warm. Warm, Kora must be at least as fast on every metric.
2. **Read-through** (5.4): while the local replica cannot answer a query completely, the query
   is answered by the server under the same grant the delivery stream uses (the server stays
   the trust boundary). Before the database is open, the answer renders straight from memory.
   Once it is open, the rows are **seeded** into the local store as temporary row snapshots
   (the existing RT-68 `_kora_fold_snapshot` mechanism), so local queries, writes and a reload
   all work on them.
3. **Background replication into a staging database** (5.7): the full scope replicates into a
   separate SQLite file with the rollback journal off and large time-sliced transactions,
   invisible to queries, and is merged into the main database in one step when it has caught
   up. The merge removes every seed. Seeds therefore never meet a remote operation newer than
   their frontier, so the final state is exactly `fold(all operations)`: convergence does not
   depend on the seeds being exact.
4. **A first-load payload no larger than the baseline's plus a small budget** (5.8): Kora's
   runtime, the SQLite WASM and the worker load after first paint at low priority, and the
   service worker precaches after first data, from the HTTP cache, without the duplicate
   `sqlite3.wasm`.
5. **Honest status** (5.10): "Getting ready for offline, 40%" until the merge, the completion
   mark and the shell are all in place; never `ready` early.

The decision that matters most is the split between (2) and (3). The UI always reads the local
store once it exists (one query engine, local writes included), the server only fills it, and
everything the server fills on demand is a disposable cache that the real replica replaces
wholesale. That keeps the correctness argument to one sentence (section 6, I3) and leaves the
gap-free delivery watermark, the fold and the access-rule stream exactly as they are.

C1 (whole-scope record snapshot) is **not on this path**: it would still wait for the WASM and
OPFS before the first row, and at the fixture's 1.8 operations per record it would take the
140 s full scope to about 78 s. Recommendation: take C1 out of the beta.15 critical path,
keep its design, and keep only its clock fix (R16), which seeds need too (section 5.13 and
decision D2).

## 1. Problem and measured baseline

### 1.1 What is measured

| Measurement | Value | Source |
|---|---|---|
| First home row from `app.sync.connect()`, Chromium, OPFS, Slow 4G, 20k-1 | 1.55 s median, 1.81 s p95 | **measured**, `fast-first-sync.md`, C1.0(b) |
| Same after C3b | home row 0.85 to 0.93 s (unthrottled) | **measured**, C3b result |
| Handshake, 100k log with five schools, before C2.5 | 1.67 s Slow 4G | **measured**, C1.0(b) |
| Full scope, 20,000 operations, Chromium OPFS, after C3b | 140 to 149 s (Slow 4G and unthrottled) | **measured**, C3b result |
| Device apply after C3b | 1.07 worker round trips per operation; about 3.9 ms per operation step inside SQLite writing pages through the OPFS rollback journal | **measured**, C3b result |
| Same fixture with `journal_mode = MEMORY` (unsafe experiment) | batch busy time 7.7 s to 0.39 s, total 11.5 s to 4.0 s (small fixture) | **measured**, C3b result |
| OPFS `insertMany` 10,000 records in one transaction | 1,675 ms | **measured**, `docs/benchmarks/baseline.md` |
| OPFS open | 799 ms (older host) | **measured**, `baseline.md` |
| OPFS single insert, own transaction | 34 ms; reactive notification p95 61 ms; with `instantUpdates` under 16 ms | **measured**, `baseline.md` and `instant-ui-updates.md` |
| `sqlite3.wasm` (`@sqlite.org/sqlite-wasm` 3.51.0-build1) | 854 KB raw, 395 KB gzip | **measured** here (`gzip -9`) |
| `react-tailwind-sync` template, `vite build` from the beta.14 packed tarballs | entry chunk 1,193 KB raw, **346 KB gzip**; SQLite glue chunk 197 KB raw, 59 KB gzip; worker 24 KB raw, 8.5 KB gzip | **measured** here (`gzip -9` of `dist/assets`) |
| `react-dom/client` 19.3 production build | 625 KB raw, 111 KB gzip unminified; a minified React plus ReactDOM app chunk is commonly about 60 KB gzip | **measured** (raw) / **estimated** (minified) |
| Service worker precache list of that template | every asset, fetched with `cache: 'reload'`, including the WASM twice (`sqlite3-<hash>.wasm` and the unhashed `sqlite3.wasm`) | **read** from `dist/sw.js` and `packages/cli/src/vite/service-worker.ts` |

### 1.2 The first visit, step by step (code path, with an estimated critical path)

What runs on a first visit of the template (`main.tsx` calls `app.ready.then(() => app.sync?.connect())`
and wraps the app in `<KoraProvider fallback="Loading...">`):

| Step | Code | Slow 4G estimate (200 KB/s down, 150 ms per request) |
|---|---|---|
| HTML | static server | 0.15 s |
| Entry chunk with all of Kora (346 KB gzip) and CSS | Vite entry | about 1.9 s, then about 0.15 s parse and execute |
| First paint | `KoraProvider` renders `fallback` ("Loading..."), not the app | at about 2.1 s, and it shows no data |
| Worker script, SQLite glue (59 KB), `sqlite3.wasm` (395 KB) | `sqlite-wasm-adapter.ts` spawns the worker; `sqlite-wasm-worker-core.ts` `import('@sqlite.org/sqlite-wasm')`; `loadSqliteModule` | about 2.8 s of transfer, plus compile |
| Service worker install starts at `load` | template `index.html`, `cache.addAll(... cache: 'reload')` | competes for the same link from about 2.1 s on, re-downloading about 1.7 MB gzip |
| OPFS open, DDL | `openOpfs`, `applyDdl` | 0.3 to 0.8 s |
| `app.ready`, then `connect()` | template `main.tsx` | WebSocket upgrade 0.15 to 0.3 s |
| Handshake, first batch, first home row | C2 and C3b path | about 1 to 1.5 s (measured from `connect()`) |
| **First home row** | | **about 7 s, 9 s with the precache competing** |
| Full scope | C3b | about 140 s more (measured) |

A plain React SPA that fetches the same list: HTML 0.15 s, a 60 to 70 KB gzip entry about
0.5 s, then one authenticated `GET` (about 0.2 s): first paint at about 0.7 s and the first row
at about **1.0 s** (estimated). The estimated gap is 7x to 9x on the first screen, and every
later screen of a first session that needs data the replica does not hold yet waits for the
stream (finding F5).

### 1.3 Findings from reading the code

- **F1. The provider gates the whole UI on the database.** `packages/react/src/context/kora-context.ts`
  returns `fallback` while `app.ready` is pending, and `kora/src/collection-accessor.ts` throws
  `AppNotReadyError` from `where()` before the store opens. Nothing can render data, from any
  source, before the WASM is compiled and OPFS is open.
- **F2. Sync starts after the database opens.** The templates connect in `app.ready.then(...)`,
  and the engine needs the store (node id, watermark, version vector) for its handshake.
- **F3. The browser benchmark's clock starts late.** `packages/test/bench/browser/page/page-entry.ts`
  boots `createApp` (database open) unthrottled, idles one second, then starts `t0` at
  `connect()`. Its "first home row" excludes page load, the runtime and WASM download, the
  compile and the OPFS open, which are most of a real first visit. It answers "how fast is sync
  once the app is up", not "how fast is the first visit".
- **F4. The precache doubles the first-visit download.** `packages/cli/src/vite/service-worker.ts`
  registers at `window.load` and precaches every asset with `cache: 'reload'`, so the entry
  chunk and the WASM, already fetched by the page, are fetched again, and the WASM a third time
  through its unhashed alias. On Slow 4G that is several seconds of bandwidth taken from the
  first data.
- **F5. Navigation in a first session backfills a new view from zero.** In the default
  `querySubsets: 'reactive'` mode each live query's equality filter is a sync subset
  (`kora/src/sync-query-bridge.ts`, `SyncEngine.registerQuerySubset`). A new screen widens the
  subset set, which is a new delivery view: the engine reconnects after a 500 ms debounce
  (`scheduleQuerySubsetReconnect`) and the new view starts at watermark 0
  (`switchDeliveryViewWithInheritance` inherits only when the new set is narrower). C1.0(b)
  measured the cost of the first such reconnect (handshake 0.93 s against 0.55 s, up to twice
  the batches). Every widening navigation of a cold session repeats it.
- **F6. Background replication already degrades interaction.** A delivery transaction holds the
  worker for its whole span (`TransactionSerializingWorkerBridge`); at about 3.9 ms per
  operation step a 100-operation batch is about 0.4 s and a 500-operation chunk
  (`MAX_DELIVERY_TRANSACTION_OPERATIONS`) about 2 s, during which a local write or a live query
  re-run waits. This is an inference from the C3b numbers; S0 measures it (metric P7).
- **F7. Applying a record costs the same order as applying an operation.** After C3b the floor is
  journal and page I/O per step, not round trips. C1 changes the number of steps by the
  operations-per-record ratio (1.8 on the fixture), not the cost per step.

## 2. The parity contract

### 2.1 The baseline

"A regular web app" is fixed as a concrete program, so the comparison cannot drift:

- The same screens, built from the same React components (a shared `screens.tsx`), the same
  React version, the same CSS, built with `vite build` in production mode.
- Data from a plain REST/JSON API served by **the same server process and the same database**:
  custom routes on the same `KoraSyncServer` using `RouteContext.query` with the token's scope
  (`packages/server/src/server/route-context.ts`), so the server-side read cost, the grant and
  the rows are identical. Responses are gzip or brotli, HTTP/1.1 keep-alive, same origin.
- Client behavior of a well-built SPA: fetch on route enter, an in-memory per-session cache keyed
  by URL (back navigation is instant, as with a typical query library), no service worker, no
  offline support, non-optimistic writes (`POST`, then the row appears from the response).
- The same auth: a bearer token in `localStorage`, the same `TokenAuthProvider` grant
  `{ schoolId }`.

The Kora app is the same components with `useQuery` and `useMutation`, `createApp` with default
options (only `sync.url` set), the `koraServiceWorker()` plugin, and `<KoraProvider>`.

### 2.2 Metrics

Measured in Chromium per run, from `performance.timeOrigin` (navigation start) unless noted:

| Id | Metric | Definition |
|---|---|---|
| P1 | First paint of the app | `first-contentful-paint` of a DOM node marked `data-app-shell` (a placeholder such as "Loading..." does not count) |
| P2 | First data | the first row of the opened screen's primary list is in the DOM |
| P3 | Screen complete | every row of that screen's primary query (up to its page size) is in the DOM, with values equal to the server's |
| P4 | Navigation, cold | click to the first row of a screen not opened before on this device |
| P5 | Navigation, warm | click to the first row of a screen opened earlier in the session (baseline: its in-memory cache) |
| P6 | Write | click to the written row in the DOM |
| P7 | Interaction during preparation | P4 and P6 measured while Kora is still preparing for offline (replication in flight), and a live query re-run after a write |
| P8 | Main-thread blocking | total blocking time (sum of task time above 50 ms) from navigation to 30 s |
| P9 | Bytes before first data | bytes received before P2 |

Kora-only targets (no baseline exists for these):

| Id | Target |
|---|---|
| K1 | Offline-ready (`app.offline.status().state === 'ready'`, which includes the shell) on the 20k-1 fixture: Slow 4G at most 30 s, 4G at most 10 s, broadband at most 8 s, with every P metric still inside its margin while it happens |
| K2 | No Kora task on the main thread over 50 ms during preparation; SQLite worker slices at most 32 ms while a foreground request is queued |
| K3 | Critical-path JavaScript added by Kora over the baseline: at most 20 KB gzip (about 0.1 s on Slow 4G) |

### 2.3 Conditions

- Network (CDP `Network.emulateNetworkConditions`, applied **before** navigation):
  `slow-4g` 150 ms, 1.6 Mbit/s down, 750 kbit/s up (the D8 preset); `4g` 60 ms, 9 Mbit/s,
  1.5 Mbit/s (the Node benchmark's `fast-4g`); `broadband` 20 ms, 50 Mbit/s, 10 Mbit/s.
- Temperature: **cold** is a new browser context (empty HTTP cache, OPFS, service worker,
  storage; a new device); **warm** is the same context reopened after the first session has
  finished (Kora offline-ready; the baseline's HTTP cache warm).
- CPU: unthrottled gates; `Emulation.setCPUThrottlingRate(4)` (a mid-range phone) is reported
  and becomes a gate after the first release that meets the unthrottled contract (decision D1).
- Fixture: the LMS fixture with a `relations` option (S0), `20k-1` and `20k-5`.

### 2.4 The margin and the pass rule

For every metric P1 to P8, every network profile and both temperatures:

```
kora.p50 <= baseline.p50 + max(0.10 * baseline.p50, 100 ms)
kora.p95 <= baseline.p95 + max(0.15 * baseline.p95, 150 ms)
```

For P8 the margin is `+50 ms` of total blocking time. For P9 Kora may exceed the baseline by
K3's 20 KB plus the read-through envelope. Warm, Kora must be **at or below** the baseline at
p50 on P2 to P6 (local data has no network on its path, so anything else is a bug). The absolute
floors (100 ms, 150 ms) keep a 30 ms metric from failing on noise. A cell passes only if both
quantiles pass; the contract passes only if every cell passes. Runs alternate the two apps, at
least seven per cell (section 11, S0).

### 2.5 Today against the target (estimates until S0)

| Cell (Slow 4G, cold) | Baseline (est.) | Kora today (est.) | Contract limit (p50) |
|---|---|---|---|
| P1 first app paint | 0.7 s | about 2.1 s, and it is a placeholder; first real app paint is P2 | 0.8 s |
| P2 first data | 1.0 s | 7 to 9 s | 1.1 s |
| P4 cold navigation | 0.3 to 0.5 s | first visit: blocked behind the stream; reactive mode: reconnect plus backfill | 0.4 to 0.6 s |
| P6 write | 0.35 s (one round trip) | 0.04 to 0.06 s committed (0.016 s with `instantUpdates`) once ready; a write before ready throws or waits | 0.45 s |
| K1 offline-ready | n/a | about 150 s (140 s data, plus the shell) | 30 s |

## 3. Goals and non-goals

**Goals**

- G1. The parity contract (section 2) holds for any app that uses `KoraProvider` and the hooks,
  with default configuration. The developer writes nothing new.
- G2. No loss, no divergence: the device converges to exactly the state it reaches today
  (rows, fold states, logs, version vector, watermark), whatever happens during the first visit.
- G3. The server never returns more than the delivery stream would give this session.
- G4. Offline is still the default state once ready: after the first visit, the app opens,
  reads and writes with no network exactly as today, and nothing in this design adds a network
  dependency to that path.
- G5. Honest status: nothing claims offline readiness, completeness or "saved" before it is true.

**Non-goals**

- Server-side rendering or HTML-inlined data (section 4, option H).
- First-visit parity for end-to-end encrypted collections: the server holds no plaintext to read
  through (5.12). They keep today's behavior, and the status says so.
- A first visit with no network (impossible; unchanged).
- Making background replication cheaper on the server (C2 already did); this is about the device.

## 4. Options considered

| Option | What it would give | Verdict |
|---|---|---|
| A. Faster replication only (C3c page I/O, or more of C3b) | Full scope faster. First data still waits for the runtime, the WASM, OPFS and the handshake: about 5 s on Slow 4G even with an infinitely fast apply (section 1.2). | Rejected as the answer; kept as part of the chosen design (5.7). |
| B. C1 whole-scope record snapshot | Full scope divided by operations per record (1.8 here, so about 78 s instead of 140 s). Same wait for WASM and OPFS before the first row. Largest correctness surface in the workstream (15 red-team cases, blockers R16 to R19). | Rejected for the first visit (5.13). |
| C. Demand-driven priority replication through query subsets (exists: `reactive`) | The visible collection subset replicates first. Each widening navigation reconnects and backfills a new view from zero (F5); throughput stays operation replay (about 140 operations per second); every view has its own watermark, so background completion keeps restarting. | Rejected as the mechanism. Within one full-scope stream, priority adds nothing once read-through answers the visible queries. |
| D. Priority lanes inside one stream (server reorders delivery by the client's visible queries) | Visible records first, one view. Breaks the gap-free watermark: delivery must be in sequence order for "everything at or below W is applied" to hold, and out-of-order delivery is exactly what `durable-delivery.md` removed. | Rejected. |
| E. Display-only read-through (server answers kept in memory, never written to the store) | Simple, no store change. A write to a displayed record cannot fold (no insert on the device, so the row hides), a reload offline shows nothing, every query is fetched twice. | Rejected as the end state. It is exactly the **pre-ready phase** of the chosen design (5.4.6). |
| F. Read-through seeding the server's exact fold state (C1 per query) | Exact merge state from the first row. Needs the two-phase fold-plan negotiation, the compact encoding, the disclosure decision (open question 3 of `fast-first-sync.md`, M14), and the resume/restart machinery. Its only gain over temporary row snapshots is exactness in the window before the merge, and seeds are discarded at the merge anyway. | Rejected for v1; a possible upgrade if the window ever matters (risk 7). |
| G. A server-built database image per device (download a ready SQLite file of the scope) | No device apply at all. Couples the server to the client store schema and version, costs server CPU per user and scope, needs integrity checks of a binary blob, and cannot hold the device's own unsent writes. | Rejected for now; noted. |
| H. SSR or initial data inlined into the HTML | The baseline's own trick for first paint. Kora is UI-agnostic and has no route-to-query manifest; it would couple Kora to a rendering framework. | Rejected (non-goal). |
| I. Bulk load into the main database with `journal_mode = MEMORY` or `OFF` | About 20x cheaper apply (measured experiment). A crash during a transaction can corrupt the main database, which holds the user's unsent writes. | Rejected: data is sacred. |
| J. Bulk load into the main database with large journaled transactions | Most of the page-I/O amortization (like `insertMany`: 10,000 records in 1.7 s). Each transaction holds the worker for seconds, so writes and queries wait (F6). | Rejected as the default; it is the fallback where staging cannot be used (5.7.6). |
| K. **Chosen**: read-through answered by the server under the delivery grant, rendered from memory before the store opens and seeded as temporary row snapshots after; full-scope replication into a staging database (journal off, large time-sliced transactions), merged once it has caught up; lazy runtime and WASM; precache after first data. | First data and navigation cost what a REST fetch costs; full scope bounded by bytes and a much cheaper apply; seeds disposable, so convergence is today's. Costs: a server read endpoint (a second read path to secure), a query evaluator on the server, a staging lifecycle in the store, a bundle split. | **Chosen.** |

## 5. Chosen design

### 5.1 Timeline

After (Slow 4G, cold, estimates for the design; S0 and the stage gates measure them):

```
t=0.00   navigation
t=0.15   HTML
t=0.15   critical JS: React + app + korajs "lite" (<= 20 KB gzip over the baseline)       (~0.5 s)
t=0.70   first app paint; components call useQuery(app.courses.where(...))
t=0.70   read-through POST {queries} with the bearer token  -> server: grant, rows, frontier F
t=1.00   first data: rows rendered from the in-memory answer (pre-ready phase)
t=1.0+   low priority: Kora runtime chunk, worker, SQLite glue, WASM (yield to foreground fetches)
t~4.5    store open: answers seeded into the main database in one transaction; queries switch
         to local SQL (same rows); writes now commit locally
t~4.6    sync connects (bulk mode): full scope streams into the staging database
t~5      service worker precache starts (idle, HTTP cache, no duplicates)
t~14     staging caught up -> merge into main (chunked, journaled), seeds dropped, completion mark
t~20     shell installed -> "Available offline"
```

Navigation at any time before the merge: the new screen's queries are cold, so they read
through (one request, as the baseline's fetch) and render; after the merge every query is local.

### 5.2 Components

| Component | Where (proposed) | Role |
|---|---|---|
| Query evaluator, shared | move `packages/store/src/overlay/query-eval.ts` to `packages/core/src/query/query-eval.ts`; `@korajs/store` re-exports it | Client SQLite semantics in JS (`checkPatchable`, `matches`, `compare`), already proven by the instant-updates differential suite. The server uses it to filter and order (5.4.3). |
| Read grant, shared | `packages/server/src/read/read-grant.ts`, extracted from `ClientSession` (`withAccessGrant`, `readGrantedIntervals`, `sessionDownlinkScope`, `accessUnenforceable`, `observeIndexStateAfterRead`) | One function computes a principal's downlink scope; the session and the read endpoint both call it. |
| Read endpoint | `packages/server/src/read/read-through.ts`, mounted at `<syncPath>/read` by `KoraSyncServer.handleHttpRequest` and `production-server.ts` | Authenticates per request, executes queries (5.4), returns rows, frontier and completeness. |
| Read client | `packages/sync/src/read/read-through-client.ts` | `fetch` with the same credentials as sync (`sync.auth` or `authClient`), batching, retries, abort. No store dependency, so it is in the lite entry. |
| First-visit controller | `kora/src/first-visit/` (`controller.ts`, `coverage.ts`, `deferred-query.ts`, `pre-ready-writes.ts`) | Coverage decisions, pre-ready answers, seeding, refresh, status inputs. |
| Seeds | `packages/store/src/seed/seed-store.ts`, new table `_kora_seed`; reuses `FOLD_SNAPSHOT_TABLE` and `createSnapshotState` | Store, re-fold, drop. |
| Staging | `packages/store/src/staging/` (`staging-store.ts`, `staging-merge.ts`); worker support in `sqlite-wasm-worker-core.ts` (second database handle, journal off) | Bulk replication target and the merge. |
| Sync engine bulk mode | `packages/sync/src/engine/sync-engine.ts` | Apply into the staging store, flow control, time slicing. |
| Wire | `packages/sync/src/protocol/messages.ts` | Additive: `delivery-flow` (pause/resume), handshake `bulk: true`. |
| Lazy runtime | `kora/src/index.ts` split into a lite entry and `kora/src/runtime.ts` loaded by `import()` | K3 budget. |
| Provider and hooks | `packages/react/src/context/kora-context.ts`, `hooks/use-query.ts`; Vue and Svelte equivalents | Render before ready; optional `source` and `complete` on `useQueryState`. |
| Precache | `packages/cli/src/vite/service-worker.ts` | Install after first data, HTTP cache for hashed assets, one copy of the WASM. |

### 5.3 Phases of a first visit

| Phase | Store | Queries read | Writes | `offline.status()` |
|---|---|---|---|---|
| P0 shell | none | nothing yet | queued (5.9) | `preparing`: `storage-opening`, `data-incomplete`, `shell-installing` |
| P1 pre-ready | opening | read-through answers in memory | queued, shown if predicted | same |
| P2 seeded | open; main holds seeds and local writes only | local SQL; cold queries read through, then seed | local, instant | `preparing`, data progress from the stream |
| P3 replicating | staging streams, main unchanged | local SQL (seeds, local writes) | local | `preparing`, progress |
| P4 merged | main is the replica; no seeds | local SQL, as today | local | `ready` once shell and auth hold |

A returning device skips P0 and P1 (its runtime is precached and its store opens from OPFS) and
is in P4 unless its replica was never completed, in which case it resumes P2 to P4.

### 5.4 Read-through

#### 5.4.1 Request and response

`POST <syncPath>/read`, `Authorization: Bearer <token>` (exactly the credential the sync
handshake would send), body:

```ts
interface ReadRequest {
  v: 1
  schemaVersion: number
  queries: Array<{
    key: string                       // client's descriptor hash
    collection: string
    where: WhereClause                // the local query language: $eq $ne $gt $gte $lt $lte $in
    orderBy: OrderByClause[]
    limit?: number
    offset?: number
    include?: string[]                // relation names, depth 1
    known?: string[]                  // ids the device would show for this query from seeds (5.4.5), at most 1,000
    cursor?: string                   // continue a partial answer
  }>                                  // at most 8 per request
}

interface ReadResponse {
  frontier: number                    // F: delivery counter read AFTER the rows (5.4.4)
  grantKey: string                    // hash of the grant the rows were read under
  results: Array<{
    key: string
    status: 'ok' | 'partial' | 'unsupported' | 'denied'
    records: ReadRecord[]             // primary collection, in client order
    included: Record<string, ReadRecord[]>
    absent: string[]                  // `known` ids the session may not read now, or that do not exist
    cursor?: string                   // when partial
  }>
}

interface ReadRecord {
  id: string
  values: Record<string, unknown>     // schema fields, the delivery wire form
  fieldVersions: Record<string, HLCTimestamp>
  created: HLCTimestamp
  latest: HLCTimestamp
}
```

Responses carry `Cache-Control: no-store, private` and `Vary: Authorization, Cookie`, never a
`Set-Cookie`. Errors: 401 (credential), 403 (a collection the grant denies is answered per query
as `denied`, never as a request error, so one denied query cannot hide others), 409
`ACCESS_RULES_CHANGED` (retriable, the access index is rebuilding), 413 (limits), 429 (rate).

Why HTTP and not a WebSocket message: the read must run before the store, the node id and the
handshake exist (P0, P1), it must multiplex with page assets on HTTP/2, and the long-poll
transport already authenticates every HTTP request against the session principal
(`KoraSyncServer.handleHttpRequest`, RT-2), so the request authentication code exists. A
WebSocket `read-request` message on a live session is a later optimization (it reuses the
session's compiled grant); it is not needed for parity because after the merge nothing reads
through.

#### 5.4.2 The grant (the server is the trust boundary)

The endpoint authenticates the token with the server's auth provider, builds the `AuthContext`,
and computes the downlink scope with the same extracted function the session uses
(`read-grant.ts`): the provider's scopes, narrowed by access rules compiled from the membership
index (`withAccessGrant`). It refuses retriably, as every session send path does, when access
rules are not in force (`accessUnenforceable`: index rebuilding, generation changed, rules
fingerprint unknown). After reading the rows it re-reads the access index state
(`observeIndexStateAfterRead`) and the user's membership high-water mark; if either changed, it
discards the result and retries once, then answers 409. A read therefore never returns rows
under a grant older than the newest committed membership change at the moment of the read.

A query's client `where` only narrows: the server evaluates `scope AND where`. A collection the
grant denies, a collection whose read rule is `serverOnly`, and a collection the client has
sealed (end-to-end encryption, signalled by the server's per-collection marker once R27 adds it,
and by the client never sending such a query) answer `denied` or `unsupported`.

#### 5.4.3 Executing a query on the server (SQLite and Postgres parity)

1. **Candidates.** `RouteContext`-style scoped read: the scope's string equalities and one
   string `$in` pushed into `queryCollection` (as `recordsMatching` and `splitScopeForQuery` do
   today), plus the query's own string equalities. At most `maxCandidates` (default 10,000) rows
   are read; past that the result is `partial`.
2. **Filter and order in JavaScript**, with the shared evaluator: `matches` for the scope branch
   (`recordMatchesCollectionScope`) and for the query's `where`, `compare` for its `orderBy`, then
   `offset + limit`. SQL never decides membership or order, so SQLite and Postgres cannot differ
   (collation, `NULL` placement, boolean and number affinity): the evaluator was built to equal
   the client's SQLite and is differential-tested against `better-sqlite3` and the WASM mock.
3. **Shapes the evaluator refuses** (`checkPatchable` false: a non-scalar field in `where` or
   `orderBy`, an over-long `$in`, an operand type mismatch): the server returns every scoped
   candidate (up to the cap) as a superset. The client's own SQL decides after seeding. Before
   the store opens such a query has no in-memory answer and renders when the store opens.
4. **Include.** For each relation in `include` (depth 1), the related records are read by their
   key (`many-to-one`: the parent ids of the primary rows; `one-to-many`: children whose field is
   in the primary ids, capped), each under **its own collection's** grant. Related records the
   grant denies are omitted, as delivery omits them.
5. **Pagination.** An answer with more rows than `maxRows` (default 500) or `maxBytes` (default
   1 MiB) is `partial` with a cursor; the client fetches the rest in the background, at most
   `maxQueryRows` (default 5,000) per query, and reports the query incomplete until then (5.5).
6. **SQL pushdown** of `orderBy` and `limit` is a later optimization (S7), allowed only for shapes
   where a differential test proves SQLite and Postgres (`COLLATE "C"`, explicit `NULLS FIRST`)
   equal the evaluator.

#### 5.4.4 The frontier F

The server reads the rows, then reads the delivery counter (on Postgres the committed maximum,
as the delivery stream does). Every operation a returned row reflects committed before the row
was read, so its delivery sequence is at most F. That is the only property seeds need (5.6). F
is not a snapshot point (rows of one answer may reflect slightly different moments), which is
fine because seeds are a cache that the merge replaces.

#### 5.4.5 Consistency between answers, and with the replica

Before the merge, the main database holds only seeds and the device's own writes (5.7), so the
only mixing is between answers taken at different frontiers. Two rules make that safe:

- A seed is replaced only by a newer answer for the same record (higher F).
- Every refresh of a query sends `known`: the ids the device would show for it from seeds. The
  server answers each with its current values (so a record that moved out of the query is
  re-seeded with values that no longer match) or lists it in `absent` (gone, or no longer
  readable). An `absent` seed is deleted and its row removed, unless the record has an unsent
  local write (then it is kept, as an access narrowing keeps such records, and the server judges
  the upload). `absent` does not distinguish "deleted" from "not readable", so it is no oracle.

After the merge the replica is complete and nothing reads through, so a query never mixes
replicated rows at W with server rows at F.

#### 5.4.6 Before the store opens (P1)

A subscription created before `app.ready` is a deferred query (5.9, 9). The controller sends
its descriptor in the next read-through request (requests from one render are coalesced into one
`POST` per animation frame) and delivers `records` to the subscriber in the server's order,
which the evaluator made equal to the client's. When the store opens, the controller seeds every
held answer in one transaction, then attaches each subscription to the store; the first local
result replaces the in-memory one (equal, so no visible change; a difference is reported as
`read:handoff-diverged` in development).

#### 5.4.7 Freshness while cold

Read-through answers are stale-while-revalidate, which is what the baseline's client does and
more: a query's answer is refreshed on re-subscribe (navigation back to a screen), on window
focus, and every 30 s while it is visible and the device is not yet merged. The local rows show
immediately; the refresh replaces them. Local writes show at once regardless (they are local).
Server push of invalidations for cold queries is a later refinement (S7); a REST app has none.

#### 5.4.8 When the network drops during a cold start

| When | What the user sees | Afterwards |
|---|---|---|
| Before any answer | the screen's `useQueryState()` reports `source: 'pending'`, `ready: false`, and `error` with `NETWORK_UNAVAILABLE` after the request fails; the app shows its offline state (a REST app shows an error too) | the request is retried with backoff when `online` fires |
| After answers, before the store opens | answered screens keep rendering from memory; new screens are pending | if the WASM was already fetched the store opens and seeds; otherwise the store cannot open (`WorkerInitError`, F15) and the status says so |
| After seeding (P2, P3) | seeded screens work, including after a reload offline (the seeds are in OPFS); writes are local and durable | replication resumes when the network returns |
| During the merge | nothing visible: the merge is local | the merge completes offline |

### 5.5 Coverage: "complete enough to answer locally"

The controller decides, per subscription, where its rows come from:

- **local**: every collection the query reads (its collection and its `include` collections) is
  covered by the completion mark of the full-scope view (`offline_complete:<signature>`,
  `docs/design/offline-readiness.md` section 4.1). After the merge this is every query. A
  returning device whose replica is complete but far behind (weeks offline) is `local` too: it
  shows its stored rows at once and catches up through the stream (decision D11 and red team V27
  discuss reading through instead).
- **seeded**: the store is open and the query has a read-through answer with `status: 'ok'` taken
  under the current grant key. The local SQL result is complete as of that answer's F (5.4.5).
- **partial**: as seeded, but the answer was `partial` or `unsupported`; rows are shown, the query
  is marked incomplete, and more pages are fetched in the background.
- **cold**: none of the above; a read-through request is issued.

The coverage is exposed as two optional fields of `useQueryState()` (section 9):
`source: 'local' | 'server' | 'pending'` and `complete: boolean`. `useQuery` itself is unchanged.

Completion marks are never written by read-through: seeds are not delivery units, and only the
merge (which carries the staging stream's completion) sets the mark (5.7.4).

### 5.6 Seeds

#### 5.6.1 What is stored

In one storage transaction per answer (or per batch of held answers when the store opens):

1. For each record without a local seed or with an older one: `clock.receive(latest)` (R16 of
   `fast-first-sync.md`, the same validation as any remote timestamp). A timestamp the clock
   refuses (`InvalidTimestampError`, `RemoteClockDriftError`) is not seeded: the record stays
   display-only for its query and `read:seed-refused` is emitted.
2. `createSnapshotState({ collection, recordId, values, fieldVersions, created, latest,
   deleted: false }, schema, { authoritativeNodeIds })` (`packages/core/src/fold/snapshot.ts`):
   every field at its own version with the sentinel operation id that sorts after any real id.
3. `INSERT OR REPLACE` into `_kora_fold_snapshot`, and into the new
   `_kora_seed (collection, record_id, frontier, grant_key)` table, which marks the snapshot as a
   seed and holds its F.
4. Re-fold the record as `join(base, snapshot, fold(log))` (the existing rule) and materialize
   its row. On a first-visit device the base is empty and the log holds only local operations.
5. Publish after commit, as remote applies do, so live queries re-run once.

A seed is never written over a record that has remote history in the main database or a
non-seed snapshot (RT-68), and never after the merge.

#### 5.6.2 Why a row snapshot and not the server's fold state

The row snapshot is exact for everything that has already happened (the values are the server's
at F, every field dominates the operations it reflects) and approximate only for an operation
older than a field's version that arrives later (RT-68 residual). Such an operation can only
arrive from the delivery stream, and the stream does not touch the main database before the
merge, which deletes every seed first (5.7.4). Local operations are always newer than the seed
stamps because the clock received them. So the approximation is never exercised. In exchange the
seed needs no fold-plan negotiation, no compact encoding, and discloses only values and
per-field versions, which scope entries already disclose (RT-27).

#### 5.6.3 Local writes on seeded records

A local update builds `previousData` from the seeded row, as from any row, and folds on top of the
snapshot: its HLC is above the snapshot stamps, so it wins every register; a counter delta adds
to the seeded value; a delete tombstones. The operation is logged, queued and uploaded as usual.
At the merge the record is re-folded from the union of the staging log and the local log,
without the seed, so the result is exactly `fold(remote ∪ local)`.

#### 5.6.4 Lifetime

Seeds are deleted:

- by the merge (5.7.4), always, all of them;
- by `absent` in a refresh (5.4.5);
- by a grant change: when a read or the sync handshake reports a `grantKey` different from a
  seed's `grant_key`, every seed of the old key that has no local write is deleted, and the
  visible queries read through again (a revoked membership must not leave seeded rows behind);
- by sign-out, user switch, `forceFullResync`, `reloadFromDisk`, backup restore and
  `deleteDatabase` (the same clear points as instant updates I12).

A seed whose record carries a local write and which the merge finds without remote history
(the record is outside the replicated view, for example a static subset that excludes it) is
kept as an ordinary RT-68 snapshot, flagged approximate, and reported (`read:seed-orphaned`):
dropping it would hide the user's own edit (red team V8).

### 5.7 Background replication

#### 5.7.1 One full-scope view

Replication downloads the session's whole downlink scope as one delivery view, with one
watermark. Read-through replaces what reactive query subsets were for on a first visit (getting
the visible data first), without their per-navigation reconnect and backfill (F5). The default
of `sync.querySubsets.mode` becomes `'disabled'` when the server supports read-through (decision
D3); `'static'` and `'reactive'` keep working, and `keep()` pins are unchanged. An app whose scope
is too large to replicate (the server reports an estimate at handshake; a development warning
past 200,000 operations) keeps using static subsets.

#### 5.7.2 Staging database

On a device whose full-scope view has never completed, the engine applies delivery batches to a
**staging store**: a second SQLite database file in the same OPFS pool (`<db>-staging`), opened
by the same worker as a second handle, with the same schema and internal tables
(`Store` instantiated over a staging adapter handle, so `applyRemoteBatch`, C3b prefetch and the
fold run unmodified), and with:

- `PRAGMA journal_mode = OFF`, `PRAGMA synchronous = OFF`: no rollback journal, no syncs. This is
  where the measured 20x of the `MEMORY` experiment comes from, without risking the main database.
- No developer-declared secondary indexes (only the indexes the apply path reads); they are built
  in main by the merge's inserts.
- Transactions sized by time, not count: a slice applies as many operations as fit in about 16 ms
  of worker time (expected 50 to 100 operations), then yields so queued foreground requests
  (queries, local writes, seeding) run (K2). Batches from the server are larger in bulk mode
  (`batchSize` 1,000 when the handshake says `bulk: true`) and are applied in slices.
- Its delivery watermark, version vector and quarantine rows live in the staging database.

The staging store is never read by queries. It is trusted only within one worker lifetime: the
worker tags it with an in-memory epoch at creation, and any reopen (crash, reload, worker
replacement) deletes it and starts again from the main database's watermark. With journaling
off, a torn staging file is possible after a crash; deleting it is the whole recovery.

#### 5.7.3 Flow control: replication yields to the foreground

The engine sends `delivery-flow { paused: true }` while a read-through request is in flight or a
navigation happened in the last 500 ms, and `{ paused: false }` after. The server finishes the
batch in flight and sends nothing more until resumed (an additive v2 message; an older server
ignores it and the device only loses the yielding). On the device, staging slices also yield to
the main thread (`scheduler.yield()` or a `MessageChannel` hop) between slices, since the fold's
JavaScript runs there.

#### 5.7.4 The merge

When the staging stream reaches `streaming` (caught up) **and** its watermark is at or above the
largest seed frontier, the engine merges. In the main database, in chunks of one collection each
(each chunk one journaled transaction of at most about 100 ms), then a final transaction:

1. Copy staging rows, `_kora_ops_<c>`, `_kora_fold_state`, `_kora_fold_base`, provisional ops,
   retraction markers and quarantine rows for records the main database does not hold
   (`INSERT ... SELECT` over an `ATTACH` of the staging file, inside the worker; if `opfs-sahpool`
   cannot attach a file another handle has open, the staging handle is closed first, and if
   `ATTACH` is unavailable the worker copies in pages through its two handles).
2. For records the main database does hold (seeds and records with local operations): append the
   staging operations to the main log, delete the seed snapshot and `_kora_seed` row, and re-fold
   from `base` and the union log; materialize with the staging retraction markers applied in
   delivery order.
3. Final transaction: merge the version vector (per-node max), set the full-scope view's
   watermark to the staging watermark, write the completion mark (`saveDeliveryWatermarkInTx`
   with the `OfflineCompletion`), delete any remaining seed, and drop the staging file after
   commit.

A crash between chunks leaves earlier chunks in main under the old watermark. On restart staging
is gone and replication into a new staging resumes from the old watermark; operations already in
main are duplicates, skipped by content id, exactly the guarantee of today's chunked batches.
Records copied without their final chunk are re-folded from their log when the new staging merges.

After the merge the device is an ordinary Kora device: the engine leaves bulk mode and applies
live batches to main as today (C3b path).

#### 5.7.5 What forces a fallback to today's path

The staging path is a fast path with the old path as fallback, like C3. It merges early and
continues in main with today's path when a batch carries an access narrowing, a retraction of a
record with an unsent local write, encrypted operations, or a stall the batched path cannot
apply; when the device holds a non-seed snapshot; on the legacy materialization; and when the
staging file cannot be created (pool slots, quota).

After a fallback the stream writes to main, so no new seed may be written (I3; the early merge
deleted the existing ones). Cold queries are then answered from memory only (the P1 mechanism),
and a hook write to a record that is shown only from memory waits in the pre-ready write queue
until the stream delivers that record; `useQueryState().source` stays `server` for such queries.
This is slower than the staging path but never wrong, and the fallbacks are rare events.

#### 5.7.6 IndexedDB fallback and native SQLite

The IndexedDB fallback runs SQLite in memory and persists snapshots: staging is an in-memory
database and the merge is followed by one durability barrier (`ensureDurable`). Native SQLite
(Tauri, `better-sqlite3`, WAL) uses a staging file with the same code; it gains less and may run
with staging disabled after measurement.

#### 5.7.7 Expected effect (to be measured in S3)

Apply busy time at about 0.2 ms per operation (the `MEMORY` experiment's 0.39 s for 2,000) is
about 4 s of worker time for 20,000 operations, plus the engine's verification (26 to 114 µs per
operation, off the main thread) and the merge (comparable to `insertMany`: about 2 to 3 s,
chunked). The download is 1.5 MiB on the wire, about 7.5 s on Slow 4G. Full scope is then bound
by bytes on Slow 4G (about 10 to 14 s) and by apply on broadband (about 6 to 8 s), against 140 s.

### 5.8 First-load payload

- **Split the entry.** `korajs` becomes a thin entry (schema builders, the typed accessors that
  return deferred queries, the read client, the first-visit controller, the hook bindings) and a
  runtime chunk (store client, sync engine, merge, fold, encryption, Yjs) loaded by `import()`
  right after first paint with `fetchpriority: low`. Budget K3: at most 20 KB gzip of Kora on the
  critical path, enforced by a size check in CI (`scripts/bench/bundle-budget.mjs`, S1).
- **Start the WASM early, at low priority.** The worker is spawned (and the WASM requested) as
  soon as the runtime chunk runs, not after the first data, so the store opens as early as the
  link allows, while foreground reads go first (HTTP/2 priorities; `delivery-flow` for the socket).
- **Precache after first data, from the HTTP cache.** The service worker registers after the
  first `kora:first-data` event or at idle (whichever is later than `load`), fetches hashed
  assets with `cache: 'default'` (their SHA-256 is already verified against the build's digests,
  so a stale HTTP cache entry cannot be stored), and serves the unhashed `sqlite3.wasm` alias from
  the hashed entry instead of downloading it again.
- **Warm visits** load everything from the precache and open OPFS (about 0.3 to 0.8 s); the store
  is then ready in the time the baseline spends on its first `GET`, so warm Kora wins.

### 5.9 Writes on a cold device

- **Before the store opens (P0, P1).** `mutateAsync` and `useMutation().mutate` wait for
  `app.ready`, then write locally. With `instantUpdates` on, the predicted row is shown from the
  in-memory answer at once. A write whose promise has not resolved is not promised (the existing
  contract, `docs/guide/offline-readiness.md`); closing the tab in this window loses an unresolved
  write, and `isLoading` says so (risk 2). Imperative `app.<collection>.insert(...)` before
  `app.ready` keeps throwing `AppNotReadyError` (unchanged semantics).
- **After the store opens (P2 to P4).** Writes are local, durable and instant, as today. They are
  faster than the baseline's round trip in every state.
- **Constraints that need data not yet replicated.** Cross-record constraints are decided by the
  server; devices check them optimistically (CLAUDE.md, Tier 2). On a cold device the optimistic
  check sees seeds and local writes only. When the collection is not covered (5.5), the device is
  online, and the write would be checked against a unique or capacity constraint, or is a delete
  of a record that `restrict` or `cascade` relations point at, the controller first asks the
  server through read-through (`where` on the constrained fields, or a `count` of referencing
  records), which costs the round trip a REST app pays anyway. Offline, or if the check fails,
  the write proceeds and the server decides, as today (`sync:operation-rejected` undoes it).

### 5.10 Honest status

- `data.state` stays `syncing` (with `progress` from the staging watermark against the frontier
  the handshake reported) until the merge writes the completion mark. Seeded screens do not count
  as complete for `ready` (decision D5 asks whether they should).
- New reasons: `storage-opening` (P0, P1) and the existing `shell-installing`; `ready` needs the
  merge, the shell and restorable auth, as today.
- The template badge says "Getting ready for offline... 40%" during P1 to P3 and "Available
  offline" only at `ready`. It never shows a percentage that can go down (progress is the staging
  watermark over the handshake frontier, recomputed only upward).
- Per query, `useQueryState().complete` is false for `partial` and `cold` queries, so an app can
  say "showing the first 500".

### 5.11 Auth on the first visit

Sign-in is the app's flow and is unchanged; the token lands where the auth client keeps it
(`localStorage` by default), which needs no database. The read client takes the credential from
the same place the sync engine does (`sync.auth()` or `createKoraAuthSync`), so the first read
leaves as soon as a token exists. A 401 triggers the auth client's refresh, then one retry. With
`store.namespaceByAuthUser` the database name needs the user id, which the token gives; the store
opens in parallel with the reads either way. Public data (`anyone()` rules, or a provider that
accepts anonymous principals) reads through without a token exactly when the sync handshake would
accept one. `offline.auth` and the restorable-session rules are unchanged.

### 5.12 Security

- **Never more than delivery.** For a principal at time T, every record a read returns is in that
  principal's downlink scope at T, computed by the same function as the session's grant, with
  access rules in force (5.4.2). Read-through returns current values only, which is what a scope
  entry gives a late joiner, and less than a scope entry (no fold state, so no removal markers,
  resolver logs or Yjs structure). Fields are the delivery wire form; there is no field the read
  returns that an operation would not carry.
- **History gating** is respected by construction: the read returns records in the current grant,
  never operations, and never a tombstone.
- **Encrypted collections** are never read through.
- **Limits**: per principal at most 4 concurrent reads and 20 per second (token bucket), at most 8
  queries per request, `maxCandidates` 10,000, `maxRows` 500, `maxBytes` 1 MiB, `in` lists at most
  256 values, `include` depth 1 and at most 3 relations, `known` at most 1,000 ids. Each limit
  answers 413 or 429 with a retry hint, and the client falls back to waiting for replication.
- **Headers**: `no-store, private`, `Vary: Authorization, Cookie`; CORS exactly as the sync path.
  If the deployment authenticates by cookie, the endpoint requires a custom header
  (`x-kora-read: 1`) and a same-origin `Origin`, so a cross-site form cannot read.
- **Logging**: query shapes and counts only, never values.
- **Server cost**: one grant computation per request (a membership index read). A per-principal
  grant cache keyed by access generation and membership high-water mark is a later optimization
  (S7), only after S0 shows the cost.

### 5.13 What this means for C1

C1 was designed to make the first sync faster. The first visit no longer waits for the first
sync: read-through gives first data and navigation, and staging makes full scope bound by bytes.
What remains of C1's value is fewer operations to apply and download at high operations-per-record
ratios, an optimization of P3 that no contract metric needs on the fixture.

- **Reuse now**: R16 (advance the HLC from every installed stamp, quarantine invalid ones), for
  seeds. The tombstone, resume and restart analysis is not needed: seeds never move a watermark.
- **Reshape**: if field data shows a ratio where staging misses K1, C1 becomes "record states into
  the staging store" (no negotiation of a watermark jump on the main database; restart is
  "delete staging"). That removes R17 to R19 from its surface.
- **Drop from beta.15**: C1.1 to C1.9 (decision D2). The `c1-snapshot-device` row of the
  packed-artifact matrix changes to the first-visit convergence check (section 10).

## 6. Invariants

- **I1. One query engine after open.** Once the store is open, every subscription result is the
  local SQL result. Read-through only writes seeds; it never patches a result.
- **I2. Seeds are a cache.** Deleting every seed at any instant changes no operation, log row,
  fold state of a record with remote history, watermark, version vector or completion mark, and
  the device converges to the same state.
- **I3. Seeds never meet the stream.** No remote operation is folded in the main database while a
  seed exists for its record: before the merge the stream writes only to staging, and the merge
  deletes every seed before or while folding staging operations into main.
- **I4. Convergence.** After the merge, every record's fold state equals `fold(O ∪ U - R)`
  (all delivered operations, local unsent writes, minus terminal rejections), as on a device that
  never read through. Property-tested (10.1).
- **I5. Never more than delivery.** Every record a read returns is in the principal's downlink
  scope at the time of the read under rules in force (5.12). Property-tested (10.2).
- **I6. Watermark untouched by reads.** Read-through never advances, sets or resets a delivery
  watermark or a completion mark.
- **I7. Staging is disposable.** The staging file is never read by queries, never trusted across
  a worker lifetime, and its loss costs only time.
- **I8. Offline principle.** After `ready`, opening, reading and writing involve no network, as
  today. Before `ready`, every network step has an offline outcome (5.4.8) and none blocks a
  local write.
- **I9. No early claims.** `ready`, `complete` and "saved" are claimed only under today's rules.
- **I10. Bounded.** Reads, seeds per answer, staging slices and merge chunks are bounded (5.4.3,
  5.7.2, 5.7.4, 5.12).

## 7. Failure modes

| Event | During | Outcome | Data |
|---|---|---|---|
| Read request fails (network) | P0 to P3 | query `pending` with `error`; retried with backoff | none at stake |
| Read answers 409 (access rebuilding) | any | retried after the hint; the screen waits | none |
| Read 429 or 413 | any | query falls back to `partial` or waits for the merge | none |
| Token expires | any | refresh, one retry, then `auth-required` as sync does | none |
| Store cannot open (WASM fetch fails, F15) | P1 | answered screens keep rendering from memory; writes stay queued; status `not-ready` with the storage reason | queued writes are unresolved, not promised |
| Tab closed or crashed | P1 | in-memory answers and unresolved writes are lost | nothing promised was lost |
| Tab crashed | P2, P3 | seeds and local writes survive (journaled main); staging is deleted on reopen; replication restarts from main's watermark | no loss |
| Crash between merge chunks | P3 to P4 | restart redoes replication into a new staging; copied operations are duplicates | no loss (5.7.4) |
| Grant narrowed (membership revoked) before the merge | P2, P3 | seeds of the old grant key without local writes are deleted; staging receives the narrowing unit and falls back (5.7.5), merging first | records with unsent writes kept, as today |
| Record deleted on the server after its seed | P2, P3 | the refresh lists it `absent`, or the merge folds the delete | converges |
| Record moved out of a query after its seed | P2, P3 | the refresh re-seeds it with new values; the query no longer shows it | converges |
| A seed timestamp refused by the clock | P2 | not seeded; the record shows from memory only; `read:seed-refused` | none |
| Seeded record with a local write is outside the replicated view at the merge | P4 | kept as an RT-68 snapshot, flagged, reported (`read:seed-orphaned`) | the user's write is kept |
| Server older than this design (no `/read`) | any | 404 is remembered for the session: no read-through, today's behavior, status unchanged | none |
| Client older than this design | any | never calls `/read`; the server is unchanged for it | none |
| `delivery-flow` unsupported by the server | P3 | no yielding; P7 may degrade on Slow 4G; reported in S0 | none |
| OPFS pool has no slot for staging | P3 | staging disabled: today's path into main (5.7.5); cold queries answered from memory, no seeds | none, slower |
| Staging falls back mid-run (narrowing, encrypted batch, stall) | P3 | early merge deletes seeds; cold queries answered from memory; writes to memory-only records wait for the record | none |
| Query shape the evaluator refuses | P1 | no in-memory answer; renders when the store opens from the superset seeds | none |
| Answer over the caps | P1 to P3 | `partial`, background pages, `complete: false` | none |

## 8. Multi-tab

- **One replicator.** Staging replication runs in the tab that holds the storage leader's worker
  (the staging handle lives in that worker), under a Web Lock `kora-replicator:<db>`. Today every
  tab runs its own sync engine and a cold start in two tabs would replicate twice (to verify in S3;
  if so, this lock fixes it for staging, and other tabs' engines stay in their current mode for
  uploads and live delivery after the merge).
- **Reads in every tab.** Each tab reads through for its own visible queries; seeding goes through
  the leader's worker like any write, and is idempotent (newer F wins), so two tabs seeding the
  same record converge.
- **Merge visibility.** The merge commits in the leader's worker and publishes `records-changed`
  on the database's `BroadcastChannel`, so every tab re-runs its queries and switches to `local`.
- **Leader change mid-staging.** The new leader's worker has a new epoch, so staging is deleted
  and the new replicator restarts from main's watermark (I7). Mid-merge, the merge chunk fails
  retriably (`BridgeTerminatedError`) and the next replicator redoes it.
- **Versions.** A tab of an older build never reads through and never touches staging; the version
  gate (newer build leads) keeps an older leader from merging a staging file it does not know.

## 9. API surface

**Zero new required API.** With `sync.url` set and a server that supports read-through, it is on.

Behavior changes (all default):

- `KoraProvider` renders its children before `app.ready`; `fallback` is shown only until the lite
  runtime has the schema (milliseconds). A new optional prop `waitForStorage` restores today's
  gating for apps that need it.
- `app.<collection>.where(...)` before `app.ready` returns a deferred query instead of throwing;
  `exec()`, `count()` and `subscribe()` on it read through before ready and resolve locally after.
  Imperative writes before ready keep throwing `AppNotReadyError`; hooks queue them.
- `sync.querySubsets.mode` defaults to `'disabled'` when read-through is available (D3).

Optional additions:

- `useQueryState()` (React, and the Vue and Svelte equivalents): `source` and `complete`.
- `createApp({ sync: { firstVisit: { readThrough?: boolean, staging?: boolean } } })`: both
  default `true`; escape hatches for debugging and for apps that must not read through.
- `new KoraSyncServer({ readThrough: { enabled?: boolean, maxRows?, maxBytes?, maxCandidates?,
  rate? } })`: defaults in 5.12.
- Events: `read:requested`, `read:answered`, `read:seeded`, `read:seed-refused`,
  `read:seed-orphaned`, `read:handoff-diverged`, `sync:staging-started`, `sync:staging-merged`,
  `sync:staging-discarded`, added to `KoraEvent` and DevTools.

## 10. Testing strategy

All deterministic except the browser gates: fake clocks, controllable transports and adapters.

### 10.1 Convergence property (the gate for S4b)

`packages/test/tests/first-visit-convergence.test.ts`, fast-check, on `better-sqlite3`, the
memory server and the real fold:

- Generate an operation log over 2 to 4 collections with a relation, every field kind (registers,
  counters, max/min, element sets, key maps, resolvers, rich text, server-authoritative fields),
  inserts, updates, deletes and revivals, scope moves, and membership grants and revokes.
- Generate a device schedule: reads at random frontiers (with and without `known`), store open,
  local writes on seeded and unseeded records, terminal rejections, staging slices, network drops,
  restarts (crash before, during and after merge chunks), grant changes, a second tab.
- Device A follows the schedule. Device B never reads through and replicates the same scope.
- Assert: after both are caught up, rows, fold states, logs, version vectors, watermarks,
  quarantine and retraction markers are identical (I4); at every step before the merge, the main
  database holds only seeds and local writes (I3); no seed survives the merge (I2); every visible
  row is in the grant at its read, or carries a local write (I5 on the device side).

### 10.2 Security property (the gate for S2)

`packages/server/src/read/read-through.property.test.ts`: random schemas with provider scopes and
access rules, random memberships over time, random queries (including `include`, `known` and
refused shapes). For each read at time T, the returned record ids are a subset of the ids a fresh
session would hold after replicating to T (computed by running the real delivery stream into a
model device). Plus races: a revoke committed between grant compile and row read (the read
retries or answers 409), a rules deploy (409), an index rebuild (409).

### 10.3 Evaluator and storage parity

- The instant-updates differential suite runs against the evaluator in its new home (core), so the
  server inherits the proof.
- `read-through` integration tests on the memory, SQLite and Postgres stores: same answers for the
  same data (the order comes from the evaluator), including `NULL`, booleans, numbers stored as
  text, non-BMP strings.

### 10.4 Staging

- Staging-and-merge equals direct apply: the 40 seeded random delivery streams of
  `packages/test/tests/batched-delivery-apply.test.ts` applied (a) as today and (b) into staging
  and merged; identical databases.
- Fault injection at each staging slice and merge chunk; restart; leader change.
- Fallbacks of 5.7.5 each have a test.

### 10.5 Browser

- The S0 parity harness becomes the gate: nightly, with the contract evaluated per cell.
- Playwright: offline at each phase (5.4.8), reload offline after P2 shows seeded screens, crash
  during staging and during the merge, two tabs, the badge never shows `ready` before the merge.
- The packed-artifact matrix gains `first-visit-device` (replaces `c1-snapshot-device`): a packed
  template app read-throughs, seeds, merges and converges with an operations-only device.

## 11. Staged plan

PR-sized steps. Each is mergeable on its own and behavior-neutral until its feature is on.

| Step | Work | Acceptance |
|---|---|---|
| **S0. Parity benchmark** | The harness specified below. No product code. | It runs both apps on the LMS fixture in Chromium and prints the contract table; first report recorded in this document (section 1.1 estimates replaced). |
| **S1. Payload** | Precache after first data, `cache: 'default'` for hashed assets, WASM alias without a second download (`packages/cli/src/vite/service-worker.ts`); bundle report and budget script (report-only); the template connects without waiting on `app.ready` once S4a allows. | S0: precache no longer overlaps P2 on Slow 4G; first-visit bytes reduced by the duplicate; offline e2e suite (`pnpm test:e2e:offline`) green. |
| **S2. Read endpoint** | Evaluator moved to core; `read-grant.ts` extracted from `ClientSession` (no behavior change, existing session tests unchanged); `<syncPath>/read`; limits, headers, rate; per-store tests. | 10.2 and 10.3 green; Postgres nightly; no session behavior change (full server suite unchanged). |
| **S3. Staging replication** | Worker second handle with the journal off; staging store; bulk handshake flag and larger batches; time slicing; `delivery-flow`; the merge (with no seeds yet it only copies); fallbacks of 5.7.5; replicator lock. Useful alone: it is the full-scope fix. | 10.4; staging-and-merge equals direct apply; S0 K1 and K2 met on 20k-1; P7 within the contract; the existing sync and store suites unchanged with staging off. |
| **S4a. Render before ready** | Lite entry and runtime chunk; deferred queries; `KoraProvider` renders before ready; pre-ready write queue in the hooks. No read-through yet: a query before ready waits for the store. | K3 budget met; S0 P1 within the contract; existing hook, StrictMode and SSR tests unchanged. |
| **S4b. Read-through and seeds** | The read client; in-memory answers (P1) and the handoff to local SQL; `_kora_seed`, seeding via row snapshots, clock receive, `known` refresh, freshness timers, grant-key clearing, clear points; the merge deletes seeds; coverage and `useQueryState` `source` and `complete`; constraint prechecks. Behind `firstVisit.readThrough`, off by default until S6. Requires S2 and S3: seeds are only written while replication goes to staging (I3). | 10.1 green; S0 P2, P4 and P5 within the contract on every profile, cold. |
| **S5. Status** | `storage-opening`, progress, badge wording, docs (`docs/guide/offline-readiness.md`, a new "First visit" section). | Offline e2e suite green; the badge never shows `ready` before the completion mark (Playwright). |
| **S6. Defaults and gates** | Read-through on by default; `querySubsets` default (D3); the nightly parity gate; the matrix check; dogfood in the LMS track. | Contract green nightly for two weeks; LMS rehearsal on a copy of production data. |
| **S7. Optional** | WebSocket `read-request`; server invalidation hints for cold queries; SQL pushdown on the server; grant cache; checkpointed staging merges for very large scopes; a replicator inside the worker; C1 into staging if field ratios call for it. | Each with its own measurement. |

Ordering note: staging (S3) comes before seeds (S4b) on purpose. A seed is a row snapshot, which is
exact only as long as no older remote operation is folded onto it; that holds because, while seeds
exist, the stream writes only to staging. Seeds on top of today's direct apply would break I3.

### S0 specification

Location `packages/test/bench/parity/`, reusing `packages/test/bench/browser/` (`fixture-server.ts`,
`byte-counter.ts`, `stats.ts`, and the `run.mjs` launcher pattern). Command
`pnpm --filter @korajs/test bench:parity`. Not in `pnpm test`.

- **Fixture.** `generateLmsFixture({ relations: true })`: adds `parentId` to `modules` and
  `lessons` (a course), `questions` and `lesson_progress` (a lesson); the default fixture and its
  operation ids are unchanged (a separate cache key). Sizes `small`, `20k-1`, `20k-5`.
- **Screens** (shared `screens.tsx`): Home (`courses` of the school, `orderBy title`, limit 50),
  Course (`lessons where parentId`, `orderBy position`), Lesson (the lesson, its `questions`, and
  `lesson_progress` where `parentId` and `ownerId = me`), a "Mark done" button that inserts a
  `lesson_progress` row. Every rendered row has `data-row` and its id.
- **Apps.** `baseline-app/` (fetch, per-session cache, non-optimistic `POST`) and `kora-app/`
  (`createApp` defaults plus `sync.url`, `KoraProvider`, `koraServiceWorker()`), both built with
  `vite build`. Both served by one `createProductionServer` (static files with brotli and gzip,
  `immutable` for hashed assets) that also hosts the sync endpoint and the baseline's routes
  (`/api/courses`, `/api/courses/:id/lessons`, `/api/lessons/:id`, `POST /api/progress`, all
  through `RouteContext.query` and `apply` with the token's scope), so both apps hit the same
  process and database.
- **Driver.** Playwright Chromium. Throttling (2.3) is applied before `page.goto`. Cold: new
  context. Warm: the same persistent context reopened after the cold run finished (Kora `ready` or
  300 s). Script: open Home, wait P2 and P3; click the first course (P4); click the first lesson
  (P4); click "Mark done" (P6); back to Home (P5). For Kora, the script runs twice per cold run: at
  first data (during preparation, P7) and after `ready`. K1 is recorded from
  `app.offline.subscribe`.
- **Timing.** In-page: a `useLayoutEffect` in the list marks `parity:<screen>:first-row` and
  `:complete`; clicks are timed from the event's `timeStamp`; FCP from `PerformanceObserver('paint')`
  checked against the `data-app-shell` node; total blocking time from a 10 ms timer's gaps over
  50 ms (the `longtask` observer reports nothing in this headless Chromium, per C1.0(b)).
- **Warm-stale cell.** A warm context whose server log has grown by 10,000 operations since its
  last session: P2 (stale rows) and the time until the screen shows the server's current rows.
- **Correctness.** Each screen's rows are compared to the server's expected rows; the Kora device's
  final database digest is compared to the server's (the C1.0(b) digest).
- **Statistics.** Apps alternate per run, 7 runs per cell, median and nearest-rank p95 (the maximum
  at 7). Host, Chromium version, load average and the build commit are printed. Output: a
  Markdown contract table (baseline, Kora, limit, PASS or FAIL per metric and cell) and
  `KORA_PARITY_JSON` raw runs.
- **Variables.** `KORA_PARITY_PROFILES` (`slow-4g,4g,broadband`), `KORA_PARITY_TEMPS`
  (`cold,warm`), `KORA_PARITY_RUNS` (7), `KORA_PARITY_SIZES` (`20k-1`), `KORA_PARITY_CPU` (1 or
  4), `KORA_PARITY_JSON`, `PW_CHROMIUM_PATH`.

## 12. Risks

1. **A second read path to secure.** The read endpoint is a new way data leaves the server. It
   shares the grant function with the session and has its own property test, but a bug there is a
   disclosure. Mitigation: 10.2, the shared function, review by an independent red team before S2
   merges.
2. **Unresolved writes before the store opens.** A `mutate` in P1 that never reached the store is
   lost with the tab, a new window of the risk instant updates already accepted. Mitigation:
   `isLoading`, the window is the WASM load, and `mutateAsync` never resolves early.
3. **Staging with journaling off.** Correct only if staging is never trusted across a crash.
   Mitigation: the worker epoch (I7), and the merge copies from staging only inside the lifetime
   that wrote it.
4. **Bundle split** may break apps that import from deep `korajs` paths or rely on synchronous
   availability of the runtime. Mitigation: the public API is unchanged; the split is internal;
   the packed-artifact matrix and the 13 templates catch it.
5. **Evaluator drift.** The server orders by the evaluator; a mismatch with the client's SQLite
   shows a different order before the store opens (one re-render after) and could cut a different
   `limit` page (the seeds then miss a row the local SQL would show until the merge).
   Mitigation: the differential suite; refused shapes return supersets.
6. **Server cost** of a grant per request and JavaScript filtering up to 10,000 candidates.
   Mitigation: caps, rate limits, S0 server timings, the grant cache (S7).
7. **The seed window.** Between seeding and the merge, a seed is a snapshot of the server at F
   plus local writes. Concurrent edits by others appear on refresh (5.4.7), not live. A REST app
   behaves the same; a Kora app after the merge is live.
8. **Default change of query subsets** (D3) increases what a device downloads for apps that relied
   on reactive narrowing. Mitigation: the scope-size warning; static subsets.
9. **Mid-range phones.** The fold's JavaScript runs on the main thread during staging; at 4x CPU
   it may exceed K2. Mitigation: slicing; the replicator-in-worker option (S7).
10. **OPFS pool slots.** Staging takes a slot (and a journal slot is not needed). A pool at capacity
    disables staging (fallback) rather than failing.
11. **Estimates may be wrong.** Every "today" number in section 2.5 is an estimate. S0 is first
    so the plan is corrected before product work.

## 13. Red-team self-review

Method: every path by which (a) a user could see data they may not read, (b) the device could end
in a state a never-read-through device would not reach, (c) the app could claim something untrue,
or (d) a metric could regress while another improves, was walked through the phases of 5.3 and
against everything that can happen concurrently (writes, other tabs, revocations, deploys,
crashes, network loss). Each finding names how the design above answers it.

| # | Finding | Change | Section |
|---|---|---|---|
| V1 | A membership revoked between the grant compile and the row read would let one read return rows under the old grant. | Re-read the index state and membership high-water mark after the rows; retry or 409. | 5.4.2 |
| V2 | Reading F before the rows (C1's order) would let a row reflect an operation above F; dropping the seed at W >= F would then show older values (a visible regression). | F is read after the rows, so every reflected operation is at or below F. | 5.4.4 |
| V3 | A seed protected from earlier retractions (C1 treats snapshot records as delivered at B) would survive a revocation whose unit has a sequence below F. | Seeds are never protected: a grant-key change deletes them; the stream never touches main before the merge. | 5.6.4, 5.7 |
| V4 | Seeds mixed with replicated rows at an older watermark would show a record in a query it left after W. | Before the merge main holds no replicated rows; the merge waits until the staging watermark passes every seed's F. | 5.4.5, 5.7.4 |
| V5 | Two answers at different frontiers could show a record in a query it has left. | `known` ids on every refresh; `absent` deletes; newer F wins. | 5.4.5 |
| V6 | `absent` could be used to probe whether an out-of-grant id exists. | `absent` covers "not readable" and "does not exist" alike. | 5.4.5 |
| V7 | A device whose clock trails the seed stamps would make local edits that lose last-write-wins to the seed. | `clock.receive` of every seed's `latest`; refused stamps are not seeded. | 5.6.1 |
| V8 | Deleting a seed whose record has a local write, when the record is not in the replicated view, would hide the user's own edit. | Kept as an RT-68 snapshot, flagged, reported. | 5.6.4 |
| V9 | A row snapshot is lossy for older operations that arrive later. | Such operations come only from the stream, which writes only staging; the merge drops seeds before folding them into main. | 5.6.2, I3 |
| V10 | Journal-off staging could be reused after a crash in a torn state. | Worker-epoch tag; any reopen deletes staging. | 5.7.2, I7 |
| V11 | A merge chunk without a watermark leaves copies under the old watermark. | Re-delivered operations are duplicates; records re-fold at the next merge; the same argument as chunked batches. | 5.7.4 |
| V12 | Access narrowings and retractions of records with unsent writes do bookkeeping outside the store transaction (C3 keeps them on the per-operation path). | Staging merges early and falls back for them. | 5.7.5 |
| V13 | Two tabs replicating into two stagings would double the work and race on the merge. | Replicator Web Lock; staging lives in the leader's worker; leader change discards it. | 8 |
| V14 | The precache competing with the first data would make P2 worse even with read-through. | Precache after first data, from the HTTP cache, one WASM copy. | 5.8 |
| V15 | Background replication bandwidth would slow cold navigation reads on Slow 4G. | `delivery-flow` pause while a read is in flight. | 5.7.3 |
| V16 | Worker-time slices could still block a foreground query behind a long staging transaction. | Slices sized by time (about 16 ms), not count; K2 measured in S0 and S3. | 5.7.2 |
| V17 | Claiming offline readiness for seeded screens would promise data not replicated (a reload offline shows seeded rows, but other screens are empty). | Not claimed; decision D5. | 5.10 |
| V18 | A sign-out or user switch would leave the previous user's seeds and in-memory answers. | Clear points of 5.6.4, also the in-memory answers. | 5.6.4 |
| V19 | Cookie-authenticated deployments make a POST endpoint a cross-site read target. | Custom header and same-origin `Origin` for cookie auth; `no-store`, `Vary`. | 5.12 |
| V20 | A server read replica could be behind the membership index. | The grant and F are read from the primary; only candidate rows may come from a replica, and a stale row is only a stale seed. | 5.4.2 |
| V21 | Queries the evaluator refuses could return a wrong `limit` page. | Refused shapes return the scoped superset (capped, `partial` if over). | 5.4.3 |
| V22 | `include` could leak related records of a denied collection. | Each included collection under its own grant. | 5.4.3 |
| V23 | Measuring Kora from `connect()` (as C1.0(b) does) would hide the first-visit cost. | The contract measures from navigation start, throttled before navigation. | 2.2, F3 |
| V24 | A REST baseline on a different server or database would make the comparison unfair either way. | Same process, same database, same grant, same components. | 2.1 |
| V25 | Making the provider render before ready changes behavior for apps that read collections imperatively at render. | `where()` returns a deferred query; imperative writes keep throwing; `waitForStorage` restores gating. | 9 |

| V26 | Building seeds before staging (an easier order) would let the stream fold older operations onto row snapshots in main, the lossy RT-68 case. | Staging (S3) is a prerequisite of seeds (S4b). | 11 |
| V27 | A warm device with a stale replica (weeks offline) shows old rows at once while a REST app shows fresh rows at about 1 s. Seeding cannot fix it: the main database already holds remote history, so a row snapshot there would meet older stream operations (I3). | Not fixed in this design: local rows show immediately (offline-first), `data.completedAt` says how old they are, and S0 adds a warm-stale cell (a replica 10,000 operations behind) to measure the catch-up. Decision D11 lists the option of showing read-through answers in memory, unseeded, during a long catch-up. | 5.5, 14 |

Open after the review (bounded, not fixed): the seed window's staleness (risk 7), the pre-ready
write window (risk 2), and evaluator drift for shapes the differential suite has not generated
(risk 5).

## 14. Decisions for Obed

**Decided 2026-10-30.** Obed: beta.15 ships everything, tested, irrespective of how long it takes; quality and adoption over release date. Applied to the decisions below (Obed can overturn any of them):

- D1: adopt the margins, and gate on **both** unthrottled and 4x-throttled CPU before release (not 4x later).
- D2: C1.1 to C1.9 are superseded by this design for beta.15; R16 is kept. C1 as "record states into staging" is re-evaluated after S3 on the measured ratio.
- D3: `querySubsets` defaults to `'disabled'` when the server supports read-through.
- D4: HTTP `POST <syncPath>/read`.
- D5: `ready` means the full replica; a per-screen "available offline" indicator for seeded queries is added as well, because users deserve to know what they can open offline before the whole scope lands.
- D6: `KoraProvider` renders before `app.ready` by default, with `waitForStorage` to opt out.
- D7: hooks queue writes until the store opens, **and** the tab-close loss window must be closed (queued writes persisted before the store opens), not documented as a risk.
- D8: ask the server before a constrained write on a cold collection when online.
- D9: **all stages S0 to S7 in beta.15.**
- D10: accept the journal-off staging database discarded after a crash.
- D11: the second option is built in beta.15: when the handshake reports a backlog above a threshold, visible queries show read-through answers until catch-up. It gets its own design section before implementation.

Original questions, kept for the record:


- **D1. The contract.** Adopt the margins of 2.4 (p50 `max(10%, 100 ms)`, p95 `max(15%, 150 ms)`,
  warm at or below the baseline) and gate on unthrottled CPU first, 4x CPU after? Recommended: yes.
- **D2. C1 in beta.15.** The 2026-10-28 decision made C1 unconditional. This design takes the
  first visit off the first sync, so C1 no longer serves the goal it was in beta.15 for.
  Recommended: move C1.1 to C1.9 out of beta.15, keep R16 (needed by seeds), revisit C1 as
  "record states into staging" if field ratios call for it.
- **D3. Default query views.** Make `querySubsets` default to `'disabled'` (full scope) when the
  server supports read-through, keeping `reactive` opt-in? Recommended: yes; reactive narrowing is
  what makes navigation reconnect and backfill (F5).
- **D4. Transport.** HTTP `POST <syncPath>/read` for read-through (recommended), or WebSocket only
  (simpler surface, but cannot run before the store and the handshake).
- **D5. Seeded screens and `ready`.** Keep `ready` for the full replica only (recommended), or
  add a per-screen "available offline" for seeded queries?
- **D6. Provider behavior.** `KoraProvider` renders children before `app.ready` by default, with
  `waitForStorage` to opt out? Recommended: yes (it is the change that makes P1 possible).
- **D7. Pre-ready writes.** Hooks queue writes until the store opens (recommended), or disable
  mutations until ready (no loss window, but a write is not possible in the first seconds).
- **D8. Constraint prechecks.** Ask the server before a constrained write on a cold collection when
  online (recommended: one round trip, the same as a REST app), or always local-optimistic.
- **D9. Release scope.** Beta.15's scope is closed to the ledger. Recommended: S0 and S1 in beta.15
  (measurement and the precache fix are low risk), S2 to S6 as the beta.16 headline. Or bring
  S2 and S3 (the read endpoint and staging, which fixes full scope on its own) into beta.15 in
  place of C1.
- **D10. Staging durability policy.** Accept a journal-off staging database that is discarded
  after any crash (recommended), knowing a crash during the first sync restarts it.
- **D11. Warm but stale replicas.** Show stored rows at once and catch up (today, recommended for
  now), or, when the handshake reports a backlog above a threshold, display read-through answers
  in memory (never seeded) for visible queries until the catch-up is done. The second needs its
  own design for writes on records that exist only in the answer.

## 15. Appendix: code map

| Concern | Today | Touched by |
|---|---|---|
| Provider gating | `packages/react/src/context/kora-context.ts` | S4a |
| Accessors before ready | `kora/src/collection-accessor.ts` | S4a |
| App start and connect | `kora/src/create-app.ts`, `kora/src/initialize-app.ts`, template `main.tsx` files in `packages/cli/templates` | S4a, S1 |
| Query subsets | `kora/src/sync-query-bridge.ts`, `packages/sync/src/scopes/query-subset.ts`, `SyncEngine.registerQuerySubset` | S6 |
| Session grant | `packages/server/src/session/client-session.ts` (`withAccessGrant`, `sessionDownlinkScope`, `recordsMatching`, `readGrantedIntervals`, `accessUnenforceable`, `observeIndexStateAfterRead`) | S2 (extract) |
| Scoped server reads | `packages/server/src/server/route-context.ts` (`queryRecords`, `splitScopeForQuery`), `ServerStore.queryCollection` | S2 |
| HTTP handling | `KoraSyncServer.handleHttpRequest`, `packages/server/src/server/production-server.ts` | S2 |
| Query semantics | `packages/store/src/overlay/query-eval.ts`, `packages/store/src/query/sql-builder.ts` | S2 (move) |
| Row snapshots and fold | `packages/core/src/fold/snapshot.ts`, `packages/store/src/fold/record-folder.ts` (`FOLD_SNAPSHOT_TABLE`, `materializeRow`) | S4b |
| Delivery apply | `Store.applyRemoteBatch`, `packages/store/src/fold/remote-batch-prefetch.ts`, `SyncEngine.handleOperationBatch`, `MAX_DELIVERY_TRANSACTION_OPERATIONS` | S3 |
| Worker and OPFS | `packages/store/src/adapters/sqlite-wasm-worker-core.ts` (`PRAGMA page_size`, journal), `sqlite-wasm-adapter.ts`, `sqlite-wasm-loader.ts` | S3, S4a |
| Completion marks | `packages/core/src/offline/offline-status.ts`, `kora/src/offline-controller.ts`, `saveDeliveryWatermarkInTx` | S3, S5 |
| Precache | `packages/cli/src/vite/service-worker.ts` | S1 |
| Benchmarks | `packages/test/bench/browser/`, `packages/test/bench/lms-first-sync-fixture.ts`, `packages/store/benchmarks/browser/store-browser-bench.mjs` | S0 |
