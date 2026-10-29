---
"@korajs/core": minor
"@korajs/store": minor
"@korajs/devtools": patch
"korajs": minor
---

A database that existed on a device and vanished is reported, not mistaken for a fresh device. The storage manifest now records each database's `epoch` and its last known unsynced-write count (`unsynced`, `unsyncedAt`), and a `localStorage['kora:db:<name>']` marker carries the epoch and the backend. When a database is created empty while either record names it for the same backend, Kora emits `store:storage-evicted` and keeps the loss in `app.storage.evicted` (`{ dbName, detectedAt, lastOpenedAt, evidence, lostWrites: { count, certain } }`) until `app.offline.acknowledgeEviction()`; the report survives a reload. It is never reported after `app.storage.deleteDatabase()`, a move between IndexedDB and OPFS, a first open, a changed `store.name` or when the user clears all site data (nothing remains to compare with). A database with lost writes is still opened and re-syncs.

Also adds the `store:storage-evicted` and `offline:meta-changed` events, and teaches DevTools the `store:write-durability` event.
