# Browser first-sync harness (C1.0(b))

Measures a device's first sync in real Chromium: the real `createApp` from `korajs`, the
shipped SQLite WASM worker on OPFS (`opfs-sahpool`), and the real WebSocket transport against a
real `KoraSyncServer` loaded with the LMS-like fixture of the Node benchmark
(`../lms-first-sync-fixture.ts`). It settles the browser half of the C1 decision in
`docs/design/fast-first-sync.md` (section 4 and "C1.0(b) result").

It is **not** part of `pnpm test` or any CI workflow. A full matrix takes hours.

## Run it

Prerequisites (nothing is downloaded):

```bash
pnpm install
pnpm --filter "korajs..." --filter @korajs/server build        # the packages the page and server use
export PW_CHROMIUM_PATH=/opt/pw-browsers/chromium                  # any Chromium; or let Playwright resolve one
```

Then, from the repository root:

```bash
# Defaults: sizes small,20k-1,20k-5; networks slow-4g,unthrottled; 5 runs each; full scope.
pnpm --filter @korajs/test bench:first-sync:browser

# A quick look (first home row only, one size, 3 runs):
KORA_BROWSER_BENCH_SIZES=small KORA_BROWSER_BENCH_UNTIL=first-home-row KORA_BROWSER_BENCH_RUNS=3 \
  pnpm --filter @korajs/test bench:first-sync:browser
```

It prints the host, one line per run (to stderr) and a Markdown table of median / p95 (to stdout).

| Variable | Default | Meaning |
|---|---|---|
| `KORA_BROWSER_BENCH_SIZES` | `small,20k-1,20k-5` | Comma list of fixture shapes (below) |
| `KORA_BROWSER_BENCH_PROFILES` | `slow-4g,unthrottled` | `slow-4g` throttles over CDP (D8 `throttleNetwork`) |
| `KORA_BROWSER_BENCH_RUNS` | `5` | Fresh browser contexts per configuration |
| `KORA_BROWSER_BENCH_UNTIL` | `full-scope` | `first-home-row` stops each run at the first home row |
| `KORA_BROWSER_BENCH_SUBSETS` | `reactive` | `disabled` turns off the live-query sync subsets (see below) |
| `KORA_BROWSER_BENCH_JSON` | none | Write every run, raw, to this file |
| `KORA_BROWSER_BENCH_CACHE` | `$TMPDIR/kora-browser-first-sync-cache` | Seeded server databases, reused between runs |
| `KORA_BROWSER_BENCH_DEBUG` | off | Print console messages and `sync:*` events with times (adds overhead) |
| `PW_CHROMIUM_PATH` | Playwright's own | Chromium executable |

Fixture shapes (`visible ops` are the school's operations; the log also holds the other
schools'):

| Name | Visible ops | Schools | Log | Ops per record |
|---|---|---|---|---|
| `small` | 2,000 | 5 | 10,000 | 1.8 |
| `20k-1` | 20,000 | 1 | 20,000 | 1.8 (the Node benchmark's "best C2 can do" run) |
| `20k-5` | 20,000 | 5 | 100,000 | 1.8 (the Node benchmark's default) |
| `20k-1-high-ratio` | 20,000 | 1 | 20,000 | about 4 (60% fewer inserts, so records are updated many times) |
| `60k-1` | 60,000 | 1 | 60,000 | 1.8 |

The first run of a shape seeds its server database (about two minutes for 100,000 operations)
and caches it.

## How it measures

- **Cold profile.** Every run is a new Chromium browser context: empty OPFS, empty HTTP cache,
  a new device. The page boots `createApp` (database open, no sync), waits one second idle, then
  the harness applies the network profile and calls `sync()`.
- **Clock.** `t0` is the instant before `app.sync.connect()`, as the Node benchmark times from
  `engine.start()`. Boot is reported separately and is not in the timings.
- **Handshake.** The first `handshake-response` message arrives (a wrapped `WebSocket` records
  the first arrival of each message type).
- **First home row.** `courses where schoolId = <school>`, subscribed before `connect()`, first
  returns a row: the Node benchmark's "first usable data".
- **Full scope.** The sync engine reaches `streaming`. Afterwards (untimed) every collection is
  digested in the page and compared with the server's rows (count and a hash of every field), so
  a fast run cannot win by dropping data.
- **Operations per second.** Operations delivered (`sync:received`) over the full-scope time.
- **Long tasks.** `PerformanceObserver('longtask')` on the main thread between `t0` and the end
  (tasks of 50 ms or more). The SQLite worker is a separate thread and is not observable this way.
- **Peak JS heap.** `performance.memory.usedJSHeapSize` of the page, sampled every 50 ms
  (`--enable-precise-memory-info`). It does not include the worker or the WASM memory.
- **Bytes.** Wire bytes come from a pass-through TCP counter in front of the sync server (frames
  after permessage-deflate, plus WebSocket framing); JSON bytes are the decoded message text the
  page received.
- **Worker requests.** The page counts the requests it posts to the SQLite worker, by type, so a
  slow apply can be traced to commits or to round trips.
- **Network.** `slow-4g` is the D8 preset (`Network.emulateNetworkConditions`: 150 ms latency,
  1.6 Mibit/s down, 750 Kibit/s up). Chromium applies it to WebSocket traffic (checked: a 1 MiB
  download over a WebSocket takes about 7.6 s throttled and 30 ms unthrottled).
- **Statistics.** Median and nearest-rank p95. With 20 or fewer runs the p95 is the maximum.

### Query subsets

`createApp` registers every live query with the sync engine as a query subset
(`sync.querySubsets.mode: 'reactive'`, the default), which makes the engine handshake a second
time. The harness reproduces that by default, because an app that renders its home screen with
`useQuery` does the same. `KORA_BROWSER_BENCH_SUBSETS=disabled` removes it, which is closer to the
Node benchmark (it subscribes on the store with no sync bridge).

## Layout

| File | Role |
|---|---|
| `run.mjs` | Launcher: bundles the page, worker and orchestrator with esbuild into `node_modules/.cache`, runs it |
| `orchestrator.ts` | Matrix, Chromium, CDP throttle, statistics, output |
| `fixture-server.ts` | Seeds, caches and starts the real `KoraSyncServer` over WebSocket |
| `byte-counter.ts` | Pass-through TCP proxy that counts wire bytes |
| `page/page-entry.ts` | The page: `createApp`, timing, instrumentation, correctness digest |
| `page/worker-entry.ts` | The shipped SQLite worker with the wasm URL pinned |
| `digest.ts`, `stats.ts` | Shared pure helpers |

Typecheck: `pnpm --filter @korajs/test typecheck`.

## Caveats

- Server, Chromium and the harness share the same host (CPU, memory). On a 2-core shared VM the
  server's work competes with the browser's. The Node benchmark has the same flaw.
- Headless Chromium on a VM is not a phone. Absolute times on a low-end handset are slower.
- CDP throttling does not model TCP slow start or loss.
- One device syncs at a time; the server is otherwise idle.
