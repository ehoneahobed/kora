# Design: durable, gap-free operation delivery

Code: `packages/server/src/store/*server-store.ts` (delivery sequence),
`packages/server/src/session/client-session.ts` (`sendDeliveryStream`, relays),
`packages/sync/src/engine/sync-engine.ts` (client watermark), and
`packages/sync/src/protocol/messages.ts` (wire fields). User-facing summary:
`docs/guide/sync-protocol.md`.

## Problem

Three sync failures turned out to be one: an operation could be skipped on a client while a
*position marker* advanced past it, so it was never recovered. The markers were the version
vector (max sequence per node) and the initial-sync resume cursor.

1. **Version-vector gap across reconnect.** Under a lossy transport, a relayed operation is
   dropped while a *later* operation from the same node is delivered. Applying the later one
   advances the client's vector to its sequence. On the next handshake the client reports that
   max, so a delta of `seq > reportedMax` never re-sends the dropped operation.
2. **Resume-cursor skip.** During paginated initial sync, an operation that fails to apply with
   a *retriable* error still lets the resume cursor advance past it (and later batches advance it
   further), so a resumed sync skips it.
3. **Cross-reconnect relay drop.** In-session relay retransmission recovers a dropped relay
   while the connection stays up, but a drop followed immediately by a reconnect loses the
   per-session pending set before the retransmit fires.

## Why the obvious fixes fail

- **A contiguous version-vector frontier** (report the highest gap-free sequence per node so
  gaps get re-requested) breaks scoped sync. A scoped client legitimately has per-node gaps,
  because it receives only operations for in-scope records. Its contiguous frontier per node is
  near 0, so it would re-request everything on every reconnect.
- **Freezing the resume cursor for one failed batch** does nothing, because the next successful
  batch advances it past the gap again.

Only the **server** knows each client's scope, so only the server can tell a drop-gap (must
recover) from a scope-gap (must not). The fix must be server-driven.

## How it works

The server assigns every stored operation a monotonic **delivery sequence**, separate from the
per-node `sequenceNumber` the version vector uses. Each client's server-to-client stream is the
server's operations filtered by that client's scope, in delivery-sequence order. The client
keeps a durable **delivery watermark**: the highest delivery sequence up to which it has applied
every in-scope operation with no gap. Because the stream is ordered and the watermark is
contiguous, a gap cannot form: a dropped or failed operation stops the watermark until it is
delivered and applied.

The version vector remains authoritative for the client-to-server direction (which of the
client's own operations the server still needs) and for local dedup.

### Delivery sequence

- Assigned **in commit order**. On Postgres it comes from a counter row locked inside the append
  transaction, so delivery order equals visibility order across concurrent server instances: a
  `> watermark` scan can never skip an operation that later becomes visible below the cursor. On
  the single-writer SQLite and memory stores it is an in-process counter.
- Commit order respects causal order (a dependency is committed, and so sequenced, before its
  dependent), so the delivery stream is causally ordered.
- Backup export is ordered by delivery sequence, so a restore reassigns sequences causally.

### Wire

- `HandshakeMessage.lastDeliverySequence`: the client's watermark for the current view (0 on
  first sync), plus the delivery anchor of the batch that set it.
- `OperationBatchMessage.baseDeliverySequence -> maxDeliverySequence`: batches chain. The base
  equals the previous batch's max, or the client's reported watermark for the first batch after
  a handshake. `deliveryAnchor` is the id of the newest operation in the server's log at or below
  `maxDeliverySequence`. The final page of an initial sync carries `isFinal`.
- `AcknowledgmentMessage.deliverySequence`: echoes the applied batch's max.

### Client rules

- Apply a batch only when it continues the chain (its base equals the watermark); advance to its
  max only when every operation in it is durably applied. A batch entirely at or below the
  watermark (a retransmit that crossed an acknowledgement) is re-acknowledged without being
  re-applied; one that straddles the watermark is applied whole, the part below being an
  idempotent no-op. A batch whose base is ahead of the watermark is not applied or acknowledged
  (`sync:delivery-gap`), so the server's retransmit or the next handshake redelivers the missing
  batch first.
- A delivery batch is applied in one storage transaction with its quarantine rows and its
  watermark advance (`SyncStore.applyDeliveryBatch` in `packages/sync/src/engine/sync-store.ts`). Anything that would leave it partly applied
  rolls it back and the batch is applied operation by operation instead, so the watermark still
  stops at the base. A device's large first sync of a view may be staged in a scratch replica
  (`sync.bulkReplication`); the live watermark is then written by the merge that makes the
  replica live, so a crash before it resumes from the live watermark.
- Any throw, retriable or terminal, stalls the watermark, and a failed batch is not acknowledged,
  so the server keeps re-sending it. An operation the device cannot apply yet (unknown
  collection, failed decrypt, far-future timestamp) goes to a durable quarantine and counts as
  handled; a possibly transient failure stalls delivery visibly (`sync:apply-blocked`). Nothing is
  silently dropped.

### Server rules

- At handshake, stream in-scope operations with delivery sequence above the reported watermark,
  paginated.
- During streaming, pushes resume from the client's last **acknowledged** delivery sequence, not
  the last sent, so a dropped or unapplied batch is re-included by the next push or the
  retransmit tick. Delivery batches are therefore not held in the bounded relay buffer, and
  recovery cannot be defeated by a buffer eviction.
- The watermark advances live during streaming, not only at handshake, so a reconnect resends
  only the true delta. A client's own operations are not echoed back during streaming but are
  included in a full resync.
- **Restores.** A client whose watermark is ahead of the server's frontier (the server was
  restored from a backup) is reset to a full resync. A client whose watermark is within the
  frontier but whose delivery anchor no longer matches the server's log was passed by writes
  made after a restore; it is resynced from 0 the same way. This needs no record of the restore,
  so database-level restores Kora never saw are covered too.
- On session teardown, unacknowledged relays move to a server-level buffer keyed by client node
  id (deduplicated, bounded, expiring) and are re-relayed, re-filtered by scope, when that node's
  next session reaches streaming. With the watermark this is a latency optimization, not the
  recovery mechanism.

### Views

The watermark is tracked per **view**: a deterministic signature over the active scope plus the
registered query subscriptions (`deliverySignature()`); the default view (no scope, no subsets)
is the empty signature and is stored under the bare `_kora_meta` key.

- Switching scope or subscriptions saves the outgoing view's watermark and restores the incoming
  one's (0 the first time), so each view back-fills at most once and returning to a synced view
  resumes instead of re-scanning.
- A widened, never-seen view scans from 0 because it can expose operations below the previous
  view's watermark; back-fill is deduplicated by content-addressed ids.
- View watermarks are kept under a least-recently-used cap (`MAX_DELIVERY_VIEW_WATERMARKS`, 64);
  the default and live views are never evicted, and eviction deletes the persisted row. Eviction
  is safe by construction: an evicted view back-fills from 0 when next visited.

## Guarantees

- No in-scope operation is skipped: the watermark never passes an operation the client has not
  applied or quarantined.
- No operation is applied twice: content-addressed ids deduplicate re-sends and back-fills.
- Scope gaps never trigger resends; delta sync stays proportional to what is new.
- Recovery depends only on the server's log and the client's persisted watermark, not on
  in-memory buffers on either side.

## Known limits

- A persistently unappliable operation that is not quarantinable stalls the view's delivery
  until the cause is fixed; this is deliberate (a visible stall over silent loss) but means one
  bad operation blocks later ones in that view.
- A never-seen or evicted view back-fills from 0; for large datasets this costs a full scan of
  the server's log for that scope (deduplicated on the client).
- The client-to-server direction still relies on the version vector plus server
  acknowledgements, not on a delivery watermark.

## Tests

- Server: `packages/server/src/store/delivery-sequence.test.ts`,
  `packages/server/src/session/delivery-stream.test.ts`,
  `packages/server/src/session/delivery-anchor.test.ts`.
- Client: `packages/sync/src/engine/delivery-watermark.test.ts`, `delivery-anchor.test.ts`,
  `delivery-position.test.ts`; wire: `packages/sync/src/protocol/delivery-fields-wire.test.ts`.
- End to end: `packages/test/tests/delivery-watermark-convergence.test.ts` and
  `delivery-log-rewind.test.ts`.
- Chaos (`ChaosTransport.dropPredicate` for deterministic faults): drop one streaming relay,
  deliver a later operation, reconnect, and the dropped one is recovered; a retriable apply
  failure mid-initial-sync is retried after resume, not skipped; for a scoped client a drop-gap is
  recovered while a scope-gap triggers no resend; N clients under drop, reorder and duplicate all
  converge with no lost operation.
