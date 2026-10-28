---
"korajs": patch
"@korajs/core": patch
"@korajs/store": patch
"@korajs/devtools": patch
"@korajs/tauri": patch
---

Make a resolved local write a durability guarantee on every storage backend. Local CRUD, `insertMany`, mutations, and outer transactions now wait for the IndexedDB fallback's strict group-commit barrier before resolving; OPFS and native adapters pay no extra barrier. A barrier failure rejects with `WriteNotDurableError` (`WRITE_NOT_DURABLE`) after the committed operation is published, so applications can surface the problem without blindly repeating an action that already exists locally. `store:write-durability` reports failure and later recovery with the affected operation ids.

Native SQLite now explicitly uses `synchronous = FULL` in both the better-sqlite3 adapter and Tauri plugin so a resolved write survives an operating-system crash or power loss.
