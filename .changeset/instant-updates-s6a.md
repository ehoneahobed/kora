---
"@korajs/core": minor
"@korajs/store": minor
"@korajs/devtools": patch
"korajs": minor
---

Instant updates for transactions: with `instantUpdates` on, `app.transaction` and `app.mutation` (and `store.transaction`) are shown before they commit, as one unit. Once the callback has returned, all of the transaction's writes appear together in the tab's live queries, and they commit or disappear together: a failed commit takes every write of the transaction back at once, along with any later write built on one of them. A transaction with a write that cannot be predicted (an atomic op, a cascading delete, a merge strategy) is not shown early at all, never partly; it appears at its commit as before. Reads inside the callback are unchanged (they see the transaction's own writes, never another write's prediction). The operations written are the same with the setting on or off. A transaction whose COMMIT answer was lost is looked up in the operation log by its first operation (found: committed and published once; absent: rolled back; unreadable: stays shown until a later read decides).

`KoraEvent` (`@korajs/core`): `store:write-pending` now has `kind: 'transaction'` for a transaction (a new member of the `kind` union; code that switches over `insert | update | delete` should handle it) and an optional `collections` (every collection the transaction touches) on `store:write-pending` and `store:write-settled`. A transaction emits one of each, not one per write. DevTools shows one row per transaction.
