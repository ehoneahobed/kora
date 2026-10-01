# LMS report Part D (#10–#13, @korajs/server): verification results

HEAD 91c6350 (1.0.0-beta.12). Postgres 16.13, local loopback (RTT about 0.1 ms, so these are the *best case*: every per-query cost scales with RTT on a managed DB). Machine: 2 vCPU. Tests: `packages/server/tests/repro/` (`LMS-10.test.ts`, `LMS-11.test.ts`, `LMS-11-pg.test.ts`, `LMS-12.test.ts`, `LMS-13.test.ts`, shared `lms-fixture.ts`). The PG files skip unless `KORA_PG_TEST_URL` is set. `LMS_OPS` sets the volume. No existing files were modified.

Fixture: 27 LMS collections, 8 fields each. About 60% inserts, 35% partial updates (they do not restate `schoolId`), 5% deletes, and 1% of updates move a record to another school. 20 schools. The scoped user sees about 5%.

---

## #10 Postgres backfill at cold start

**Problem: CONFIRMED. The real problem is larger than reported, and there are 2 new correctness bugs that the proposed fix does not address.**

Measured, with `setSchema` on a fresh store instance:

| ops | records | HEAD cold | HEAD warm restart (already materialized) | proposed (4 parallel, 500-row batches, 1 tx per collection) | batching only (1 at a time) | persisted marker |
|---|---|---|---|---|---|---|
| 50k | 30k | 32.9 s, 30,306 SQL | 23.8 s, 30,306 SQL | 1.50 s, 174 SQL (21.9x) | 1.44 s | 1 ms |
| 100k | 60k | 40.5 s, 60,371 SQL | 40.4 s, 60,371 SQL | 1.43 s, 240 SQL (28.3x) | 1.94 s | 0.6 ms |

- Their 90 s to 8 s claim is plausible. Our 22–28x is bigger than their 11x, consistent with a remote DB plus the parallel overhead below.
- The cost is about one statement per record, row at a time, outside any transaction.
- **It runs on every restart, not only on migration.** A warm restart costs the same as a cold one (40 s at 100k ops, linear in log size). The templates call `await store.setSchema()` before `listen()`, so every deploy has that much downtime.
- HEAD loads the whole collection's op history into memory at once, so memory is O(ops per collection).
- The proposed result is byte-identical to HEAD's materialized state (the test asserts this).

New defects, pinned by tests that fail at HEAD:

1. **Backfill races live writes (rolling deploy).** Instance B reads the log once, then upserts for seconds. A live update that instance A commits in that window is overwritten with B's stale replay. Measured: `after live write: edited-live; after B's backfill: original`.
   - The proposed one-tx-per-collection version keeps the race. The tx snapshot is taken at the first SELECT, so a write A commits before B reaches that row is still overwritten.
   - The bigger transactions also hold row locks on up to 500 rows per statement for the whole collection, which blocks or deadlock-exposes live `applyConditional`.
2. **Tombstones lose their scope fields.** A record that was inserted and then deleted before it was first materialized (restore to a new DB, first `setSchema` on an existing log, or a newly added collection) is written as `(id, _deleted=1)` with NULL fields.
   - The delete op has no data, so `lookupRecordFields` returns NULL `schoolId`. The delete is judged out of scope, while the insert carries its own data and is in scope.
   - A fresh scoped client therefore gets the insert but never the delete: **the deleted record comes back**. Measured: `delivered: ["ins"]`.
   - Every restart re-creates the same tombstone, so it is permanent. The proposed fix copies this behaviour.

Related observation (read in code, not tested): non-merge `importBackup` rewrites `operations` but never touches the materialized tables. HEAD only becomes consistent again at the next restart's backfill, so a marker design must invalidate the marker on restore.

**Proposed fix: ACCEPT WITH CHANGES.**
- Multi-row batching is the entire win.
- Parallelism adds 0.96–1.36x on 2 cores. It costs 4 pooled connections plus 4 large lock-holding transactions. Drop it, or make it opt-in.
- A fixed 500-row batch **breaks on wide collections**: 500 rows x 144 columns = 72,000 parameters, over the 65,535 bind-parameter limit. The test shows the proposed version throws while HEAD succeeds. The batch size must be `floor(65535 / columns)`, or use `unnest()` / `COPY` to a temp table plus `INSERT ... SELECT`.
- Ordering versus delivery_seq: backfill does not touch delivery_seq, and per-record HLC replay order is preserved. Parallelism across collections is safe because they are different tables. The real ordering hazard is the live-write race above.

**State-of-the-art design:**
1. Store a persisted materialization marker: a `kora_materialization (collection, schema_hash, materializer_version, through_delivery_seq)` table, updated under the existing `kora:ensure-tables` advisory lock.
   - Cold start becomes O(1).
   - Rebuild only collections whose hash or version changed, and only incrementally for ops with `delivery_seq > through_delivery_seq`.
   - Restore invalidates the marker.
2. Add a per-row version column `_kora_seq = max(delivery_seq replayed)`. Every upsert, live or backfill, becomes `ON CONFLICT DO UPDATE ... WHERE t._kora_seq < excluded._kora_seq`. This makes backfill idempotent and race-free without long transactions.
3. Stream ops through a server-side cursor ordered by `(collection, record_id, HLC)`. Memory then stays bounded per record, not per collection.
4. Tombstones keep the last live field values. Replay should return the pre-delete snapshot together with a deleted flag.

Overlap: SRV-7 uses the same replay-full-history machinery, and the version column helps there too. SRV-4 is the same multi-instance class (state outside the tx).

**Severity:** perf Medium (deploy downtime, linear in log size). Race High (materialized divergence that feeds scope judgement and route queries until the next restart). Tombstone High (resurrected deleted data on scoped clients).

**Effort:** batching plus parameter-aware sizing about 0.5 day. Marker, version column and tombstone fix 2–3 days.

---

## #11 Delivery stream: per-op `lookupRecordFields`

**Problem: CONFIRMED. The numbers are plausible. Their description is partly wrong, and a related critical security bug turned up.**

Fresh scoped client, `lastDeliverySequence: 0`, real `ClientSession` on PG:

| strategy | 50k ops | 100k ops |
|---|---|---|
| HEAD, `__none__` sentinel, retain | 5.97 s, 19,939 SQL | 12.4 s, 39,802 SQL |
| HEAD, `__none__` sentinel, **retract** | 17.7 s, 68,182 SQL | 40.2 s, 136,225 SQL |
| HEAD, denied collections **omitted** | 4.64 s, 15,601 SQL | 9.7 s, 31,238 SQL |
| proposed preload Map + deny-set + chunk x20 (re-implementation) | 0.47 s, 46 SQL, preloads 23k rows (**all tenants**) | 1.21 s, 71 SQL, 46.6k rows, ~26 MB heap |
| batched `id = ANY($ids)` per 500-op chunk | 1.29 s, 2,682 SQL | 2.96 s, 5,337 SQL |
| scope key on op row at write time + index (SQL pushdown) | 16 ms, 4 SQL | 36 ms, 8 SQL |

What the numbers show:
- **First batch arrives at about the total time** (12,380 of 12,394 ms). The client receives nothing until the whole scan finishes, which is SRV-5. That is what times out on 3G, more than raw query count.
- Payload: 1.79 MB of JSON for 3,577 ops, which is about 5 min at 50 kbps on 2G.
- Plausibility of "5+ min": 136k queries x 2 ms RTT is about 270 s. With a managed PG it is reachable on the retract path at 100k ops.
- What generates lookups: partial updates and deletes in scoped collections, every op when `syncQueries` subsets exist, and, under `retract`, **every out-of-scope op, including inserts and deletes, which can never exit scope** (`scopeRetractionFor` looks up before checking `op.type === 'update' && previousData`).
  - The in-memory test asserts zero lookups for out-of-scope inserts and fails at HEAD: 190 of 200.
  - Moving that check before the lookup is a one-line fix that removes about 70% of retract-mode SQL.

Discrepancies in their description:
- `__none__` appears nowhere in Kora. It is the LMS app's sentinel predicate.
- Kora already denies a collection that is **absent** from the scope map, with zero lookups.
- **However, omission is bypassable. This is a CRITICAL authz bug at HEAD.** `resolveSessionScopes` merges the client's handshake `syncScope` over auth scopes, so a client sending `syncScope: { grades: {} }` gains **read and write** on a collection the auth provider omitted. Both are proven by tests that fail at HEAD; the control without `syncScope` passes. This is probably why the app uses a sentinel.
  - Fix: when auth supplies scopes, the handshake may only narrow collections auth lists, never add new ones.

**Proposed fix: REJECT as specified.**
- **11.1 preload all rows into a Map per stream.**
  - Memory is O(all rows of all scoped collections, all tenants) per concurrent first sync. 50 phones reconnecting means 50 copies, and other tenants' data sits in each session's heap.
  - **It loses data.** A record inserted after the preload and then partially updated during the scan gives a Map miss and an undefined record. The update is judged invisible and dropped, and `maxScanned` advances the watermark past it permanently. Any fallback to a DB lookup on a miss reintroduces per-op queries.
  - It worsens SRV-5 instead of fixing it.
- **11.2 deny-set:** the right idea, but it belongs in Kora as "absent means deny", made secure (fix the handshake merge). A string sentinel should not be special-cased.
- **11.3 skip retractions when `fromDeliverySeq === 0`: INCORRECT.** The stream itself creates client state: an insert is delivered, then a later update moves the record out of scope, and only a retraction in the same stream removes it.
  - The test is pinned, and passes at HEAD.
  - `fromDeliverySeq` is also forced to 0 on scope change and server rollback, when the client holds data.
  - The safe version of the optimisation is the type check above.
- **11.4 chunk x20:** harmless and irrelevant. Scan queries are about 1% of the SQL.

**State-of-the-art design:**
1. Now: put the retraction type check before the lookup. Batch the lookups per scan chunk with one `ANY($ids)` per collection, or a single UNION per chunk. This keeps memory bounded, data fresh, and query count about ops/500 x collections.
2. Stream batches as they fill (SRV-5) so the first batch arrives in milliseconds.
3. Enable `perMessageDeflate` on ws (off by default). A synthetic batch went from 52 KB to 4 KB (upper bound; real data compresses less), or use the protobuf wire format.
4. Medium term: declare scope keys in the schema, stamp them on the op row at write time, and add an index on `(scope_key, collection, delivery_seq)`. The delivery query then filters in SQL, at 36 ms and 8 queries for 100k ops.
   - Caveat: write-time semantics differ from HEAD's current-record judgement (3,898 vs 3,577 ops). Retraction semantics need to be designed alongside it.
5. Long term: compacted snapshot plus watermark for first sync, sending current state instead of full history. On 2G, bandwidth, not SQL, is the floor.

Overlap: SRV-5 (buffering) directly. The ghost re-scan under #12 multiplies this cost.

**Severity:** perf High. Authz bypass **Critical**. The 11.3 regression risk is High if adopted.

**Effort:** type check about 1 h. Batched lookups 0.5–1 day. Handshake-scope fix 0.5 day. Streaming (SRV-5) 1–2 days. Write-time scope keys 1–2 weeks.

---

## #12 WebSocket keepalive

**Problem: CONFIRMED. It is worse than described.**

- No ping exists anywhere. The production server never pinged an idle socket in 35 s (test fails).
- A blackholed TCP peer (no FIN or RST) was still counted after 10 s, and the OS will not notice for minutes.
- **Ghost cost:** a half-open delivery-watermark session never acks. On every delivery-poll tick, `pushDeliveryStreamIfSupported` re-scans **from its unacked watermark (0 on first sync) to the frontier and re-sends the whole backlog.**
  - Measured: 18 full rescans of a 2,001-op backlog in 1 s at a 50 ms tick. At the default 2 s tick on PG that is about 20–40k SQL every 2 s per ghost (see the #11 numbers), plus unbounded socket buffering.
- **The HTTP long-poll transport is never reaped.** An abandoned client stays a session forever with an unbounded `queue` (test: still 1 session after 30 fake minutes). Ping/pong cannot help there.
- The production server does not route HTTP sync at all, but `KoraSyncServer.handleHttpRequest` is public.
- Client side: the sync package has no heartbeat and the protocol has no heartbeat message. Browsers cannot send ping frames, so a client on a half-open socket waits for TCP.

**Proposed fix: ACCEPT WITH CHANGES.**
- Verified: their `ws.terminate()` emits `close`, which goes through `WsServerTransport` to `ClientSession.close` and then `handleSessionClose`. Session, awareness, Yjs and blob relay registrations are all freed (test passes, session count goes 1 to 0).
- Changes needed:
  - Implement it in `WsServerTransport` or `KoraSyncServer.handleConnection`, so the standalone `start()` path is covered too. Their snippet only patches the production-server upgrade handler.
  - Make it configurable (`heartbeatIntervalMs`, default about 25–30 s), terminate after 2 missed pongs, and `unref` the timers.
  - 25–30 s sits inside the 30–120 s carrier NAT idle windows. Pings are tiny, though each one can wake a cellular radio, so keep the interval configurable and do not go below 15 s.
  - Add a handshake timeout (SRV-6).
  - Add an idle TTL for HTTP clients (no POST or GET for N x poll interval, then `transport.close`).
  - Add an application-level heartbeat (server sends `heartbeat` every N s on both transports; the client reconnects after about 2N with no inbound traffic). Also probe immediately on `online`, `visibilitychange` and `resume`.
  - Back off or stop re-pushing a delivery that is stalled unacked (the `repeatCount` stall is already detected and emitted, but scanning continues).

Overlap: SRV-6 (same item: heartbeat, handshake timeout, maxPayload). SRV-5 (each ghost re-send is a full buffered backlog).

**Severity:** High (DB and CPU amplification per ghost).

**Effort:** server heartbeat, HTTP TTL and handshake timeout about 1 day. Client heartbeat plus protocol message 2–3 days.

---

## #13 Cache-Control for static assets

**Problem: CONFIRMED. It is worse than described.**

Actual headers from `createProductionServer` over a Vite-shaped dist:
- Every static response has only `Content-Type` plus COOP/COEP.
- There is no `Cache-Control`, `ETag` or `Last-Modified`, no 304, and no compression.
- The `Cache-Control` string the grep found is only on the `/__kora/events` SSE endpoint.

Further findings:
- Because there is no validator, browsers do not "re-validate every request" as the report says. They re-download in full, or apply heuristic freshness, which is worse.
- `/assets/index-OLDHASH1.js`, a stale tab after a deploy, gets **200 `text/html` (index.html)** instead of 404. That causes a MIME error, and a service worker would cache HTML as JS.
- `.webmanifest` is served as `application/octet-stream`. `.jpeg`, `.webp`, `.mjs` and `.txt` are also unmapped, and no type has a charset.
- 2G cost: a 177 KB real JS bundle is 28 s at 50 kbps uncompressed, 6.2 s gzip, 5.2 s brotli.
- The templates ship no service worker (no `serviceWorker`, workbox or vite-plugin-pwa), so the offline-first app shell cannot load offline. Out of scope for #13, but it is the real fix for repeat loads.

**Proposed fix: REJECT the heuristic. ACCEPT the intent.**
- `filePath.includes('/assets/')` marks **Kora's own template output** `dist/assets/sqlite3.wasm` and `dist/assets/sqlite3-opfs-async-proxy.js` as immutable for a year. These are unhashed copies made by `sqliteWasmHotfix` in every template's `vite.config.ts`. After a sqlite-wasm upgrade, clients would combine new hashed JS glue with a year-cached old WASM or proxy, the version mismatch breaks the DB, and the app is down for its whole data plane.
- It also marks `index.html` immutable if the deploy path contains `/assets/`, which would freeze deploys for a year.
- It never matches Windows paths.
- All three are pinned as pure-function tests.

**Correct design:**
1. Treat a file as immutable only when its path relative to `distDir` matches Vite's hash pattern (`-[A-Za-z0-9_-]{8,}\.`), or, better, appears in Vite's `build.manifest`.
2. Everything else, including `index.html`, `sw.js`, the manifest and unhashed assets, gets `no-cache` plus a strong `ETag` (size, mtime or content hash) and `Last-Modified`, with 304 handling.
3. Serve precompressed `.br`/`.gz` produced at build time, with `Vary: Accept-Encoding`, and fall back to on-the-fly gzip for small text.
4. Return 404 for missing paths that have an extension. Use the SPA fallback only for navigations.
5. Support HEAD, complete the MIME table and add charsets.

Remit: a CDN or reverse proxy is the right production answer. But the templates ship this server as the default single-process deploy, and target markets often have no CDN, so it must be correct by default. Document "put a CDN/Caddy in front" as the scale path, and add a service-worker precache to the templates.

Overlap: none with SRV-*.

**Severity:** Medium for perf. High if the report's heuristic is adopted (sqlite WASM version skew).

**Effort:** 1–2 days (static handler), plus 1–2 days (template SW precache).

---

## Summary

| # | Problem | Fix verdict | Severity |
|---|---|---|---|
| 10 | CONFIRMED, runs every restart; NEW: live-write race, tombstone resurrection | ACCEPT WITH CHANGES (batching yes; parallelism no; parameter-limit-safe; marker + `_kora_seq` guard) | Med perf / High correctness |
| 11 | CONFIRMED; `__none__` is app convention; NEW: **handshake syncScope authz bypass (read+write)**; retract-mode wasted lookups | REJECT (preload loses data + memory/tenant; skip-retractions-at-0 incorrect); do type check + batched lookups + SRV-5 streaming + write-time scope keys | High / **Critical** (authz) |
| 12 | CONFIRMED; ghosts re-scan full backlog every 2 s; HTTP sessions never reaped; no client heartbeat | ACCEPT WITH CHANGES (in transport/server, both paths, configurable, + HTTP TTL + app-level heartbeat) | High |
| 13 | CONFIRMED (no cache headers, no validators, no compression, 200 HTML for missing assets) | REJECT heuristic (makes Kora's own unhashed sqlite3.wasm immutable); hash-aware + ETag + precompression | Med (High if heuristic adopted) |

Tests that fail at HEAD (asserting correct behaviour):
- LMS-10: race, tombstone.
- LMS-11: handshake read bypass, handshake write bypass, retract lookups.
- LMS-12: ping within 35 s, HTTP reap.
- LMS-13: 7 header assertions.

Tests that pass and pin a defect of the proposed fix:
- LMS-10: 65,535 parameter limit.
- LMS-11: first-sync retraction required.
- LMS-13: 3 heuristic tests.
