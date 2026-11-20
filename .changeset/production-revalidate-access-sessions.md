---
"@korajs/server": patch
---

The `createProductionServer` handle has `revalidateAccessSessions()`, as `KoraSyncServer` does: after restoring a backup with `store.importBackup(...)` in your own code, call it to end the sessions the restored membership index no longer grants (each reconnects and is re-scoped) at once instead of at the next delivery poll.
