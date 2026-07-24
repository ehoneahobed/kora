---
"@korajs/server": minor
---

Make conditional route apply (`request.kora.applyConditional`) race-free across
server instances backed by the same Postgres database.

Previously the admission gate (read the target, check the predicate, apply the
update plus its `also` set) was atomic only within a single server instance. Two
instances admitting to the same capped record concurrently could both pass a
`responseCount < max` check and over-admit. The Postgres store now implements a
store-level conditional transaction: a transaction-scoped advisory lock keyed on
the target record serializes the read-decide-write cycle across every instance
sharing the database, the idempotency key is checked under that same lock (so a
retry is at-most-once even across instances), and the whole set commits or rolls
back together.

Two correctness details this depends on:

- The increment op is re-resolved against the value read under the lock, and its
  HLC is advanced past the target record's latest committed operation, so
  last-write-wins materialization reflects the serialized commit order even when
  two instances commit in the same millisecond. Without the advance, a
  same-millisecond tie could let materialization pick an earlier resolved value
  and undercount the counter, admitting past the cap.
- Server-originated sequence numbers are now reserved atomically on the Postgres
  store (`reserveSequenceNumber`), so two concurrent server operations can never be
  handed the same number (which would let one shadow the other during
  version-vector delta sync).

Stores that serve writes on a single process (in-memory, SQLite) are unchanged:
they keep the per-instance serialized path, which is correct because only one
server operation is ever in flight.
