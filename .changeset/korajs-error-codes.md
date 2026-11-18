---
'@korajs/core': patch
'korajs': patch
---

Runtime errors from `korajs` now carry a `KoraError` code and a `fix` hint instead of being plain `Error`s:

- **`APP_NOT_READY` (`AppNotReadyError`):** `app.getStore()`, `app.blobs.store`, transactions, sequences, and backup and audit calls made before the store exists.
- **`APP_OPEN_FAILED` (new `AppOpenFailedError`):** a query or call that needs a store that didn't open.
- **`BLOB_SYNC_UNAVAILABLE` (new `BlobPullUnavailableError`):** `app.blobs.pull()` without a sync connection.

The two new classes are exported from `@korajs/core`, `@korajs/core/lite` and `korajs`, and the errors reference lists all three codes.
