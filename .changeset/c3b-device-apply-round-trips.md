---
"@korajs/store": patch
"@korajs/sync": patch
"korajs": patch
---

Applying a delivery batch on the device costs about 1 storage round trip per operation instead of about 18 (13 reads, 5 writes). The sync engine announces the chunk's operations (`SyncStoreBatch.prefetch`, optional) and the store reads what they need once, in a few queries: which are already logged or compacted, who holds their sequence numbers, each record's fold state, base, snapshot, provisional effects, retraction marker and row. Each operation then folds from what the batch knows, which its own earlier writes keep current, so operations of one batch that touch the same record see each other. The prior operations of merge traces are read together before the commit, and a step's `SAVEPOINT`, statements and `RELEASE` travel in one request. Records the cache cannot answer for (a retraction marker, a base or snapshot, a shared node id, a taken sequence number, a record the batch changed by another route) take the per-operation path exactly as before. The batch is still one storage transaction with its quarantine rows and watermark, one savepoint per operation, and the same fold results and events after the commit. In Chromium on OPFS, first sync of a 20,000-operation school went from about 7 to 9 minutes to the time recorded in `docs/design/fast-first-sync.md`.
