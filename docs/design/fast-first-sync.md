# Design: fast first sync

Status: the visibility index (C2), batched delivery apply (C3), batch-level content-id
verification (C1.0(a)) and batched device reads (C3b) are shipped. The record snapshot (C1,
section 3) is designed but **not built**; section 4 explains why.

Targets for a new device syncing an LMS-shaped scope (20,000 operations, 30 scoped collections,
4G): **first usable data under 2 s**, **full scope under 10 s**. Related:
[durable delivery](durable-delivery.md), [server fold authority](server-fold-authority.md),
[offline readiness](offline-readiness.md), [access rules](../guide/access-rules.md),
[benchmark baseline](../benchmarks/baseline.md).

## 1. Measuring first sync

`packages/test/bench/first-sync.bench.test.ts` (`pnpm --filter @korajs/test bench:first-sync`, not
in `pnpm test`), with `lms-first-sync-fixture.ts` and `throttled-link.ts`:

- **Fixture.** 30 collections, every record with `schoolId`; the device belongs to `school-0`.
  `KORA_BENCH_VISIBLE_OPS` operations of that school are interleaved with as many for each of
  `KORA_BENCH_TENANTS - 1` other schools (default 100,000 operations, 20,000 visible), skewed toward
  high-volume collections; 60% inserts, 35% partial updates, 5% deletes; optional moves between
  schools (`KORA_BENCH_MOVE_RATE`). Deterministic per seed, with real content-hash ids.
- **Server and device.** A real `KoraSyncServer` (SQLite; `KORA_BENCH_STORE=memory|postgres`)
  seeded through `applyRemoteOperation`, granting `{ schoolId }` with `scope: ['schoolId']` declared;
  a real `Store` and `SyncEngine` wired as `createApp` wires them, with `scopeExit: 'retract'`.
- **Network.** An in-process link modelling bandwidth, RTT, ordering and `bufferedAmount()`, with
  deflated wire bytes. Profiles `slow-4g` (1.6 Mbps / 750 kbps / 150 ms), `fast-4g`, `unthrottled`.
- **Metrics.** `handshakeMs`, `firstBatchMs`, `firstHomeRowMs` (a home query subscribed before the
  start first returns a row: **first usable data**), `homeCompleteMs`, `fullScopeMs` (streaming, and
  every collection holds exactly the school's records: **full scope**), apply time, bytes.
- **Correctness check.** Every collection must equal the server's rows and fold states for the
  school, so a speed change cannot win by dropping data. The bench also estimates the payload of a
  C1 snapshot of the same scope.

`KORA_BENCH_AB=1` alternates the index on and off against one seeded log; `KORA_BENCH_BREAKDOWN=1`
replays the received messages into server-less devices and attributes time per statement kind. The
nightly workflow runs the bench on Postgres (`delivery-index-postgres` in `chaos-nightly.yml`). A
browser variant, `packages/test/bench/browser/` (`bench:first-sync:browser`; not in CI), runs the real
`createApp` in Chromium on the SQLite WASM worker with OPFS against a real server over WebSocket, with
CDP throttling and a digest check.

**What the first measurements showed.** The network was not the bottleneck (deflate brings 10 MB of
JSON to about 1.4 MB, overlapped with apply). The scoped handshake pre-pass
(`collectVisibleNodeIds`) and then `streamDelivery` scanned the whole global log, costing seconds
before the first byte on multi-tenant logs. Full scope was bound by one storage transaction per
operation on the device, which in the browser (10 to 17 ms per OPFS commit) is minutes. Stored fold
state is a poor wire format: about 2.3 KB per record against 0.5 KB per operation.

The benchmark also found that a batch's retractions were applied before its operations. Retractions
now carry their stream position (`afterOperations`), clients declaring `orderedRetractions` apply
them in order, older clients get batches cut before such a retraction, visibility follows delivery
order, and `KoraSyncServer.forceFullResync()` repairs affected devices
(`packages/test/tests/batch-retraction-order.test.ts`).

## 2. C2: a visibility index `(partition_key, delivery_seq)`

### Problem

Every delivery read was `operations WHERE delivery_seq > cursor ORDER BY delivery_seq`, each row
judged by `filterDeliveryChunk`. A device seeing 1/T of the log paid T times the useful work, twice
(pre-pass and stream); a resume read every tenant's writes since; live delivery judged every new
operation per session.

### The invariant

The index only narrows what is read; it never decides delivery. `filterDeliveryChunk` stays the
single authority, and the index must return a **superset** of what it would act on below a known
frontier. A false positive costs one judgment; a false negative is a lost operation the watermark
cannot recover. Keys may therefore be 64-bit hashes: a collision only adds rows.

### What `filterDeliveryChunk` acts on

1. Operations visible to the session, judged on the **post** scope snapshot.
2. **Scope entries** (pre outside, post inside), synthesized from the trigger at its sequence.
3. **Retractions** (pre inside, post outside): these need the **pre** key.
4. **The client's own accepted writes that leave the read grant** (`ownWriteLeavesGrant`), found
   by **node**, since the record may be in no partition the session reads.
5. **Membership changes** (`operationTouchesMemberships`): membership rows naming the user; groups
   the user owned or now owns; deletion or restore of a held group; revival of a group the user has
   a membership row for.
6. **The frontier** the final batch claims: nothing acted on may lie below it unread.

### Partition key

`partition_key = int64(sha256(collection \0 field \0 canonicalJSON(value)))` for each field in the
partition set `P(c)` and each value it has in the operation's **pre or post** scope snapshot. `P(c)`
comes from the schema (`scope`, sync-scope bindings, fields named by access read rules, membership
`userId` and group field, group `id` and owner field) plus `deliveryPartitions` on `KoraSyncServer`
for provider scopes the schema does not declare. It is stored with a fingerprint (prefix `dp2:`).

- Operations without a usable snapshot get `collection \0 ?`, read by every session reading `c`.
- **Tombstones**: a delete (or an operation leaving the record deleted) is also filed under every
  partition the record was in before, because a session sends a delete when the record was ever in
  its view. The property test found this case.
- Collection-wide reads and the session's own node use `idx_collection_delivery` and
  `idx_node_delivery` on `operations`.

### Tables

`kora_delivery_partitions (partition_key, delivery_seq)` primary-keyed on both (`WITHOUT ROWID` on
SQLite; Postgres indexes built `CONCURRENTLY` after startup, with invalid ones rebuilt), and sorted
arrays in the memory store. Until indexes are valid, sessions use the global scan.

### Writing

Rows are written **in the append transaction** with the operation and its snapshot, so neither is
ever visible without the other; compaction, log quarantine and replace-mode restore delete them in
the same transaction. A contiguous `delivery_partitions_through` counter, advanced under the
delivery-counter lock (or the single SQLite writer), marks how far the index is complete. Because
every Postgres append holds the counter row lock to commit, a tombstoning write always sees every
earlier snapshot.

### Reading

`getOperationsAfterDeliveryIn(sources, after, limit)` returns operations from any source above the
cursor and at or below `coveredThrough`, in order, deduplicated (Postgres: one statement merging
`LATERAL` ranges; SQLite: per-source queries merged in JavaScript). Source sets above
`MAX_DELIVERY_SOURCES` (256) collapse the widest collection to a whole read, never narrower. The read
re-checks the plan fingerprint, `through` and a reset epoch after probing and falls back to the
global scan if any changed (`through` alone is not a generation across restore and rebuild).

### The session

Sources are computed at handshake and after each grant refresh or re-scope unit: per collection, per
scope branch, one partition field constrained by equality or `$in` (its value keys plus `c \0 ?`), or
the whole collection. For access rules, one source per case of `operationTouchesMemberships`: the
user's `userId` key; the owner-field key for the user on each group collection (finds a group
transferred to someone who held nothing in it); the `id` keys of held groups and capability grants
(group collections are read whole past 10,000 membership rows); the session's node.

A re-scope unit ends the chunk so the next read uses the new sources; a grant change while a chunk is
judged drops the index for the rest of that stream. `streamDelivery` and the pre-pass read through
the index to `coveredThrough`, then scan the tail globally. Every gate inside `filterDeliveryChunk`
is unchanged. Pruning by `joinedSeq` is deliberately not done: earlier operations still produce
retractions and membership units. A scope field outside `P(c)` reads the collection whole and logs
`delivery.partition_miss` once.

### Migration and backfill on existing databases

A fingerprint change (or a new table) resets `through` and truncates, under the counter lock. A
background backfill, resumable and idempotent, indexes 5,000 operations per transaction after the
scope-snapshot rebuild. In a rolling upgrade an older instance's appends stop `through`; every
delivery poll calls `ServerStore.catchUpDeliveryIndex`, and sessions read the gap by global scan:
slower, never wrong. Restores rebuild the index; exports skip it.

### C2 as built: testing and effect

Membership scenarios; a grant landing mid-chunk; a fast-check property that the indexed stream
equals the global scan over a school fixture (catch-up, live, burst); a property that membership
sources cover every membership-touching operation; "a delete is filed under every partition its
record was in" on every store; rolling-deploy and backfill tests on SQLite and Postgres; the nightly
Postgres job. Removing the unit split or a membership key fails them. In A/B runs (100,000-operation
log, 20,000 visible, node, shared host) the index cut handshake and first home row roughly 3 to 7
times and full scope roughly 2 times at the median.

## 3. C1: cold start from current state (designed, not built)

For a never-synced view the server would send each visible record's fold state, then jump the
watermark to a baseline B; the device stores states as bases and folds later operations on top,
generalizing how scope entries carry fold state. Synthetic insert operations were rejected: new HLCs
would beat older offline edits, and they fail content-id verification.

- **Negotiation, two phases** (the plan includes authoritative node ids, which a new device learns
  only from the handshake response): the handshake sends the authority-independent plan part; the
  server offers only for a view that never had a delivery run (not a reset view, which must be able
  to remove out-of-view records), with no end-to-end-encrypted collection and no access rebuild; the
  client confirms the full plan or declines before any batch is sent.
- **Server.** Read B first, then the grant, then page records with their fold state. Isolation
  across pages is unnecessary because fold states only grow and the fold is idempotent; freshness is
  required (stale states brought up to date, no read replicas). Tombstones in scope are sent, or a
  later revival diverges from replay.
- **Device.** One transaction per batch: join into the base, re-fold with the local log (unsent edits
  kept), materialize. Resume keeps B or restarts; a restart removes every contribution of the run
  except local operations. Unstorable states are never dropped (no ack; after retries, fall back to
  operations). Completion marks follow [offline readiness](offline-readiness.md), section 10. Rich
  text sends the server's Yjs update set as is; blobs travel as refs; encrypted collections are
  excluded.
- **Gate.** A fast-check property over every field kind: snapshot base at a cut B (with read lag)
  plus the later stream (with duplicates) plus unsent local operations minus rejected ones equals
  folding all operations directly. Under the default `retain` policy a snapshot device lacks records
  that left its scope before it connected; that difference is intended.
- **Blockers found in review.** R16: snapshot stamps must pass through `clock.receive` (invalid
  stamps quarantined per record). R17: "new view" is not "new device", so negotiation needs an
  explicit view-history field or a sweep. R18: restart cleanup needs a persisted record of remote
  operations received above B. R19: resume must bind scope key, subsets, grant, rules key and fold
  plan. Also: keyset byte-bounded paging, a frozen grant, plan ids that survive minification,
  handling authority and field-kind changes, two tabs, and every serializer and transport.
- **Fold-state disclosure.** A fold state carries removal markers, resolver logs, atomic chains and
  Yjs structure. Scope entries send a redacted form to late joiners; C1 would extend that exposure to
  every record, and redaction for history-gated collections is incomplete. This must be settled
  before C1 covers access-controlled collections.
- **Size.** In today's encoding a snapshot is about 2.5 times the operations' JSON (1.3 times
  deflated); a compact encoding (one stamp table per record, full operation ids) would be required.

## 4. Whether C1 is needed

First usable data: C2 removes the server cost before the first byte, and a page of records costs
about what a batch of operations does, so C1 barely helps; Chromium on OPFS at Slow 4G reaches the
first home row in about 1.5 s median without it. Full scope: the bottleneck is device apply, which C1
divides at best by the operations-per-record ratio (1.8 on the fixture), at the cost of the largest
correctness surface in the workstream. Correctness ranks above performance and only measured
bottlenecks are optimized, so the chosen levers were C3 and C3b, which help every sync. Revisiting C1
needs a real deployment's operations-per-record ratio and a per-record cost well below a
per-operation one.

## 5. C3 as built: one storage transaction per delivery batch

`SyncEngine.handleOperationBatch` first tries `SyncStore.applyDeliveryBatch` (`Store.applyRemoteBatch`
underneath): retractions and operations in stream order, each in a savepoint with buffered statements
sent to the worker in `batch` requests, then quarantine rows and the watermark advance, all in one
transaction. Everything published (notifications, `operation:applied`, merge traces, apply failures,
retractions, constraint reports) runs after the commit, in order, in one query refresh.

- **A mid-batch stall rolls back, then applies per operation**, which leaves the watermark at the
  base and does not acknowledge. Committing a prefix would need an intermediate watermark, unsound
  because retractions and scope entries have sequences of their own and retransmission is per batch.
- **Constraint checks** run after each operation through the batch's transaction; only reports wait.
- **Bounded transactions:** chunks of at most `MAX_DELIVERY_TRANSACTION_OPERATIONS` (500), so other
  work is not blocked; only the last chunk moves the watermark, and a re-sent batch's applied part
  folds as duplicates.
- **Per-operation path kept** for re-sent fallen-back batches, the blocking operation, access
  narrowings, retractions of records with unsent writes, and split storage.

Tests: `packages/store/src/store/remote-batch.test.ts`,
`packages/store/tests/integration/remote-batch-worker.test.ts`, and
`packages/test/tests/batched-delivery-apply.test.ts`, including 40 seeded random streams in which a
batched device must match a per-operation device in rows, fold states, logs, markers, version vector,
quarantine, watermark, query results, acknowledgements and events. On native SQLite commits turned
out to be about a third of device time; in the browser, where a commit is a fixed cost, C3 removes
almost all of them.

## 6. C1.0(a) result: batch-level content-id verification

`SyncEngine.prepareInboundBatch` decrypts and verifies a batch before its transaction, digesting in
concurrent groups of 64 so WebCrypto work overlaps. Every operation is still verified exactly once;
results pass through an internal weak map and are reused by a per-operation fallback. Failures are
handled in `applyInbound` as before, with the same quarantine codes and events.
`packages/sync/src/benchmarks/batch-verification-bench.test.ts` shows the engine's per-operation
cost roughly halved.

## 7. C1.0(b) result: browser first sync

With C2, C3 and C1.0(a), in Chromium on OPFS: first home row about 1.4 to 1.8 s at Slow 4G for
single-school logs, under target (a five-school log was slower until the pre-pass moved onto the
index). Full scope was minutes: each operation still cost about 19 worker round trips, mostly reads
inside the batch transaction, and time scaled with operations, not network or log size. Reactive query
subsets caused a second handshake that delayed the first row slightly. Every run's digest matched the
server. Caveats: shared 2-core host (about 20% variance), desktop Chromium, CDP throttling without
loss; the IndexedDB fallback, multi-tab and installed PWAs were not measured.

## 8. C3b result: device apply round trips

Applying one operation cost about 18 storage calls (13 reads, 5 writes). Now:

- `SyncStoreBatch.prefetch`: the engine announces a chunk's operations and the store reads what they
  need once (`RemoteBatchPrefetch`: logged or compacted status, sequence-number holders, and per
  record the fold state, base, snapshot, provisional effects, retraction marker and row). Operations
  fold from the cache, which their own writes keep current.
- Merge-trace priors are read together before the commit (`resolveDeferredPriors`; failure rolls the
  batch back to the per-operation path). A step's `SAVEPOINT`, statements and `RELEASE` travel in one
  request; audit traces are grouped.
- Anything the cache cannot answer takes the per-operation path, which remains the fallback.

Semantics are unchanged. A cross-step write buffer was rejected: it broke the rule that a failing
statement undoes only its own step. Round trips fell to about 1.07 per operation and browser full
scope fell about 2.7 times; the remaining floor is SQLite page and journal I/O through the OPFS
rollback journal. Tests: `packages/store/src/store/remote-batch-prefetch.test.ts` (property test
against a per-operation device across merge kinds, constraints, cascades, duplicates, retractions and
failing statements; not covering encryption, transforms or scope-entry fold states) and
`packages/test/tests/device-apply-round-trips.test.ts` (budget of 1.5 round trips per operation).

## 9. Known limits and follow-ups

- Browser full scope for 20,000 operations is still far above 10 s; the floor is page and journal
  I/O. The practical target is fast first data plus progressive completion.
- Provider-granted scopes need declared partition fields (`scope` or `deliveryPartitions`) to use
  the index; learning them from live sessions was rejected as implicit and harder to prove.
- The handshake pre-pass remains for older clients and `kora compact`; a v2 opt-out would save a log
  read per handshake. The first delivery batch waits for a one-batch lookahead.
- If a transaction rejects although its commit landed, the fallback re-applies the batch as
  duplicates: data and watermark are right, but that batch's `operation:applied` events and merge
  traces are not emitted.
- Not measured: IndexedDB fallback, multi-tab, phone hardware, an access-rules fixture, a real
  operation mix. `MAX_DELIVERY_SOURCES` and backfill sizing are untuned.
- C1 remains unbuilt.
