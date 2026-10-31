---
"korajs": patch
---

`MergeAwareSyncStore.beginBulkReplication()` and the `sync.bulkReplication` option: a large first sync is applied into a scratch in-memory replica and merged into the database once (first-visit parity S3). Default on in the browser (SQLite WASM); native SQLite stages only when `bulkReplication` is set explicitly. `bulkReplication` also takes `{ minOperations, maxOperations, maxBytes }` (defaults 2000, 150000, 256 MiB); a larger scope or replica falls back to direct apply. `sync: { bulkReplication: false }` applies the stream directly.
