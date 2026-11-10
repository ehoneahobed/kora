---
'@korajs/server': patch
---

`SqliteServerStore.close()` now closes the database connection that `createSqliteServerStore`
opened (checkpointing the WAL and releasing the file). A store constructed on a caller's own
Drizzle connection still leaves that connection to the caller. `close()` first waits for every
call already running (reads, writes, backup export and import); calls made after it began fail
with `SqliteServerStore is closed`.
