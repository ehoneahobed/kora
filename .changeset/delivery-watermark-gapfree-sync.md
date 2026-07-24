---
"@korajs/server": minor
"@korajs/sync": minor
"@korajs/store": patch
"korajs": patch
---

Add a gap-free server-to-client delivery watermark, so no operation the server holds is
ever lost on its way to a client, even across drops, reconnects, restarts, and scoped
sync.

Previously the server drove server-to-client sync from the version vector. Under a lossy
transport this could strand an operation permanently: if a relayed operation was dropped
while a later operation from the same node was delivered, the client's version vector
advanced past the gap, and version-vector delta on the next connection never re-sent the
missing one. The paginated initial-sync resume cursor had the mirror problem: a retriable
apply failure let the cursor advance past the failed operation, skipping it on resume.

The server now assigns every stored operation a monotonic delivery sequence in commit
order and drives each client's stream from a durable, per-client delivery watermark. On
Postgres the sequence is assigned from a counter row locked inside the append
transaction, so delivery order equals visibility order and a `> watermark` scan can never
skip an operation that later becomes visible below the cursor, even across concurrent
server instances. Each server-to-client batch chains `base -> max` delivery sequences;
the client applies a batch only when its watermark equals the base and advances the
watermark only when every operation applied, so a dropped or failed batch stalls the
watermark and is recovered contiguously rather than skipped. The watermark advances live
during streaming and is persisted on the client, so a reconnect resends only what was
genuinely missed. Because a causal dependency is always committed (and thus sequenced)
before its dependent, delivery order respects causal order and needs no reordering.

The watermark also advances live during streaming (a client's watermark tracks the
server frontier while connected, so a reconnect resends only the true delta), a client's
own operations are not echoed back to it during streaming (they are still included in a
full resync so a client that lost its local store recovers its own history), and a client
whose persisted watermark is ahead of the server's frontier (the server restored an older
backup) resets to a full resync instead of stalling above a frontier that no longer
exists.

All wire fields are optional and additive: an old client omits its watermark and gets the
version-vector delta unchanged, and a new client against an old server keeps its version
vector, so both still converge. The version vector remains authoritative for the
client-to-server direction and for local deduplication. On Postgres the schema setup and
delivery-sequence backfill run under an advisory-locked transaction, so simultaneous
cold start of multiple server replicas against a fresh database is safe.

Correctness characteristics worth knowing when adopting:

- The delivery watermark is tracked per view (a stable signature of the active scope plus
  query subscriptions), so changing the scope or registering a new query subscription
  back-fills that view at most once and returning to a previously-synced view resumes from
  its own watermark instead of re-scanning it. A widened scope can expose operations below
  the current watermark, so the first visit to a view scans from zero; any back-fill is
  deduplicated, so operations already applied under another view are re-received but not
  re-applied.
- Per-view watermarks are retained under a bounded, least-recently-used cap (default and
  live views are never evicted), so a client that churns through many distinct views (for
  example a search that registers a fresh subscription per keystroke) cannot accumulate an
  unbounded number of persisted watermark rows. Eviction is a storage tradeoff only, never
  a correctness one: an evicted cold view simply back-fills from zero (deduplicated) the
  next time it is visited.
- An inbound operation that cannot be applied (for example a scope that includes a child
  record but excludes its parent) surfaces as a visible, recoverable sync stall rather
  than being silently skipped: the watermark holds and the operation is re-fetched until
  it applies. This upholds the no-silent-loss guarantee.
- A dropped or unacknowledged streaming batch is recovered by re-sending from the client's
  last acknowledged position, so recovery does not depend on a bounded retransmit buffer.
- Backup export preserves delivery (commit) order, so restoring a backup keeps causal
  order and a resumed client never receives a dependent before its dependency.
