---
"@korajs/core": minor
"@korajs/store": minor
"@korajs/devtools": minor
"korajs": minor
---

Instant updates (opt-in): `createApp({ store: { instantUpdates: true } })` shows this tab's own writes in its live queries (`useQuery`, `subscribe`) before their storage transaction commits, so a typed character or a toggled checkbox appears in the same frame instead of after the SQLite worker round trip. The write itself is unchanged (same operations, ids, order and storage; the promise resolves at the same point). The early view is a tab-local prediction that the database overwrites at commit and that disappears if the write fails. A row shown this way is not saved until the write's promise resolves. Off by default in `1.0.0-beta.15`; with it off nothing changes. The IndexedDB fallback store uses the same setting. See the "Instant updates" guide.

`insert`, `insertMany`, `update` and `delete` accept a last `{ durable: true }` argument that shows that one write only after it has committed (it adds no durability, only skips the prediction).

Failure handling: a write that fails inside its transaction is removed from the tab's queries and its promise rejects as before; a write whose COMMIT answer was lost is looked up by its content-addressed operation id (found: committed and published once; absent: rolled back; unreadable: stays shown until a later read decides). Every prediction is checked against the database: a difference emits `store:overlay-diverged` (field names only), three for one collection stop prediction for it for the session (`store:overlay-disabled`), and test builds (`NODE_ENV=test`) throw `OverlayDivergedError`. Pending writes are dropped on close, sign-out, user switch, `reloadFromDisk`, backup restore and a full resync.

New `KoraEvent` types (`@korajs/core`): `store:write-pending`, `store:write-settled`, `store:overlay-diverged`, `store:overlay-disabled`, `query:patched`; DevTools lists them. New exported types (`@korajs/store`): `InstantUpdatesOptions`, `WriteOptions`.

Fixes found on the way: a json or object value with a key named like an `Object.prototype` member (`toString`, `constructor`, `hasOwnProperty`, ...) made `insert` throw ("Cannot read properties of undefined"); the fold now treats every key as plain data.
