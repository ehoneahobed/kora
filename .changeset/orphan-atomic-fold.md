---
"@korajs/store": patch
---

Fix atomic operations that arrive before their insert (reordered delivery) being
folded by last-write-wins, which dropped concurrent deltas.

When an update lands before the record's insert, it is logged but not materialized;
the insert later folds those orphaned operations into the row. That fold used plain
per-field last-write-wins, so two concurrent `op.increment`s that both arrived before
the insert would keep only one writer's resolved value instead of composing (for
example settling at 3 or 5 instead of 8).

The fold now re-materializes atomic-op fields by replaying `[insert, ...orphans]` in
HLC order through the shared atomic-aware replay (the same fold the server and the
live apply path use), so reordered atomic deltas compose correctly. Non-atomic fields
keep their last-write-wins result, and per-field versions are unchanged, so future
merges stay correct.
