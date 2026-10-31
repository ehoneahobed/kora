---
"korajs": patch
---

`MergeAwareSyncStore.beginBulkReplication()` and the `sync.bulkReplication` option: a large first sync is applied into a scratch in-memory replica and merged into the database once (first-visit parity S3). Default on where the database can stage (a durable browser or native SQLite database); `sync: { bulkReplication: false }` applies the stream directly.
