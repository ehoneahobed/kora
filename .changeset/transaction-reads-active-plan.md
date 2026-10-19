---
"@korajs/server": patch
---

Server transactions decide on the record the active fold plan defines. During a rolling deploy that changes operation transforms or merge rules, a record an instance still on the previous plan materialized was read as stored by `server.kora.transaction` and `applyConditional` until the delivery poll re-folded it, so an `if` predicate, an atomic op (`op.increment`) or route logic could decide on the previous plan's values. Every read inside a transaction (`tx.findById`, `tx.query`, the conditional set's target and predicate, the current value atomic ops resolve against, and the constraint and relation checks of its writes) now sees such a record folded with the deciding instance's plan, on SQLite and Postgres, without writing anything. Records already on the current plan are read as before.
