# First-visit parity benchmark (S0)

Measures whether a Kora app is ever slower than a regular web app, from the user's point of view:
the parity contract of `docs/design/first-visit-parity.md` (section 2), stage S0 (section 11).
Two production builds of the same LMS screens run in real Chromium against one server process and
one database:

- **Kora app** (`apps/kora`): `createApp` with default options plus the sync URL, `KoraProvider`,
  `useQuery` and `useMutation`, the `koraServiceWorker()` plugin, started like the
  `react-tailwind-sync` template (`app.ready.then(() => app.sync?.connect())`).
- **Baseline** (`apps/baseline`): the same React components over a plain REST/JSON API, fetch on
  route enter, an in-memory per-session cache, no service worker, non-optimistic writes.

Every time is measured from **navigation start** (`performance.timeOrigin`), never from
`connect()`. It is **report-only**: it prints PASS or FAIL per cell but never fails the process on
a FAIL (stage S6 adds the gate). It is not part of `pnpm test` or any CI workflow.

## Run it

Prerequisites (nothing is downloaded):

```bash
pnpm install
pnpm --filter "korajs..." --filter @korajs/server --filter @korajs/cli build
export PW_CHROMIUM_PATH=/opt/pw-browsers/chromium     # any Chromium; or let Playwright resolve one
```

Then, from the repository root, one command:

```bash
pnpm --filter @korajs/test bench:parity
```

It builds both apps with `vite build`, seeds the server database the first time (about 20 s,
cached afterwards), runs the matrix, and prints the contract table (Markdown, to stdout) and the
raw runs (JSON, path on stderr). The full default matrix (3 networks, 2 CPU rates, cold and warm,
7 runs, both apps) takes about 3 hours on a 2-core host. A quick look:

```bash
KORA_PARITY_RUNS=1 KORA_PARITY_PROFILES=broadband KORA_PARITY_CPU=1 pnpm --filter @korajs/test bench:parity
```

Print the table of saved runs again (several files are merged, for a matrix run in parts):

```bash
KORA_PARITY_REPORT=cpu1.json,cpu4.json pnpm --filter @korajs/test bench:parity
```

| Variable | Default | Meaning |
|---|---|---|
| `KORA_PARITY_PROFILES` | `slow-4g,4g,broadband` | Networks (below) |
| `KORA_PARITY_TEMPS` | `cold,warm` | `cold`, `warm`, and `warm-stale` (separate cell, below) |
| `KORA_PARITY_RUNS` | `7` | Runs per cell; the two apps alternate which goes first |
| `KORA_PARITY_SIZES` | `20k-1` | Fixture: `small`, `20k-1`, `20k-5` (`relations: true`) |
| `KORA_PARITY_CPU` | `1,4` | CPU slowdown rates (CDP `Emulation.setCPUThrottlingRate`); both are gated (decision D1, 2026-10-30) |
| `KORA_PARITY_APPS` | `baseline,kora` | Run one app only (the table then has no cells) |
| `KORA_PARITY_THROTTLE` | `proxy` | `proxy`: one shared shaped link; `cdp`: per-page CDP throttling (see "Network") |
| `KORA_PARITY_JSON` | `node_modules/.cache/parity-bench/parity-<time>.json` | Raw runs, written after every run |
| `KORA_PARITY_REPORT` | none | Comma list of saved JSON files: print their table, run nothing |
| `KORA_PARITY_STEP_TIMEOUT_MS` | `90000` | One scripted step longer than this is a timeout (and fails its cell) |
| `KORA_PARITY_READY_TIMEOUT_MS` | `300000` | How long a cold Kora visit waits for offline-ready |
| `KORA_PARITY_STALE_OPS` | `10000` | Operations the server log grows by for `warm-stale` |
| `KORA_PARITY_DIAG` | none | Cause analysis only: `no-script` opens no screen while the Kora device prepares; `subsets-disabled` runs the Kora app with `sync.querySubsets.mode = 'disabled'` |
| `PW_CHROMIUM_PATH` | Playwright's own | Chromium executable |

## What one run does

For each app, on a new Chromium profile (an empty HTTP cache, OPFS, service worker and storage:
a new device), with the network and CPU shaped **before** navigation:

1. **Cold visit.** Navigate to the app. P1 (first paint of the app shell, not a loading
   placeholder) and P2 (first home row). At P2, the first pass of the script: open a course (P4),
   open its first lesson (P4), "Mark done" (P6), back home (P5). On Kora this pass runs while it
   prepares for offline, so it is reported as P7. Kora then waits for `offline.status()` ready
   (K1, at most 300 s), checks that every collection on the device equals the server's (digest),
   and runs the second pass on a course and lesson never opened before (P4 to P6 after ready).
   The baseline runs its second pass right away. P3 is the first moment the home list equals the
   server's rows, on whichever mount of the home screen.
2. **Warm visit.** The same profile reopened (a browser restart: Kora is offline-ready, the
   baseline's HTTP cache is warm). P1 to P3, then one pass on a third course and lesson.

Each visit stays open until 30 s after navigation, for P8 (total blocking time, navigation to
30 s).

The **warm-stale** cell (`KORA_PARITY_TEMPS=warm-stale`) starts a fresh server per run, prepares
a device untimed and unthrottled (Kora: until offline-ready), grows the server's log by 10,000
server-authored updates (the first 25 rename home courses), then reopens the device on the shaped
network: P2 is the first, possibly stale, home row and P3 the moment the home screen shows the
server's current rows.

## Metrics and the pass rule

| Id | Metric | How |
|---|---|---|
| P1 | First paint of the app | Element Timing render time of the shell heading (`elementtiming="app-shell"`); "Loading..." does not count |
| P2 | First data | `useLayoutEffect` mark when the home list first holds a row |
| P3 | Screen complete | The home list's ids and titles equal the server's (`GET /api/courses`) |
| P4 | Cold navigation | Click (event `timeStamp`) to the first row of a course or lesson never opened on this device |
| P5 | Warm navigation | Click to the first row of the home screen, opened earlier in the session |
| P6 | Write | Click on "Mark done" to the written row in the DOM |
| P7 | Interaction during preparation | P4 and P6 of the first pass of a cold visit (Kora: before offline-ready) |
| P8 | Main-thread blocking | Sum of (stall minus 50 ms) of a 10 ms timer's late ticks, navigation to 30 s |
| P9 | Bytes before first data | KiB the link delivered to the browser before P2 (every connection, service worker included) |

Per cell (metric, network, temperature, CPU): Kora passes when
`p50 <= baseline p50 + max(10%, 100 ms)` and `p95 <= baseline p95 + max(15%, 150 ms)`; warm, Kora
must also be at or below the baseline p50 on P2 to P6. P8 allows +50 ms, P9 +20 KiB. A timeout
counts as infinitely slow. p95 is nearest rank, so at 7 runs it is the maximum.

Kora-only targets: K1 offline-ready (Slow 4G 30 s, 4G 10 s, broadband 8 s); K2 no main-thread
stall over 50 ms between first data and offline-ready; K3 critical-path JavaScript (the entry
script, its module preloads and the inline probe, gzip -9) at most 20 KiB over the baseline's.

The report also prints the **Kora cold phase timeline** (median ms from navigation): entry chunk
downloaded and evaluated, provider fallback, worker script, WASM download start and end and its
compile (timed inside the app's worker entry), `app.ready`, shell mounted, `connect()`, handshake,
first batch, first home row, home complete, service worker shell installed, offline-ready. That
table is what attributes each failing cell to a cause.

## Network

| Profile | Round trip | Down | Up |
|---|---|---|---|
| `slow-4g` | 150 ms | 1.6 Mibit/s | 750 Kibit/s (the D8 preset) |
| `4g` | 60 ms | 9 Mbit/s | 1.5 Mbit/s |
| `broadband` | 20 ms | 50 Mbit/s | 10 Mbit/s |

By default the network is shaped by `shaping-proxy.ts`, a TCP proxy in front of the server: one
link shared by every connection (round-robin between them, as TCP flows share a bottleneck), half
the round trip added each way, one round trip before a new connection carries data. The design
names CDP `Network.emulateNetworkConditions`, but in this Chromium page-level CDP throttling does
not apply to the service worker (measured: the whole precache finished 0.3 s after the entry
chunk ran on "Slow 4G"), so the precache would never compete with the first data (finding F4).
`KORA_PARITY_THROTTLE=cdp` uses CDP throttling instead, for comparison.

CPU: `Emulation.setCPUThrottlingRate` on the page. Measured in this Chromium at rate 4: the page's
main thread runs 3.7x slower, a dedicated worker about 2.3x slower (the SQLite worker is
partially throttled), and the service worker is not throttled.

## Layout

| File | Role |
|---|---|
| `run.mjs` | Launcher: `vite build` of both apps, esbuild bundle of the orchestrator, run |
| `orchestrator.ts` | Matrix, Chromium, shaping, the scripted visits, statistics, output |
| `contract.ts` | The contract's metrics, margins and pass rule (pure) |
| `parity-server.ts` | One `createProductionServer`: static apps, `/kora-sync`, the baseline's `/api` routes through `RouteContext` with the token's grant |
| `shaping-proxy.ts` | The shared-link network model and byte counter |
| `apps/` | The `@korajs/parity-bench-apps` workspace package: `shared/screens.tsx` (both apps' components and timing marks), `shared/probe.ts` (inlined in `<head>`), `kora/`, `baseline/`, `vite.config.ts` |

The fixture is `generateLmsFixture({ relations: true })` with `lmsRelationsSchema`
(`../lms-schema.ts`): `parentId` on modules and lessons (a course) and on questions and lesson
progress (a lesson). The default fixture and its operation ids are unchanged; the relations
fixture has its own cache key.

Typecheck: `pnpm --filter @korajs/test typecheck` and `pnpm --filter @korajs/parity-bench-apps typecheck`.

## Caveats

- Server, Chromium and the harness share one host; on a shared 2-core VM other work adds noise.
  The report prints the load average at the start of each run.
- Headless Chromium on a VM is not a phone; 4x CPU approximates a mid-range one.
- The proxy does not model loss or TCP slow start.
- Observation-only code lives in the apps, not in Kora: the probe, the timing marks, and a
  BroadcastChannel report of the WASM download and compile from the app's worker entry.
- The Kora app declares `offline.auth` (the token in `localStorage` survives a reload); with a
  bare `sync.auth` function and no declaration, `offline.status()` stays `not-ready`
  (`auth-unknown`) forever and K1 could never be measured.
