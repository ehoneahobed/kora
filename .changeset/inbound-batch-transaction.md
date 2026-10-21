---
"@korajs/store": minor
"@korajs/sync": minor
"korajs": minor
---

A delivery batch is applied on the device in one storage transaction (beta.15 workstream C3).

The operations of a server delivery batch, the quarantine rows of the ones the device cannot apply, and the delivery watermark advance now commit together, instead of one transaction per operation followed by a separate watermark write. A crash leaves either the whole batch with its watermark or none of it, and the server re-sends it. Each operation and retraction runs in its own savepoint, so one that fails is undone alone and quarantined exactly as before; retractions keep their stream position (#54). Live queries, `operation:applied`, merge traces and `sync:*` apply events are published only after the commit, coalesced, and never for a rolled-back attempt. Each step's write statements go to the SQLite worker in `batch` requests.

Nothing about what is applied changes. A batch that cannot be fully applied (a retriable failure, a failed retraction) is rolled back as a whole and applied operation by operation, which stops the watermark at the batch's base as before. Batches that carry an access narrowing, or retract a record with unsent local writes, also keep the per-operation path (their bookkeeping is written outside the store's transaction), as does the legacy materialization (`experimental.legacyMerge`).

First sync of 20,000 operations on native SQLite (the `bench:first-sync` fixture): see `docs/benchmarks/baseline.md`. In the browser the gain is larger: one OPFS commit per batch of 100 instead of 100.

New APIs, all optional for custom implementations: `Store.applyRemoteBatch(fn)` (`RemoteApplyBatch`, `ProvisionalSideEffect` types), `SyncStore.applyDeliveryBatch` and `storageIdentity`, `SyncStatePersistence.storageIdentity`, and the `SyncStoreBatch` type. A sync store and sync-state persistence written for earlier releases keep the per-operation path.
