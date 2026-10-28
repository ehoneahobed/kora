---
"@korajs/core": minor
"@korajs/store": minor
"@korajs/tauri": minor
---

A local write now resolves only after it is durable. On the IndexedDB fallback (SQLite in memory plus a snapshot) the write path waits for the durability barrier after the transaction commits; concurrent writes share one snapshot and the barrier skips the 500 ms debounce. Barrier snapshots open their IndexedDB transaction with `durability: 'strict'`. OPFS and native writes are durable on commit and pay nothing.

If the snapshot cannot be saved, the write stays committed and visible and the promise rejects with `WriteNotDurableError` (`WRITE_NOT_DURABLE`, with `operationId` and `reason: 'save-failed' | 'snapshot-superseded'`). Do not retry such a write: it exists. `store:write-durability` reports the change and `store.getWriteDurability()` returns the current state. Use `insertMany` or one `app.transaction` for bulk imports on the fallback: each awaited write pays one snapshot.

`better-sqlite3` and the Tauri plugin now set `synchronous = FULL` explicitly, so a resolved write survives power loss in WAL mode.
