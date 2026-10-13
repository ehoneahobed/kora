---
"@korajs/server": patch
---

`kora.transaction(async (tx) => mutations | tx.reject(code, message))`: read, decide and write as one step. No other write (route, device upload or another transaction, on any instance sharing the database) commits between the reads and the commit, and the mutations commit all together or not at all, on the memory, SQLite and Postgres stores (`ServerStore.transact`). `tx.roleOf` and `server.access.roleOf` read a user's effective role in a group from the access index.

`applyConditional` now commits its whole set or nothing on every store (on SQLite and memory a failing `also` mutation used to leave earlier ones applied) and judges its mutations like any other write (schema, constraints, relations). Every `server.access` write runs as a transaction.
