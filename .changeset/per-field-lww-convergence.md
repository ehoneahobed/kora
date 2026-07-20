---
"@korajs/core": patch
"@korajs/store": patch
"@korajs/merge": patch
"korajs": patch
---

Fix silent data loss and divergence on concurrent cross-device edits.

Two connected devices editing the same record while briefly offline could
permanently drop one edit and diverge, violating the "no operation is ever
lost" guarantee. This release closes that bug and every adjacent defect found
while auditing the apply path:

- **Per-field LWW register.** Materialized rows now carry `_field_versions`
  (field → last-writer HLC). Remote updates resolve field-by-field, atomically,
  inside the write transaction: deterministic, order-independent, commutative,
  and idempotent. Concurrent edits to different fields both survive; same-field
  conflicts converge to one agreed winner on every node.
- **Optimistic-concurrency guard for merge results.** Richtext, add-wins-set,
  constraint, and custom-resolver merges are computed from a version snapshot
  and applied only if the row is unchanged; otherwise the merge recomputes from
  fresh state (bounded retries). A local edit can no longer slip between a
  merge's read and its write.
- **Operation-log integrity.** Merge results are no longer persisted under the
  original operation's content-addressed id. The log always stores the
  canonical operation; only the materialized row reflects merged values.
- **Insert collisions.** A remote insert targeting an existing record id no
  longer crashes with a primary-key violation (or silently drops the merged
  result on a timestamp tie) — it resolves per-field like an update, with
  `createdAt` converging to the max insert wall time.
- **Deterministic add-wins ordering.** Concurrent array edits previously
  converged on membership but diverged on element ORDER across devices
  (local-before-remote ordering flips per device). Additions now order
  deterministically, so merged arrays are byte-identical everywhere.
- **Transaction serialization.** The better-sqlite3 adapter serializes async
  transactions through a mutex, eliminating nested-BEGIN collisions that could
  silently drop a relayed operation applied during a local write.
- **Atomic increment composition.** Concurrent `op.increment` updates now
  compose to the sum of both deltas through the real sync path (previously one
  side's delta could be lost to last-write-wins, and the merge engine's
  synthetic local operation carried the REMOTE op's intent metadata, doubling
  the remote delta whenever atomic composition ran).
- **Out-of-order delivery.** An update or delete delivered before its insert
  (reordering transports) no longer vanishes from the materialized row: when
  the insert lands, already-logged operations for that record are folded in
  timestamp order inside the same transaction, matching in-order devices
  exactly. Ops tables gained a `record_id` index to keep record-scoped
  lookups fast.

Clock rebases re-stamp per-field versions, and backups round-trip them, so
field-level LWW stays correct across clock corrections and restores.
