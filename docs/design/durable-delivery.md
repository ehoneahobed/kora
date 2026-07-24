# Design: durable, gap-free operation delivery

Status: IMPLEMENTED (beta.5). Internal design doc (not published).

The design below shipped as the server-to-client delivery watermark. What landed matches
this design, with these concrete choices worth noting:

- The monotonic delivery sequence is assigned in commit order. On Postgres it comes from a
  counter row locked inside the append transaction, so delivery order equals visibility
  order even across concurrent server instances; a `> watermark` scan can never skip an
  operation that later becomes visible below the cursor. On the single-writer SQLite and
  memory stores it is an in-process counter.
- Each server-to-client batch chains `baseDeliverySequence -> maxDeliverySequence`. The
  client applies a batch only when its watermark equals the base, advances only on full
  apply, re-acknowledges a duplicate, and skips a gap. This is what makes both the
  version-vector gap and the resume-cursor skip unrecoverable-no-more.
- The watermark advances live during streaming (not only at handshake), so a reconnect
  resends only the true delta. A client's own operations are not echoed back during
  streaming but are included in a full resync for disaster recovery. A client whose
  watermark is ahead of the server frontier (backup restore) resets to a full resync.
- Streaming pushes resume from the client's last ACKNOWLEDGED delivery sequence, not the
  last sent, so a dropped or unapplied batch is re-included by the next push or the
  retransmit tick. Delivery batches are therefore not held in the bounded relay buffer;
  recovery cannot be defeated by a buffer eviction.
- The watermark advances only when every operation in a batch is durably applied. Any
  throw (retriable or terminal) stalls it; a failed delivery batch is not acknowledged,
  so the server keeps re-sending it. A persistently un-appliable inbound operation becomes
  a visible stall, never silent loss.
- The watermark is tracked per view (a stable signature of the active scope plus query
  subscriptions). Switching scope or query subscriptions saves the current view's
  watermark and restores the target view's (0 the first time it is seen), so each view is
  back-filled at most once and returning to a synced view resumes instead of re-scanning.
  A widened, never-seen view scans from 0 because it can expose operations below the prior
  view's watermark; any back-fill is deduplicated.
- Backup export is ordered by delivery sequence (commit order), which respects causal
  order, so a restore reassigns delivery sequences causally.

Code: `packages/server/src/store/*server-store.ts` (delivery sequence + backfill),
`packages/server/src/session/client-session.ts` (`sendDeliveryStream`), and
`packages/sync/src/engine/sync-engine.ts` (client watermark). Tests:
`delivery-sequence.test.ts`, `delivery-stream.test.ts`, `delivery-watermark.test.ts`,
`delivery-fields-wire.test.ts`, and `delivery-watermark-convergence.test.ts`.

## Problem

Three separately-reported sync issues are one underlying problem: an operation can
be skipped on a client while a *position marker* advances past it, so it is never
recovered. The markers are the version vector (max sequence per node) and the initial-
sync resume cursor.

Concrete facets:

1. **Version-vector gap across reconnect.** Under a lossy transport, a relayed op is
   dropped while a *later* op from the same node is delivered. `applyRemoteOperation`
   advances the client's vector to the later op's sequence. On the next handshake the
   client reports that max, so delta (`seq > reportedMax`) never re-sends the dropped
   op. Confirmed deterministically: applying seq 3 while seq 2 is missing sets the
   vector to 3.

2. **Resume-cursor skip.** During paginated initial sync, an op that fails to apply
   with a *retriable* error still lets the resume cursor advance past it (and later
   batches advance it further), so a resumed sync skips it.

3. **Cross-reconnect relay drop.** Reliable relay (implemented) retransmits unacked
   relay batches while the connection stays up, but a drop immediately followed by a
   reconnect loses the per-session pending set before the retransmit tick fires.

## Why the naive fixes fail

- **Contiguous version-vector frontier** (report the highest gap-free sequence per node
  so gaps get re-requested) **breaks scoped sync.** A scoped client legitimately has
  per-node gaps, because it only receives ops for in-scope records. Its contiguous
  frontier per node is ~0, so it would re-request everything on every reconnect — a
  full resync each time, defeating delta sync.
- **Freezing the resume cursor for one failed batch** does nothing, because the next
  successful batch advances it past the gap again.

The distinguishing fact: only the **server** knows each client's scope, so only the
server can tell a drop-gap (must recover) from a scope-gap (must not). The fix must be
server-driven.

## Design

Add a server-assigned, monotonic **delivery sequence** that is separate from the
per-node operation sequence used by the version vector. The server delivers each
client its scope-filtered operation stream in delivery-sequence order and tracks, per
client, a single **contiguous delivery watermark**: the highest delivery sequence the
client has acknowledged with no gap below it. Because delivery is a single ordered
stream and the watermark is contiguous, a gap cannot form — a dropped or failed op
simply stops the watermark from advancing until it is delivered and applied.

- **Server op ordering.** Every stored op already has `receivedAt`; add (or derive) a
  strictly-monotonic server delivery sequence. The per-client delivery stream is the
  server's ops filtered by that client's scope, ordered by delivery sequence.
- **Watermark.** Per client (keyed by client node id, durable across reconnects), the
  server records the highest contiguous delivery sequence the client has acked. On
  handshake the client reports its last contiguous delivery sequence; the server
  resends everything after it, in order. The version vector stays as-is for the
  client's local state and dedup; the watermark drives *recovery*.
- **Streaming.** Relay carries the delivery sequence. The client acks contiguously;
  the watermark advances only through the contiguous prefix. A dropped relay stalls the
  watermark, and the reconnect resend (from the watermark) recovers it — this subsumes
  the per-session reliable-relay retransmit already shipped and closes the cross-
  reconnect facet.
- **Resume cursor.** Replace the position-in-batch cursor with the delivery watermark:
  resume from the last contiguously-applied delivery sequence, so a retriable failure
  can never be skipped (later batches do not advance past it).

### Cheaper interim step (bounded, no protocol change) — IMPLEMENTED

The cross-reconnect relay facet is closed by a bounded increment on the existing ack
mechanism (shipped): on session teardown, the session's unacked relay *operations* are
moved into a server-level buffer keyed by client node id (deduped by op id, bounded by
count, expired by TTL); when a new session for that node id reaches streaming, they are
replayed through `relayOperations` (which re-filters by the new session's scope,
re-tracks, and re-sends). This reuses the reliable-relay path and adds no protocol
surface. Verified with a chaos test: a relay dropped just before a reconnect is
redelivered on reconnect, with recovery coming from the buffer (not the in-session
retransmit tick).

Still open with this interim step: the **initial-sync resume-cursor** facet and the
general **version-vector gap** for delta (not relay) still need the delivery-sequence
watermark below. The streaming cross-reconnect relay gap itself is now closed.

## Implementation steps

1. Server: assign a monotonic delivery sequence to ops; expose the per-client scope-
   filtered, delivery-ordered stream.
2. Protocol: add the delivery sequence to relay/delta batches and a
   `lastDeliverySequence` to the handshake.
3. Client: track the contiguous delivery watermark, report it on handshake, ack
   contiguously.
4. Server: persist the per-client watermark; on handshake resend from it in order.
5. Replace the resume cursor with the watermark.
6. Remove the per-session-only relay retransmit once the watermark subsumes it (or keep
   as a latency optimization).

## Concrete protocol design (server → client delivery watermark)

This is the wire-format and state design for the remaining facet, ready to implement.
It replaces the resume cursor and closes the delta version-vector gap for the
server → client direction. The version vector stays for the client → server direction
(the client's own ops) and for local dedup.

### Core idea

The server assigns every operation a monotonic **delivery sequence** (`deliverySeq`)
on ingest — a single server-global counter, independent of the per-node operation
`sequenceNumber`. The server → client stream for a given client is the server's ops
filtered by that client's scope, sent in `deliverySeq` order. The server tracks, per
client, a **delivery watermark**: the highest `deliverySeq` up to which the client has
contiguously acknowledged every in-scope op. Because the stream is ordered and the
watermark is contiguous, a dropped or unapplied op simply stops the watermark; on the
next handshake the server resends everything after it. Only the server evaluates scope,
so scope-gaps never trigger a resend and delta stays efficient.

### Wire-format changes (all additive / optional, so old peers interoperate)

`packages/sync/src/protocol/messages.ts`:

- `HandshakeMessage`: add `lastDeliverySequence?: number` — the client's persisted
  watermark (0 or omitted on first sync). Drives where the server resumes its stream.
- `OperationBatchMessage`: add `maxDeliverySequence?: number` — the highest
  `deliverySeq` among this batch's ops (they are sent in `deliverySeq` order).
- `AcknowledgmentMessage`: add `deliverySequence?: number` — the `maxDeliverySequence`
  of the batch being acked. (`lastSequenceNumber` stays for existing behavior.)
- `SerializedOperation`: no change required (deliverySeq travels on the batch, not per
  op), unless per-op resume granularity is wanted later.

Mirror these optional fields in the protobuf schema and both serializers
(`serializer.ts`, `dynamic-serializer.ts`). Optional fields keep old clients/servers
working: a client that omits `lastDeliverySequence` gets today's version-vector delta.

### Server state and store

- Store: add a `delivery_seq` column to the server operation table (SQLite, Postgres,
  memory), assigned from a monotonic server counter as each op is ingested
  (`applyRemoteOperation` / conditional apply / route apply). Backfill existing rows by
  `receivedAt` then `sequenceNumber` order on migration. Index it for range scans.
- `ServerStore`: add `getOperationsAfterDelivery(afterDeliverySeq, limit)` returning ops
  in `deliverySeq` order (the server applies the per-client scope filter as it streams,
  reusing `operationVisibleToClient`).
- `KoraSyncServer`: per client node id, an in-memory `deliveryWatermark` (authoritative
  source is the client's reported `lastDeliverySequence` at handshake; the server may
  also persist it for cross-restart resume, optional).

### Server algorithm

1. Handshake: read `lastDeliverySequence` (default 0). Stream in-scope ops with
   `deliverySeq > lastDeliverySequence` in `deliverySeq` order, paginated; each batch
   carries `maxDeliverySequence`. This replaces `sendDelta`'s version-vector scan for
   the server → client direction. (Keep the version-vector scan for client → server:
   which client ops the server still needs.)
2. Streaming: relay carries `maxDeliverySequence` too. (Relay reliability is already
   handled by the shipped ack + retransmit + cross-reconnect buffer; the watermark
   simply gives relay a durable resume point that subsumes that buffer over time.)
3. Ack: advance the per-client watermark to the acked batch's `deliverySequence`, but
   only contiguously (an ack for a later batch while an earlier one is unacked does not
   jump the watermark). Since batches are sent in order over an ordered transport, acks
   arrive in order; a dropped batch is simply never acked and the watermark stalls
   there.

### Client state and algorithm

- Persist `lastDeliverySequence` exactly like the existing delta cursor
  (`persistDeltaCursor` → `persistDeliveryWatermark`), advanced only when a batch is
  fully applied, and only contiguously (a batch whose ops did not all apply does not
  advance it). This is the fix for the resume-cursor skip: a retriable apply failure
  leaves the watermark below the failed op, so the next handshake re-fetches it.
- Report `lastDeliverySequence` in the handshake. Drop the `deltaCursor` field once the
  watermark subsumes it (or keep both during a transition release).
- The watermark is keyed by a **view signature**: a deterministic string over the active
  auth scope plus the set of registered query subscriptions (`deliverySignature()`), with
  the default (no scope, no subsets) view keyed by the empty string for backward
  compatibility. All view watermarks are preloaded on start; switching scope or
  subscriptions saves the outgoing view's watermark and restores the incoming view's (0 if
  unseen), so each view back-fills at most once and revisiting a view resumes it. Persist
  each view under a signature-suffixed `_kora_meta` key (`saveDeliveryWatermark(signature,
  watermark)`), the bare key remaining the default view so an upgrade keeps its position.
- View watermarks are retained under a least-recently-used cap
  (`MAX_DELIVERY_VIEW_WATERMARKS`); the default and live views are never evicted, and each
  eviction also deletes the persisted row (`deleteDeliveryWatermark(signature)`). This
  bounds storage for a client that churns through many transient views. Eviction is safe
  by construction: a dropped view back-fills from 0 (deduplicated) when next visited. A
  one-time trim on start also collapses a set persisted by an older, uncapped client.

### Backward compatibility and rollout

- All new fields optional. Old client + new server: no `lastDeliverySequence`, server
  uses today's version-vector delta (unchanged). New client + old server: server
  ignores `lastDeliverySequence`, client also keeps its version vector, so it still
  converges (just without the gap fix against that old server).
- Ship the `delivery_seq` column + backfill first (no behavior change), then the
  protocol fields, then flip the client to report/consume the watermark.

### File-by-file implementation checklist

1. `packages/sync/src/protocol/messages.ts`: add the three optional fields + guards.
2. `packages/sync/src/protocol/serializer.ts` + `dynamic-serializer.ts` + protobuf
   schema: encode/decode the new fields.
3. `packages/server/src/store/*server-store.ts` + `drizzle-*schema.ts` + `materialization`
   migration: `delivery_seq` column, monotonic assignment, backfill,
   `getOperationsAfterDelivery`.
4. `packages/server/src/session/client-session.ts`: stream by `deliverySeq` in
   `sendDelta`; stamp `maxDeliverySequence` on batches; advance per-client watermark on
   ack (contiguously).
5. `packages/sync/src/engine/sync-engine.ts`: track + persist `lastDeliverySequence`
   (contiguous), report it in handshake, replace resume-cursor use.
6. Remove the resume-cursor skip path once the watermark is authoritative.

## Test plan (chaos harness)

The `ChaosTransport.dropPredicate` hook (shipped) enables deterministic faults. Cover:

- Drop one streaming relay, deliver a later op (advance the vector), reconnect: the
  dropped op is recovered; all replicas converge.
- Retriable apply failure mid-initial-sync, disconnect, resume: the failed op is
  retried, not skipped.
- Scoped client: a drop-gap is recovered, but a scope-gap never triggers a resend
  (delta stays efficient — no full resync on reconnect).
- Property/chaos: N clients, drop + reorder + duplicate, all converge with no lost op.
