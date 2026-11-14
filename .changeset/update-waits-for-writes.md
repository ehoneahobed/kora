---
'korajs': minor
'@korajs/store': minor
'@korajs/sync': minor
'@korajs/react': minor
'@korajs/cli': patch
---

Accepting a new version never loses a write on screen, and apps share one honest sync summary. Found redesigning KoraPOS.

- The offline shell's update (`koraServiceWorker()`) waits until no write is still committing before the new version takes over and the page reloads. It dispatches `kora:update-waiting` meanwhile. Before, tapping "Reload" during a sale's commit could lose the sale. The store exposes the count it waits on: `store.pendingWriteCount()` and `store.whenWritesSettled()`, published to the page as `__KORA_WRITES__`.
- `summarizeSyncStatus()` (`@korajs/sync`, `korajs`) and `useSyncSummary()` (`@korajs/react`) summarize a sync status for an indicator: tone, title, one honest line of detail, pending writes, and `downloading` while the first download runs. Four Kora apps had each written their own version.
