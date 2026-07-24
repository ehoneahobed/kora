---
"@korajs/server": patch
"@korajs/sync": patch
"korajs": patch
---

Fix multi-tenant scoped sync dropping any update that does not restate the scope
field, which silently diverged tenants across devices.

Scope visibility was judged from an operation's own `data`/`previousData` only. A
partial update that changed a non-scope field (toggling `completed`, an atomic
increment, a cascade side-effect) or a delete carried no scope field, so it was
treated as out of scope and never relayed, delta-synced, or (when the client
configured a scope) pushed. Two devices of the same tenant would then disagree.

Visibility now backfills the scope (and query-subset) fields from the record's
materialized state when the operation itself does not carry them, on both the server
relay/delta path and the client push path. The record read includes soft-deleted
rows so a relayed delete is judged against the record's actual scope, and an
operation that reassigns the scope field is judged by its new value (the record
leaving one tenant and entering another). Genuinely out-of-scope operations are still
hidden, preserving tenant isolation.
