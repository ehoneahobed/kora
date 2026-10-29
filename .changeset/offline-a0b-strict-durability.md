---
"@korajs/store": minor
"korajs": minor
---

Barrier snapshots on the IndexedDB fallback now open their IndexedDB transaction with `durability: 'strict'`, so a resolved write has reached disk (Chrome's default `relaxed` can fire `complete` earlier). Background snapshots stay relaxed; the scheduler tracks a separate strict generation, so a relaxed snapshot never satisfies a barrier and concurrent barriers still share one snapshot.

`app.storage.writes` (`status()` and `subscribe()`) and `store.getWriteDurability()` report whether resolved writes are durable: `failing` after a committed write could not be confirmed, `permanent` after a superseded snapshot (reload before making more changes). A latency gate measures awaited inserts at 1,000 and 10,000 records.
