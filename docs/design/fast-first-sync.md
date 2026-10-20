# Design: fast first sync (beta.15 workstream C)

Status: PROPOSED. Internal design doc (not published). Nothing here is implemented except
the benchmark (`packages/test/bench/`).

Targets (beta.15 plan): on a new device, for an LMS-shaped scope (20,000 operations over 30
scoped collections, 4G), **first usable data in under 2 s** and **the full scope in under
10 s**. Field reports say it takes minutes today. This doc does three things:

1. Specifies a benchmark that can be reproduced, and records the first numbers.
2. Designs the server's visibility index (C2).
3. Designs a cold start from current state (C1).

It ends with a decision on whether C1 is needed for beta.15.

Code read for this doc:
- `packages/server/src/session/client-session.ts`: `streamDelivery`, `filterDeliveryChunk`,
  `collectVisibleNodeIds`, `rescopeUnit`, `scopeEntryFor`.
- `packages/server/src/store/{sqlite,postgres,memory}-server-store.ts` and
  `drizzle-{,pg-}schema.ts`: `getOperationsAfterDelivery`, `kora_fold_state`, the delivery
  counter.
- `packages/server/src/access/access-delivery.ts`: interval gating and re-scope basis.
- `packages/server/src/store/scope-snapshot.ts`, `packages/server/src/session/scope-entry.ts`.
- `docs/design/durable-delivery.md`: the watermark.
- `packages/core/src/fold/` and `packages/store/src/fold/record-folder.ts`: the fold.
- `packages/sync/src/engine/sync-engine.ts`: `handleOperationBatch`.

## 1. Measure first

### The benchmark

`packages/test/bench/first-sync.bench.test.ts`, with
`packages/test/bench/lms-first-sync-fixture.ts` and `packages/test/bench/throttled-link.ts`.
Run it with `pnpm --filter @korajs/test bench:first-sync`. It is not part of `pnpm test`.

What the run uses:

- **Fixture.** 30 collections (`users` ... `audit_logs`). Every record carries `schoolId`, and
  the device under test belongs to `school-0`.
  - The log holds `KORA_BENCH_VISIBLE_OPS` operations of that school. They are interleaved
    round robin with the same number for each of `KORA_BENCH_TENANTS - 1` other schools, so
    the default log is 100,000 operations, of which the device may read 20,000.
  - The distribution is skewed: progress, answers, attempts, attendance and audit dominate,
    and the home-screen `courses` collection is about 1/80 of the log.
  - 60% of operations are inserts, 35% are partial updates that do not restate `schoolId`,
    and 5% are deletes.
  - Optionally, a share of updates moves a record to another school (`KORA_BENCH_MOVE_RATE`).
  - The fixture is deterministic for a seed: timestamps start at a fixed epoch, so the same
    options give the same operations, ids included. Operation ids are real version-2 content
    hashes, so the server and the device verify them like any upload.
- **Access.** `TokenAuthProvider` grants `{ schoolId: 'school-0' }` on every collection. This
  is a server-granted scope, so the server filters the delivery stream. An access-rules
  variant, with schools as groups and a membership per user, is listed under follow-ups. It
  exercises interval gating and re-scope units.
- **Server.** A real `KoraSyncServer` on the SQLite store (`KORA_BENCH_STORE=memory|postgres`
  are also accepted; Postgres runs in a fresh schema that is dropped afterwards), seeded
  through `applyRemoteOperation`, so fold state and scope snapshots are the server's own.
- **Device.** A real `Store` on better-sqlite3 with the W7 fold, a real `SyncEngine`, and the
  korajs adapters (`MergeAwareSyncStore`, `StoreQueueStorage`, `StoreSyncStatePersistence`),
  wired as `createApp` wires them. `scopeExit: 'retract'` is set so the device holds exactly
  its scope.
- **Network.** An in-process link that carries JSON text. It models per-direction bandwidth,
  RTT, in-order delivery and the server's `bufferedAmount()`, so delivery backpressure
  behaves as it does over a socket. Bytes on the wire are the permessage-deflate size that
  `ws` sends by default. Profiles:
  - `slow-4g` (default): Lighthouse mobile, 1.6 Mbps down, 750 kbps up, 150 ms RTT.
  - `fast-4g`: 9 Mbps, 1.5 Mbps, 60 ms.
  - `unthrottled`: CPU only.
- **What is timed**, from `engine.start()`:
  - `handshakeMs`: the handshake response arrives.
  - `firstBatchMs`: the first delivery batch is applied (`sync:received`).
  - `firstHomeRowMs`: the home query (`courses where schoolId`, subscribed before the start)
    first returns a row. **This is "first usable data".**
  - `homeCompleteMs`: the home query holds every live course of the school.
  - `fullScopeMs`: the engine reaches `streaming` and every collection holds exactly the
    school's live records. **This is "full scope".**
  - `clientApplyMs`: the sum of the device's per-operation apply time.
  - Bytes down, as JSON and on the wire.
- **Correctness check.** After the run, every collection on the device must equal the
  server's materialized rows for the school: the same records with the same values of every
  schema field, and the same fold state per record. The benchmark fails otherwise, so a
  fast-sync change cannot win by dropping data, a dropped update or a stale field.
- **C1 payload estimate.** The bench also serializes what a record snapshot of the same scope
  would carry, in the exact `RecordSnapshotMessage` shape (section 3): every in-scope record,
  **tombstones included** (soft-deleted rows whose last values match the scope,
  `queryCollection({ includeDeleted: true })`), each as `{ collection, recordId, state }` with
  `state` the stored fold state serialized (`serializeFoldState`) and no separate values, in
  batches of the delivery batch size with the envelope fields (`type`, `messageId`,
  `snapshotId`, `baseline`, `batchIndex`, `isFinal`, `cursor`), as JSON and deflated. It reports
  live and tombstone counts separately. The state is today's canonical encoding; the compact
  encoding (section 3) is estimated from it once it exists, so the number is an upper bound.

### Where it runs and how CI uses it

- **Pull requests: correctness smoke.** Add a step to `benchmark-gates.yml`:
  `KORA_BENCH_VISIBLE_OPS=2000 KORA_BENCH_TENANTS=5 KORA_BENCH_PROFILE=unthrottled`, about
  20 s on a shared runner. It enforces the correctness check, with no time gate.
- **Nightly: the full fixture.** Add to `chaos-nightly.yml`: SQLite, and Postgres where
  `KORA_PG_TEST_URL` is set, at `slow-4g`. It reports `firstHomeRowMs` and `fullScopeMs` as
  `benchmark` annotations, like the store gates. Seeding 100,000 operations takes about
  2 minutes on SQLite, so the seeded server database should be cached by fixture hash.
- **Gates, once C2 lands.** Use absolute targets (2 s and 10 s, x1.1) on dedicated runners.
  Shared runners use the relative A/B check (`scripts/bench/ab-regression.mjs`), as the store
  gates do (`docs/benchmarks/baseline.md`).
- **The browser number.** This one decides the C1 question (section 4). It needs a browser
  variant: record the delivery batches of a node run to a JSON file, then replay them into
  `@korajs/store` in Chromium on the worker and OPFS, next to
  `packages/store/benchmarks/browser/store-browser-bench.mjs`. Node measures the server and
  the protocol, but the browser apply path is where "minutes" comes from.

### Baseline

Measured on the 2-core shared review container (load average about 0.3), one run each,
SQLite server store, delivery batch 100, October 2026:

| Run | handshake | first batch | first home row | home complete | full scope | client apply | down (wire / JSON) |
|---|---|---|---|---|---|---|---|
| 100k log, 5 schools, device sees 20k, **slow-4g** | (not captured) | 3,359 ms | **3,293 ms** | 14,042 ms | **14,148 ms** | (not captured) | 1.44 MB / 10.0 MB |
| same, unthrottled | 2,866 ms | 3,127 ms | 3,035 ms | 13,841 ms | 13,896 ms | (not captured) | 10.0 MB |
| 20k log, 1 school (only visible ops), unthrottled | 439 ms | 568 ms | 541 ms | 11,476 ms | 11,549 ms | 7,491 ms | 10.0 MB |
| same, **slow-4g** | 1,014 ms | 1,401 ms | 1,328 ms | 12,653 ms | 12,703 ms | 8,077 ms | 1.42 MB / 10.0 MB |

Record snapshot of the same scope, in the `RecordSnapshotMessage` shape (11,024 live records
plus 971 tombstones, fold state as stored, no separate values, 120 batches): **25.2 MB JSON,
1.82 MB deflated**, compared with 10.0 MB and 1.42 MB for the 20,000 operations.

What the numbers say:

- **The network is not the bottleneck on node.** Slow 4G adds 0.3 to 1.2 s to runs of
  11 to 14 s. Deflate brings 10 MB of JSON down to 1.4 MB, which takes about 7 s at
  1.6 Mbps, and that transfer overlaps with apply.
- **The global log scan costs about 2.4 s before the first byte of data.** The handshake
  takes 2.9 s against a 100k log and 0.44 s against the 20k log of the same visible data. The
  cause is `collectVisibleNodeIds` (`client-session.ts`), the scoped handshake pre-pass. It
  reads `getOperationsAfterDelivery` from the watermark, and it reads to the end of the log
  whenever another tenant's nodes never become visible. That is the normal multi-tenant case.
  After the handshake, `streamDelivery` scans the global log a second time. This is the cost
  C2 removes.
- **The full scope is bound by per-operation apply on the device.** Apply alone takes 7.5 to
  8 s for 20,000 operations on native SQLite (about 0.4 ms each). That is one storage
  transaction per operation: `Store.applyRemoteFolded`, called once per operation from
  `SyncEngine.handleOperationBatch`.
- **In the browser that same loop is the "minutes".** The recorded OPFS measurements in
  `remediation/HANDOFF.md` and `docs/benchmarks/baseline.md` are 15 to 17 ms per commit (DELETE
  journal), and 47 to 98 ms for a single-insert app-path transaction. 20,000 transactions at
  15 ms or more is at least 5 minutes, before any fold work. This is an inference from those
  numbers, not a browser measurement of this fixture. The browser variant above measures it.
- **The fold state as stored is a poor wire format.** Per record it is about 2.3 KB of JSON,
  against about 0.5 KB per operation. Every field carries a stamp holding a 64-hex operation
  id and a serialized HLC, and `reg` states store the value twice (`e[].v` and `val`). At this
  fixture's 1.8 operations per live record, a naive C1 sends more bytes than the operation
  stream.

### Found while measuring: retractions overtake the operations of their own batch

With `KORA_BENCH_MOVE_RATE=0.01` (1,000 visible operations, 2 schools) the correctness check
fails. The device keeps `lesson_progress-154`, which was inserted in `school-0` and moved to
`school-1` 98 operations later. With delivery batch 1 the same fixture passes. That points to
ordering within a batch, and the code confirms it.

The cause:
1. `sendDeliveryBatch` puts a batch's retractions in a separate `retractions` array.
2. `handleOperationBatch` (`sync-engine.ts`) applies every retraction before the batch's
   operations.
3. When a record's insert and its scope exit share a batch, the retraction runs first,
   against a row that does not exist yet. `Store.applyScopeRetraction` hides nothing.
4. The insert then materializes a live row, because `materializeRow` consults
   `_kora_scope_retractions` only for an existing row.

Retractions for access-rule collections are sent whatever the exit policy, so this affects
beta.15 access rules by default. It is independent of C1 and C2 and should be fixed first.
Two possible fixes:
- Make the order explicit on the wire (additive): each retraction carries the index of the
  operation it follows, and the client applies items in stream order.
- For old clients, the server cuts a batch before a retraction whose record has an earlier
  operation in the same batch.

Add a convergence test for it in `packages/test`. The PR smoke above should then run with a
move rate above zero.

## 2. C2: a visibility index `(partition_key, delivery_seq)`

### Problem

Every delivery read is `operations WHERE delivery_seq > cursor ORDER BY delivery_seq`. Today
the only index for it is the global `idx_delivery_seq` (`drizzle-pg-schema.ts`,
`drizzle-schema.ts`), and `filterDeliveryChunk` judges every row. The costs:

- **First sync** costs O(log after the watermark). For a device that sees 1/T of the log,
  that is T times the work that matters, paid twice (the handshake pre-pass and the stream).
- **Resume** after a long offline period costs O(everything written since), including every
  other tenant.
- **Live delivery** (`pushDeliveryStream` on each wake-up) scans each new operation once per
  session. With S sessions that is O(S x new ops) judgments.

### The invariant

The index only narrows what is read. It never decides delivery:
`filterDeliveryChunk` stays the single authority on what a session receives, and the index
must return a **superset** of the operations that `filterDeliveryChunk` would act on below a
known frontier. A false positive costs one wasted judgment. A false negative is a lost
operation, which the watermark cannot recover, because the stream would advance past it.

Every rule below follows from that. In particular, keys can be 64-bit hashes: a collision
only adds rows.

### What `filterDeliveryChunk` acts on

The index has to cover each of these:

1. Operations visible to the session, judged on the **post** scope snapshot (RT-14), or on
   current row plus `op.data` when there is no snapshot. Query views narrow this further.
2. **Scope entries**: an update whose pre snapshot is outside the scope and whose post is
   inside. The entry is synthesized at read time from the trigger operation and shares its
   delivery sequence, so no index row is needed beyond the trigger's post key.
3. **Retractions**: an update whose pre was inside and whose post is outside. These need the
   **pre** key. `accessPreHeld` also gates them on `historyAllows` over the pre values.
4. **The client's own accepted writes that leave the read grant** (`ownWriteLeavesGrant`).
   The record may be in no partition the session reads (a write rule broader than the read
   rule), so these must be found by **node**.
5. **Membership changes** (`operationTouchesMemberships`), which trigger re-scope units:
   - rows of the memberships collection naming the user;
   - group records that the user owned or now owns;
   - deletion or restore of a group the user belongs to (also `grantedGroups`, which
     terminates the session);
   - `revivesGroupOfMine`: a group revived while the user holds a membership row with no
     interval.
6. The **frontier**: the final batch claims `maxScanned` (or the reserved access frontier),
   so the session must know that nothing it acts on lies below that sequence.

### Partition key

`partition_key = int64(sha256(collection \0 field \0 canonicalJSON(value)))` for each field
in the collection's partition set `P(c)`, and for each distinct value that field has in the
operation's **pre or post** scope snapshot.

`P(c)` is derived from the schema, and stored with a fingerprint in `kora_server_meta`
(`delivery_partition_fields`):

- `schema.collections[c].scope` and the sync-scope bindings (`core/src/scopes/sync-scope-bindings.ts`);
- every field that an access read rule of `c` names (`owner`, `member`, `memberOfKey`,
  `where`, recursively through `or` and `and`);
- for the memberships collection: `userId` (a user's own rows are always sent) and the group
  field;
- for each group collection: `id` (deletion, restore and revival of a group) and its owner
  field;
- `deliveryPartitions: { [collection]: string[] }` on `KoraSyncServer`, for providers whose
  scopes name fields the schema does not declare. `TokenAuthProvider` scopes are arbitrary
  maps, so the server cannot infer them.

Two cases need special keys:

- **Snapshot-less operations** (legacy rows that RT-14 could not backfill) get the key
  `collection \0 ?`. Every session that reads `c` includes it. Today these are judged on the
  current row, which can move after indexing, so no value key is safe for them.
- **Snapshot gaps**: a snapshot captured before a scope field existed lacks that field
  (RT-20). The partition fields are scalars, so they are exactly the fields
  `scopeSnapshotFingerprint` covers. A fingerprint change already recomputes every snapshot.
  The index rebuild is tied to the same step, and an operation whose snapshot still lacks a
  field in `P(c)` also gets the `?` key. Over-long strings are recorded as `null` in
  snapshots. They are indexed under `null` and fail closed in the filter, as they do today.

Two cases need no rows at all, because indexes on `operations` serve them:

- **Collection-wide reads**: an `anyone()` rule, a provider grant of `{}` for a collection, or
  a scope whose branches constrain no partition field. These use a new composite
  `idx_collection_delivery (collection, delivery_seq)`.
- **The session's own node** (case 4): a new `idx_node_delivery (node_id, delivery_seq)`.

Write cost is about |P(c)| + 1 rows per operation, a few more for an update that moves a
record. The LMS fixture with `scope: ['schoolId']` writes 1 row per operation.

### Tables

Postgres:

```sql
CREATE TABLE IF NOT EXISTS kora_delivery_partitions (
  partition_key BIGINT NOT NULL,
  delivery_seq  BIGINT NOT NULL,
  PRIMARY KEY (partition_key, delivery_seq)
);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_collection_delivery ON operations (collection, delivery_seq);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_node_delivery ON operations (node_id, delivery_seq);
```

SQLite uses the same table `WITHOUT ROWID` and plain `CREATE INDEX IF NOT EXISTS`. The memory
store keeps `Map<bigint, number[]>`, an append-only sorted array per key, read by binary
search, as `getOperationsAfterDelivery` already does.

`CONCURRENTLY` cannot run inside `ensureTables`' transaction. It runs after it, once per
start, and treats an `INVALID` index left by a crash as absent (`DROP INDEX CONCURRENTLY`,
then retry). Until the indexes are valid, sessions use today's scan.

### Writing

Index rows are written **in the append transaction** that writes the operation and its scope
snapshot (`applyRemoteOperation`, conditional apply, route apply, side effects), after the
snapshot is known. A reader therefore never sees an operation without its rows, or rows
without their operation.

The rows are server-internal and never leave the server, so they reveal nothing across
tenants. A session reads operations only through `filterDeliveryChunk`, exactly as today.
Compaction, the log-integrity quarantine (`operations_quarantine`), and a replace-mode
restore delete the rows of the operations they remove, in the same transaction.

A contiguous `delivery_partitions_through` counter in `kora_server_meta` marks how far the
index is complete. The append transaction already holds the delivery-counter lock (Postgres)
or is the single writer (SQLite). In that same transaction it advances `through` to its own
sequence when `through` equals that sequence minus 1. Access-index reconciles that reserve a
sequence without an operation also advance it.

### Reading

A new optional store method:

```ts
getOperationsAfterDeliveryIn?(
  sources: DeliverySources, // partition keys, collections, node ids
  afterDeliverySequence: number,
  limit: number,
): Promise<{ operations: DeliveredOperation[]; complete: boolean; coveredThrough: number }>
```

It returns the operations in any source, after the cursor and at or below `coveredThrough`
(the value of `through` read before the query), in delivery order, deduplicated. When it
returns fewer than `limit` with `complete: true`, nothing the session acts on lies in
`(cursor, coveredThrough]`.

Postgres uses one statement, one LATERAL index range per key, merged:

```sql
SELECT o.* FROM (
  SELECT DISTINCT s.seq FROM (
    SELECT p.delivery_seq AS seq FROM unnest($keys::bigint[]) k(key)
      CROSS JOIN LATERAL (SELECT delivery_seq FROM kora_delivery_partitions
        WHERE partition_key = k.key AND delivery_seq > $after AND delivery_seq <= $through
        ORDER BY delivery_seq LIMIT $limit) p
    UNION ALL
    SELECT c.delivery_seq FROM unnest($collections::text[]) k(name)
      CROSS JOIN LATERAL (SELECT delivery_seq FROM operations
        WHERE collection = k.name AND delivery_seq > $after AND delivery_seq <= $through
        ORDER BY delivery_seq LIMIT $limit) c
    UNION ALL
    SELECT delivery_seq FROM operations WHERE node_id = $node
      AND delivery_seq > $after AND delivery_seq <= $through
  ) s ORDER BY s.seq LIMIT $limit
) w JOIN operations o ON o.delivery_seq = w.seq ORDER BY o.delivery_seq
```

The node branch also needs `ORDER BY delivery_seq LIMIT $limit`.

SQLite runs one bounded query per source and merges the results in JS (k-way, by sequence).
Each read costs O(|sources| x log n + |sources| x limit). That is not O(visible ops), so key
sets above `MAX_DELIVERY_SOURCES` (proposed 256) fall back:
- `$in` grants collapse to their collection (still a superset);
- past that, the session uses the global scan.

Access grants may hold up to 10,000 group ids (`MAX_ACCESS_GRANT_VALUES`), which is why the
fallback exists.

### The session

At handshake, and again after each `refreshAccessGrant` and re-scope unit,
`DeliverySources` is computed from the downlink scope:
- for each collection, the branches of its scope (`scopeBranches`);
- in each branch, one partition field it constrains by equality or `$in` (the first in
  `P(c)` order), giving that field's value keys plus `c \0 ?`;
- the collection itself when no branch constrains a partition field, and nothing for a
  denied collection.

Then, for access rules:

- `userId` keys on the memberships collection.
- For each group collection, its **owner-field key for the session's user**
  (`group \0 <owner field> \0 canonicalJSON(userId)`). `operationTouchesMemberships` re-scopes
  on any group operation whose pre or post owner is the user, including a group the user does
  not hold yet being transferred to them (and one being transferred away). The id keys below
  cannot find that operation, since the group is not held; the owner field is in `P(c)` for
  group collections and is indexed on both pre and post values, so this key does.
- The `id` keys of every group the user holds an interval for, or a membership row for. The
  row comes from the memberships collection, not the intervals, because `revivesGroupOfMine`
  covers rows that have no interval. The `grantedGroups` are added as well.
- The client's own node.

Each bullet maps to one case of `operationTouchesMemberships` (memberships rows naming the user;
owner pre or post equal to the user; deletion or restore of a held group; revival). A test
enumerates them against the source set: for each case, the triggering operation is returned by
`getOperationsAfterDeliveryIn` and produces the same re-scope unit as the global scan,
including a group transferred to a user who held nothing in it.

A source set derived from intervals changes when memberships change. The re-scope unit is
the point where the stream switches source sets, so the unit's own sequence is the boundary:
the new set is used for reads after the unit. The existing unit logic covers everything at
or before the boundary: it narrows, then sends entries for what the old set never saw.

`streamDelivery` and `collectVisibleNodeIds` read through `getOperationsAfterDeliveryIn` up
to `coveredThrough`, then fall back to today's global scan for the tail. The tail is empty in
steady state, and short after a rolling upgrade. The claimed max is `coveredThrough` (or the
tail's `maxScanned`), as `maxScanned` is today. `filterDeliveryChunk` and every gate inside it
are unchanged:
- interval gating (`historyAllows`, which still judges each operation against the interval
  open at its sequence);
- re-scope units;
- scope entries sharing their trigger's sequence;
- the rule that a batch never ends on an entry;
- the narrowing that starts a batch.

`historyAllows` could also prune by `joinedSeq` per key. That is not done: operations before
`joinedSeq` still produce retractions and membership units, so pruning would break the
superset invariant for a small gain.

A session whose scope constrains a field that is not in `P(c)` logs `delivery.partition_miss`
once, with the collection and field. It then reads that collection by collection. This tells
the developer to declare `scope` or `deliveryPartitions`.

### Migration and backfill on existing databases

1. **Startup** (`ensureTables` / `setSchema`): create the table, and compute `P` and its
   fingerprint. If the stored fingerprint differs, or the table is new:
   - set `delivery_partitions_through = 0`;
   - record `delivery_partitions_from = current counter`;
   - truncate the table, in one transaction under the counter lock.

   New appends index immediately but cannot advance `through` (it is not contiguous). The
   delivery index's rebuild marker follows the pattern of the scope-snapshot rebuild marker
   (`SCOPE_SNAPSHOT_PENDING_KEY`).
2. **Background backfill.** It runs after the server is ready and is not on the startup path.
   - It reads `operations` in delivery order in chunks of 5,000 above `through`.
   - It inserts the rows (`ON CONFLICT DO NOTHING`, so it is idempotent) and advances
     `through`, one transaction per chunk.
   - On Postgres it takes the counter lock only for the final catch-up, so live writes are not
     blocked.
   - It is resumable: a restart continues from `through`.
   - The scope-snapshot rebuild (RT-20) runs first. An operation whose snapshot is still
     pending is indexed under `c \0 ?`.
3. **Rolling upgrade (Postgres).** An older instance appends without index rows, so `through`
   stops at its first such write. The backfill loop runs on every delivery poll and indexes
   the gap, which advances `through` again. Until then sessions read the tail by global scan.
   This is correct, only slower, and the fallback is automatic.
4. **Access-rules deploy, or a schema change of scope fields.** The fingerprint changes, so
   the index rebuilds as in step 1. During the rebuild every session uses the global scan.
   Access sessions are re-scoped anyway, because `accessUnenforceable` sees the read-rules
   fingerprint change.
5. **Backup.** A restore rebuilds the index. Exports skip it, because it is derived data.

### Expected effect

Reads become O(visible operations + |sources| per chunk) for:
- the first sync,
- resume,
- the handshake pre-pass,
- live pushes.

The benchmark's 1-school run approximates the upper bound of that effect. It holds the same
visible volume and shape, but it is not the same records:
the handshake falls from 2.9 s to 0.44 s, and the first home row from 3.0 s to 0.54 s
unthrottled (1.33 s on Slow 4G).

## 3. C1: cold start from current state

The idea: for a view the device has never synced (watermark 0), the server sends each
visible record's fold state instead of its history, then jumps the watermark to a baseline.
The client stores each state as the record's base and folds later operations on top.

Rejected alternative: synthetic operations (one insert per record carrying current values).
They beat older offline edits under last-write-wins, because they carry new HLCs, or else
they forge old ones. They also fail id verification, because they are not the operations
that produced the state. Scope entries already carry `foldState` (RT-29), and C1
generalizes that path.

### Negotiation (additive, within protocol v2)

The handshake gets an optional field:

```ts
recordSnapshot?: { foldStateVersion: number; foldPlan: string }
```

`foldPlan` is the fold-plan fingerprint the client computes for its schema. It uses the same
function that writes the server's `fold_plan_fingerprint`: field kinds, merge strategies,
resolver source, fold-state version, and the authoritative node ids from the previous
handshake (empty on a new device).

The server answers with `recordSnapshot: true` in `handshake-response` only when all of these
hold:
- the plan and the version match its own;
- the view's watermark is 0;
- the scope has no end-to-end-encrypted collection (see below);
- the session is not in an access rebuild.

Otherwise the session uses the operation stream exactly as today. The plan check has to be
redone after the handshake's authoritative ids are known, because those are part of the plan.

Old clients never send the field, and old servers ignore it.

### Message

```ts
interface RecordSnapshotMessage {
  type: 'record-snapshot'
  messageId: string
  snapshotId: string      // one per snapshot run
  baseline: number        // delivery sequence B, captured before any read
  batchIndex: number
  isFinal: boolean
  cursor: string          // opaque resume position (collection, record id)
  records: Array<{
    collection: string
    recordId: string
    state: string         // compact fold state (below)
  }>
  accessRulesKey?: string // on the final batch, as on delivery batches
}
```

After the final snapshot batch, the session streams ordinary delivery batches from
`baseDeliverySequence = B`.

The client acks each snapshot batch with its `messageId`. The final ack commits the watermark
jump to B, in the same transaction as the last records, through `commitDeliveryProgress` and
the view watermark.

### Compact state encoding

As measured, a snapshot in today's fold-state encoding is about 2.5x the JSON bytes of the
operations it replaces (1.3x deflated) at 1.7 operations per in-scope record, tombstones
included. C1 needs `encodeFoldStateCompact` / `decodeFoldStateCompact` in
`@korajs/core`:

- one stamp table per record (distinct `(t, o, c)` triples), with fields referencing stamps
  by index;
- `reg` without the cached `val`;
- operation ids are never shortened. Stamps are compared on the full id, so a shortened id
  could change an order. The full id travels once per distinct stamp, not once per field.

The gate is a property test that `decode(encode(s))` deep-equals `s` for every field kind.
The estimate is about 0.6 KB of JSON per record that was written once. Measure it with the
bench's payload estimate (which serializes this message with today's encoding, tombstones
included) before building the client side, and re-run it with the compact encoding.

### Server: building a consistent snapshot

Order of the reads:

1. Read the delivery counter, giving **B**. On Postgres, read
   `max(delivery_seq, access frontier)` after taking and releasing the counter lock, so every
   sequence at or below B is committed (commit order is sequence order, per durable-delivery).
2. Read the membership intervals and compile the grant **after** B. A membership change at or
   below B is then in the grant, and one above B is met again by the stream. That repeat is
   harmless: `rescopeBasis(held = current)` yields no unit.
3. Page through the records matching the downlink scope, using the existing
   `recordsMatching` with an id cursor. Each page reads the row and the fold state in **one
   statement** (`JOIN kora_fold_state`), so the pair is consistent. Both are written in the
   same transaction.

Snapshot isolation across pages is **not** required. The argument:

- Every state read after B contains every operation at or below B. Fold states only grow:
  `joinStates` is monotone.
- A state may also contain operations above B. The stream from B re-delivers them, and
  merging an operation already in the state is a no-op, because the fold is idempotent.
- A record that left the scope between B and its page is not sent. Its exit operation is
  above B, so the stream carries it as a retraction of a record the client lacks, which is
  harmless.
- A record that entered between B and its page is sent. Its entry operation above B produces
  a scope entry with the same state, which joins idempotently.

Freshness is required. `kora_fold_state` can lag the log:
- during a rolling upgrade, an older instance appended without folding ("merge the missing
  tail", `server-fold-authority.md`);
- `covered_seq` is set to -1 after a restore or a quarantine;
- the `plan` may differ.

The snapshot reads states through the same freshness check the apply path uses: `covered_seq`
and `covered_op_id` against the record's newest operation, plus the plan. A stale state is
brought up to date (tail merge or re-fold) before it is sent. A raw read would silently
omit operations at or below B.

Read replicas are not allowed for the snapshot read: they can lag B.

**Tombstones are included.** A deleted record whose last values match the scope is sent as
its dead state. Without it, an operation above B that revives the record diverges: the
client folds an update onto an empty state, gets no insert and no row. Full replay revives
the record with every field's merged value. (Red team, case 3.)

A future optimization: send dead records only when a later revival operation exists, via a
"revival entry" at that operation, like a scope entry. That needs its own proof and is out
of scope.

Under access rules, the snapshot is the current state of the records the current grant
admits. That is exactly what a late joiner receives today through scope entries, so interval
gating needs no new rule. The session sets:
- `run.held` to the live intervals the grant was compiled from;
- `run.asOfSeq` to null;
- `rulesChanged` to false, with the rules key sent on the final batch.

The stream from B then re-scopes only on membership operations above B.

### Client: applying a snapshot

`record-snapshot` is applied inside one storage transaction per batch:

1. For each record, decode the state. If it cannot be read, or `mismatchedFoldFields` is not
   empty, the batch is not acked (see quarantine below).
2. `joinIntoBase` into `_kora_fold_base`. That table is for exact, operation-built states, and
   the server's state is one.
3. Re-fold the record: `join(base, snapshot, fold(log - rejected))`. This keeps any local
   operation, including **unsent offline edits**: on a device that is not new, the view is new
   but the device may hold data. Then materialize the row (`clearRetraction: true`).
4. Record `(snapshotId, B, cursor)` in `_kora_meta`, and add the record to
   `_kora_snapshot_records (snapshot_id, collection, record_id)`.

Records become visible to queries as soon as their batch commits. That is the point of C1:
the home screen renders from page 1.

Unsent local edits upload as usual. The server folds them, the stream above B does not echo
them (`ownOperationsIncludedThrough`), and the join already shows them locally. Terminal
rejection re-folds from base and log without the rejected operation, so the record returns to
the server's state. The version vector is not advanced by a snapshot. This is fine, because
v2 clients count pending from their own acks (RT-28).

**Resume.** A reconnect mid-snapshot sends `snapshotResume: { snapshotId, baseline, cursor }`
in the handshake. If the server still accepts B, it continues paging with the **same** B. This
is correct by the argument above, because the stream from B covers every change after B,
including changes to records already sent. The server does not accept B when:
- the access generation or rules key changed;
- the delivery index fingerprint changed;
- the server was restored below B.

In that case it answers `snapshotRestart`. The client then hides the rows of every record in
`_kora_snapshot_records` for that snapshot that has no log rows and no local operations, drops
those bases, and starts over. Without this, a record sent in run 1 and out of scope by run 2
would stay on the device with nothing to retract it.

**Quarantine.** A record state the client cannot store must not be dropped. That covers an
unknown collection after a downgrade, a plan mismatch the handshake missed, and a corrupt
payload. The batch is not acked, and the existing stall path applies. After
`MAX_SNAPSHOT_ATTEMPTS`, the client persists `recordSnapshot: disabled` for the view,
discards the snapshot as for a restart, and syncs from operations. The data is still
complete, just slower.

On the server, records with quarantined history (RT-70, `quarantine-base.ts`) fold onto a row
snapshot with sentinel stamps. Sending that state gives the client exactly the server's view.
Their states are flagged, and the property test below compares against the server's state for
them, not against log replay. The server's own replay of its log is incomplete for those
records.

### Access-rule retraction during and after a snapshot

- **Revocation above B.** The stream meets the membership operation and builds a narrowing
  unit with the existing logic. The narrowing runs on the client's own values, so it removes
  records that came from the snapshot like any others. Records with unsent writes are kept,
  as today.
- **Revocation between the grant read and B.** This cannot happen, because B is read first.
- **A rules deploy during the snapshot.** `accessUnenforceable` fires
  (`ACCESS_RULES_CHANGED`), and the session ends. The resume is refused (the rules key
  changed), so the client restarts, as above.
- **The found retraction-ordering bug.** It applies to the post-snapshot stream as much as to
  today's stream, and must be fixed first.

### Yjs rich text

The `rt` state is the set of Yjs updates plus a reset register. The snapshot sends the
server's set as is (base64 in the compact encoding). The client joins by set union, and
materialization runs `mergeYjsUpdates` exactly as it does from operations. The output
encoding depends only on content, so it is byte-identical.

The set is not collapsed into one merged update. That would make the client's state differ
from the server's (a different set), which breaks the state-equality property and the
subsumption bound for later updates.

Rich text is the largest field kind on the wire. `richtextSubsumes` compaction already keeps
the server's set small. The Yjs doc channel (`yjs-doc-relay.ts`) is unaffected.

### Blobs

Blob fields are registers holding a `BlobRef`. The snapshot carries the refs, and the bytes
are pulled as today through the chunk relay. `BlobAccessIndex` authorizes a pull by "a live
record in the requester's scope references this hash", which the snapshot does not change.
No blob bytes travel in a snapshot.

### End-to-end encryption

The server folds only the cleartext scope fields of envelope operations, and never
materializes sealed members. It has no state to send for them, and the device needs the
envelopes to decrypt. A scope containing an encrypted collection does not negotiate C1. A
later refinement is C1 for the plaintext collections and operations for the encrypted ones.

### Disclosure

A fold state carries more than current values:
- element-set and key-map removal markers (an element set keeps removed values);
- resolver write logs with each writer's base;
- atomic chains since the last plain write;
- Yjs structure.

A late joiner already receives this through scope entries (RT-29), so C1 adds no new class of
disclosure. It does extend the exposure from "records entering a scope" to "every record".
This needs a decision, listed in the open questions.

### The property test that gates C1

In `@korajs/core`, `fast-check`, beside the existing fold property tests. It generates:

- a set of operations O over a few records, covering every field kind:
  - `reg` with atomic chains, `ctr`, `max`, `min`;
  - an element set, including append-only;
  - a key map;
  - a resolver;
  - `rt` with real Yjs updates;
  - server-authoritative fields with an authority set;
- deletes and revivals, and inserts onto existing records;
- a commit order of O, a cut B (a prefix of it), and a read lag L: operations above B that a
  page's state already includes;
- the device's local unsent operations U, and a set R of them the server terminally rejects.

The assertion, for every record:

```
fold(base = foldRecord(prefix(B) ∪ L), then merge (O after B, in commit order, with
     duplicates and re-deliveries of L) ∪ U, minus R)
  == foldRecord(O ∪ U - R)
```

Both serialized states are compared after the compact encode and decode round trip. The
materialized rows (`materialize`) are compared as well.

The end-to-end variant lives in `packages/test`. Two devices sync the same scope, one from
operations under `retract` and one from a snapshot. While the snapshot pages, writes are
injected through a store hook:
- scope moves in and out;
- deletes and revivals;
- membership grants and revokes;
- rules deploys (resume refused);
- reconnects mid-snapshot.

Both devices must then hold identical rows and states, and keep converging under the chaos
transport.

Under the default `retain` policy, a device synced from operations keeps records that left
its scope before it first connected. A snapshot device never had them. The test asserts that
the snapshot device's records are a subset of the operation device's, and that the difference
is exactly those records. This is documented as intended.

### Red team: where snapshot plus later operations could diverge from replay

| # | Case | Outcome in this design |
|---|---|---|
| 1 | The state is read before B, or from a replica behind B, so operations at or below B are missing. | B is read first; reads go to the primary only. |
| 2 | The server's fold state lags its log (rolling upgrade, `covered_seq = -1`, a plan change). | The freshness check and tail merge run before sending. |
| 3 | A tombstone is omitted and a later update revives the record. | Tombstones in scope are sent. |
| 4 | A state includes operations above B that the stream re-delivers. | The fold is idempotent (property-tested, with duplicates). |
| 5 | Pruned history (a plain write prunes older chain entries) meets a late, older operation. | The fold is a CRDT, and the late operation is ignored, as in replay (property-tested). |
| 6 | Client and server fold plans differ: resolver source, merge kinds, authoritative ids, transforms. | Negotiated by plan fingerprint and re-checked after the handshake. Any mismatch uses the operation stream. |
| 7 | A membership change between the grant read and B. | Ruled out by the read order (B, then grant, then records). |
| 8 | A resume with a new baseline B' > B. | Not allowed: a resume keeps B or restarts, and a restart cleans the snapshot's records. |
| 9 | A retraction in the same batch as the record's insert. | Today's bug. It must be fixed independently, and applies equally after a snapshot. |
| 10 | A record that left the scope before first connect (`retain`). | It differs by design, and the test pins it. |
| 11 | Server records with quarantined history. | The client equals the server, not log replay. Flagged in the test. |
| 12 | The client's unsent edits and terminal rejections. | Kept by the join, and removed by re-fold from base and log. |
| 13 | E2E-encrypted collections. | Excluded. |
| 14 | The version vector and dedup of operations at or below B delivered later (a full resync from 0). | They are appended and merged idempotently. The only cost is log size. |

## 4. Decision: is C1 needed for beta.15?

**First usable data under 2 s.** C2 alone plausibly meets this. The benchmark's 1-school run
is the best C2 can do on this fixture, because the server reads only visible operations:
- the first home row arrives at **1.33 s on Slow 4G** on node, against 3.29 s today;
- the handshake falls from 2.9 s to 0.44 to 1.0 s.

C2 also makes the pre-pass in `collectVisibleNodeIds` O(visible). C1 would not improve the
first page much, because the first batch of 100 operations and the first page of 100 records
cost about the same.

The browser is the risk. If the first batch is applied as 100 OPFS transactions at 15 ms or
more, it adds about 1.5 s and misses the target. Applying a delivery batch in one storage
transaction ("C3", below) removes that.

**Full scope under 10 s.** No variant measured so far meets this, C2 included: 11.5 to 12.7 s
on node with C2's upper bound. The bound is per-operation apply on the device (7.5 to 8 s
native), and it is far worse in the browser (inferred at more than 5 minutes for 20,000
per-operation OPFS commits). This is the "minutes in the field".

The first lever is **C3: apply each delivery batch in one storage transaction**:
- `Store.applyRemoteBatch`, called from `handleOperationBatch`;
- quarantine and stall semantics stay per operation, with a savepoint for each;
- the watermark commit moves into the same transaction.

C3 is smaller and lower-risk than C1, and helps every sync, not just cold starts.

C1 then divides the remaining work by the ratio of operations to live records, and removes
the log rows. On this fixture that ratio is only 1.8. In a real LMS after a term, progress
records are updated many times, so it is likely much higher. That is an assumption, and field
data should settle it.

**The measurement that decides.** Run the browser variant of the benchmark in Chromium, with
the worker and OPFS, on this fixture, after C2 and C3, at Slow 4G. Run it at operations-per-
record ratios of 1.8 and of the ratio measured on a real LMS database:
- if `fullScopeMs` is at or below 10 s at the real ratio, **C1 is not needed for beta.15**;
- if not, the same run reports how much C1's per-record path would save, from the payload
  estimate and a record-apply micro-benchmark, before any protocol work.

**Recommendation.** For beta.15, build:
1. the retraction-ordering fix;
2. C2, with the pre-pass on the index;
3. C3 (batched client apply).

Then run the browser measurement.

Keep C1 designed but unbuilt until that measurement says the full-scope target cannot be met
without it. C1 has the largest correctness surface in this workstream: tombstones, resume,
fold-plan negotiation, disclosure of fold-state history, and the E2E exclusion. CLAUDE.md
ranks correctness over performance and says to optimize only the measured bottleneck. Today
the measured bottleneck is per-operation apply, which C3 targets directly.

## Follow-ups

- An access-rules variant of the fixture: schools as groups, one membership per user, and
  membership changes during the sync.
- A Postgres baseline (nightly, `KORA_PG_TEST_URL`).
- Send the first delivery batch without the one-batch lookahead in `streamDelivery`. Today
  the first batch waits until a second one is cut.

## Open questions for Obed

1. **Partition fields.** Is it acceptable to require `scope: [...]` in the schema, or
   `deliveryPartitions` on the server, for provider-granted scopes to get the fast path? The
   alternative is learning fields from live session scopes, which is implicit and harder to
   make correct.
2. **The handshake pre-pass.** `collectVisibleNodeIds` exists for beta.12 clients and for
   `kora compact`'s peer entries. Can a protocol v2 client opt out of it (handshake flag)?
   That removes a log read from every handshake, not just a faster one.
3. **Fold-state disclosure (C1, and today's scope entries).** Do we accept that a late joiner
   receives removal markers, resolver logs and Yjs structure written before they joined? Or
   do we want a redaction design for both paths?
4. **The `retain` exit policy.** Should a snapshot device match `retain` semantics (it cannot:
   it never saw those records), or is "a new device holds its current scope" the documented
   behavior?
5. **Ops-per-record ratio.** Can we get it, and the scope size, from a real LMS deployment?
   It decides C1's value.
