---
'@korajs/sync': patch
---

A failed access narrowing no longer stalls sync silently. Before, when the store could not apply the server's narrowing for a collection, the engine swallowed the error: delivery stopped at that batch with no event, log or status. Now it reports the failure the way a blocked operation is reported. It emits `sync:apply-blocked` on the first failure and `sync:apply-retrying` when it repeats, sets `getStatus().blockedFailure`, logs the cause and updates device status. The code is `ACCESS_NARROWING_FAILED` when the store threw, or `ACCESS_NARROWING_UNSUPPORTED` when the store has no `applyCollectionNarrowing`. Once the narrowing applies, it emits `sync:apply-recovered`.
