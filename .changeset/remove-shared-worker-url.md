---
'korajs': minor
'@korajs/store': minor
---

Removed `store.sharedWorkerUrl` and the `SqliteWasmAdapter` option of the same name. Both have been ignored since beta.6, because SharedWorker-hosted SQLite cannot use OPFS and was never durable. Delete the option: TypeScript reports it, and JavaScript callers have it ignored.
