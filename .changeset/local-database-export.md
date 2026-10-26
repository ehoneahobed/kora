---
"@korajs/store": minor
---

Add `exportLocalDatabase()` to the SQLite WASM entry point. It exports a closed local database from its authoritative OPFS or IndexedDB backend as a standard SQLite file while holding the database's exclusive lock. The operation never migrates or deletes the source and reports stable `STORAGE_IN_USE` and `LOCAL_DATABASE_NOT_FOUND` errors.

The browser worker now supports binary export for both OPFS-backed and in-memory databases.
