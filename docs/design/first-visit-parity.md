# Design: first-visit parity (a Kora app is never slower than a regular web app)

Status: PROPOSED; stage S0 BUILT AND RUN (section 11, "S0 result"), stages S1, S2 and S3 implemented ("S1 result", "S2 result", "S3 result"). Internal design doc (not
published). Written against `main` at `aa834a9` (2026-10-30). Every number in this document is marked as **measured** (with its source) or
**estimated** (with its arithmetic). The S0 result (section 11) supersedes the estimates of
sections 0, 1.2 and 2.5; they are kept, marked superseded, so the plan's reasoning stays
readable against what was measured.

## 0. Summary

The goal, from Obed: someone opening a Kora-built product for the first time, or on a new
device, must not see any difference from a regular web app that fetches from a server. No slower
first screen, no waiting for data, no degraded feel. They get every offline benefit on top, and
never a degradation.

Today a first visit is serial. The browser downloads Kora's whole runtime with the app's entry
chunk, `KoraProvider` shows its fallback until `app.ready` (SQLite WASM fetched, compiled, OPFS
opened), the template connects sync only after that, and the first row of the home screen
arrives after the handshake and the first delivery batch. From the bytes and the recorded
component timings (section 1.2) the first home row on Slow 4G lands at an ~~estimated 7 to 9 s~~
(**superseded: measured 15.2 s median**, S0 result) after navigation, against ~~an estimated
1 s~~ (**measured 0.99 s**) for a plain REST app rendering the same screen. The
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
| **First home row** | | ~~about 7 s, 9 s with the precache competing~~ **superseded: 15.2 s measured** (S0 result) |
| Full scope | C3b | ~~about 140 s more (measured)~~ **superseded: offline-ready at 38 s from navigation on Slow 4G, 20 s on broadband** (S0 result; see "Contradictions" there for why the C3b figure does not carry over) |

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

- Network (shaped **before** navigation). S0 found that page-level CDP
  `Network.emulateNetworkConditions` does not reach the service worker in this Chromium, so the
  harness shapes one shared link with a TCP proxy instead (CDP stays available as an option); see
  the S0 result.
  `slow-4g` 150 ms, 1.6 Mbit/s down, 750 kbit/s up (the D8 preset); `4g` 60 ms, 9 Mbit/s,
  1.5 Mbit/s (the Node benchmark's `fast-4g`); `broadband` 20 ms, 50 Mbit/s, 10 Mbit/s.
- Temperature: **cold** is a new browser context (empty HTTP cache, OPFS, service worker,
  storage; a new device); **warm** is the same context reopened after the first session has
  finished (Kora offline-ready; the baseline's HTTP cache warm).
- CPU: ~~unthrottled gates; `Emulation.setCPUThrottlingRate(4)` (a mid-range phone) is reported
  and becomes a gate after the first release that meets the unthrottled contract (decision D1).~~
  Superseded by the 2026-10-30 decision (section 14): **both** unthrottled and
  `Emulation.setCPUThrottlingRate(4)` (a mid-range phone) gate.
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

### 2.5 Today against the target (estimates, superseded by the S0 result)

The estimates below were written before S0. They are kept struck through next to the measured
medians (Slow 4G, cold, unthrottled CPU, 7 runs; the full tables are in section 11, "S0 result").

| Cell (Slow 4G, cold) | Baseline | Kora today | Contract limit (p50, from the measured baseline) |
|---|---|---|---|
| P1 first app paint | ~~0.7 s (est.)~~ **0.84 s** | ~~about 2.1 s, and it is a placeholder~~ **11.9 s** (the shell paints only after `app.ready`; the 2.2 s placeholder does not count) | 0.94 s |
| P2 first data | ~~1.0 s (est.)~~ **0.99 s** | ~~7 to 9 s~~ **15.2 s** | 1.09 s |
| P4 cold navigation | ~~0.3 to 0.5 s (est.)~~ **0.17 s** | ~~blocked behind the stream~~ **0.12 s while preparing (P7), when the course's records happen to be local; p95 a timeout after ready (lost records, S0 finding R1)** | 0.27 s |
| P6 write | ~~0.35 s (est.)~~ **0.17 s** | ~~0.04 to 0.06 s~~ **0.03 s after ready, 0.19 s while preparing** | 0.27 s |
| K1 offline-ready | n/a | ~~about 150 s~~ **38 s, and claimed falsely** (S0 finding R1) | 30 s |

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
    reason?: string                   // why the answer is not `ok` (shipped S2; never silent)
    records: ReadRecord[]             // primary collection, in client order
    included: Record<string, ReadRecord[]>
    includedStatus: Record<string, { status: 'ok' | 'partial' | 'unsupported' | 'denied'; reason?: string }>
    refreshed: ReadRecord[]           // `known` ids that are readable but left the query (shipped S2)
    absent: string[]                  // `known` ids the session may not read now, or that do not exist
    cursor?: string                   // when partial and paging can continue; signed (shipped S2)
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
`ACCESS_RULES_CHANGED` (retriable, the access index is rebuilding or a membership changed during
the read), 409 `READ_CONFLICT` (retriable, a record kept changing while it was read), 409
`SCHEMA_MISMATCH`, 413 (limits), 429 (rate, or `AUTH_BUSY`: the server is limiting calls to its auth
provider for tokens it has not seen), 503 `AUTH_UNAVAILABLE` (retriable, the auth provider threw or
did not answer in time). A result is `ok` only when it is complete: every truncation sets `status` and `reason`
(an include that is cut or not resolved sets `includedStatus` and makes the result `partial`).

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
grant denies and a collection whose read rule is `serverOnly` answer `denied`. A record that has
an encrypted operation is never answered (the server holds no plaintext for it): that record
alone is left out and the result is `partial` with reason `encrypted-records` (a store that
cannot tell answers `unsupported`, and a server that requires encryption answers `unsupported`
`encryption-required`). Shipped S2 note: a writer who seals one record therefore makes the
queries that would return it `partial`, not the whole collection unreadable.

#### 5.4.3 Executing a query on the server (SQLite and Postgres parity)

1. **Candidates.** `RouteContext`-style scoped read: the scope's string and number equalities
   and one string `$in` pushed into `queryCollection` (as `recordsMatching` and
   `splitScopeForQuery` do today), plus the query's own string and number equalities, always in
   id order and with a row limit of `maxCandidates + 1`. Booleans are not pushed down (the
   stores keep them as 0/1 or booleans); a scope on one is bounded by the cap. The work of one
   request is also bounded as a whole (`maxWork`, default 30,000: store rows loaded, every store query (5
   each, so a long `$in` fan-out costs more than its rows), field-version and row re-reads
   including retries, and encrypted-record checks, across queries, includes and `known`).
   Candidate scans read only the light columns (`CollectionQueryOptions.columns` skips richtext
   and blob columns); the page reads the large ones. A read that
   fills its limit proves the scope is wider than the cap; no prefix of it is the answer in the
   query's own order, so the result is `unsupported` with no records and reason
   `too-many-candidates` (`work-budget` when the request ran out of work, `scope-too-wide` past
   256 store queries). Replication answers those queries.
2. **Filter and order in JavaScript**, with the shared evaluator: `matches` for the scope branch
   (`recordMatchesCollectionScope`) and for the query's `where`, `compare` for its `orderBy`, then
   `offset + limit`. SQL never decides membership or order, so SQLite and Postgres cannot differ
   (collation, `NULL` placement, boolean and number affinity): the evaluator was built to equal
   the client's SQLite and is differential-tested against `better-sqlite3` and the WASM mock.
   Postgres hands BIGINT columns back as strings; `_created_at` and `_updated_at` are coerced to
   numbers before comparing.
3. **Shapes the evaluator refuses** (`checkPatchable` false: a non-scalar field in `where` or
   `orderBy`, an over-long `$in`, an operand type mismatch): the server returns every scoped
   candidate as a superset, status `unsupported`, reason `unsupported-shape`. A superset that
   would be cut by `maxRows` or the byte budget is not sent (`too-many-candidates`, no records):
   a cut superset is no superset.
   The client's own SQL decides after seeding. Before the store opens such a query has no
   in-memory answer and renders when the store opens.
4. **Include.** For each relation in `include` (depth 1), the related records are read by their
   key (`many-to-one`: the parent ids of the primary rows; `one-to-many`: children whose field is
   in the primary ids, at most 200 primaries and `maxRows` children each), each under **its own
   collection's** grant. The related scope is pushed into every store query, so the row limit
   cuts rows the principal may read, not rows it may not; a store read that still fills its
   limit marks the include `partial` (`row-cap`). Related records the grant denies are omitted, as delivery omits them.
   Completeness is explicit per related collection in `includedStatus`: `ok`; `partial` (row cap,
   byte budget, encrypted records left out); `unsupported` (too many primaries, work budget,
   store cannot tell about encryption); `denied` (the grant does not cover the collection). An
   include that is not `ok` (or `denied`) makes the result `partial`, reason `include-incomplete`.
5. **Pagination.** An answer with more rows than `maxRows` (default 500) or `maxBytes` (default
   1 MiB) is `partial` with a cursor; the client fetches the rest in the background, at most
   `maxQueryRows` (default 5,000) per query, and reports the query incomplete until then (5.5).
   A cursor is a KEYSET (the sort key of the last row served, plus how many rows the query
   served and its starting offset), so a row deleted between pages cannot make the next page skip
   another one. It is signed with an HMAC (`cursorSecret`, random per process by default) and
   bound to the query shape, the principal and the grant it was issued under; it is not bound to
   the frontier (a write between pages would then invalidate every cursor), so pages may reflect
   different frontiers: a paged chain is only as fresh as its earliest page's frontier, and a row
   updated between two pages so that it sorts before the cursor is skipped by the later page (a
   device that needs the newest state asks again from the first page; the delivery stream, which
   keeps running, repairs the row once the device is subscribed). `maxQueryRows` bounds the absolute position (`offset` + rows served), so
   neither an offset nor a fresh cursor restarts the allowance. A cursor that does not verify
   (another instance, a restart, a changed grant, a forged one) does not fail the request: that
   query alone answers `unsupported`, reason `cursor-invalid`, with no records and no `absent`,
   and the device asks again without the cursor.
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
| Read 429 (including `AUTH_BUSY`, which a cold first-visit read can get during a flood of bad tokens) or 413 | any | query falls back to `partial` or waits for the merge | none |
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
| **S0. Parity benchmark** (**done**, "S0 result" below) | The harness specified below. No product code. | It runs both apps on the LMS fixture in Chromium and prints the contract table; first report recorded in this document (section 1.1 estimates replaced). |
| **S1. Payload** | Precache after first data, `cache: 'default'` for hashed assets, WASM alias without a second download (`packages/cli/src/vite/service-worker.ts`); bundle report and budget script (report-only); the template connects without waiting on `app.ready` once S4a allows. | S0: precache no longer overlaps P2 on Slow 4G; first-visit bytes reduced by the duplicate; offline e2e suite (`pnpm test:e2e:offline`) green. |
| **S2. Read endpoint** | Evaluator moved to core; `read-grant.ts` extracted from `ClientSession` (no behavior change, existing session tests unchanged); `<syncPath>/read`; limits, headers, rate; per-store tests. | 10.2 and 10.3 green; Postgres nightly; no session behavior change (full server suite unchanged). |
| **S3. Staging replication** (**implemented**, "S3 result" below) | Worker second handle with the journal off; staging store; bulk handshake flag and larger batches; time slicing; `delivery-flow`; the merge (with no seeds yet it only copies); fallbacks of 5.7.5; replicator lock. Useful alone: it is the full-scope fix. | 10.4; staging-and-merge equals direct apply; S0 K1 and K2 met on 20k-1; P7 within the contract; the existing sync and store suites unchanged with staging off. |
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

### S0 result

Built and run on 2026-10-30. Command: `pnpm --filter @korajs/test bench:parity`; the harness, its
README and the pieces behind the cause analysis below are in `packages/test/bench/parity/`.
Report-only: nothing here gates a build (S6 adds the gate).

**Host and method.** 2 vCPU Intel Xeon, 7.8 GiB, Node 22.23.4, Chromium 153.0.8010.12 (headless),
commit a11ff61 plus this PR. Fixture `20k-1` with `relations: true` (about 20k operations, one
school). 7 runs per cell, the two apps alternating which goes first, median and nearest-rank p95
(the maximum at 7 runs). Cold is a new persistent profile, warm the same profile reopened. The
1 minute load average at the start of a run was a median of 1.3 (max 5.6 once, at the start of the
4x matrix), so the host is noisy: read differences under about 50 ms as noise. A cell passes only
if both its p50 and its p95 are within the margins of 2.4. A timeout counts as infinite.

**What the throttling does and does not reach (a measurement, not an assumption).** CDP network
throttling on a page does not reach the service worker or the dedicated worker in this Chromium
(the precache and the WASM download went at full speed), so the network is shaped by a TCP proxy
shared by every connection of the page (`shaping-proxy.ts`), using the profiles of section 2.3.
CPU 4x is `Emulation.setCPUThrottlingRate(4)`, which slows the main thread about 3.7x, the
dedicated worker (SQLite WASM) about 2.3x, and the service worker not at all. A 4x cell is
therefore kinder to Kora than a real 4x device, because Kora's replication runs in the worker.

**Result: 47 of 126 contract cells pass.** The cold first visit fails every cell of P1, P2, P3 and
P9 on every network and CPU rate. The warm visit fails P1 to P3 on every network and CPU rate
(Kora 1.2x to 3x the baseline) and the warm navigation P5 almost everywhere. The estimates of
sections 0, 1.2 and 2.5 are struck through and superseded by the figures below.

Full contract table (fixture `20k-1`; "Over" is Kora minus the limit, negative is headroom):

| Metric | Network | Temp | CPU | Baseline p50 / p95 | Kora p50 / p95 | Limit p50 / p95 | Over p50 / p95 | Result |
|---|---|---|---|---|---|---|---|---|
| P1 first app paint | slow-4g | cold | 1x | 841 ms / 1092 ms | 11.9 s / 12.3 s | 941 ms / 1256 ms | +11.0 s / +11.1 s | FAIL |
| P2 first data | slow-4g | cold | 1x | 993 ms / 1146 ms | 15.2 s / 15.8 s | 1093 ms / 1318 ms | +14.1 s / +14.4 s | FAIL |
| P3 screen complete | slow-4g | cold | 1x | 993 ms / 1146 ms | 38.2 s / 46.7 s | 1093 ms / 1318 ms | +37.1 s / +45.4 s | FAIL |
| P4 cold navigation, course | slow-4g | cold | 1x | 166 ms / 172 ms | 16 ms / timeout | 266 ms / 322 ms | -250 ms / n/a | FAIL |
| P4 cold navigation, lesson | slow-4g | cold | 1x | 163 ms / 188 ms | 16 ms / timeout | 263 ms / 338 ms | -247 ms / n/a | FAIL |
| P5 warm navigation (home) | slow-4g | cold | 1x | 2 ms / 6 ms | 30 ms / timeout | 102 ms / 156 ms | -72 ms / n/a | FAIL |
| P6 write | slow-4g | cold | 1x | 168 ms / 203 ms | 29 ms / timeout | 268 ms / 353 ms | -240 ms / n/a | FAIL |
| P7 navigation during preparation, course | slow-4g | cold | 1x | 168 ms / 184 ms | 118 ms / 167 ms | 268 ms / 334 ms | -149 ms / -167 ms | PASS |
| P7 navigation during preparation, lesson | slow-4g | cold | 1x | 166 ms / 227 ms | 89 ms / 173 ms | 266 ms / 377 ms | -177 ms / -203 ms | PASS |
| P7 write during preparation | slow-4g | cold | 1x | 175 ms / 201 ms | 194 ms / 271 ms | 275 ms / 351 ms | -82 ms / -81 ms | PASS |
| P8 total blocking time, 0 to 30 s | slow-4g | cold | 1x | 0 ms / 104 ms | 19 ms / 248 ms | 50 ms / 154 ms | -31 ms / +94 ms | FAIL |
| P9 KiB before first data | slow-4g | cold | 1x | 62 KiB / 62 KiB | 1995 KiB / 2039 KiB | 82 KiB / 82 KiB | +1913 KiB / +1958 KiB | FAIL |
| P1 first app paint | slow-4g | warm | 1x | 420 ms / 514 ms | 943 ms / 1039 ms | 520 ms / 664 ms | +423 ms / +376 ms | FAIL |
| P2 first data | slow-4g | warm | 1x | 593 ms / 681 ms | 949 ms / 1055 ms | 593 ms / 831 ms | +355 ms / +224 ms | FAIL |
| P3 screen complete | slow-4g | warm | 1x | 593 ms / 681 ms | 949 ms / 1055 ms | 593 ms / 831 ms | +355 ms / +224 ms | FAIL |
| P4 cold navigation, course | slow-4g | warm | 1x | 165 ms / 172 ms | 3818 ms / 4998 ms | 165 ms / 322 ms | +3653 ms / +4675 ms | FAIL |
| P4 cold navigation, lesson | slow-4g | warm | 1x | 163 ms / 170 ms | 45 ms / 63 ms | 163 ms / 320 ms | -118 ms / -257 ms | PASS |
| P5 warm navigation (home) | slow-4g | warm | 1x | 2 ms / 3 ms | 27 ms / 89 ms | 2 ms / 153 ms | +25 ms / -64 ms | FAIL |
| P6 write | slow-4g | warm | 1x | 168 ms / 189 ms | 33 ms / 59 ms | 168 ms / 339 ms | -135 ms / -280 ms | PASS |
| P8 total blocking time, 0 to 30 s | slow-4g | warm | 1x | 0 ms / 72 ms | 20 ms / 28 ms | 50 ms / 122 ms | -30 ms / -94 ms | PASS |
| P9 KiB before first data | slow-4g | warm | 1x | 2 KiB / 2 KiB | 1 KiB / 1 KiB | 22 KiB / 22 KiB | -21 KiB / -21 KiB | PASS |
| P1 first app paint | 4g | cold | 1x | 335 ms / 379 ms | 2946 ms / 3002 ms | 435 ms / 529 ms | +2511 ms / +2473 ms | FAIL |
| P2 first data | 4g | cold | 1x | 398 ms / 438 ms | 4623 ms / 4701 ms | 498 ms / 588 ms | +4125 ms / +4113 ms | FAIL |
| P3 screen complete | 4g | cold | 1x | 398 ms / 438 ms | 22.3 s / 23.3 s | 498 ms / 588 ms | +21.8 s / +22.7 s | FAIL |
| P4 cold navigation, course | 4g | cold | 1x | 68 ms / 132 ms | 16 ms / 24 ms | 168 ms / 282 ms | -152 ms / -258 ms | PASS |
| P4 cold navigation, lesson | 4g | cold | 1x | 70 ms / 70 ms | 16 ms / 17 ms | 170 ms / 220 ms | -153 ms / -203 ms | PASS |
| P5 warm navigation (home) | 4g | cold | 1x | 2 ms / 2 ms | 30 ms / 40 ms | 102 ms / 152 ms | -72 ms / -112 ms | PASS |
| P6 write | 4g | cold | 1x | 71 ms / 71 ms | 29 ms / 90 ms | 171 ms / 221 ms | -142 ms / -132 ms | PASS |
| P7 navigation during preparation, course | 4g | cold | 1x | 70 ms / 132 ms | 60 ms / 83 ms | 170 ms / 282 ms | -110 ms / -199 ms | PASS |
| P7 navigation during preparation, lesson | 4g | cold | 1x | 69 ms / 73 ms | 93 ms / 112 ms | 169 ms / 223 ms | -76 ms / -111 ms | PASS |
| P7 write during preparation | 4g | cold | 1x | 73 ms / 76 ms | 156 ms / 193 ms | 173 ms / 226 ms | -17 ms / -33 ms | PASS |
| P8 total blocking time, 0 to 30 s | 4g | cold | 1x | 0 ms / 0 ms | 0 ms / 5 ms | 50 ms / 50 ms | -50 ms / -45 ms | PASS |
| P9 KiB before first data | 4g | cold | 1x | 62 KiB / 62 KiB | 2419 KiB / 2445 KiB | 82 KiB / 82 KiB | +2337 KiB / +2363 KiB | FAIL |
| P1 first app paint | 4g | warm | 1x | 216 ms / 239 ms | 607 ms / 651 ms | 316 ms / 389 ms | +292 ms / +263 ms | FAIL |
| P2 first data | 4g | warm | 1x | 284 ms / 342 ms | 614 ms / 659 ms | 284 ms / 492 ms | +330 ms / +166 ms | FAIL |
| P3 screen complete | 4g | warm | 1x | 284 ms / 343 ms | 615 ms / 659 ms | 284 ms / 493 ms | +330 ms / +166 ms | FAIL |
| P4 cold navigation, course | 4g | warm | 1x | 71 ms / 73 ms | 16 ms / 2241 ms | 71 ms / 223 ms | -56 ms / +2018 ms | FAIL |
| P4 cold navigation, lesson | 4g | warm | 1x | 69 ms / 71 ms | 22 ms / 42 ms | 69 ms / 221 ms | -47 ms / -179 ms | PASS |
| P5 warm navigation (home) | 4g | warm | 1x | 2 ms / 2 ms | 27 ms / 65 ms | 2 ms / 152 ms | +25 ms / -87 ms | FAIL |
| P6 write | 4g | warm | 1x | 72 ms / 73 ms | 33 ms / 42 ms | 72 ms / 223 ms | -39 ms / -181 ms | PASS |
| P8 total blocking time, 0 to 30 s | 4g | warm | 1x | 0 ms / 0 ms | 0 ms / 14 ms | 50 ms / 50 ms | -50 ms / -36 ms | PASS |
| P9 KiB before first data | 4g | warm | 1x | 2 KiB / 2 KiB | 1 KiB / 1 KiB | 22 KiB / 22 KiB | -21 KiB / -21 KiB | PASS |
| P1 first app paint | broadband | cold | 1x | 170 ms / 207 ms | 1444 ms / 2386 ms | 270 ms / 357 ms | +1174 ms / +2029 ms | FAIL |
| P2 first data | broadband | cold | 1x | 207 ms / 229 ms | 2819 ms / 4058 ms | 307 ms / 379 ms | +2512 ms / +3679 ms | FAIL |
| P3 screen complete | broadband | cold | 1x | 207 ms / 229 ms | 20.0 s / 28.3 s | 307 ms / 379 ms | +19.7 s / +27.9 s | FAIL |
| P4 cold navigation, course | broadband | cold | 1x | 29 ms / 31 ms | 16 ms / 24 ms | 129 ms / 181 ms | -113 ms / -157 ms | PASS |
| P4 cold navigation, lesson | broadband | cold | 1x | 29 ms / 34 ms | 16 ms / 27 ms | 129 ms / 184 ms | -112 ms / -157 ms | PASS |
| P5 warm navigation (home) | broadband | cold | 1x | 1 ms / 3 ms | 30 ms / 61 ms | 101 ms / 153 ms | -72 ms / -92 ms | PASS |
| P6 write | broadband | cold | 1x | 31 ms / 35 ms | 24 ms / 91 ms | 131 ms / 185 ms | -106 ms / -94 ms | PASS |
| P7 navigation during preparation, course | broadband | cold | 1x | 31 ms / 57 ms | 75 ms / 111 ms | 131 ms / 207 ms | -57 ms / -96 ms | PASS |
| P7 navigation during preparation, lesson | broadband | cold | 1x | 30 ms / 34 ms | 76 ms / 104 ms | 130 ms / 184 ms | -54 ms / -80 ms | PASS |
| P7 write during preparation | broadband | cold | 1x | 33 ms / 44 ms | 155 ms / 258 ms | 133 ms / 194 ms | +22 ms / +64 ms | FAIL |
| P8 total blocking time, 0 to 30 s | broadband | cold | 1x | 0 ms / 0 ms | 0 ms / 6 ms | 50 ms / 50 ms | -50 ms / -44 ms | PASS |
| P9 KiB before first data | broadband | cold | 1x | 62 KiB / 62 KiB | 2617 KiB / 2937 KiB | 82 KiB / 82 KiB | +2535 KiB / +2855 KiB | FAIL |
| P1 first app paint | broadband | warm | 1x | 143 ms / 174 ms | 549 ms / 684 ms | 243 ms / 324 ms | +305 ms / +360 ms | FAIL |
| P2 first data | broadband | warm | 1x | 174 ms / 200 ms | 555 ms / 694 ms | 174 ms / 350 ms | +381 ms / +344 ms | FAIL |
| P3 screen complete | broadband | warm | 1x | 174 ms / 200 ms | 555 ms / 694 ms | 174 ms / 350 ms | +382 ms / +344 ms | FAIL |
| P4 cold navigation, course | broadband | warm | 1x | 32 ms / 33 ms | 20 ms / 2164 ms | 32 ms / 183 ms | -12 ms / +1981 ms | FAIL |
| P4 cold navigation, lesson | broadband | warm | 1x | 30 ms / 31 ms | 23 ms / 62 ms | 30 ms / 181 ms | -7 ms / -119 ms | PASS |
| P5 warm navigation (home) | broadband | warm | 1x | 2 ms / 2 ms | 35 ms / 76 ms | 2 ms / 152 ms | +34 ms / -77 ms | FAIL |
| P6 write | broadband | warm | 1x | 31 ms / 35 ms | 42 ms / 120 ms | 31 ms / 185 ms | +11 ms / -65 ms | FAIL |
| P8 total blocking time, 0 to 30 s | broadband | warm | 1x | 0 ms / 0 ms | 13 ms / 22 ms | 50 ms / 50 ms | -37 ms / -28 ms | PASS |
| P9 KiB before first data | broadband | warm | 1x | 2 KiB / 2 KiB | 1 KiB / 1 KiB | 22 KiB / 22 KiB | -21 KiB / -21 KiB | PASS |
| P1 first app paint | slow-4g | cold | 4x | 1010 ms / 1035 ms | 11.4 s / 11.4 s | 1111 ms / 1190 ms | +10.3 s / +10.2 s | FAIL |
| P2 first data | slow-4g | cold | 4x | 1178 ms / 1197 ms | 14.2 s / 14.4 s | 1296 ms / 1377 ms | +13.0 s / +13.0 s | FAIL |
| P3 screen complete | slow-4g | cold | 4x | 1178 ms / 1197 ms | 68.2 s / 69.8 s | 1296 ms / 1377 ms | +66.9 s / +68.4 s | FAIL |
| P4 cold navigation, course | slow-4g | cold | 4x | 170 ms / 172 ms | 31 ms / 3762 ms | 270 ms / 322 ms | -239 ms / +3440 ms | FAIL |
| P4 cold navigation, lesson | slow-4g | cold | 4x | 169 ms / 170 ms | 26 ms / 137 ms | 269 ms / 320 ms | -243 ms / -183 ms | PASS |
| P5 warm navigation (home) | slow-4g | cold | 4x | 5 ms / 7 ms | 39 ms / 150 ms | 105 ms / 157 ms | -67 ms / -8 ms | PASS |
| P6 write | slow-4g | cold | 4x | 174 ms / 190 ms | 40 ms / 265 ms | 274 ms / 340 ms | -233 ms / -75 ms | PASS |
| P7 navigation during preparation, course | slow-4g | cold | 4x | 184 ms / 185 ms | 172 ms / 234 ms | 284 ms / 335 ms | -111 ms / -101 ms | PASS |
| P7 navigation during preparation, lesson | slow-4g | cold | 4x | 174 ms / 177 ms | 201 ms / 247 ms | 274 ms / 327 ms | -73 ms / -80 ms | PASS |
| P7 write during preparation | slow-4g | cold | 4x | 178 ms / 181 ms | 346 ms / 428 ms | 278 ms / 331 ms | +68 ms / +97 ms | FAIL |
| P8 total blocking time, 0 to 30 s | slow-4g | cold | 4x | 12 ms / 19 ms | 137 ms / 167 ms | 62 ms / 69 ms | +75 ms / +98 ms | FAIL |
| P9 KiB before first data | slow-4g | cold | 4x | 62 KiB / 62 KiB | 2083 KiB / 2133 KiB | 82 KiB / 82 KiB | +2001 KiB / +2051 KiB | FAIL |
| P1 first app paint | slow-4g | warm | 4x | 566 ms / 575 ms | 1302 ms / 8702 ms | 666 ms / 725 ms | +637 ms / +7977 ms | FAIL |
| P2 first data | slow-4g | warm | 4x | 715 ms / 746 ms | 1338 ms / 8723 ms | 715 ms / 896 ms | +623 ms / +7827 ms | FAIL |
| P3 screen complete | slow-4g | warm | 4x | 715 ms / 746 ms | 1338 ms / 8723 ms | 715 ms / 896 ms | +623 ms / +7827 ms | FAIL |
| P4 cold navigation, course | slow-4g | warm | 4x | 185 ms / 190 ms | 73 ms / 4336 ms | 185 ms / 340 ms | -112 ms / +3997 ms | FAIL |
| P4 cold navigation, lesson | slow-4g | warm | 4x | 174 ms / 177 ms | 49 ms / 112 ms | 174 ms / 327 ms | -125 ms / -214 ms | PASS |
| P5 warm navigation (home) | slow-4g | warm | 4x | 9 ms / 15 ms | 41 ms / 100 ms | 9 ms / 165 ms | +32 ms / -65 ms | FAIL |
| P6 write | slow-4g | warm | 4x | 177 ms / 181 ms | 52 ms / 262 ms | 177 ms / 331 ms | -125 ms / -69 ms | PASS |
| P8 total blocking time, 0 to 30 s | slow-4g | warm | 4x | 23 ms / 27 ms | 154 ms / 190 ms | 73 ms / 77 ms | +81 ms / +112 ms | FAIL |
| P9 KiB before first data | slow-4g | warm | 4x | 2 KiB / 2 KiB | 1 KiB / 1514 KiB | 22 KiB / 22 KiB | -21 KiB / +1492 KiB | FAIL |
| P1 first app paint | 4g | cold | 4x | 450 ms / 462 ms | 3808 ms / 3910 ms | 550 ms / 612 ms | +3258 ms / +3298 ms | FAIL |
| P2 first data | 4g | cold | 4x | 538 ms / 547 ms | 6805 ms / 6968 ms | 638 ms / 697 ms | +6167 ms / +6271 ms | FAIL |
| P3 screen complete | 4g | cold | 4x | 538 ms / 547 ms | 61.3 s / 62.9 s | 638 ms / 697 ms | +60.6 s / +62.2 s | FAIL |
| P4 cold navigation, course | 4g | cold | 4x | 81 ms / 90 ms | 21 ms / 3817 ms | 181 ms / 240 ms | -161 ms / +3577 ms | FAIL |
| P4 cold navigation, lesson | 4g | cold | 4x | 79 ms / 85 ms | 26 ms / 106 ms | 179 ms / 235 ms | -153 ms / -128 ms | PASS |
| P5 warm navigation (home) | 4g | cold | 4x | 5 ms / 17 ms | 41 ms / 176 ms | 105 ms / 167 ms | -63 ms / +8 ms | FAIL |
| P6 write | 4g | cold | 4x | 84 ms / 95 ms | 35 ms / 131 ms | 184 ms / 245 ms | -149 ms / -114 ms | PASS |
| P7 navigation during preparation, course | 4g | cold | 4x | 96 ms / 104 ms | 154 ms / 217 ms | 196 ms / 254 ms | -42 ms / -37 ms | PASS |
| P7 navigation during preparation, lesson | 4g | cold | 4x | 84 ms / 88 ms | 225 ms / 280 ms | 184 ms / 238 ms | +41 ms / +42 ms | FAIL |
| P7 write during preparation | 4g | cold | 4x | 91 ms / 100 ms | 291 ms / 515 ms | 191 ms / 250 ms | +101 ms / +265 ms | FAIL |
| P8 total blocking time, 0 to 30 s | 4g | cold | 4x | 24 ms / 54 ms | 139 ms / 161 ms | 74 ms / 104 ms | +64 ms / +58 ms | FAIL |
| P9 KiB before first data | 4g | cold | 4x | 62 KiB / 62 KiB | 3368 KiB / 3480 KiB | 82 KiB / 82 KiB | +3286 KiB / +3398 KiB | FAIL |
| P1 first app paint | 4g | warm | 4x | 386 ms / 440 ms | 1226 ms / 1298 ms | 486 ms / 590 ms | +740 ms / +708 ms | FAIL |
| P2 first data | 4g | warm | 4x | 473 ms / 495 ms | 1255 ms / 1328 ms | 473 ms / 645 ms | +782 ms / +683 ms | FAIL |
| P3 screen complete | 4g | warm | 4x | 473 ms / 495 ms | 1255 ms / 1328 ms | 473 ms / 645 ms | +782 ms / +683 ms | FAIL |
| P4 cold navigation, course | 4g | warm | 4x | 95 ms / 109 ms | 36 ms / 4628 ms | 95 ms / 259 ms | -59 ms / +4369 ms | FAIL |
| P4 cold navigation, lesson | 4g | warm | 4x | 84 ms / 89 ms | 51 ms / 105 ms | 84 ms / 239 ms | -33 ms / -134 ms | PASS |
| P5 warm navigation (home) | 4g | warm | 4x | 9 ms / 11 ms | 47 ms / 160 ms | 9 ms / 161 ms | +38 ms / -1 ms | FAIL |
| P6 write | 4g | warm | 4x | 88 ms / 91 ms | 64 ms / 235 ms | 88 ms / 241 ms | -24 ms / -6 ms | PASS |
| P8 total blocking time, 0 to 30 s | 4g | warm | 4x | 45 ms / 73 ms | 162 ms / 224 ms | 95 ms / 123 ms | +67 ms / +101 ms | FAIL |
| P9 KiB before first data | 4g | warm | 4x | 2 KiB / 2 KiB | 1 KiB / 1 KiB | 22 KiB / 22 KiB | -21 KiB / -21 KiB | PASS |
| P1 first app paint | broadband | cold | 4x | 352 ms / 404 ms | 2316 ms / 2516 ms | 452 ms / 554 ms | +1864 ms / +1961 ms | FAIL |
| P2 first data | broadband | cold | 4x | 397 ms / 418 ms | 5183 ms / 5502 ms | 497 ms / 568 ms | +4685 ms / +4934 ms | FAIL |
| P3 screen complete | broadband | cold | 4x | 398 ms / 419 ms | 60.0 s / 62.0 s | 498 ms / 569 ms | +59.5 s / +61.4 s | FAIL |
| P4 cold navigation, course | broadband | cold | 4x | 41 ms / 46 ms | 23 ms / 33 ms | 141 ms / 196 ms | -118 ms / -162 ms | PASS |
| P4 cold navigation, lesson | broadband | cold | 4x | 42 ms / 60 ms | 22 ms / 26 ms | 142 ms / 210 ms | -120 ms / -185 ms | PASS |
| P5 warm navigation (home) | broadband | cold | 4x | 9 ms / 11 ms | 38 ms / 51 ms | 109 ms / 161 ms | -71 ms / -110 ms | PASS |
| P6 write | broadband | cold | 4x | 45 ms / 54 ms | 32 ms / 39 ms | 145 ms / 204 ms | -113 ms / -165 ms | PASS |
| P7 navigation during preparation, course | broadband | cold | 4x | 51 ms / 56 ms | 186 ms / 215 ms | 151 ms / 206 ms | +35 ms / +9 ms | FAIL |
| P7 navigation during preparation, lesson | broadband | cold | 4x | 44 ms / 46 ms | 232 ms / 251 ms | 144 ms / 196 ms | +89 ms / +55 ms | FAIL |
| P7 write during preparation | broadband | cold | 4x | 50 ms / 65 ms | 408 ms / 486 ms | 150 ms / 215 ms | +258 ms / +270 ms | FAIL |
| P8 total blocking time, 0 to 30 s | broadband | cold | 4x | 50 ms / 86 ms | 188 ms / 322 ms | 100 ms / 136 ms | +89 ms / +186 ms | FAIL |
| P9 KiB before first data | broadband | cold | 4x | 62 KiB / 62 KiB | 3526 KiB / 3538 KiB | 82 KiB / 82 KiB | +3444 KiB / +3456 KiB | FAIL |
| P1 first app paint | broadband | warm | 4x | 368 ms / 425 ms | 1194 ms / 1251 ms | 468 ms / 575 ms | +726 ms / +676 ms | FAIL |
| P2 first data | broadband | warm | 4x | 393 ms / 450 ms | 1218 ms / 1277 ms | 393 ms / 600 ms | +826 ms / +678 ms | FAIL |
| P3 screen complete | broadband | warm | 4x | 393 ms / 450 ms | 1218 ms / 1278 ms | 393 ms / 600 ms | +826 ms / +678 ms | FAIL |
| P4 cold navigation, course | broadband | warm | 4x | 53 ms / 59 ms | 46 ms / 4718 ms | 53 ms / 209 ms | -6 ms / +4509 ms | FAIL |
| P4 cold navigation, lesson | broadband | warm | 4x | 43 ms / 51 ms | 78 ms / 155 ms | 43 ms / 201 ms | +36 ms / -46 ms | FAIL |
| P5 warm navigation (home) | broadband | warm | 4x | 8 ms / 9 ms | 42 ms / 213 ms | 8 ms / 159 ms | +34 ms / +54 ms | FAIL |
| P6 write | broadband | warm | 4x | 50 ms / 68 ms | 89 ms / 217 ms | 50 ms / 218 ms | +39 ms / -1 ms | FAIL |
| P8 total blocking time, 0 to 30 s | broadband | warm | 4x | 43 ms / 87 ms | 198 ms / 284 ms | 93 ms / 137 ms | +105 ms / +147 ms | FAIL |
| P9 KiB before first data | broadband | warm | 4x | 2 KiB / 2 KiB | 1 KiB / 1 KiB | 22 KiB / 22 KiB | -21 KiB / -21 KiB | PASS |

Kora-only targets (section 2.2) and the critical-path JavaScript budget:

| Target | Network | CPU | Kora p50 / p95 | Target | Result |
|---|---|---|---|---|---|
| K1 offline-ready (20k-1) | slow-4g | 1x | 38.1 s / 46.7 s | 30.0 s | FAIL |
| K2 longest main-thread task while preparing (stalls over 50 ms: 1 median) | slow-4g | 1x | 60 ms / 96 ms | 50 ms | FAIL |
| K1 offline-ready (20k-1) | 4g | 1x | 22.3 s / 23.3 s | 10.0 s | FAIL |
| K2 longest main-thread task while preparing (stalls over 50 ms: 0 median) | 4g | 1x | 0 ms / 0 ms | 50 ms | PASS |
| K1 offline-ready (20k-1) | broadband | 1x | 20.1 s / 28.5 s | 8000 ms | FAIL |
| K2 longest main-thread task while preparing (stalls over 50 ms: 0 median) | broadband | 1x | 0 ms / 0 ms | 50 ms | PASS |
| K1 offline-ready (20k-1) | slow-4g | 4x | 68.2 s / timeout | 30.0 s | FAIL |
| K2 longest main-thread task while preparing (stalls over 50 ms: 0 median) | slow-4g | 4x | 0 ms / 54 ms | 50 ms | FAIL |
| K1 offline-ready (20k-1) | 4g | 4x | 61.4 s / 63.0 s | 10.0 s | FAIL |
| K2 longest main-thread task while preparing (stalls over 50 ms: 0 median) | 4g | 4x | 0 ms / 65 ms | 50 ms | FAIL |
| K1 offline-ready (20k-1) | broadband | 4x | 60.1 s / 62.1 s | 8000 ms | FAIL |
| K2 longest main-thread task while preparing (stalls over 50 ms: 2 median) | broadband | 4x | 67 ms / 101 ms | 50 ms | FAIL |
| K3 critical-path JS over the baseline (gzip) | all | all | 269.6 KiB (Kora 331.1, baseline 61.5) | 20 KiB | FAIL |

Where the time goes on a cold Kora visit (median of 7, milliseconds from navigation, from the
phase timers of the Kora app):

| Phase (Kora, cold, ms from navigation, median) | slow-4g 1x | 4g 1x | broadband 1x | slow-4g 4x | 4g 4x | broadband 4x |
|---|---|---|---|---|---|---|
| entry chunk downloaded | 2111 ms | 511 ms | 127 ms | 2124 ms | 523 ms | 180 ms |
| entry chunk evaluated (`kora:entry`) | 2159 ms | 555 ms | 208 ms | 2307 ms | 717 ms | 424 ms |
| provider fallback shown | 2166 ms | 563 ms | 216 ms | 2331 ms | 753 ms | 465 ms |
| worker script downloaded | 2725 ms | 758 ms | 305 ms | 2928 ms | 961 ms | 584 ms |
| WASM download starts (worker) | 3139 ms | 849 ms | 362 ms | 3323 ms | 1057 ms | 651 ms |
| WASM downloaded (worker) | 9588 ms | 1938 ms | 488 ms | 9739 ms | 2144 ms | 757 ms |
| WASM compiled and instantiated (worker) | 9591 ms | 1941 ms | 491 ms | 9743 ms | 2147 ms | 761 ms |
| store open (`app.ready`: OPFS open, DDL) | 11.9 s | 2934 ms | 1433 ms | 11.4 s | 3772 ms | 2285 ms |
| app shell mounted (provider stops gating) | 11.9 s | 2939 ms | 1437 ms | 11.4 s | 3790 ms | 2301 ms |
| WebSocket requested (`connect()`) | 12.0 s | 2970 ms | 1470 ms | 11.4 s | 3874 ms | 2381 ms |
| handshake response | 14.6 s | 4202 ms | 2378 ms | 13.3 s | 5362 ms | 3588 ms |
| first operation batch applied | 14.8 s | 4388 ms | 2570 ms | 13.7 s | 6007 ms | 4631 ms |
| first home row (P2) | 15.2 s | 4623 ms | 2819 ms | 14.2 s | 6805 ms | 5183 ms |
| home equals the server (P3) | 38.2 s | 22.3 s | 20.0 s | 68.2 s | 61.3 s | 60.0 s |
| service worker shell installed | 10.2 s | 2246 ms | 682 ms | 10.3 s | 2487 ms | 887 ms |
| offline-ready (K1) | 38.1 s | 22.3 s | 20.1 s | 68.2 s | 61.4 s | 60.1 s |

#### Measured cause of each failing cell

1. **P1 cold, all networks (11.9 s, 2.9 s, 1.4 s at 1x; baseline 0.84 s, 0.34 s, 0.17 s).** The
   first paint of the app waits for `app.ready` (F1, confirmed): `KoraProvider` shows its
   `fallback` (a "Loading..." placeholder at 2.2 s on Slow 4G, not counted as app paint) until the
   store has opened. The chain on Slow 4G: entry chunk 2.1 s, worker script 0.6 s, WASM download
   6.4 s (3.1 s to 9.6 s; compile and instantiate take 3 ms), then the OPFS open and DDL 2.3 s
   (9.6 s to 11.9 s), then the shell mounts. On broadband the same chain is 1.4 s, of which the
   store open is 0.95 s and the WASM download 0.13 s. The cause is a serial chain (bundle, worker,
   WASM, open) with the UI gated on its end: the WASM download dominates on a slow link, the open
   on a fast one.
2. **P2 cold (15.2 s, 4.6 s, 2.8 s).** P1 plus connect-after-ready (F2, confirmed): the socket is
   requested at 12.0 s, 30 ms after the shell mounts, and the first home row arrives 3.2 s later on
   Slow 4G (handshake response 2.6 s after the request, first batch 0.2 s later, first row 0.4 s
   later). Both gates are in series; nothing overlaps.
3. **P3 cold and K1 (38 s on Slow 4G, 22 s on 4G, 20 s on broadband at 1x; 60 to 68 s at 4x).**
   Full-scope replication into the main database. On broadband it is about 17 s from the first
   batch to the end whatever the link, and at 4x CPU it triples: apply-bound in the worker, not
   download-bound. Slow 4G adds the transfer. The home screen is "complete" only when the whole
   scope has arrived (it shows the server's current rows), so P3 equals K1 within a second in
   every cell.
4. **P9 cold (2.0 to 3.5 MB before first data, limit 82 KiB).** Bundle and worker, the SQLite WASM
   (about 385 KiB gzip), the sync handshake, and the service worker's precache sharing the link
   (F4: the shell was installed at 10.2 s on Slow 4G, before first data at 15.2 s, so the precache
   overlaps P2). The figure grows with the speed of the network (2.0, 2.4, 2.6 MB at 1x) because a
   faster link has delivered more of the first sync's batches by the time the first row renders.
   K3: the critical-path JavaScript is 331.1 KiB gzip against 61.5 KiB for the baseline (+269.6
   KiB).
5. **P7 write during preparation (+22 ms to +258 ms over the limit at broadband 1x and 4x, 4g 4x,
   Slow 4G 4x) and P8 total blocking time at 4x CPU (+58 to +186 ms; unthrottled only at the Slow
   4G p95).** The write is slower than the baseline's 30 to 50 ms because it is made while the
   worker applies delivery batches (155 to 408 ms against 24 to 40 ms when the device is idle).
   That attribution is inferred from timing, not isolated; the same holds for the main-thread
   blocking, whose stalls (67 ms median at broadband 4x) coincide with batch arrival. The S3
   acceptance (staging, time slicing) is aimed at exactly these two.
6. **P1 to P3 warm (Kora 0.55 to 0.94 s against 0.14 to 0.42 s at 1x).** A warm Kora visit still
   spawns the worker, compiles the cached WASM and opens OPFS before it renders: the store is open
   about 0.3 s after the entry chunk even with everything cached, while the baseline renders from a
   small cached bundle plus one fetch. F1 again; warm P2 equals P1 because the first read is
   local. At 4x the Kora figure is 1.2 s against 0.4 s.
7. **P5 warm navigation (27 to 47 ms against 2 ms) and the warm P6 write at broadband (42 and 89
   ms against 31 and 50 ms).** The baseline's warm return to Home is a synchronous render from an
   in-memory cache (1 to 9 ms). A worker-backed store pays a message round trip and a query (about
   30 ms here). The contract's warm rule is "at or below the baseline p50" with no margin, so this
   cell fails by construction unless Kora answers from memory for a query it has already run. This
   is a finding about the contract as much as about Kora (see Contradictions).
8. **P4 warm course, p95 (2.2 s to 5.0 s; the p50 passes), and one Slow 4G cold run whose second
   course did not appear in 90 s.** Opening a course whose `lessons` the device does not hold
   changes the sync view: the status goes back to `data=incomplete`, the engine reconnects,
   handshakes and back-fills (in a recorded Slow 4G run: socket requested 0.5 s after the click,
   handshake response 1.5 s later, course rows at 4.96 s). It is the same mechanism as the
   `lessons` finding below, and why only some warm runs hit it.

#### The `lessons` mismatch (correctness finding R1): cause found

27 of the 41 Kora cold runs that reached offline-ready finished with fewer `lessons` on the device
than on the server (24 to 29 of 153; every other collection exact) while `offline.status()` said
`ready` and `data=complete`. At 1x CPU it is 21 of 21 runs, so it is not intermittent there.
Controlled variants (broadband, 1x, cold, 3 runs each; the harness variable `KORA_PARITY_DIAG`
selects them):

| Variant | `lessons` digest | Offline-ready |
|---|---|---|
| As measured (the script opens a course and a lesson while the device prepares) | mismatch 3 of 3 (24, 25, 28 of 153) | 20.8 s to 22.4 s |
| No screen opened while preparing | match 3 of 3 | 20.1 s to 21.8 s |
| Screen opened, `sync.querySubsets.mode = 'disabled'` | match 3 of 3 | 19.0 s to 21.4 s |

Cause: the default `querySubsets.mode = 'reactive'` (documented: "a device downloads what its views
need"). Opening the Course screen registers the subset `lessons where parentId = X` (the Lesson
screen another), the engine switches the delivery view and reconnects, and from then on `lessons`
is delivered only for the viewed courses; the offline status is complete for the views the app has
asked for. At 4x CPU the narrowing takes hold in only some runs (6 of 20 in the matrix; 2 of 5 in a
repeat at broadband, where the narrowed runs reach ready at about 42 s and the others, which hold
the full scope, at about 60 s). That timing dependence is consistent with the suspected race
between the delivery that is in flight and the view switch, and decides only whether the narrowing
happens; I did not instrument the engine to confirm which interleaving it is, and both outcomes
are consistent (no record the server holds is lost, no operation is dropped).

**Is it a product bug?** The narrowing is the documented, designed behavior and loses no data. Two
things are real against the parity goal and against this design's assumptions: (a)
`offline.status()` reads `ready` with `lessons` at 16% of the server, so a badge saying
"available offline" tells the user a whole school is offline when one course is; (b) each course
opened for the first time afterwards costs a reconnect, a handshake and a back-fill (2 s to 5 s
here, once a 90 s timeout on Slow 4G). Whether (a) is a defect or a wording problem is a decision
for Obed (add it to D3, the `querySubsets` default). The harness checks that the device holds
the whole scope and prints a CORRECTNESS line when it does not; with reactive narrowing that check
fails by design. S3's full-scope view removes the narrowing for the first visit, and S5 must make the badge
say what is held.

#### Contradictions with the design's assumptions

- **Network throttling does not reach the service worker or the dedicated worker** in this
  Chromium, so CDP per-page throttling understates Kora's cost (the precache and the WASM go at
  full speed). The proxy is the only valid way to measure Kora's network; 2.3 now says so.
- **P1 and P2 are far worse than the estimates:** 11.9 s and 15.2 s measured on Slow 4G (estimated
  2.1 s and 7 to 9 s). The estimate left out that the WASM download (6.4 s here) is in series
  with the first paint, and the 2.3 s open after it.
- **The 140 s full-scope figure (C3b) does not carry over:** 38 s on Slow 4G and 20 s on
  broadband from navigation. K1 (target 30 s on Slow 4G) fails by 8 s, and the 8 s and 10 s
  targets for broadband and 4G fail by about 12 s each, but the assumption that the full sync
  takes minutes is wrong for 20k operations on this host.
- **K3 is 269.6 KiB (gzip) over the baseline, not about 20 KiB.** The S4a budget needs a
  different plan than moving a lite entry in front.
- **Warm Kora is slower than the baseline on P1 to P3, P5 and often P6**, which section 2 had
  assumed warm would pass trivially. The warm rule (at or below the baseline p50, no margin) is
  tight against any worker-backed store; P5 cannot pass without an in-memory answer for queries
  already run (a design addition, not a tuning).
- **P7 mostly passes** (navigation during preparation within the margins except on the 4x 4g and
  broadband cells), better than the estimate, because replication runs in the worker. The write
  during preparation is the exception.
- **Offline-ready is claimed on a partial collection** (above). Not in the design.
- **K1 was unmeasurable with the template's bare token function:** a `sync.auth` function without
  an `offline.auth` declaration keeps the offline status `not-ready` forever (`auth-unknown`).
  The Kora app declares `offline.auth`. Worth a line in the offline guide; not changed here.
- **CPU 4x barely affects the baseline (a few hundred ms) and triples the Kora full sync**, so
  the 4x gate widens the set of failing cells but not the causes.

#### What changed in the repository (no product code)

- `packages/test/bench/parity/` (harness, shaping proxy, contract, README) and
  `packages/test/bench/parity/apps/` (workspace package `@korajs/parity-bench-apps`: the two apps
  and their shared screens).
- `packages/test/bench/lms-schema.ts` (new, shared schemas) and an opt-in `relations: true` in
  `generateLmsFixture` (`parentId` on `modules`, `lessons`, `questions`, `lesson_progress`; the
  default fixture is byte-identical, checked) with its own cache key in `fixture-server.ts`.
- Observation hooks live only in the benchmark's own app files (a `BroadcastChannel` from the app's
  own worker entry for the WASM fetch and instantiate times, and `app.on` and `offline.subscribe`
  marks). No file of a shipped package was touched, so no hook in product code was needed.
- `packages/test/tests/parity-contract.test.ts`: the contract arithmetic (margins, p95, timeout as
  infinite). No test depends on timing.

### S1 result

Implemented on `feat/fvp-s1-precache-budget` (2026-10-30), against `main` at `a11ff61`.

**What changed**

- `packages/cli/src/vite/service-worker.ts`, registration: on a page no service worker controls
  (a first visit, a new device), the worker is registered only after the app's first data, then
  at an idle moment (`requestIdleCallback`, at most 2 s). The wait is bounded:
  `firstDataTimeoutMs` (new option, default 10 s after `load`) covers an app that never connects
  sync and an older `korajs` that sends no signal. A page a worker already controls (a warm
  visit, which loads from the precache) registers at `load` as before, so update checks and the
  version gate's waiting-worker flow are unchanged.
- `kora/src/first-data-signal.ts` (new): `createApp` publishes
  `globalThis.__KORA_FIRST_DATA__ = { v: 1, state: 'pending' | 'done' }` and dispatches
  `kora:first-data`, the reverse direction of the `__KORA_SHELL__` contract (korajs cannot import
  the CLI). Done means: `app.ready` for a local-only app; for a syncing app, the first delivery
  batch applied, the session caught up (`streaming`, also with nothing to deliver), sync stopped
  until someone acts (`auth-required`, `encryption-locked`, blocked), or an attempt that ended
  offline; and a failed `app.ready` (the shell must still install).
- Install: every precached file with a build-time digest is taken from the HTTP cache first
  (`cache: 'only-if-cached'`, under its own URL or a byte-identical one, no network at all), then
  with revalidation (`cache: 'default'`, a 304 when unchanged), and stored only when its SHA-256
  equals the digest. Otherwise it is fetched with `cache: 'reload'` and stored as `cache.addAll`
  stored it (unchanged behavior, see the follow-up below). A worker generated without digests
  uses `cache: 'reload'` throughout, as before.
- The duplicate WASM: byte-identical files are grouped by content at build time
  (`collectPrecache` returns `aliases`); the shortest URL of a group is fetched and the response
  is stored under every URL of the group. The heal path restores a lost alias from its twin
  without the network.

**Two refinements of 5.8, found while implementing**

1. *HTTP cache for every digest-verified file, not only hashed names.* The duplicate WASM had a
   root cause in naming: `collectPrecache` already skipped "an unhashed copy whose bytes equal a
   content-hashed file", but Vite's hash for the WASM was `sqlite3-1f8bVu-G.wasm`, and
   `isHashedName` (the same rule as the production server's `immutable` caching) does not accept a
   hash containing `-`. So the rule never fired and both copies were precached. Keying reuse on
   the digest instead of the name makes the name rule irrelevant to correctness, and covers
   mutable URLs too (`no-cache` files revalidate with a 304 instead of a full download).
   `isHashedName` is unchanged (it stays in step with the server, where missing a hash is the safe
   direction).
2. *Which copy to fetch.* Measured on the template: the SQLite runtime requests the **unhashed**
   `/assets/sqlite3.wasm` (that is why the template copies it); the hashed name is never requested
   by the page. The old rule would have kept the hashed copy and dropped the one the runtime
   needs offline. The fetched member of a group is therefore the shortest URL (the stable name a
   runtime asks for), and every member stays in the precache, so both URLs open offline.

**Measured: cold first load, `react-tailwind-sync`, production server, unthrottled Chromium**

Counted at the server through a transparent proxy (`countingProxy` in `e2e/offline/harness.ts`),
so service worker, dedicated worker and HTTP cache traffic are all visible; from navigation until
the shell reports `installed`. Signed out (the sync session stops at `auth-required`).

| | Before (`main`) | After (S1) |
|---|---|---|
| Requests that reached the server | 26 | 17 |
| Response body bytes | 1,528,019 | 806,771 |
| Main bundle (`index-*.js`, 319 KB on the wire) downloaded | 2 times | 1 time |
| SQLite WASM (379 KB on the wire) downloaded | 2 times (hashed and unhashed name), plus a 304 | 1 time |
| `sw.js` requested | 7th request, before the page's WASM download | after the page's WASM download finished |

What the precache still downloads after S1 is what the page never loaded: the lazy chunks
(`export-audit`, `indexeddb`, `restore`, `sqlite3-worker1`, about 9 KB) and `/index.html` (the
navigation fetched `/`, a different HTTP cache key). On `vite preview` (the local-only
templates), which sends `Vary: Origin`, the `only-if-cached` step misses for the page's
crossorigin module scripts and the `default` step revalidates them: 304s, no second body.

The Slow 4G effect on P2 (acceptance "precache no longer overlaps P2") needs the S0 harness,
which does not exist yet; the ordering is asserted directly instead (below). By the arithmetic
of 1.2, removing about 0.72 MB from the link during the first visit is about 3.6 s of Slow 4G
transfer that no longer competes with the first data (estimated).

**Tests**

- Unit (`packages/cli/src/vite/service-worker-shell.test.ts`): scheduling (registers only after
  `kora:first-data` and idle; bounded by `firstDataTimeoutMs`; event-before-load; no Kora app;
  warm visit registers at load; nothing before load), and the install (no second download of
  what the HTTP cache holds; one download per distinct content on a cold cache; a stale HTTP
  cache entry is never stored; the `reload` fallback; no-digest workers; a 404 still fails the
  install; alias heal without the network). `kora/src/first-data-signal.test.ts` for the signal.
  All with fake timers and fake network, no real-time waits.
- Playwright, every web template (`e2e/offline/offline-readiness.spec.ts`, "a cold first load
  downloads the main bundle and the SQLite WASM once, precache after them"): a fresh context
  behind the counting proxy until the shell is `installed`; the entry chunk and the WASM bytes
  (under any of their names) are each answered `200` exactly once, no URL is downloaded twice,
  and `sw.js` is requested after the page's WASM download ended.

**Offline suite (A7)**

`pnpm test:e2e:offline`, all 13 templates from the packed workspace build: 67 passed, 1 skipped
(`tauri-react`, desktop), in 8.4 min. Every existing check is unchanged and green (ready means
offline, offline status, restart offline, signed-out sync templates never ready, service worker
blocked never ready), plus the new cold-load check on all 12 web templates. Cold first load
after S1, requests reaching the server / body bytes: sync templates (production server,
compressed) 17 / 754 to 807 KB; local-only templates (`vite preview`, uncompressed) 23 / 1.24 to
1.30 MB, the extra requests being 304 revalidations with no body.

**Critical-path budget (K3)**

`scripts/bench/bundle-budget.mjs` (`pnpm bench:bundle-budget`) scaffolds `react-tailwind-sync`
from the workspace CLI and packed packages, builds it with `--manifest --sourcemap`, takes the
`index.html` entry chunk and its static imports from the Vite manifest plus the inline scripts of
`index.html`, and attributes every byte through the source maps. Kora's bytes are korajs,
`@korajs/*` and their transitive dependencies and peer dependencies, minus the UI framework; the
app's own code and its other libraries are the baseline. Kora's gzip is the level-9 gzip of its
bytes in bundle order. The budget is K3, 20 KB gzip.

| Measure (react-tailwind-sync, after S1) | Raw | Gzip |
|---|---|---|
| Critical-path JavaScript, total | 1,202.8 KB | 350.8 KB |
| Added by Kora | 962.0 KB | **274.7 KB** |
| K3 budget | | 20.0 KB |
| Gap | | **254.7 KB over** |

Largest contributors (raw): `@korajs/store` 284 KB, `@korajs/sync` 223 KB, `@korajs/core`
112 KB, `korajs` 95 KB, `yjs` 60 KB, `@korajs/devtools` 43 KB, `@korajs/auth` 36 KB, `protobufjs`
32 KB, `lib0` 20 KB, `@korajs/merge` 15 KB, `preact` 13 KB, `long` 12 KB, `@korajs/react` 9 KB,
the shell registration script 8 KB. Two of these are on the critical path of a production build
for no reason the first paint needs: DevTools (with Preact and htm) although the template passes
`devtools: import.meta.env.DEV`, and protobufjs with `long` although JSON is the default wire
format. Both are candidates for S4a's runtime chunk or a dynamic import of their own.

The gap is reported, not hidden: the budget was not raised. CI runs the check as the
`bundle-budget` job of `.github/workflows/e2e.yml` on every PR, failing with the gap and the
reason, and the job is `continue-on-error` until S4a (the staged plan makes the S1 budget
report-only and S4a's acceptance "K3 budget met"); S4a removes that line and the gate blocks.

**Not in S1**

- "The template connects without waiting on `app.ready` once S4a allows": depends on S4a.
- Follow-up candidate (behavior unchanged here): when the HTTP cache and a revalidation both give
  bytes other than the build's, the install stores what a `cache: 'reload'` fetch returns, as
  `cache.addAll` did. Refusing such an install would keep a mid-deploy install from caching two
  builds, at the cost of never installing on hosts that rewrite files in flight.

### S2 result

The server read-through endpoint, `POST <syncPath>/read` (documented in `docs/api/server.md`,
"Read-through endpoint"). No client change.

**What shipped**

- `packages/server/src/read/`: `read-grant.ts` (the grant, shared with the handshake),
  `read-limits.ts` (options, defaults, `ReadLimiter`), `read-types.ts` (wire types and the strict
  parser), `read-through.ts` (the service). `KoraSyncServer.handleReadRequest` and the production
  server mount it at `${syncPath}/read`, ahead of custom routes; `readThrough` configures it.
- The query evaluator (`checkPatchable`, `matches`, `compare`) moved from `@korajs/store` to
  `@korajs/core` (`@korajs/core/internal`), because the package rules forbid the server from
  importing the store. `@korajs/store` re-exports it; its differential suite against SQLite is
  unchanged and green (278 overlay tests).
- `ServerStore.recordsWithEncryptedOperations(collection, ids)` (optional; memory, SQLite and
  Postgres implement it).

**How the invariant is kept**

- The grant is computed per request by the code the handshake uses (`computeReadGrant`: scope
  resolution with `onUnresolved: 'throw'`, scope normalisation, membership intervals, the compiled
  access read grant, `applyAccessGrant`). A request `where` is ANDed with the grant, never
  substituted for it. `ClientSession` now calls the same helpers; its behaviour is unchanged
  (the full server suite is green).
- Scoped candidates are pushed to the store as equality queries and re-judged in JavaScript with
  the evaluator, so the pushdown is an optimisation and never the access check.
- F (`frontier`) is read AFTER every row, so no row reflects an operation past F. The grant
  `basis` (index generation, rules fingerprint, intervals fingerprint, scopes) is recomputed
  after the rows; a difference retries once, then answers 409 `ACCESS_RULES_CHANGED` (retriable).
- A record with any encrypted operation is never served: that record alone is left out and the
  result is `partial` (`encrypted-records`); `absent` carries sealed `known` ids; a store that
  cannot tell fails closed (`unsupported`).
- Work is bounded: store reads carry `ORDER BY id LIMIT maxCandidates + 1`, string and number
  scope predicates are pushed down, and one request has a total work budget (`maxWork`).
- Every truncation is explicit (`reason`, `includedStatus`); a record's values and versions are
  paired by re-reading the row after its versions and retrying (`READ_CONFLICT` if it keeps
  changing); cursors are signed and bound to principal and grant.
- The confirming read of a row is the last look at it, so it is judged against the grant again
  (third review, F1): a record moved out of the grant between the scan and the confirming read
  is dropped, never served on its old row. A dropped primary row rebuilds the answer once and
  then reports `partial` / `records-changed` (never an `ok` short page); a dropped `known` id is
  `absent`; a dropped included row is left out.

**Tests**

- `tests/integration/read-through-property.test.ts` (fast-check, school access fixture with
  memberships, moves, deletes, owner transfers): after every generated action, for two users,
  every record a read returns is held by a fresh device that catches up on the delivery stream
  (the subset invariant), on memory and SQLite (and Postgres when `KORA_PG_TEST_URL` is set); and
  a second property lets the log change between the rows and the frontier and checks that every
  returned record's newest operation has a delivery sequence at most `frontier`. Both properties
  were checked to fail under mutation (access grant ignored; frontier read before the rows).
- `src/read/read-through.test.ts` (47): grant versus request, auth (401, revoked, expired,
  reserved principal), ordering and paging, known/refreshed/absent, include, caps, validation,
  oversized request, CSRF for cookie credentials, rate and concurrency limits.
- `tests/integration/read-through-stores.test.ts` (memory, SQLite, Postgres when available):
  membership intervals and revoke, a revoked credential, an encrypted record, the frontier.
- `tests/integration/read-through-production.test.ts`: the HTTP mount, headers, 401/405/415/413,
  custom `syncPath`, disabled endpoint. `src/read/read-limits.test.ts` for the limiter with an
  injected clock; `packages/core/src/query/query-eval.test.ts` for the moved evaluator.

**Ambiguities resolved**

1. `ReadResult.refreshed` is an addition to the design's response: current values of `known` ids
   that are readable but not in `records`, so a device can re-seed a row that left the query.
2. `schemaVersion` must equal the server schema's version: otherwise 409 `SCHEMA_MISMATCH`, not
   retriable (the client falls back to replication).
3. The endpoint answers 404 when disabled or when the server has no schema, like a server
   without it.
4. `include` accepts a relation name or the related collection name; depth 1; related records
   are read under their own collection's grant and left out when denied; an unknown relation
   makes the query `unsupported`.
5. A scope with a long `$in` fans out into one store query per value; past 256 store queries the
   query is `unsupported` (replication answers it).
6. Scoped candidates past `maxCandidates` answer `unsupported` (`too-many-candidates`) with no
   records: no prefix of them is the answer in the query's order. (Reviewed: the first
   implementation returned an arbitrary set marked `partial`.)
7. The cursor is an HMAC-signed keyset bound to its query, the principal and the grant (not to
   the frontier, which every write moves); another query's, another user's or a forged cursor
   makes that query `unsupported` (`cursor-invalid`, status 200), not an HTTP error.
8. The byte budget always returns at least the first record of an answer, so a large record
   still progresses.
9. Authentication is bounded by the TOKEN, not the address (third review, F2): a charge to an
   address before authentication is a denial of service on a shared address (a proxy without
   `trustProxy`, a NAT with stale tabs). `ReadAuthGuard` remembers an HMAC fingerprint of each
   authenticated token for `authGuard.ttlMs` (5 s, capped at the credential's expiry), shares one
   provider call among concurrent first requests, remembers repeated bad tokens, and caps only
   provider calls for unseen tokens globally (retriable 429 `AUTH_BUSY`). A cached token skips
   the provider and every address check. Failed sign-ins are charged to the address only with
   `trustProxy` set, keyed by IPv6 /64 (an IPv4-mapped address in any spelling is its IPv4
   address). The body is parsed only after authentication and the principal's admission.
   What this does not promise (fourth review): a user is protected from the miss cap only within
   `ttlMs` of their last read. A first-visit read has no cache entry, so a flood of distinct
   garbage tokens from many addresses (or from any address when `trustProxy` is unset) can
   spend the miss budget and answer cold reads `429 AUTH_BUSY` (measured by the reviewer: 35 of
   40 cold valid users refused under a 300-address flood). Mitigations that are cheap: the miss
   budget is split in two lanes, so addresses that have recently failed share a quarter of it;
   this adds little (a flood from a handful of addresses stays under each address's failure
   refill and looks clean, and without `trustProxy` there are no lanes), so it is not relied on;
   a provider call has a deadline (default 8 s; past it the slot is freed, the provider is
   passed an `AbortSignal`, the read is 503 and a late answer is never cached; abandoned calls
   still running are capped at twice the concurrency, past which cold reads are 503). None of
   this stops a distributed flood in which every address is still clean. The client treats
   `AUTH_BUSY` as any 429 (table in 8): the query waits for replication, so the cost is the
   first-visit speed-up, never correctness.
   Staleness: the cache is dropped for a user by `refreshScopes(userId)`, for everyone by
   `terminateSessions`, the periodic `revalidateSessions`, and a membership-index generation
   change, and an answer from a provider call that began before an eviction is used once and
   never cached. A provider whose scopes change without calling the server is stale for up to
   `ttlMs`. A token refused and then made valid is still refused for the negative lifetime
   (min(`ttlMs`, 2 s)). A read in flight when its user is evicted is rebuilt under a fresh
   authentication once (a second eviction ends in a retriable 409 `ACCESS_RULES_CHANGED`; the client retries once, then
   waits for replication), because the grant is built
   from the authentication taken before the rows were read. Evictions by `refreshScopes` are per
   user; `terminateSessions` for a device, the periodic `revalidateSessions` and an index
   generation change are global, which costs one provider call per active user per event (the
   cache lives only `ttlMs`, so a global clear every 30 s is a small cost).
   Authenticated requests use the principal bucket; reads without an identity (no auth provider,
   or an anonymous principal) use their own deployment-sized bucket (200/s, burst 200, 16 in
   flight by default, `rate.anonymous`). The server caps request bodies being received (fifth
   review): 128 for uncached senders and a separate 128 for cached principals, 8 per cached user,
   16 per trusted address (bucketed as failed sign-ins are: IPv6 /64, IPv4-mapped as IPv4), 32
   uncached in all when no address is trusted; a body must arrive at about 1 KiB/s after a 2 s
   grace, at most 10 s (408), and a chunked body gets the full 10 s. Residual: with `trustProxy` unset stalled senders can
   fill the 32 uncached slots and refuse cold reads (the device waits for replication) while
   signed-in users are served.
10. Cookie credentials need `Content-Type: application/json`, the `x-kora-read` header and a
    same-origin `Origin`; bearer credentials need only the content type.
11. The store method above is optional; a custom store without it gets `unsupported` for
    every collection (fail closed) until it implements it.
12. An auth provider that throws is a retriable 503, not a 401.
13. `absent` is read as "delete these seeds", so it lists only ids that are gone or outside the
    grant (`denied` and `encryption-required` answers list every `known` id). A limit of the
    server (`too-many-candidates`, `work-budget`, `scope-too-wide`, `cursor-invalid`,
    `encrypted-records`, `known-truncated`) lists none, and an id served as a record is never
    also absent.
14. A store error while reading a record's versions fails the read (500, retriable, logged); no
    wall-time-0 versions are invented.

**Not in S2**

- The client, `useQuery` seeds and the delivery-equivalence of seeds with the local store (S3).
- Postgres runs only where `KORA_PG_TEST_URL` is set; it was not available in this build
  environment, so the Postgres store implementation is covered by the same code paths and the
  shared contract only through CI.

**Independent review follow-ups (PR #132)**

Fixed: unbounded reads (limit, id order, number pushdown, total work budget, a 2,000-row test),
the shared-address bucket, silent truncation (`reason`, `includedStatus`), torn records (row
re-read after the versions), string BIGINT timestamps, cursor forging, auth-provider failures,
sealed-record griefing (only that record is left out), body-read timeout and cap, an unused
constant. The property test now covers `include`, `known`, cursors and compares values and
versions with the stream-applied record; mutations that remove the included-record grant check,
ignore `leftSeq`, or read the frontier before the rows each fail it (fixed seed and random run).

Second review (895c30a) fixed: a one-to-many include cut before the related scope was applied
(it reported `ok` and an empty include), `absent` listing ids for server-side limits, offset
cursors that could skip a row (now keysets) and an unenforced `maxQueryRows`, the auth provider
being called after the failure bucket was spent, a stale cursor failing the whole batch, uncharged
store queries and retries, large columns loaded by candidate scans, the shared anonymous bucket,
swallowed version-read errors and cut `unsupported-shape` supersets. The property test now also
asserts completeness of `ok` answers and runs 30 cases on SQLite, and a second property checks
generated scopes (booleans, number and second `$in` lists, `$or`) against an oracle that does
not use the endpoint.

Mutants, all killed: drop half of the records of an `ok` answer (property); skip the JavaScript
scope re-check (scope property); remove the included-record grant check (property); ignore
`leftSeq` (property); read the frontier before the rows (property, on SQLite alone and on
memory); leave sealed records in (store integration test); ignore the row re-read (unit test);
break the keyset comparison (unit test). The sealed filter and the re-read are checked by unit
and store tests, not the generated-log property, which would need sealed uploads and interleaved
writes the generator does not model.

Third review (abdeb78) fixed: the confirming read adopted a newer row without judging it against
the grant again (a record moved to another organisation between the scan and the confirming read
was served); a row dropped there made a short page marked `ok`; authentication gated by a
per-address failure bucket before the provider (a denial of service for valid users on a shared
address) and a principal limiter taken after authentication and body parsing (now `ReadAuthGuard`
and the reordering, see ambiguity 9); multi-page limit and `maxQueryRows` tests, column-selection
tests on every store, and a documentation error about forged cursors.

Third-review mutants, all killed except the two classified below: no scope re-check on the
confirming row; drops tolerated on the first build; `served` counting dropped rows or not
accumulating; the more-rows test ignoring drops; no `records-changed` status; a dropped known id
not absent; the auth cache ignoring credential expiry, without single flight, without a negative
cache, without the miss cap, eviction a no-op, `terminateSessions` not evicting; no failure peek
or charge; IPv6 not reduced to /64; the `sameState` skip of unread large columns (now observable
as one version read per record); `position > maxQueryRows` (an offset at the cap); the include
scope pushdown; the `cursor?.key ?? null` fallback; SQLite, Postgres-shared and memory column
selection ignored. Surviving, equivalent: `order >= 0` in the keyset compare (reached only when
`order !== 0`); `sortKeyOf` without `?? null` (a missing key and a null compare alike in the
evaluator, and the null paging test passes on both). `absent` ignoring `outside` is no longer
observable by itself because the confirming read now drops such a row into `absent` too (defence
in depth).

Fourth review (9d0b888) fixed: `refreshScopes`, the periodic `revalidateSessions` and a membership
index generation change did not drop the cached authentications the read grant is built from (a
removed collaborator kept reading for up to `ttlMs`); a hung auth provider held its guard slot
forever (calls now have a deadline, 503, and a late answer is never cached); an authentication
in flight during an eviction was cached anyway (an epoch counter now prevents it); the oracle of
the property test resolved fields by arrival instead of by version (the reviewer's counterexample
is a fixed regression, and the random-seed property ran 200 times on memory and 40 on SQLite
with no failure); overstated "never refuses a signed-in user" claims (see ambiguity 9); and the
negative cache lifetime is capped at two seconds. Added tests: sealed records in an include and
in `known`, the grant-basis rebuild (once, then 409), the 10,000-entry cache bound, IPv4-mapped
addresses in dotted and hex spelling.

Fourth-review mutants, all killed except three classified: `refreshScopes`, `revalidateSessions`
or an index-generation change not evicting; no provider deadline; a late answer cached; no epoch
bump; uncapped negative lifetime; one lane for all; the hex and dotted IPv4-mapped reductions;
no concurrency or rate cap; inflight slot not released; a thrown provider remembered; cache trim
removed; the sealed filter in an include and in `known`; the grant-basis recheck. Surviving,
equivalent: the related-scope filter in `includeRelation` (the confirming read judges the same
rows again) and the fail-closed `scope === null` test in the confirming read (a collection
without a scope never reaches it: the query returns `denied` earlier).

Fifth review (eefe819) fixed: a read in flight when its user was revoked or narrowed answered the
old grant (the authentication is now stamped when taken and checked again after the rows; an
eviction rebuilds the answer once under a fresh authentication, then 409); a request arriving
after an eviction joined a pre-eviction authentication in flight (eviction now drops the join
table, and a settling call removes only its own entry); stalled body senders could fill the
global body cap before authentication (cached principals have their own pool, trusted addresses
16 bodies each, 32 uncached when no address is trusted, and a minimum-rate deadline);
lanes that could exceed the configured caps (a budget too small to split is one lane); the
deadline timer is unref-ed, the provider is passed an `AbortSignal`, and abandoned calls are
capped; the eviction stamp is per user (global only for generation changes, device-only
revocations and the periodic revalidation). The lane split is stated as adding little.

Fifth-review mutants, all killed: eviction not dropping the join table; any-entry deletion on
settle; no stale check after the rows; no re-authentication on the rebuild; second eviction not
409; late or stale answers cached; user evictions global or ignored; wrong stamps at lookup and
at resolve; the shared lane for a small budget; timer not cleared or not unref-ed; signal not
aborted or not passed; orphan cap off or never released; the unavailable answer; cached pool
bypass; per-address and unattributed caps; the body deadline; body slot release; cached-token
detection.

Sixth review (a6ea3eb) fixed: body slots were keyed on the raw address (now the same bucketing as
the failure limiter, so a /64 or the spellings of a mapped IPv4 address share one allowance);
a cached user could take the whole cached body pool (8 per user now); abandoned provider calls
that never settle wedged the orphan cap (they stop counting after `orphanTtlMs`, 60 s); the abort
signal now reaches `MixedAuthProvider`, `TokenAuthProvider` and, as a check between I/O steps,
`KoraAuthProvider`; the second-eviction 409 message no longer says "memberships" for a revocation.
Added tests: body deadline tied to the server over real HTTP, the joined waiter's stamp, the
per-user eviction map trim (the floor), a refusal racing a global eviction, orphan recovery.

Known limits: a boolean scope is not pushed to the store (bounded by the cap); the
record-pairing check compares values and `_updated_at`, so a write that restores the same values
within one millisecond between the two reads is not detected; the body timeout has no
deterministic test; Postgres runs only in CI.

### S3 result

**What was built.** A large first sync is applied into a scratch **in-memory** replica and merged into the
live database once.

- `Store.beginStaging()` opens the replica: a second SQLite WASM worker (memory, no OPFS, no journal file) in the browser,
  `:memory:` on native SQLite (`StorageAdapter.createStagingAdapter`). It is an ordinary `Store` with the same schema
  minus indexes, so `applyRemoteBatch`, the C3b prefetch, the fold, quarantine and the chained watermark run unmodified.
- `SyncEngine` stages the first delivery stream of a view (base 0, watermark 0, more than one batch, server frontier at least
  `bulkReplication.minOperations` = 2000) by pointing `applyBatchInOneTransaction` at the replica's store and sync state. The
  final batch merges. A batch that narrows the view or retracts records, or that fails to apply in the replica, does **not**
  restart the stream: the clean staged prefix is merged (`mergeStagedPrefix`, the same merge as the final one, which writes the
  watermark of the prefix) and the rest of the stream is applied directly on the same connection. A scope or view change, `stop()`,
  a revocation, a server rollback or a full resync drops the replica (memory, nothing to delete) and puts the live watermark
  back. `sync.bulkReplication: false` turns it off.
- `mergeStagingInto` copies **whole records** (row, op log, fold state, base, snapshot, provisional effects, retraction marker)
  in chunks sized to about 150 ms of live-worker time (parents before children for foreign keys, deferred foreign-key check
  per chunk). A record the live database already has anything for (a write made while replicating, an operation under this
  device's own node id, a reused node/sequence) is never copied over: its staged operations replay through the ordinary pipeline
  (`ApplyPipeline.applyRemote`), which deduplicates and folds with live history. The version vector moves in the chunk that
  carries the operations; the HLC adopts the newest staged timestamp after the merge; the watermark, quarantine rows and
  completion mark are written in the **last** transaction.
- Anything that cannot be reproduced faithfully by copying (a retracted record also written here, changed authoritative node ids,
  a missing column) returns `unmergeable`: the replica is discarded and the stream is replicated again directly.

**Decision D10 and the invariants.** Nothing of a staged stream is in the live database, and the live watermark has not moved,
until the merge, so a crash, reload, `stop()`, view switch, server rollback or failed merge leaves the live database exactly
where it was; the next session replicates from the live watermark (the replica is memory, so there is nothing to delete). Chunks
that committed before a crash hold whole records (log, state and row together), never a state without its log. The server's
acknowledgments of staged batches are session flow control, and a resume always starts from the handshake's watermark, so
acknowledging early loses nothing. Writes made during replication go to the live database at once, are visible, are uploaded
normally, and merge with the staged copy of the same record (tested, including the server echoing the device's own write).

**Mid-stream retractions, stalls and a device narrowed while staging (exactly what happens).** The replica is invisible to
the user and to the live watermark, so any event that makes staged data wrong or unfinishable has to end with the live database
holding either a whole, consistent prefix under an honest watermark or nothing.

- *A batch that retracts records or narrows the view.* A retraction needs the live records to act on, and the replica only
  holds the stream so far. The engine merges the staged prefix first (live database now equals the direct apply of those
  batches, watermark = end of the prefix, written in the last merge transaction) and applies the retracting batch and everything
  after it directly, through the ordinary single-transaction path. Safe because the merged prefix is by construction what the
  direct path would have produced, and the batch that follows chains from the new live watermark (`baseDeliverySequence` equals
  it), so the gap-free rule holds. Test: "retractions are honoured" and "a batch that narrows the view merges what is staged".
- *A stall or a failed apply in the replica.* The replica store rolls the batch back like any store: its watermark stays at the
  batch base, nothing of the batch is acknowledged or announced, and the engine merges the prefix and continues directly,
  where the batch is retried by the ordinary path (and quarantined or stalled there as before). Test: "a failed apply leaves
  the watermark at the batch base" and "a stall in the final batch completes nothing".
- *A device narrowed while staging* (its scope or query views change, the access rules re-scope it, or the server sends an
  `accessNarrowing` unit): the old replica was filled under the old view and must not be merged as if it were the new one. A
  view change drops the replica and restores the live watermark; the new view starts a stream of its own (and may stage again).
  An `accessNarrowing` unit inside the stream is a retraction batch (first case). A change that lands *during* a merge
  supersedes it: the merge's result is discarded without touching the in-memory or persisted watermarks (guarded in
  `mergeStaging` and `mergeStagedPrefix`; covered by reasoning and the stop/crash tests, **not** by a dedicated test; listed in
  the open questions).
- *Events and notifications.* Everything the replica emits (applied, merge traces, constraint reports) goes into a bounded
  buffer (`ReplicaEventBuffer`, 100000 events, the overflow is counted in `sync:staging-merged.eventsDropped`) and is replayed
  to the live listeners after the merge commits, in slices. Nothing is announced about data that is not yet in the live
  database. Test: "nothing is announced or notified about staged operations until they are in the database".

**Where the time went (profiled).** Node applies the 20k-op fixture in about 0.55 s, so the browser cost was storage: every
batch was a journaled OPFS transaction (403 commits of 16 KiB pages, with a journal write per commit). In the replica there is
no journal and no OPFS, and the live database sees about 20k records in a few hundred large commits instead. What remains
(measured on a quiet host, broadband 1x): about 7.7 s to apply 20k operations into the replica (one worker request per operation
step, hashing, the JS fold) and 2.6 to 3.3 s of merge.

**Measured (S0 parity harness, Kora app only, cold, fixture 20k-1, median of 5 runs per cell; host load 1.0 to 2.9 on the 2 vCPU
host before and after each run, 30 runs kept, none discarded; an earlier matrix run concurrent with other builds, load 5 to 11, was
discarded).** P3 equals K1 on this fixture (the home list is complete when the replica merges).

| Cell | K1 before (S0) | K1 after (S3) | Target | P8 TBT before | P8 TBT after |
|---|---|---|---|---|---|
| broadband 1x | 20.1 s | 13.8 s | 8 s | 0 ms | 0 ms |
| 4g 1x | 22.3 s | 14.7 s | 10 s | 0 ms | 0 ms |
| slow-4g 1x | 38.1 s | 19.2 s | 30 s (**passes**) | 50 ms | 0 ms |
| broadband 4x | 60.1 s | 35.0 s | 8 s | 188 ms | 137 ms |
| 4g 4x | 61.4 s | 35.8 s | 10 s | 139 ms | 108 ms |
| slow-4g 4x | 68.2 s | 42.1 s | 30 s | 137 ms | 119 ms |

K2 (longest main-thread stall while preparing) passes in all six cells (0 ms median). The C3b browser harness (20k-1,
unthrottled, full scope) was 143.55 s median before; the S0 harness is the reference now (see "Contradictions" in the S0 result).

**P7 is not yet meaningful.** The first home row (P2) still appears only after the merge (about 14 s at broadband 1x), because
the screen waits for `app.ready` data that arrives with it; so the "write during preparation" the harness measures runs after
the merge (26 ms at 1x, 37 to 46 ms at 4x, versus 150 to 400 ms before). Whether a write is fast *during* the merge is covered
by the 150 ms chunk bound and the test that writes during replication; the user-visible P7 needs S4a (render before ready).

**Default `minOperations` (2000), measured.** C3b browser harness, unthrottled, full scope, one tenant, 5 runs per cell, bulk
off versus on, host load 0.6 to 3.0 before and after the cells (all cells below the 3.0 gate; 5k on ended at 3.00). Medians in ms:

| Fixture | Home row, direct | Home row, staged | Full scope, direct | Full scope, staged |
|---|---|---|---|---|
| 500 ops | 588 | 2193 | 2597 | 2298 |
| 1000 ops | 641 | 2761 | 5570 | 3056 |
| 5000 ops | 776 | 5580 | 30590 | 6465 |

Reading: staged replication saves 11 percent of full-scope time at 500 operations, 45 percent at 1000 and 79 percent at 5000,
and costs time to the first home row at every size (the row waits for the merge: 3.7x at 500, 4.3x at 1000, 7.2x at 5000). The
cost is the price of S3 alone and is what S4a (render before ready) removes. Below about 1000 operations the gain does not
pay for the first-row delay, so the threshold has to sit above 500; 2000 keeps a 2x margin over the first size where the gain
is large (1000) and is where the direct path starts to hurt (direct full-scope time grows from 5.6 s at 1000 to 30.6 s at 5000; 2000 itself was not measured). It is a
judgment call between 1000 and 2000; I did not measure 2000 directly in this study. **Noisy cells:** one of five staged runs
at 1000 (home row 2540 ms, full scope 9504 ms) and one of five at 5000 (home row 2396 ms, full scope 31267 ms) were bimodal:
the first replica was dropped (the Kora app's query subsets changed the view right after the first batch) and the stream was
re-done directly. The medians exclude nothing (the median of five is the fourth value), but the tail is real: the bad case
costs as much as staging off, plus the wasted first batch. See lever 1 below.

**Merge chunk (150 ms), measured.** The chunk bounds how long the live worker is held by the merge, i.e. the worst write
latency during a merge (P7). Earlier measurement on the quiet host, broadband 1x, 20k operations: 80 ms chunks gave a merge of
4.9 s (per-chunk transaction and foreign-key overhead dominates), 200 ms gave 2.6 to 3.3 s with a 26 ms P7 write, and 150 ms
sits between them (the chunk size adapts: 20 to 1000 records, first chunk 100). I did not re-run 500, 1000 and 5000 for the chunk
size separately. 150 ms is a judgment call
and not a tuned optimum.

**Not met, and why.** K1 targets for broadband and 4g (8 s, 10 s) and every 4x cell are not met. K1 of 13.8 s at broadband
1x is made of about 7.7 s applying into the replica, 2.6 to 3.3 s of merge, about 0.8 s lost when the first replica is dropped
because the query subsets change the view, and about 2 s of boot, handshake and transfer.

**K1 breakdown plan (next levers, in order of recommendation).**

1. *Make the replica survive the first view change (about 0.8 s typical, up to 25 s in the bad case above).* Either start
   staging only once the view has settled or carry the replica over when the new view only narrows or reorders query subsets.
   Cheapest, removes the bimodal tail, and no change to the merge. **Recommended first.**
2. *Coalesce the replica's per-operation worker requests (largest, about 7.7 s to apply).* The replica is memory and private,
   so a batch can be applied as one request with error isolation done by retrying the failing operation alone. Estimated saving
   2 to 4 s (estimate, not measured). Needs a design for isolating a failing operation without losing the savepoint-per-operation
   semantics. **Recommended second.**
3. *Defer index creation until after the merge.* The live database maintains its indexes for every merged row; creating them
   after the merge trades per-row index writes for one scan, probably 0.5 to 1 s of the 2.6 to 3.3 s, but makes the merge end
   with a long index build that holds the worker (needs chunked index creation or a measured bound). Not recommended before
   1 and 2.
4. *Fewer fold-state writes.* Most records have a single operation; their fold state, base and snapshot rows are derivable.
   Skipping them is the "seeds" idea of section 5.6 (C1) and the only lever that moves the apply and merge phases together,
   but it changes what is stored and needs the read-side to rebuild state lazily. This is the lever that gets to 8 s, and it is
   a design stage of its own.
5. *Avoiding the second pass* (making the replica the live database): impossible with OPFS sahpool without handing a file
   between workers; not pursued.

My recommendation is 1, then 2, then re-measure; 8 s at broadband 1x probably needs 4 as well.

**Tests.** `packages/test/tests/staged-replication.test.ts` (48 tests): staged equals direct for deletes, cascades,
concurrent authors, unknown collections (quarantine) and 30 seeded random operation sets (rows, fold state, op logs, version
vector, quarantine payloads, watermark, acknowledgments); stop and reload between batches; writes during replication and the
server echo of a local write; a narrowing batch merges the prefix and continues directly; the delivery invariants on the staged
path (nothing announced before the commit, a failed apply leaves the watermark at the batch base, a stall in the final batch,
retractions honoured, replica events replayed after the merge); crash injection after each staged batch and at every
transaction of the merge, including the last. `staged-replication-e2e.test.ts`: a staged joiner equals a direct joiner on
a real server with encrypted history and with a v1 to v2 schema transform. `batched-delivery-apply.test.ts` gained a
40-seed "staged apply equals per-operation apply" property (deletes, concurrent writes, quarantine, cascades, retractions,
duplicates; final rows, op logs, fold state, version vector, quarantine, watermark and the event stream). The four test
files that assert direct-apply internals now set `bulkReplication: false` explicitly.

**Forced-staging classification.**

Forcing staging on (`minOperations: 0`) for every multi-batch first sync in `packages/test`, before any fix, failed 28 tests in 4 files (everything else passed). Each one individually:

| # | File | Test | What the assertion saw | Class | Resolution |
|---|---|---|---|---|---|
| 1 | batch-retraction-order | an older client (no ordered retractions) gets batches cut before the retraction | rows visible after a non-final batch; with staging they appear only at the merge | (a) | staging off; staged equivalent: a stream that stops before its final batch shows nothing live and leaves the live watermark at 0 |
| 2 | batched-delivery-apply | one transaction for the batch, its watermark and its quarantine | counts live-store transactions (0: the batch is in the replica) | (a) | staging off; staged equivalent: batch, quarantine rows and watermark in one replica transaction, watermark moves only on full apply |
| 3 | batched-delivery-apply | a stall mid-batch rolls the attempt back | stall injected on the live store never fires | (a) | staging off; staged equivalent: stall on the replica leaves the replica watermark at the batch base, nothing acknowledged or published |
| 4 | batched-delivery-apply | a crash during the batch transaction | crash injected on the live store never fires | (a) | staging off; staged equivalent: crash injected at every replica and merge transaction, live database never partial, live watermark old |
| 5 | batched-delivery-apply | a project delete cascades to its lessons | counts live per-operation cascade work | (a) | staging off; staged cascade equals direct (state, op log, quarantine) |
| 6 | batched-delivery-apply | a batch above 500 operations applies in bounded chunks | counts live chunk transactions | (a) | staging off; staged equivalent: the same chunking inside the replica, one merge |
| 7 | batched-delivery-apply | a crash between chunks | crash on the live store never fires | (a) | staging off; staged equivalent: crash between merge chunks leaves whole records under the old watermark, the retry completes |
| 8 | batched-delivery-apply | a stall in a later chunk | stall on the live store never fires | (a) | staging off; staged equivalent: replica stall in a later chunk, batch falls back per operation, re-send completes |
| 9 | batched-delivery-apply | a batch whose batched attempt fell back is not attempted again | counts live attempts | (a) | staging off; covered by the replica stall test |
| 10 | batched-delivery-apply (property) | random delivery stream, seed 1 | `SyncError: transport is not connected`: a retraction or stall made the engine drop the replica and restart the connection | (b) | fixed: the engine merges the clean staged prefix and continues directly on the same connection |
| 11 | batched-delivery-apply (property) | random delivery stream, seed 6 | `SyncError: transport is not connected`: a retraction or stall made the engine drop the replica and restart the connection | (b) | fixed: the engine merges the clean staged prefix and continues directly on the same connection |
| 12 | batched-delivery-apply (property) | random delivery stream, seed 13 | `SyncError: transport is not connected`: a retraction or stall made the engine drop the replica and restart the connection | (b) | fixed: the engine merges the clean staged prefix and continues directly on the same connection |
| 13 | batched-delivery-apply (property) | random delivery stream, seed 16 | `SyncError: transport is not connected`: a retraction or stall made the engine drop the replica and restart the connection | (b) | fixed: the engine merges the clean staged prefix and continues directly on the same connection |
| 14 | batched-delivery-apply (property) | random delivery stream, seed 20 | `SyncError: transport is not connected`: a retraction or stall made the engine drop the replica and restart the connection | (b) | fixed: the engine merges the clean staged prefix and continues directly on the same connection |
| 15 | batched-delivery-apply (property) | random delivery stream, seed 22 | final events differed from the per-operation run | (b) | fixed: replica events and constraint reports are buffered and replayed after the merge commits |
| 16 | batched-delivery-apply (property) | random delivery stream, seed 25 | `SyncError: transport is not connected`: a retraction or stall made the engine drop the replica and restart the connection | (b) | fixed: the engine merges the clean staged prefix and continues directly on the same connection |
| 17 | batched-delivery-apply (property) | random delivery stream, seed 31 | `SyncError: transport is not connected`: a retraction or stall made the engine drop the replica and restart the connection | (b) | fixed: the engine merges the clean staged prefix and continues directly on the same connection |
| 18 | batched-delivery-apply (property) | random delivery stream, seed 36 | `SyncError: transport is not connected`: a retraction or stall made the engine drop the replica and restart the connection | (b) | fixed: the engine merges the clean staged prefix and continues directly on the same connection |
| 19 | batched-delivery-apply (property) | random delivery stream with mid-batch stalls and re-sends, seed 1 | `SyncError: transport is not connected`: a retraction or stall made the engine drop the replica and restart the connection | (b) | fixed: the engine merges the clean staged prefix and continues directly on the same connection |
| 20 | batched-delivery-apply (property) | random delivery stream with mid-batch stalls and re-sends, seed 6 | live-store stall count 0 (expected 32 / 22) | (a) | staging off; the staged property test compares outcomes, not stall counts |
| 21 | batched-delivery-apply (property) | random delivery stream with mid-batch stalls and re-sends, seed 13 | `SyncError: transport is not connected`: a retraction or stall made the engine drop the replica and restart the connection | (b) | fixed: the engine merges the clean staged prefix and continues directly on the same connection |
| 22 | batched-delivery-apply (property) | random delivery stream with mid-batch stalls and re-sends, seed 16 | live-store stall count 0 (expected 32 / 22) | (a) | staging off; the staged property test compares outcomes, not stall counts |
| 23 | batched-delivery-apply (property) | random delivery stream with mid-batch stalls and re-sends, seed 20 | `SyncError: transport is not connected`: a retraction or stall made the engine drop the replica and restart the connection | (b) | fixed: the engine merges the clean staged prefix and continues directly on the same connection |
| 24 | batched-delivery-apply (property) | random delivery stream with mid-batch stalls and re-sends, seed 22 | final events differed from the per-operation run | (b) | fixed: replica events and constraint reports are buffered and replayed after the merge commits |
| 25 | batched-delivery-apply (property) | random delivery stream with mid-batch stalls and re-sends, seed 25 | `SyncError: transport is not connected`: a retraction or stall made the engine drop the replica and restart the connection | (b) | fixed: the engine merges the clean staged prefix and continues directly on the same connection |
| 26 | batched-delivery-apply (property) | random delivery stream with mid-batch stalls and re-sends, seed 31 | `SyncError: transport is not connected`: a retraction or stall made the engine drop the replica and restart the connection | (b) | fixed: the engine merges the clean staged prefix and continues directly on the same connection |
| 27 | batched-delivery-apply (property) | random delivery stream with mid-batch stalls and re-sends, seed 36 | `SyncError: transport is not connected`: a retraction or stall made the engine drop the replica and restart the connection | (b) | fixed: the engine merges the clean staged prefix and continues directly on the same connection |
| 28 | device-apply-round-trips | a 100-operation delivery batch costs few storage round trips | 32 requests against a budget of 21 | (a) | staging off; the budget describes the direct path, staged round trips are reported by the parity bench |

Totals: **(b) 16** (real behavioural differences, all fixed), **(a) 12** (assert direct-apply internals; now run with staging explicitly off, each with a staged-path invariant test). A later forced run found one more (b) with the same root cause as the event-outcome failures: "constraint reports describe each operation of a batch" (reports were lost); fixed by the same event replay.

**Open for Obed.** (1) `minOperations` 2000 and the 150 ms merge chunk are judgment calls backed by the tables above (2000 not
measured directly). (2) A first replica is dropped when the view changes right after its first batch; lever 1 above. (3) A view
change that lands during a merge is guarded but has no dedicated test. (4) Staged `sync:apply-failed` and quarantine events are
emitted by the engine after the replica commit and before the live commit. (5) Merge traces of non-contested staged operations
are replayed from a buffer capped at 100000 events; beyond that they are counted, not replayed. (6) During staging the live
database shows nothing of the stream, and the home row waits for the merge; S4a is the answer.

### Critical-path trim (before S4a)

Measured with `node scripts/bench/bundle-budget.mjs --report-only` (template
`react-tailwind-sync`, production build with a manifest and source maps, KB = 1,000 bytes). The
S0 harness (PR #130) measured +269.6 KB gzip over the plain baseline; this script attributes the
same build's bytes to Kora through the source maps (277.2 KB before this trim), so the two
numbers are neighbours, not the same measurement.

| | Raw | Gzip |
|---|---|---|
| Kora's critical-path JavaScript, before | 970.9 KB | 277.2 KB |
| After this trim | 840.8 KB | **242.1 KB** |
| Saved | 130.1 KB | 35.1 KB |
| K3 budget | | 20.0 KB |

What moved off the critical path, with behavior unchanged:

1. **DevTools** (`@korajs/devtools`, Preact, htm: 57.6 KB raw, about 16.8 KB gzip).
   `setupDevtools` loads the instrumenter and the overlay with a dynamic `import()` only when
   `devtools` is on. Events emitted before the chunk arrives are held (capped, `onAny` on the
   emitter) and replayed into the instrumenter in order, so a late load shows the same history.
2. **protobufjs** (`protobufjs` 31.9 KB, `long` 11.7 KB and the serializer 20.4 KB raw: 64.0 KB, about
   17 KB gzip). `ProtobufMessageSerializer` and `NegotiatedMessageSerializer` moved to
   `protocol/protobuf-serializer.ts` and are reachable by the same `@korajs/sync` exports, plus the
   new `@korajs/sync/protobuf` entry. `@korajs/sync` declares `sideEffects: false`, so a bundler
   drops them when unused; the module touches protobufjs only when it encodes or decodes. The
   engine's default serializer is now `JsonMessageSerializer` (the engine only used it for
   operation (de)serialization, which was already JSON). `HttpLongPollingTransport` keeps its
   default `NegotiatedMessageSerializer('json')` behavior by loading it with `import()` in
   `connect()`; a failed load (offline) leaves the JSON serializer. The wire format and the
   public exports are unchanged.
3. **The beta.12 pairwise pipeline** (`LegacyApplyPipeline`, `MergeEngine` creation): only
   `experimental.legacyMerge` uses them, so they load with `import()` during `initializeApp`
   (before `ready`) when that flag is set.

A static guard keeps these out: `kora/src/critical-path-imports.test.ts` and
`packages/sync/src/protocol/protobuf-opt-in.test.ts`.

What was tried and is not worth keeping: `sideEffects: false` on `@korajs/core`, `store`, `merge`,
`auth`, `react`, `vue` and `korajs` changed no byte (the dist chunks are already consumed whole), so
only `@korajs/sync` carries it (without it, protobufjs returns: 332.8 KB total versus 319.4 KB).

Ranked remaining Kora contributors (raw KB in the critical chunk; gzip is each package
compressed alone, so the column does not add up to 242.1 KB):

| # | Source | Raw | Gzip alone | Reachable cut |
|---|---|---|---|---|
| 1 | `@korajs/store` | 293.1 | 83.0 | S4a: runtime chunk (the store, fold and SQLite glue open after first paint); SQLite WASM loading is a separate stage |
| 2 | `@korajs/sync` | 202.5 | 53.0 | S4a: `SyncEngine` and transports behind `import()` once `sync` is configured |
| 3 | `@korajs/core` | 111.7 | 35.2 | shared; shrinks with the two above |
| 4 | `korajs` | 85.9 | 28.3 | S4a lite entry: version gate, offline keep, storage and encryption controls |
| 5 | `yjs` | 60.0 | 17.4 | load with the first rich-text field (needs async rich-text paths) |
| 6 | `@korajs/auth` | 35.5 | 10.5 | the app's own auth client; move behind the provider's fallback |
| 7 | `lib0` | 19.6 | 7.1 | goes with `yjs` |
| 8 | `@korajs/merge` | 15.2 | 4.7 | constraint and referential checks the fold path uses |
| 9 | `@korajs/react` | 9.0 | 3.4 | needed |
| 10 | inline offline-shell script | 8.2 | 2.4 | unminified template string; minify in the Vite plugin |

The K3 budget is not reachable by trimming alone: the 20 KB target needs the S4a lite entry (app
shell and accessors first, store and sync in a runtime chunk). This stage removes the parts that
were never needed on any path.

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
