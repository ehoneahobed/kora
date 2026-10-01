# SRV verification results (SRV-1 .. SRV-7)

Harness: real `KoraSyncServer` + `MemoryServerStore`/`SqliteServerStore`/`PostgresServerStore`, real `TestDevice` clients (Store + `ApplyPipeline` from kora/src + `SyncEngine`) over in-memory transports. Postgres: a local PG16 cluster was started ad hoc (`/usr/lib/postgresql/16`, port 54329); the repro is `skipIf(!KORA_PG_TEST_URL)` like the repo's existing PG tests.

Run commands:
- `cd packages/test && npx vitest run tests/repro/SRV-1.test.ts` (also SRV-2, SRV-3)
- `cd packages/server && npx vitest run tests/repro/SRV-5.test.ts` (also SRV-6, SRV-7)
- `cd packages/server && KORA_PG_TEST_URL=postgres://kora@127.0.0.1:54329/srv4 npx vitest run tests/repro/SRV-4.test.ts`

All repro tests assert the correct behavior and FAIL today. One exception: `SRV-6.test.ts` contains a passing control test that checks the rate limiter works within a single session.

| Item | Verdict | Severity | Effort |
|---|---|---|---|
| SRV-1 | CONFIRMED (arrays/objects/resolvers). Insert-reset: code-read only, narrow reach. Update-after-delete: REFUTED | P1 | L |
| SRV-2 | CONFIRMED (move-in). Move-out under `retain` and scope narrowing: documented, REFUTED as defects | P1 | M |
| SRV-3 | CONFIRMED (measured 2.0–2.5x) | P2 | S |
| SRV-4 | CONFIRMED (all 4 facets, real Postgres) | P2 (vector), P3 (dedup, INTEGER) | S–M |
| SRV-5 | CONFIRMED | P2 | M |
| SRV-6 | CONFIRMED for 4 facets by test, the rest by code reading | P1 (unbounded body), P2 (rest) | M |
| SRV-7 | CONFIRMED (measured) | P2 | M–L |

---

## SRV-1 — Server materialization differs from client merge
**Verdict:** CONFIRMED for array, object and custom-resolver fields. The insert-reset sub-claim is reachable only narrowly and was confirmed by code reading. The "update revives deleted record" sub-claim is REFUTED as a server/client divergence.

**Evidence:** `packages/test/tests/repro/SRV-1.test.ts`. Two devices make concurrent edits through the real sync path (A and B always agree with each other). Observed:
- Arrays, base `['base']`, A sets `['base','a']`, B sets `['base','b']`: clients get `['a','b','base']`, server gets `['b','base']`.
- Objects, A sets `color:blue`, B sets `size:2`: clients get `{color:'blue',size:2}`, server gets `{color:'red',size:2}`.
- Custom resolver (additive qty, base 10, A 15, B 13): clients get 18, server gets 13.
- Update-after-delete: 3 devices, delete at t1 and update at t2 delivered in reverse order. Every client and the server agreed (the record is alive). The client's `applyRemoteUpdateOnDeletedRow` uses the same `replayOperationsForRecord` fold as the server. That test was removed because it passed.
- Insert reset: replay sets `record = {...op.data}` (core/src/operations/replay-record.ts:46-53), dropping fields that an earlier update set. The client `applyRemoteInsertAttempt` merges against the existing row instead. A public client cannot reach this: ids are UUIDv7, and the HLC receive rule orders every update after its insert. It is reachable through `RouteMutation{type:'insert', recordId:<existing>}` (route-context.ts:198-210) or a forged op (SEC-3).

**Location:** packages/core/src/operations/replay-record.ts:37-80 (server fold: whole-value LWW plus atomics). Callers: packages/server/src/store/memory-server-store.ts:369-401, sqlite-server-store.ts:330-360, postgres `rebuildMaterializedRecord`. The client side is kora/src/apply-pipeline.ts:839-865 (`updateNeedsMergeEngine` sends array/object/json/richtext/resolver/constraint fields to the MergeEngine).

**Root cause:** The client resolves non-scalar and resolver fields through the pairwise three-tier `MergeEngine`. The server folds the log with plain LWW. Only atomic ops share one definition.

**Impact:** Server-side readers see values that no client has. These readers are route handlers (`ctx.query/findById`), `applyConditional` admission gates (for example a resolver-merged inventory qty), `operation-constraint-validator`, REST reads, and route-update `previousData`. Clients still converge with each other (but see MERGE-2).

**Fix:** Define one deterministic, order-independent per-field fold in @korajs/merge or core. Clients and server both materialize through it.
- Array: OR-set computed from each op's `(previousData→data)` diff (adds and removes as tagged elements).
- Object/json: key-wise LWW using the per-key diff against `previousData`.
- Resolver: fold the resolver in HLC order with `base = previousData[field]`.
- Insert onto an existing row: per-field LWW, not reset.

Invariant: `materialize(opsSet)` is a pure function of the op set, so server == every client. Replace the pairwise merge in apply-pipeline with "append, then fold" (this also fixes MERGE-2).

**Regression risk:** High. This changes the merge semantics of shipped data, and existing convergence tests depend on the current pairwise behavior. It needs a re-materialization migration on the server.

**Severity:** P1. **Effort:** L.

## SRV-2 — Visibility judged per op against op data / current row
**Verdict:** CONFIRMED for move-into-scope. The other two sub-claims are REFUTED as defects:
- Move-out under the default `scopeExit:'retain'` keeps a stale copy. This is documented (docs/api/sync.md:730-744).
- Auth-scope narrowing is handled client-side at handshake when `scopeExit:'retract'` (sync-engine.ts:1186 `applyScopeNarrowing`).

"Retractions rely on client previousData" holds (operationExitsScopes, server-scope-filter.ts:89-106) but only matters with forged ops (SEC-2/3).

**Evidence:** `packages/test/tests/repro/SRV-2.test.ts`. Setup: a scoped server (`todos:{owner:<user>}`, admin unscoped) with real TestDevices. Bob inserts `{title:'handover',owner:'bob'}` and admin updates `owner:'alice'`. Results:
- Alice: `findById` returns null, both live and on a fresh initial sync from delivery seq 0.
- Server row: `{title:'y',owner:'alice'}`.
- Alice's local op log holds only the orphan update `{owner:'alice'}`; the insert was never sent.
- A control test (an in-scope insert by admin) reaches Alice, so the harness is valid.

**Location:** packages/server/src/session/client-session.ts:1319-1337 (`operationVisibleToClient`), server-scope-filter.ts:132-146 (`buildSnapshot`: op data overrides the current row, so the insert is judged by `owner:'bob'`). Callers: sendDeliveryStream (:1231) and sendDelta (:1125). Same pattern for query subsets: packages/sync/src/scopes/query-subset.ts:52-77.

**Root cause:** Visibility is decided per operation from that op's own field values, not per record. Ops written while the record was out of scope are filtered out forever. The delivery watermark then advances past them (maxScanned), so they are never re-sent.

**Fix:** In the delivery and delta stream, detect a scope entry: the op is visible, but the record's state before this op (from a server replay of the prior ops, not client `previousData`) was not. On entry, emit every prior op of the record (`getOperationsForRecord`, deliverySeq ≤ current) ahead of the op. The client dedups by op id.

Invariant: if a client has received any op of record R, it has received every op of R with a lower delivery sequence.

Also compute exits from server state (pre/post replay), not from `op.previousData`.

**Regression risk:** Medium. It adds burst sends on reassignment, and retract-mode interactions need tests.

**Severity:** P1 (silent, permanent invisibility for multi-tenant apps; scopes are the standard multi-tenant config). **Effort:** M.

## SRV-3 — Streaming push re-sends the whole unacked backlog
**Verdict:** CONFIRMED. One correction: after handshake, `lastAckedDeliverySeq` equals the client's reported watermark, not literally 0 (it is 0 only for a fresh client). The behavior is intentional per durable-delivery.md ("resume from the client's last ACKNOWLEDGED delivery sequence") but harmful to bandwidth.

**Evidence:** `packages/test/tests/repro/SRV-3.test.ts`. The peer's uplink is delayed 20ms to model RTT.
- (a) A fresh peer with a 400-op backlog, plus 5 live writes during its initial sync: 810 ops sent for 405 needed (2.00x). The handshake stream sets state to `streaming` before any ack, and the next relay push resends everything from 0.
- (b) Steady writes, one every 2ms, N=50: 119–126 ops sent (2.4–2.5x).

Zero latency gives 1.0x, so the amplification scales with RTT and write rate. Clients still converged, because duplicates are re-acked.

**Location:** packages/server/src/session/client-session.ts:417-466 (`pushDeliveryStream` calls `sendDeliveryStream(this.lastAckedDeliverySeq, …)` at :438) and :909-918.

**Root cause:** There is no send cursor. Every relay wake-up re-scans and re-sends from the ack cursor.

**Fix:** Add a `lastSentDeliverySeq`. Live pushes send from `lastSentDeliverySeq`, chained with base = lastSent. Rewind `lastSentDeliverySeq = lastAckedDeliverySeq` only when the outstanding batch is stale (no ack within T, via the existing retransmit tick or `outstandingDelivery.sentAtMs`) or when the client reports a gap.

Invariant: lastAcked ≤ lastSent. Each seq is sent once per retransmit epoch. Batches stay contiguous because they chain from lastSent.

**Regression risk:** Low–medium. The client must handle `base > watermark` (a gap) by stalling or NACKing; the existing stall path plus the tick rewind covers it.

**Severity:** P2. **Effort:** S.

## SRV-4 — Postgres store multi-instance defects
**Verdict:** CONFIRMED, all four facets against real Postgres 16 (`packages/server/tests/repro/SRV-4.test.ts`, 4/4 fail).

**Evidence and location:**
1. **In-memory vector cache.** After A applies an op, `B.getVersionVector().get(node)` is `undefined`. postgres-server-store.ts:41, :178-181, :851 (hydrated only at `initialize`).
2. **Legacy clients miss writes.** A legacy client (no `lastDeliverySequence`) handshaking on B did not receive A's op. It received only ops that existed when B started. client-session.ts:1116-1128 `sendDelta` iterates B's stale `getVersionVector()`. Delivery-watermark clients are unaffected because they read `delivery_seq` from the DB.
3. **Dedup outside the transaction.** The same op applied concurrently on A and B returned `'applied'` twice in 19/20 trials. The select at :129-136 sits outside the tx at :140. Consequences: duplicate relay and events, a burned delivery seq, and for deletes the referential cascade side effects (apply-server-operation.ts:84-99) are generated twice with distinct server op ids.
4. **INTEGER overflow.** `sequenceNumber = 2^31` fails with `value "2147483648" is out of range for type integer`. drizzle-pg-schema.ts:26,47 and ensureTables DDL (`sequence_number INTEGER`, `max_sequence_number INTEGER`). It only hurts a forged or very long-lived node, and fails as a throw, not as corruption.

**Root cause:** The store caches cluster-wide state per process, and its check-then-insert is not atomic.

**Fix:**
- `getVersionVector()`: read `sync_state` (cheap, keyed by node). Alternatively, make the interface async-refreshable and refresh before handshake and sendDelta.
- Dedup: perform `INSERT … ON CONFLICT DO NOTHING RETURNING id` inside the tx first. If no row is returned, roll back (or skip the counter, sync_state and materialization) and return `'duplicate'`. Take the delivery seq only after a successful insert.
- Add a migration: `ALTER COLUMN sequence_number TYPE BIGINT` and the same for `max_sequence_number`. Also validate `sequenceNumber` as a safe positive integer at ingest.

**Regression risk:** Low.

**Severity:** P2 (vector facet: multi-instance plus legacy clients). P3 (dedup, INTEGER). **Effort:** S–M.

## SRV-5 — Delivery stream buffers the whole backlog; memory store scan is quadratic
**Verdict:** CONFIRMED.

**Evidence:** `packages/server/tests/repro/SRV-5.test.ts`. N=5000, batchSize=100:
- 5000 ops were scanned and held before the first batch was sent (expected ≤500).
- `MemoryServerStore` visited 32,500 entries for 5,000 ops (each chunk rescans from the head).

**Location:** client-session.ts:1204-1247 (the `deliverable` array is accumulated over the whole `while` loop before any send). memory-server-store.ts:124-141 (linear scan from the start on every call). SQLite and Postgres use indexed `> seq LIMIT` range scans and are fine.

**Root cause:** Pagination applies to the store reads but not to the sends. The memory store does not seek to the cursor.

**Fix:** Stream per scan chunk. After each chunk, send full batches as soon as `batchSize` deliverables are pending, chaining base→max. Carry the remainder forward. Mark the last batch `isFinal` with max = maxScanned. This needs a one-chunk lookahead to know which batch is final, or a trailing empty final batch.

Invariant: server memory per stream is O(scanChunk), independent of log size.

For the memory store, binary-search the start index (ops are in delivery order) or keep an index array.

**Regression risk:** Low–medium (base/max chaining must stay contiguous).

**Severity:** P2. A 1M-op log means 1M ops in heap per fresh client, which is a DoS lever. The memory-store part is P3 (documented as test-only). **Effort:** M.

## SRV-6 — Missing server resource limits
**Verdict:** CONFIRMED. Tested facets are listed with evidence below; the others were checked by code reading.

**Evidence:** `packages/server/tests/repro/SRV-6.test.ts`:
- **Rate limiter reset on reconnect.** With `maxOpsPerMinute:5`, 12 ops over 4 reconnects were never limited. The control test (6 ops in one session) is limited. Location: client-session.ts:371 (`new SessionRateLimiter` per session).
- **Scope-rejected ops not counted.** 50/50 out-of-scope ops were processed (each with a store lookup and an `operation-rejected` reply). No RATE_LIMIT was sent. Location: client-session.ts:957-967, where the scope check runs before `rateLimiter.allow` at :979.
- **HTTP sessions never expire.** 100 `handleHttpRequest` clientIds stayed alive after 24h of fake time. Location: kora-sync-server.ts:886-903 creates sessions; removal happens only on session close (:861-862). Nothing closes an idle `HttpServerTransport`, and its `queue` grows unbounded while unpolled.
- **Unbounded request body.** A 20 MiB unauthenticated POST to a custom route (`/auth/...`) was fully buffered and passed to the handler (status 200, not 413). Location: production-server.ts:278-308 (`readBodyBuffer`/`readJsonBody`, no cap). The same applies to `/__kora/backup/import` (token-gated).

**Code reading only:**
- `clientId` is the only binding for HTTP requests (types.ts:140-149 has no auth field). Anyone who knows a clientId can poll that session's messages or inject messages into the authenticated session.
- No handshake timeout and no ping/pong heartbeat: no timers in client-session.ts, and ws-server-transport.ts has no ping. Half-open sockets hold sessions indefinitely.
- No `bufferedAmount` backpressure (ws-server-transport.ts:52-62).
- `DEFAULT_MAX_CONNECTIONS = 0` means unlimited (kora-sync-server.ts:31).
- No limit on ops per batch: the whole `msg.operations` is decoded (client-session.ts:944). It is bounded only by the ws default `maxPayload` of 100 MiB, since `WebSocketServer` is constructed without `maxPayload` (kora-sync-server.ts:421, production-server.ts:587).

**Root cause:** Limits are per-session and in-memory, ordered after expensive work, and absent at the HTTP and WS layers.

**Fix:**
- Key the rate limiter by authenticated userId/nodeId in a server-level map with TTL. Call `allow()` before the scope check, and count rejections.
- Cap the per-batch op count (for example 1000) and close the session with an error when exceeded.
- Bound `readBodyBuffer` (default 1 MiB, configurable). Reply 413 and `req.destroy()` once over the cap.
- Expire HTTP clients idle longer than T: track `lastSeenAt` in the existing background tick, then `transport.close()`. Bind HTTP sessions to the handshake auth result with a server-issued random session secret that must accompany every GET/POST. Bound the queue.
- Add a ws ping/pong heartbeat, a handshake deadline (close if not handshaken within e.g. 10s), and an explicit `maxPayload`. Choose a sane default for `maxConnections`.

**Regression risk:** Medium. Clients that legitimately burst after a long offline period need the limit to apply per minute with backoff. The existing RATE_LIMIT retriable path handles that.

**Severity:** P1 (unauthenticated memory DoS via body size in the production server's default config). P2 for the rest. **Effort:** M.

## SRV-7 — No op-log compaction; every write replays full history
**Verdict:** CONFIRMED. No compaction, pruning or snapshot exists in packages/server/src. Tombstone rows are kept with `_deleted=1`.

**Evidence:** `packages/server/tests/repro/SRV-7.test.ts`, 3000 sequential updates to one record:
- SQLite: first 300 writes took 530–657ms, last 300 took 2481–2507ms (3.8–4.7x, growing linearly).
- Memory store: 14ms vs 182–407ms (12–30x). It filters the entire log, across all records, on every write.

**Location:** sqlite-server-store.ts:330-360 (SELECT and replay of all of the record's ops inside the write tx). memory-server-store.ts:369-401 (`this.operations.filter(...)` over the whole log, then sort). The Postgres `rebuildMaterializedRecord` follows the same pattern.

**Root cause:** Materialization recomputes from scratch on each write instead of incrementally.

**Fix:**
- Store per-row materialization metadata: the HLC of the last applied op per field, plus the atomic-chain kind.
- When the new op's HLC is ≥ the row's max HLC (the common in-order case), apply it incrementally with the same fold step (extract a `foldStep(state, op)` from `replayOperationsForRecord`).
- Fall back to a full replay only for an out-of-order op.

Invariant: the incremental fold is identical to the full fold for the same HLC-sorted set.

Longer term: snapshot plus tail-compaction of ops below the min acked delivery watermark of all known clients. This needs a client "too far behind → full row resync" path.

**Regression risk:** Medium. The atomic-chain state must be persisted exactly.

**Severity:** P2 (hot records degrade linearly; the log grows forever). **Effort:** M (incremental), L (compaction).

---

## New related defects
- **NEW-SRV-1** (part of SRV-7 evidence): `MemoryServerStore.rebuildMaterializedRecord` is O(total log) per write, not O(record history) (memory-server-store.ts:383-384). P3 (test store).
- **NEW-SRV-2** (from SRV-4 test 3): concurrent duplicate apply on Postgres runs the referential cascade twice (apply-server-operation.ts:84-99), creating duplicate side-effect ops under different server nodeIds. P3. Fixed by the SRV-4 dedup fix.
- **NEW-SRV-3** (from SRV-2): orphan updates for records that never materialize stay in the client op log indefinitely. They are applied as "row absent" (apply-pipeline.ts:347-351). Nothing later backfills the insert, so the client's state is permanently incomplete without any error or stall signal. Same root cause and fix as SRV-2.

## Files created
- packages/test/tests/repro/SRV-1.test.ts (3 failing)
- packages/test/tests/repro/SRV-2.test.ts (2 failing)
- packages/test/tests/repro/SRV-3.test.ts (2 failing; latency via `SRV3_LAT` env, default 20ms)
- packages/server/tests/repro/SRV-4.test.ts (4 failing with KORA_PG_TEST_URL; skipped otherwise)
- packages/server/tests/repro/SRV-5.test.ts (1 failing)
- packages/server/tests/repro/SRV-6.test.ts (4 failing + 1 passing control)
- packages/server/tests/repro/SRV-7.test.ts (2 failing; timing-ratio based, threshold 2x)
