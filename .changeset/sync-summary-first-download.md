---
'@korajs/sync': patch
---

`summarizeSyncStatus()` / `useSyncSummary()` report `downloading` only for a device's first download. The engine resets its catch-up counters every session, so the catch-up after a reconnect or restart also read as "Downloading", and an app that held its first-run screens on it blocked a till with its data already present. `SyncStatusInfo.initialSync.first` (new) says whether this session's catch-up started with nothing from the server.
