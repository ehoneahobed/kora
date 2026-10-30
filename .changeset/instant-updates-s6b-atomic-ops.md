---
"@korajs/store": patch
"@korajs/core": patch
---

Instant updates (opt-in `instantUpdates`, still off by default) now show atomic operations at once: `op.increment`, `op.append`, `op.remove`, `op.max` and the other atomic operations, writes to `counter`, `max`, `min` and `append-only` fields, and writes to array fields appear in live queries before the commit, with the value the merge will produce (arrays as multisets, pending writes building on each other, inside `app.transaction` and `app.mutation` too). The prediction runs the same fold the commit runs (`predictLocalUpdate` in `@korajs/core`, internal), and the check at commit re-predicts from the base the commit actually read, so a concurrent remote change to the same field is not reported as a divergence. Writes keep their call order in the operation log whether or not instant updates are on. Writes to `server-authoritative` fields, richtext, resolvers and cascading deletes still appear at commit.
