---
"@korajs/server": minor
"@korajs/core": minor
---

Compose atomic operations in the server's materialized view so it matches what
clients converge to.

Previously the server materialized records by last-write-wins over each operation's
resolved `data`, and did not persist the atomic-op intent (`op.increment`,
`op.max`, `op.min`, `op.append`, `op.remove`). Concurrent, independent atomic writes
to the same field — two offline clients each incrementing a shared counter, then
syncing — collapsed to a single winner in the server's view (materialized reads and
initial-sync hydration), even though clients converge to the composed result.

The server now persists atomic-op intent alongside each operation and composes it
during materialization. Per field, an atomic op composes onto the running value when
the previous writer on that field was an atomic op of the same type (a same-type
chain: increments sum, maxes take the max, appends accumulate); any other write,
including the first atomic write after a plain set, resolves by last-write-wins. This
mirrors the client merge engine, so the server's materialized value equals the
clients' converged value. Verified end to end against real client devices syncing
through the server (`@korajs/test`), plus SQLite and Postgres persistence.

Details:

- `@korajs/core` exports `applyAtomicOp(currentValue, atomicOp)`, the single source
  of truth for atomic-op semantics that both the client write path (`resolveAtomicOp`)
  and the server materialization use.
- The SQLite and Postgres operation logs gain a nullable `atomic_ops` column, added
  by a backward-compatible migration. Existing rows read as "no atomic ops" and keep
  materializing by last-write-wins exactly as before, so no data migration is required.
- Materialization now orders operations by full HLC total order (wallTime, logical,
  nodeId), matching `HybridLogicalClock.compare`, so composition and last-write-wins
  see operations in the order the merge engine converges them.

Operations that carry no atomic-op intent (the common case) materialize exactly as
before.
