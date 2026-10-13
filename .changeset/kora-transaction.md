---
"@korajs/server": patch
---

`kora.transaction(async (tx) => mutations | tx.reject(code, message))`: read, decide and write as one step. No other write (route, device upload or another transaction, on any instance sharing the database) commits between the reads and the commit, and the mutations commit all together or not at all, on the memory, SQLite and Postgres stores (`ServerStore.transact`; a custom store without it runs the decision and the writes one after the other, as before). `tx.roleOf` and `server.access.roleOf` read a user's effective role in a group from the access index; `server.access.prepareGrant(tx, ...)` and `prepareRevoke(tx, ...)` build membership changes inside a transaction. Starting a write inside a decision throws `RouteTransactionReentryError` instead of waiting for ever.

`applyConditional` now runs as a transaction on every built-in store: it commits its whole set or nothing (on SQLite and memory a failing `also` mutation used to leave earlier ones applied), and its mutations are judged like any other write. On Postgres this adds the schema, constraint and relation checks the set used to skip, so a set that wrote invalid values is now refused. Constraints between mutations of one set are corrected by the server after the commit, as for concurrent writes. Every `server.access` write runs as a transaction.

On SQLite, a transaction is decided again when another connection to the same database file commits during the decision (up to five times, then `TransactionConflictError`); relations of a delete are judged on the state the whole batch leaves, so a transaction may remove every child and then their parent under `restrict`.
