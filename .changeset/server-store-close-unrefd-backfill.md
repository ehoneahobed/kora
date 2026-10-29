---
"@korajs/server": patch
---

`SqliteServerStore.close()` and `PostgresServerStore.close()` no longer hang in a process with nothing else alive. The live-view backfill starts behind an unref'd timer, and `close()` waited for it, so a script or test that opened a store, set a schema and closed it ended with an unsettled await (Node's test runner reported the test as cancelled). `close()` now ends the wait itself, and a closed store starts no backfill pass. Regression in canaries since 20261024185231.
