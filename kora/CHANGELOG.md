# kora

## 1.0.0-beta.15

### Minor Changes

- 6c72c04: Schemas can declare access rules. A schema-level `access` block names the memberships collection, the ordered roles and the group collections whose creator becomes a member; each collection declares `read`, `create`, `update`, `delete` (or `write`) and per-field `fields` rules built from `owner()`, `member()`, `memberOfKey()`, `where()`, `anyone()`, `serverOnly()`, `or()`, `and()` and `custom()`. `t.string().stamp('userId')` marks a field the server sets to the writing user. `defineSchema` validates every rule against the schema with an actionable message (unknown fields, roles, ambiguous groups, `anyone()` writes without `{ writes: true }`, `custom()` in read rules, read rules that expand past 8 alternatives). Read rules compile per user into the scope predicate the sync stream uses, and writes are decided by one evaluator (field rules, immutable access fields, stamps, server-owned memberships). The sync server enforces them (see the access-rules entries of this release).

  `where()` values must fit their field (type and enum domain). A group collection's owner field must be stamped (`t.string().stamp('userId')`).

- 8667762: Access rules on the device. An insert fills fields declared `t.string().stamp('userId')` with the signed-in user (the app knows it through `authClient` or a `principal`), so apps no longer pass `ownerId` themselves; naming another user, or inserting before the app knows who is signed in without passing the field, throws `StampedFieldError` (`STAMP_MISMATCH`, `STAMP_USER_UNKNOWN`). A group created offline, with content in it, syncs without ever leaving the device. A scope retraction of an access-collection record that has unsent writes is deferred, durably, until those writes are acknowledged or refused, so offline work is judged by the server instead of quarantined; the record is hidden then and `sync:scope-retracted` is emitted.
- 714ebd2: Blob pulls no longer hang on a lost message. A blob chunk request was sent only while the sync engine was `streaming`, so a pull started while the initial sync was still arriving (when its rows are already visible) was silently dropped; it then waited 30 s and failed with a plain `Error`, and neither a lost answer nor a reconnect led to a retry.

  - Blob chunk messages go out as soon as the handshake is accepted (`syncing` or `streaming`); servers since 1.0.0-beta.13 already accept them then. `BlobChunkChannel.send` returns whether the message was sent, and `onReady(handler)` runs after each accepted handshake.
  - `createRemoteChunkProvider` re-sends an unanswered request under the same request id after 5 s, then a wait doubling to 30 s (20% jitter), re-sends every pending request when the connection is ready again, and fails only after 2 minutes without any answer (`deadlineMs`; `timeoutMs` is a deprecated alias). Failures reject with `BlobTransferError` (a `KoraError`: `BLOB_CHUNK_TIMEOUT`, `BLOB_CHUNK_UNAVAILABLE`, `BLOB_CHUNK_CANCELLED`, with `hash`, `attempts` (requests actually sent: tries made offline are not counted), `lastReason`); `receiveBlob` and `fetchBlobManifest` report a chunk nobody holds as `BLOB_CHUNK_UNAVAILABLE`. The provider takes an injectable `clock` and `random`, and `close()` cancels pending requests and clears their timers (called on `app.close()`).
  - New events `blob:request-retried`, `blob:request-failed` and `blob:handler-error`, recorded by DevTools. A blob channel handler that throws no longer stops the other handlers (or the message from reaching the chunk provider); its error is emitted as `blob:handler-error`, or logged when the engine has no emitter.
  - The sync server's blob relay always answers a connected requester: "not held" once every peer it asked said not held or left, and when a request expires (counted from its first arrival, so client re-sends do not extend it, on a timer rather than when the next request arrives); `throttled` (with `retryAfterMs`) over the per-session pending cap, when bytes are ready but the session may not receive them, and for a request id pending for another session. Counters are kept per answer kind (`BlobChunkRelay.getStats()`: each delivered answer once under its kind, a request whose requester left once under `requesterGone`), and the pending-cap and duplicate-id cases are logged.

  No wire or protocol change: every answer is a `blob-chunk-response` of a shape servers already send (`throttled` since 1.0.0-beta.13, whose clients retry on it). An older client against a new server gets an answer instead of silence (a beta.12 client reads `throttled` as "not held", as it already does for the request budget); a new client against an older server recovers through its retries.

- 4237195: Faster local writes in the browser, and `collection.insertMany(rows)`.

  - **Batched worker messages.** Inside a write's transaction the store now buffers its write statements and sends them to the SQLite worker in batches (a new `batch` worker request, run with cached prepared statements), instead of one message per statement. Reads inside the write first send what is buffered, and everything is sent before the commit, so a write that resolved is committed exactly as before and a failing statement still rolls the whole write back. Inserting 10,000 records in one transaction on OPFS went from about 6.2 s to 1.8 s in Chromium. A worker from an older build (another tab still on the previous deploy as storage leader) is sent statements one by one, as before.
  - **16 KiB pages for new OPFS databases** (SQLite's default is 4 KiB): the commit of a large write is about 40% cheaper, a one-row commit costs the same. Existing databases keep their page size.
  - **`app.<collection>.insertMany(rows)`** (also on `store.collection(name)` and `useCollection`): inserts many records of one collection in one transaction, all or none. Every row is validated before anything is written; each record is still its own insert operation (input order, consecutive sequence numbers, one shared `transactionId`), and live queries update once after the commit. 10,000 records take about 1.7 s on OPFS. Inside `app.transaction`, `tx.<collection>.insertMany(rows)` adds the rows to that transaction.
  - `Transaction` gains an optional `executeBatch(statements)`; `LocalMutationHandler` an optional `insertMany`. Custom adapters and handlers need no change. `LocalMutationHandler.beforeLocalDelete` still gets a transaction whose `await tx.execute(...)` means the statement ran (it is not buffered).

  Awaited single `insert` calls are unchanged: each is still its own durable transaction (about 34 ms each on OPFS in that benchmark, almost all of it SQLite and OPFS commit time). Use `insertMany` or `app.transaction` for bulk writes.

- 6470e48: A delivery batch is applied on the device in one storage transaction (beta.15 workstream C3).

  The operations of a server delivery batch, the quarantine rows of the ones the device cannot apply, and the delivery watermark advance now commit together, instead of one transaction per operation followed by a separate watermark write. A crash leaves either the whole batch with its watermark or none of it, and the server re-sends it. Each operation and retraction runs in its own savepoint, so one that fails is undone alone and quarantined exactly as before; retractions keep their stream position (#54). Live queries, `operation:applied`, merge traces and `sync:*` apply events are published only after the commit, coalesced, and never for a rolled-back attempt. Each step's write statements go to the SQLite worker in `batch` requests.

  A batch of more than 500 operations (the server's default is 100) is applied in chunks of at most 500, one transaction each, so no transaction holds the database for long (live queries, local writes and other tabs wait behind it). Only the last chunk advances the watermark; a crash between chunks leaves the earlier chunks applied under the old watermark, and the re-sent batch finds them as duplicates (the per-operation path's guarantee).

  Nothing about what is applied changes. A batch that cannot be fully applied (a retriable failure, a failed retraction) is rolled back as a whole and applied operation by operation, which stops the watermark at the batch's base as before. Batches that carry an access narrowing, or retract a record with unsent local writes, also keep the per-operation path (their bookkeeping is written outside the store's transaction), as does the legacy materialization (`experimental.legacyMerge`). A batch re-sent after it fell back, or that holds the operation blocking the stream, goes straight to the per-operation path instead of trying the transaction again.

  The optimistic check of cross-record constraints (unique, capacity, referential) after a remote operation runs right after that operation, inside the batch's transaction (it sees the batch's writes so far), so each `constraint:violated` report describes the operation it names, exactly as when operations are applied one by one; the reports are emitted after the commit. A failing check stalls the operation, as before.

  First sync of 20,000 operations on native SQLite (the `bench:first-sync` fixture): see `docs/benchmarks/baseline.md`. In the browser the gain is larger: one OPFS commit per batch of 100 instead of 100.

  New APIs, all optional for custom implementations: `Store.applyRemoteBatch(fn)` (`RemoteApplyBatch`, `ProvisionalSideEffect` types), `SyncStore.applyDeliveryBatch` and `storageIdentity`, `SyncStatePersistence.storageIdentity`, and the `SyncStoreBatch` type. A sync store and sync-state persistence written for earlier releases keep the per-operation path.

- 9afd6a0: Instant updates (opt-in): `createApp({ store: { instantUpdates: true } })` shows this tab's own writes in its live queries (`useQuery`, `subscribe`) before their storage transaction commits, so a typed character or a toggled checkbox appears in the same frame instead of after the SQLite worker round trip. The write itself is unchanged (same operations, ids, order and storage; the promise resolves at the same point). The early view is a tab-local prediction that the database overwrites at commit and that disappears if the write fails. A row shown this way is not saved until the write's promise resolves. Off by default in `1.0.0-beta.15`; with it off nothing changes. The IndexedDB fallback store uses the same setting. See the "Instant updates" guide.

  `insert`, `insertMany`, `update` and `delete` accept a last `{ durable: true }` argument that shows that one write only after it has committed (it adds no durability, only skips the prediction).

  Failure handling: a write that fails inside its transaction is removed from the tab's queries and its promise rejects as before; a write whose COMMIT answer was lost is looked up by its content-addressed operation id (found: committed and published once; absent: rolled back; unreadable: stays shown until a later read decides). Every prediction is checked against the database: a difference emits `store:overlay-diverged` (field names only), three for one collection stop prediction for it for the session (`store:overlay-disabled`), and test builds (`NODE_ENV=test`) throw `OverlayDivergedError`. Pending writes are dropped on close, sign-out, user switch, `reloadFromDisk`, backup restore and a full resync.

  New `KoraEvent` types (`@korajs/core`): `store:write-pending`, `store:write-settled`, `store:overlay-diverged`, `store:overlay-disabled`, `query:patched`; DevTools lists them. New exported types (`@korajs/store`): `InstantUpdatesOptions`, `WriteOptions`.

  Fixes found on the way: a json or object value with a key named like an `Object.prototype` member (`toString`, `constructor`, `hasOwnProperty`, ...) made `insert` throw ("Cannot read properties of undefined"); the fold now treats every key as plain data.

- d45441e: Instant updates for transactions: with `instantUpdates` on, `app.transaction` and `app.mutation` (and `store.transaction`) are shown before they commit, as one unit. Once the callback has returned, all of the transaction's writes appear together in the tab's live queries, and they commit or disappear together: a failed commit takes every write of the transaction back at once, along with any later write built on one of them. A transaction with a write that cannot be predicted (an atomic op, a cascading delete, a merge strategy) is not shown early at all, never partly; it appears at its commit as before. Reads inside the callback are unchanged (they see the transaction's own writes, never another write's prediction). The operations written are the same with the setting on or off. A transaction whose COMMIT answer was lost is looked up in the operation log by its first operation (found: committed and published once; absent: rolled back; unreadable: stays shown until a later read decides).

  `KoraEvent` (`@korajs/core`): `store:write-pending` now has `kind: 'transaction'` for a transaction (a new member of the `kind` union; code that switches over `insert | update | delete` should handle it) and an optional `collections` (every collection the transaction touches) on `store:write-pending` and `store:write-settled`. A transaction emits one of each, not one per write. DevTools shows one row per transaction.

- 95f5a26: `useMutation` reports writes the sync server refuses. In React, Vue and Svelte, `useMutation(fn, { onRejected })` and a `rejected` state (`{ code, message, collection, recordId, operationId, operationIds, reverted, args }`) tell the component that made a write when the server permanently refuses it, even hours later after an offline period, so an app can show "this change was undone, and why" without listening to sync events. One `mutate()` call is one write: every operation it committed, including a delete's cascades and a whole `app.transaction()`; it is reported once. `reverted` is false only for the refusals the device keeps locally (`OUT_OF_UPLINK_SCOPE`, `NODE_ID_MISMATCH`, `SEQUENCE_CONFLICT`). Retriable rejections are not reported. A hook reports nothing after it unmounts, and tracks at most 500 unsynced writes; the app-level `sync:operation-rejected` event and `app.sync.getRejectedOperations()` still report every refusal. Tracking needs `<KoraProvider app={app}>`. Svelte's mutation also gains `subscribeRejected(fn)`.

  Two new sync events support it: `sync:operations-acknowledged` (`operationIds` the server stored) and `sync:operations-rewritten` (`reason`, `idMapping`: unsent operations re-authored under new ids by a clock rebase, a node-id rotation or a sequence renumbering).

- 92f08d3: Barrier snapshots on the IndexedDB fallback now open their IndexedDB transaction with `durability: 'strict'`, so a resolved write has reached disk (Chrome's default `relaxed` can fire `complete` earlier). Background snapshots stay relaxed; the scheduler tracks a separate strict generation, so a relaxed snapshot never satisfies a barrier and concurrent barriers still share one snapshot.

  `app.storage.writes` (`status()` and `subscribe()`) and `store.getWriteDurability()` report whether resolved writes are durable: `failing` after a committed write could not be confirmed, `permanent` after a superseded snapshot (reload before making more changes). A latency gate measures awaited inserts at 1,000 and 10,000 records.

- dec63c6: A database that existed on a device and vanished is reported, not mistaken for a fresh device. The storage manifest now records each database's `epoch` and its last known unsynced-write count (`unsynced`, `unsyncedAt`), and a `localStorage['kora:db:<name>']` marker carries the epoch and the backend. When a database is created empty while either record names it for the same backend, Kora emits `store:storage-evicted` and keeps the loss in `app.storage.evicted` (`{ dbName, detectedAt, lastOpenedAt, evidence, lostWrites: { count, certain } }`) until `app.offline.acknowledgeEviction()`; the report survives a reload. It is never reported after `app.storage.deleteDatabase()`, a move between IndexedDB and OPFS, a first open, a changed `store.name` or when the user clears all site data (nothing remains to compare with). A database with lost writes is still opened and re-syncs.

  Also adds the `store:storage-evicted` and `offline:meta-changed` events, and teaches DevTools the `store:write-durability` event.

- ea9f219: `app.offline.status()` and `app.offline.subscribe()` report whether a reload with no network would open the app with its data, and `useOfflineReady()` (React, Vue, Svelte `createOfflineReadyStore`) renders it. `data.state` is `complete` only on a durable completion mark, written in the same transaction as the delivery watermark of a fully applied final batch, cleared before a batch that narrows the view or removes records and by every watermark reset, and held back by a delivery-unit key while a unit that spans several transactions is open: a delivery that crashed or stalled mid-way is never `complete` after a reload. On the IndexedDB fallback a mark counts once a persisted snapshot holds it. Readiness changes reach other tabs through the new `kora-offline-meta-changed` bus message. The shell, files and sign-in components report `none`, zeros and `unknown` until their steps land, so no app reads `ready` yet. `offline` joins the reserved app property names.
- 941c67e: Offline readiness knows whether the signed-in session survives an offline reload (A3). `AuthSyncBinding` gains `resolveOfflineRestore()`, which `createKoraAuthSync` implements from the stored tokens: restorable only with both tokens stored, on storage that survives a reload, with a refresh token that has not expired and an offline grace (`maxOfflineGraceMs`, measured from the stored refresh token's issue time) that has not run out. A wall clock set back reports `clock-rollback`, and a 30 second watchdog re-checks while the session is restorable. `AuthTokenStorage` gains an optional `durability` (`durable`, `session`, `memory`): the default `localStorage` store is durable, `createMemoryAuthTokenStorage` and `sessionStorage` are not, and a custom store that does not say is `unknown`, so `app.offline` is never `ready` on an assumption. `createAuthTokenStorage({ store, durability })` declares it.

  `createApp({ offline: { auth } })` declares restorability for apps with their own sign-in (a bare `sync.auth` token function cannot know). `app.offline.status().auth` is now `restorable`, `not-restorable`, `unknown`, `loading` or `n/a`, and `ready` flips off when the session's limit passes.

- a5b3933: The offline app shell reports whether it is really there. The worker generated by `koraServiceWorker()` answers `KORA_SW_STATUS` after checking every precached URL, and when online refetches a missing one past the HTTP cache and stores it only if its SHA-256 equals the digest recorded at build time (a newer deployment's bytes are never stored, the entry stays missing); it also compares the page's hashed scripts and styles with its own build (`other-build`) and records the URLs it could not serve (`misses`, bounded). The registration script publishes `globalThis.__KORA_SHELL__ = { v: 1, state, version, misses }` and a `kora:shell` event (checked at start, on `updatefound`, `controllerchange` and `visibilitychange`, never polled), and `app.offline.status().shell` reads it: `installing`, `installed`, `not-installed`, `other-build`, `unsupported`, `bundled` (a native-storage desktop build) or `none` (no plugin, `vite dev`, or an older `@korajs/cli`: update both). All 13 templates, `tauri-react` included, render an `<OfflineBadge />` built on `useOfflineReady()` ("Available offline", "Preparing offline copy... 40%", "Not available offline yet"; first reason as the tooltip), on by default and not rendered in `vite dev`.
- ab20522: `app.offline.keep(query, { files })` keeps data on the device on purpose: it returns a handle (`status`, `subscribe`, `whenComplete`) and `app.offline.release`, `hold` (reference counted, for components) and `list` complete the API. Pins are stored in the device database, widen the sync query views so `data.state` is judged over them, are limited to 64 (`OFFLINE_PIN_LIMIT`) and refuse `limit`, `offset` and `include`. Holds of a closed or killed tab are pruned by the other tabs. With `files: true` one elected tab fetches the referenced blobs in the background, verified by SHA-256, and reports `quota`, `unavailable`, `integrity` or `error` failures; persistent storage is requested in the background. `useOfflineKeep` is available in `@korajs/react`, `@korajs/vue` and `@korajs/svelte` (and `korajs/*`). Blob stores gain a `durable` flag.

### Patch Changes

- 0c1f8f3: New guide, [Offline Readiness](https://korajs.dev/guide/offline-readiness): what Kora guarantees (a `ready` app opens offline, a write whose promise resolved is never lost) and what the app is responsible for, with `app.offline.status()`, `keep`, the app shell and `<OfflineBadge />`, offline sign-in, storage-loss reporting and durable writes on the IndexedDB fallback.

  Upgrade notes for `1.0.0-beta.15`:

  - Update `korajs`, `@korajs/auth` and `@korajs/cli` together. An older `@korajs/auth` cannot report offline sign-in (`auth-unknown`, never `ready`); an older `@korajs/cli` plugin publishes no shell status (`shell-none`).
  - A custom `AuthTokenStorage` that does not declare `durability` reads as `unknown` and is never `ready`. Pass `durability: 'durable'` to `createAuthTokenStorage` for a store that survives a restart, or declare `offline.auth`.
  - A custom `ContentAddressedBlobStore` that does not declare `durable` counts as not durable: a pin that keeps files reports `storage-non-durable`. Declare `readonly durable = true` on a store whose bytes survive a restart.
  - On the IndexedDB fallback a write can now reject with `WriteNotDurableError` (it used to resolve even when its snapshot failed). The write exists; do not retry it.
  - An app with a bare `sync.auth` token function reads `not-ready` until it declares `offline.auth`.

- 946dd42: With `experimentalAccessRules`, the download stream follows membership changes. When a session's stream reaches a change to the user's memberships, it re-reads them and sends what changed as one re-scope unit at that delivery sequence, starting a batch: a narrowing (the grant now in force per access collection, new `accessNarrowing` batch field) that the client applies to the records it holds, judged on its own values and keeping records with unsent writes, then scope entries (current values) for records the user may now read, filtered by the client's query view. Narrowing on the client removes records that moved or were deleted while the user was revoked, which the server cannot name. A group revoked and granted again, or a membership whose role changed in place since the client's watermark (tracked by a new `role_seq` index column, added to existing databases on open), is re-sent in full. History is gated by the open membership interval: a late joiner receives a group's current state, never the operations written before they joined, on a live session, a reconnect and a fresh device alike. What a reconnecting client holds is rebuilt from the membership intervals at its watermark, so a reconnect after changes made while offline resumes from the watermark. Access collections are reported to clients as unrestricted, so a client's view and its watermark stay the same across membership changes; the server alone enforces the grant. Records leaving an access collection's grant are always retracted. The delivery poll refreshes each session's memberships, so rich-text, presence and blob channels follow a change within one poll interval even when a client's stream is not progressing. `server.access.grant` no longer writes `expiresAt` when the memberships collection does not declare it.

  Rule types (`OwnerRule`, `MemberRule`, `OrRule`, ...) are exported from `@korajs/core` and `korajs`, so a schema module with declaration emit can export a schema that uses access rules.

  `@korajs/sync` applies a batch's `accessNarrowing` before its retractions and operations (`SyncStore.applyCollectionNarrowing`, implemented by `@korajs/store`); a failure stalls the delivery watermark so the batch is re-sent.

  A device keeps the key of the read rules it was last fully re-scoped under (`accessRulesKey`, sent at the handshake and carried by the batch that re-scopes it); a server running other read rules (a deploy, or another instance mid-rollout) narrows every access collection and sends everything it may read again, and a collection whose rules were dropped is re-sent under the session's own scope. Index reconciles, which write no operation, take a delivery sequence of their own, and the stream advances caught-up clients past it. When a client's own accepted write leaves an existing record outside what it may read (a write rule broader than the read rule), the server retracts that record from the client; records the client created stay. Records a narrowing kept for unsent writes are remembered on the device and removed once those writes are refused, unless the server sent them again meanwhile.

- 19cd5d9: Applying a delivery batch on the device costs about 1 storage round trip per operation instead of about 18 (13 reads, 5 writes). The sync engine announces the chunk's operations (`SyncStoreBatch.prefetch`, optional) and the store reads what they need once, in a few queries: which are already logged or compacted, who holds their sequence numbers, each record's fold state, base, snapshot, provisional effects, retraction marker and row. Each operation then folds from what the batch knows, which its own earlier writes keep current, so operations of one batch that touch the same record see each other. The prior operations of merge traces are read together before the commit, and a step's `SAVEPOINT`, statements and `RELEASE` travel in one request. Records the cache cannot answer for (a retraction marker, a base or snapshot, a shared node id, a taken sequence number, a record the batch changed by another route) take the per-operation path exactly as before. The batch is still one storage transaction with its quarantine rows and watermark, one savepoint per operation, and the same fold results and events after the commit. In Chromium on OPFS, first sync of a 20,000-operation school went from about 6.4 minutes to about 2.3 minutes (about 2.7x; the rest is OPFS journal I/O, see `docs/design/fast-first-sync.md`).
- d36239c: First-visit parity, stage S1: the offline shell's precache no longer competes with the app's first data, and no longer downloads the app a second time.

  - `koraServiceWorker()`: on a first visit (a page no service worker controls yet) the worker is registered, and the shell precached, only after the app's first data (the new `kora:first-data` event), at most `firstDataTimeoutMs` (new option, default 10 s) after `load`, then at an idle moment. A page a worker already controls registers at `load`, as before.
  - The install takes each file from the HTTP cache first (`only-if-cached`, then `cache: 'default'`), keeping it only when its SHA-256 equals the build's digest, and falls back to `cache: 'reload'` as before. Byte-identical files (the unhashed `sqlite3.wasm` copy of the hashed WASM) are downloaded once and stored under every URL; previously both were precached and downloaded, because Vite's hash `1f8bVu-G` contains `-` and was not recognised as one. On the default template's cold first load this takes the requests that reach the server from 26 to 17 and the body bytes from 1.53 MB to 0.81 MB: the main bundle and the WASM are each downloaded once.
  - `korajs`: `createApp` publishes `globalThis.__KORA_FIRST_DATA__` (`pending`, then `done`) and dispatches `kora:first-data` once the first data is in: at `app.ready` for a local-only app; for a syncing app when the first delivery batch is applied, the session is caught up, or sync stops until someone acts (signed out, locked, blocked) or an attempt ends offline.

- 2b9b8b5: Make a resolved local write a durability guarantee on every storage backend. Local CRUD, `insertMany`, mutations, and outer transactions now wait for the IndexedDB fallback's strict group-commit barrier before resolving; OPFS and native adapters pay no extra barrier. A barrier failure rejects with `WriteNotDurableError` (`WRITE_NOT_DURABLE`) after the committed operation is published, so applications can surface the problem without blindly repeating an action that already exists locally. `store:write-durability` reports failure and later recovery with the affected operation ids.

  Native SQLite now explicitly uses `synchronous = FULL` in both the better-sqlite3 adapter and Tauri plugin so a resolved write survives an operating-system crash or power loss.

- b378fb9: Shared browsers: each account gets a device id, and so a sync node, of its own. beta.12 gave every
  account on a browser the same device id, so with `store.namespaceByAuthUser` two users' databases
  authored under one node; later servers refused every account but the device's first
  (`DEVICE_OWNERSHIP_CONFLICT`). The persistent device identity now holds one device id per account
  that signed in on the device (and one unused id), storing nothing about the accounts; every
  sign-in, sign-up and OAuth callback offers them all (`deviceCandidates`) and the auth server picks
  the one registered to the account, else an unregistered one (sign-up checks before creating the
  account; an MFA sign-in registers it only after the second factor; when every candidate is refused
  the browser replaces its unused id and retries once). A namespaced database whose pinned node moved retires the previous node, asks the server
  by id which of its own writes it stores (`probeOperationIds` / `operationProbe` in the handshake),
  and re-authors the rest under its own node (`sync:operations-rewritten`, reason `node-rotation`;
  `sync:local-node` action `retired-repaired`), never an operation it received under that node, and
  not while a tab still has the node open. The device's registered owner keeps the old node, and the
  server hands it over as before.
  A node known only from outbound-queue entries (beta.12 queued writes a tab received from the
  user's other device) is asked about by id too: what the server stores is settled
  (`queue-settled`) instead of being reported as held unassigned writes.
- fe4d3cb: A stopped or disconnected sync engine no longer keeps its diagnostics interval running (it emitted `sync:diagnostics` every 5 s forever after the first connection). A Node process that used a sync engine can now exit after `stop()`.

  Messages still queued when a sync session ends no longer act on the next session: a stale handshake response, batch or acknowledgment is dropped, an error from a session that a new connection attempt replaced no longer ends or suspends that attempt, and a scope narrowing started by an ended session stops before hiding further rows (`applyScopeNarrowing` takes an optional `shouldContinue`).

- 1c9dbe0: Smaller critical-path JavaScript for a web app (first-visit parity, K3): Kora's share of the `react-tailwind-sync` template's entry bundle drops from 277.2 KB to 242.1 KB gzip (970.9 KB to 840.8 KB raw), with no behavior or wire-format change.

  - DevTools (`@korajs/devtools`, Preact, htm) loads with a dynamic `import()` only when `devtools` is on. Events emitted before it loads are held and replayed into the instrumenter in order (`Instrumenter.replay`, `SimpleEventEmitter.onAny`).
  - protobufjs is an explicit opt-in. `ProtobufMessageSerializer` and `NegotiatedMessageSerializer` keep their `@korajs/sync` exports and are also available from the new `@korajs/sync/protobuf`; `@korajs/sync` is now `sideEffects: false` so they are dropped from a bundle that does not use them. The sync engine's default serializer is `JsonMessageSerializer`; `HttpLongPollingTransport` still defaults to the negotiated serializer (JSON unless told otherwise), loaded on connect.
  - The beta.12 pairwise merge pipeline loads only with `experimental.legacyMerge`.
  - `MergeAwareSyncStore` accepts `undefined` for its merge engine, and `initializeApp` no longer takes one.

- 68cbb70: Version gate, stage 2: the app API. `createApp({ build })` names the deployment (otherwise the build id the `@korajs/cli/vite` plugins inject, read from `globalThis.__KORA_BUILD__` or `<meta name="kora-build">`; never the package version). In a browser, createApp creates the database's version gate and:

  - announces supersession with `app:build-superseded` (`{ currentBuild, newerBuild, preventDefault() }`) before any write is refused, then shows "A new version of this app is available. Reload to continue." with a Reload button, unless a listener called `preventDefault()`, the app set `store.onBuildSuperseded`, `store.buildPrompt` is false, or the app handles the offline shell's `kora:update-available` event (reused for this prompt);
  - shows "Your latest changes are not saved yet. Retry, or Export them." with Retry and Export (a JSON download of the in-memory database) while a failed IndexedDB barrier holds retirement, naming the reason when it is known (`QUOTA_EXCEEDED`: storage is full; `STORAGE_UNAVAILABLE`: no storage worker left), and waiting / other-tab messages in a tab whose gate is closed; from the moment retirement starts, `app.close()` saves every admitted write first and is refused (`PersistenceError`, `context.code: 'UNSAVED_WRITES'`) before anything is torn down when that fails;
  - stops sync as a retirement step: the engine is destroyed (a permanent fence: an auth reconnect or a `connect()` already in flight never opens a session or touches persisted sync state), and retirement waits (bounded) for those attempts before releasing the tab lock; inbound operations refused meanwhile stall without a `sync:apply-blocked` report. Every sync API that connects or changes persisted sync state (`connect`, `reconnect`, `retryNow`, `setQuerySubsets`, `clearRejectedOperations`, `assignHeld`, `discardHeld`) then refuses with `BuildSupersededError`; `app.sync.connect()` and `reconnect()` then refuse with `BuildSupersededError`, and no automatic reconnect starts. Queued operations stay in the outbound queue and the new build uploads them;
  - refuses blob writes (`app.blobs.put`, `delete`, `pull`, `gc`, and `put` / `delete` on `app.blobs.store`) like every other write.

  New: `app.reloadForNewBuild()` (emits `app:before-build-reload` synchronously; under the offline shell it checks for (within 10 s) and activates the newer build's waiting service worker, `KORA_SW_SKIP_WAITING`, and reloads on `controllerchange`; it never reloads under the worker that served the page's own build: when no newer worker is ready (offline, a failed update) it resolves false and the prompt offers Try again; otherwise a plain reload), `store.onBuildSuperseded`, `store.buildPrompt`, `store.allowUncoordinatedTabs`, exports `BuildSupersededError`, `StorageFormatAheadError`, `TabCoordinationUnavailableError`. `BUILD_SUPERSEDED` is a local refusal: it is a mutation's `error`, never its server `rejected` state. A storage format or schema ahead, a superseded tab and missing Web Locks are never answered with an in-memory database. On plain HTTP (not HTTPS, not localhost) the gate is off, as before it, with one console warning. A failed initialization whose cleanup close is refused with `UNSAVED_WRITES` keeps the gate (the retirement releases it once the writes are saved).

- ad6fce2: Version gate, stage 3: a build id for every Vite build. `koraServiceWorker()` now stamps `<meta name="kora-build" content="<id>">` into built pages (opt out with `buildId: false`), and the new standalone `koraBuildId()` plugin (from `@korajs/cli/vite`) does the same for apps without the offline shell. The id is a hash of every deployed file once the build is written (chunks, HTML pages with the id itself normalized, files copied from `publicDir`, files other plugins wrote), except the worker `koraServiceWorker()` generates (a `sw.js` the app ships itself is hashed by `koraBuildId()`), sourcemaps, precompressed copies of another emitted file (a standalone `.gz`/`.br` asset is hashed and precached) and dotfiles; each file is hashed separately and combined with length-prefixed paths. In `vite dev` it is `dev-<server start>` (a dev-server restart prompts open tabs to reload). With both plugins, the meta tag is injected once and both stamp the same id. An authored `kora-build` tag has its content replaced; only that tag's placeholder is stamped (the same string elsewhere in a page stays); precompressed copies of a stamped page (`.html.gz`, `.html.br`) are regenerated; every page is stamped, multi-page and nested entries included. `createApp()` reads it when no `build` option is given (an unstamped placeholder is ignored), so tabs of two deployments never write the local database at the same time, including deployments that change only application code. Every web template already uses `koraServiceWorker()`; Tauri templates need none (native SQLite is not gated).
- df7a430: Version gate, stage 4: form drafts. `useFormDraft(formKey, initial, { fields })` (React hook, Vue composable, Svelte store; `korajs/react`, `korajs/vue`, `korajs/svelte`) keeps what the user was typing across the reload a new build asks for. Opt-in per form: nothing is stored unless a form calls it, and only the listed `fields` are drafted (in `sessionStorage`, under `kora-draft:<db>:<formKey>`).

  - Never drafted, even when listed: a field bound to a password input (`type="password"`, or `autocomplete` `current-password` / `new-password` / `one-time-code` / `cc-*`; observed when the binding first sees the input and on every type change, not only at save, and once seen never drafted again in that form, so a "show password" toggle, even before the first keystroke, does not draft it), an input marked `data-kora-sensitive`, a `t.secret()` field of `collection` (nothing of such a form is drafted until the schema is known), and `sensitive` fields (a dotted path such as `answers.ssn` removes that nested value; sensitivity is otherwise per top-level field); `allowSensitive` overrides (discouraged). A `sensitive`, `allowSensitive` or `safe` entry that is not a listed field warns.
  - Fail closed: the control is resolved at or inside the bound element (a component whose ref lands on a wrapper is read through it; any password control inside makes the field secret). A listed field with no resolvable `<input>` / `<textarea>` / `<select>` (values set from code, wrappers without a control) is not drafted unless listed in `safe`. `describeFormDraftInput()` (core bindings) is the shared resolver.
  - When the app enables encryption (`app.encryption`), no draft is stored at all: no plaintext copy, the form is simply not restored. (Decision for the design's deferred question; a sealed draft store may come later.)
  - A restored draft is removed at once and rewritten only on the next change; `clear()` after a successful submit; `clearFormDrafts(app)` (from `korajs`) removes every draft of the database on sign-out or a user change (with `namespaceByAuthUser`, of every namespace of the base name), and a draft written under another known `userId` is removed, never restored. `userId: undefined` means the session is still loading: nothing is restored, consumed or saved until the user is known, then the draft is restored (keeping what was typed meanwhile). Pass `null` when signed out. Vue accepts a ref or getter, Svelte a store or getter (or `draft.setUser()`).
  - `app:before-build-reload` saves the latest values synchronously before `app.reloadForNewBuild()` reloads.

  Review round: a `userId` getter is followed (an account switch it reports resets the form and restores that user's draft; values are never stored under another user); the last known user is tracked across loading states (alice, loading, bob never carries Alice's input to Bob); fields typed while the session loads win over the restored draft; `clear()` and the automatic "back at the initial values" removal keep the stored draft while the user is unknown; `allowSensitive` overrides dotted sensitive paths (`answers` or `answers.ssn`); `clearFormDrafts(app)` takes the app as documented (or a database name); equality checks never throw on `bigint` or cyclic values (`formValuesEqual`); an ancestor gaining `data-kora-sensitive` is observed in every binding (React and Vue observe attributes React or Vue does not re-render for).

- Updated dependencies [191930a]
- Updated dependencies [0c1f8f3]
- Updated dependencies [0c1f8f3]
- Updated dependencies [24f5531]
- Updated dependencies [6c72c04]
- Updated dependencies [6fd998a]
- Updated dependencies [946dd42]
- Updated dependencies [8667762]
- Updated dependencies [003d7bf]
- Updated dependencies [0b461fa]
- Updated dependencies [8411be3]
- Updated dependencies [a5c61ff]
- Updated dependencies [714ebd2]
- Updated dependencies [70e0611]
- Updated dependencies [4237195]
- Updated dependencies [d988dda]
- Updated dependencies [19cd5d9]
- Updated dependencies [180923d]
- Updated dependencies [fa1a971]
- Updated dependencies [b8f9e6f]
- Updated dependencies [c5ef367]
- Updated dependencies [6470e48]
- Updated dependencies [9afd6a0]
- Updated dependencies [d45441e]
- Updated dependencies [4d5f2a2]
- Updated dependencies [daf696c]
- Updated dependencies [c9defbd]
- Updated dependencies [d19c7f7]
- Updated dependencies [95f5a26]
- Updated dependencies [92f08d3]
- Updated dependencies [dec63c6]
- Updated dependencies [ea9f219]
- Updated dependencies [941c67e]
- Updated dependencies [ab20522]
- Updated dependencies [2b9b8b5]
- Updated dependencies [89cb4c4]
- Updated dependencies [0b461fa]
- Updated dependencies [b378fb9]
- Updated dependencies [fe4d3cb]
- Updated dependencies [1c9dbe0]
- Updated dependencies [0388bd7]
- Updated dependencies [68cbb70]
- Updated dependencies [df7a430]
- Updated dependencies [b7f964a]
  - @korajs/store@1.0.0-beta.15
  - @korajs/vue@1.0.0-beta.15
  - @korajs/core@1.0.0-beta.15
  - @korajs/sync@1.0.0-beta.15
  - @korajs/devtools@1.0.0-beta.15
  - @korajs/merge@1.0.0-beta.15
  - @korajs/react@1.0.0-beta.15
  - @korajs/svelte@1.0.0-beta.15

## 1.0.0-beta.14

### Patch Changes

- afe97c6: A beta.12 database whose user signed up and wrote without reloading the page no longer strands
  those writes after the upgrade. beta.12 authored them under the random node the store opened with
  before anyone signed in; once `createKoraAuthSync` pinned the store to the device id, that node
  was never registered, so its queued writes stayed in the queue, neither uploaded nor reported.
  `Store.open` now registers the node id a pinned `nodeId` replaced and the authors of queued
  operations: the writes are held as `unassigned` (`status.heldNodes`) until the app assigns them.
  When the server then refuses the assigned node (beta.12 history with no recorded owner), the
  writes it never stored are re-authored under a fresh node of the user's
  (`Store.reauthorLocalNode`) and upload; what it stored is not repeated.
- 44ddf65: `importBackup` converts a version-1 backup (Kora 1.0.0-beta.12 and earlier) itself, with the
  rules of `convertBackupV1`, and reports `convertedFromVersion: 1` (F3). beta.13 returned
  `success: false` with `BACKUP_FORMAT_OUTDATED`, which code that ignored the result never
  noticed. A file holding an operation whose timestamp cannot be recovered is still refused
  (`BACKUP_OPERATION_INVALID`): dropping operations stays an explicit `convertBackupV1` option.
- a1e5765: A `NODE_ID_CLAIMED` refusal now says whether another user owns the node
  (`nodeOwnership: 'other-principal'`) or it only has history with no recorded owner
  (`'unowned'`). A store with a pinned node id (the `createKoraAuthSync` device id) cannot move to
  a fresh node, so after `'other-principal'` it refuses local writes (`NODE_OWNED_BY_ANOTHER_USER`)
  instead of storing them under a node whose writes could only upload as its owner; the server
  accepting the node again lifts it. An `'unowned'` refusal (a beta.12 node awaiting handover or a
  bind) keeps writes on.
- Updated dependencies [afe97c6]
- Updated dependencies [99cedc4]
- Updated dependencies [8b7de83]
- Updated dependencies [4ec1bc5]
- Updated dependencies [44ddf65]
- Updated dependencies [a1e5765]
- Updated dependencies [a0965d3]
- Updated dependencies [88654fa]
- Updated dependencies [267fa9f]
  - @korajs/store@1.0.0-beta.14
  - @korajs/sync@1.0.0-beta.14
  - @korajs/core@1.0.0-beta.14
  - @korajs/react@1.0.0-beta.14
  - @korajs/vue@1.0.0-beta.14
  - @korajs/svelte@1.0.0-beta.14
  - @korajs/merge@1.0.0-beta.14
  - @korajs/devtools@1.0.0-beta.14

## 1.0.0-beta.13

### Major Changes

- **Breaking.** Security, data-safety and convergence release. `createApp` speaks sync protocol v2,
  applies server-to-client operations through a gap-free delivery watermark, quarantines operations
  it cannot apply yet instead of dropping them, and undoes permanently refused writes on their
  author (`sync:operation-rejected`).
- Writes are bound to the signed-in user; writes made before the user was known are held
  (`app.sync.assignHeld` / `discardHeld`, `status.heldOperations`).
- End-to-end encryption works across a user's devices: `app.encryption` (`unlock`, `lock`,
  `getStatus`, rotation, passphrase change, recovery key, `startNewKeyring`).
- The first open re-materializes every record with the deterministic fold (`store:rematerialized`);
  `experimental.legacyMerge` compares against the beta.12 pipeline for this release only.
- Records, inputs, `where`, `orderBy`, `include` and transactions are typed from the schema.
- `createApp` is inert without `window` (`ServerRenderingAppError` on `app.ready`); `findById`
  before `ready` throws `AppNotReadyError`; `app.storage` never deletes a database with unsynced
  writes and requests persistence in the background; `korajs` re-exports only the everyday core
  API.
- Security fixes are described in the [security advisory](https://github.com/ehoneahobed/kora/blob/main/docs/releases/security-advisory-beta13.md).

See the [1.0.0-beta.13 release notes](https://github.com/ehoneahobed/kora/blob/main/docs/releases/v1.0.0-beta.13.md) and the [upgrade guide](https://github.com/ehoneahobed/kora/blob/main/docs/guide/upgrading-to-beta13.md) (servers first, then clients).

## 1.0.0-beta.12

### Minor Changes

- Add collision-free `app.collections` access, `app.on()`, and opt-in scope retractions.

## 1.0.0-beta.11

### Minor Changes

- Add authenticated-only sync suspension, stable query-subset policies, awaitable
  active-view settlement, active apply-failure state, store identity introspection,
  and an auth-bound React app lifecycle for shared-browser isolation.

## 1.0.0-beta.9

### Patch Changes

- Updated dependencies [b657130]
  - @korajs/core@1.0.0-beta.9
  - @korajs/react@1.0.0-beta.9
  - @korajs/store@1.0.0-beta.9
  - @korajs/sync@1.0.0-beta.9
  - @korajs/devtools@1.0.0-beta.9
  - @korajs/merge@1.0.0-beta.9
  - @korajs/svelte@1.0.0-beta.9
  - @korajs/vue@1.0.0-beta.9

## 1.0.0-beta.6

### Patch Changes

- Retire SharedWorker-hosted SQLite as a durable storage path. OPFS
  SyncAccessHandle is dedicated-worker-only in browsers, so a SharedWorker-hosted
  SQLite core cannot obtain durable OPFS storage. Kora now uses the
  dedicated-worker leader/follower path as the single durable multi-tab SQLite WASM
  path, with Web Locks leader election, BroadcastChannel follower RPC, and
  automatic promotion when the leader tab closes.

  The `sharedWorkerUrl` option is deprecated and ignored for storage selection. If
  it is still provided, Kora logs a one-time warning and transparently uses the
  durable dedicated-worker leader/follower path. No application code change is
  required for durability; remove `sharedWorkerUrl` when convenient.

  When OPFS SyncAccessHandle cannot be acquired, `createApp()` now falls back to
  the durable IndexedDB adapter instead of allowing the app to continue on an
  in-memory SQLite database. Kora emits `store:storage-fallback` for this recovered
  state. `store:opfs-unavailable` is now reserved for the true last-resort case
  where both OPFS and IndexedDB are unavailable and the store is running in memory,
  so a data-loss condition remains observable rather than silent.

  The dedicated-worker leader/follower path also keeps already-open same-origin
  tabs reactive. Kora broadcasts committed local operations per database name and
  invalidates matching queries in sibling tabs without reapplying the operation.
  Worker access is serialized at the leader boundary across whole transaction
  spans, so concurrent writes from the leader and followers cannot interleave
  between `begin` and `commit`. If a follower disappears while it owns a
  transaction span, the leader reclaims it with a real rollback against the SQLite
  worker before resuming other clients; followers also send a best-effort leave
  message on page unload for faster cleanup. The idle backstop defaults to 10s,
  which bounds crash-case unavailability while leaving normal programmatic
  transactions ample time to finish.

- Updated dependencies
  - @korajs/store@1.0.0-beta.6
  - @korajs/react@1.0.0-beta.6
  - @korajs/svelte@1.0.0-beta.6
  - @korajs/vue@1.0.0-beta.6

## 1.0.0-beta.5

### Minor Changes

- Server-side adjudication of untrusted client operations before they become
  authoritative. This is what lets Kora serve public and multi-tenant offline apps
  where the client cannot be trusted (anonymous form submissions, one tenant that
  must not write another's data).

  Pass `validateOperation` in the server's `syncOptions` (or to `KoraSyncServer`).
  It runs at sync ingestion, after HLC ordering and the built-in guards, and before
  materialization, returning `accept`, `reject`, or `ignore`. On `reject` the
  operation never enters the authoritative log, so no other replica ever sees it,
  and a structured rejection travels back to the submitter tied to the operation id.
  The validator receives an `auth` context (null for anonymous connections) and the
  trusted `kora` data-plane, so it can read current state and author a derived
  server operation — for example promoting a validated anonymous submission into an
  owner-visible collection.

  On the client, a rejected operation is diverted out of the pending outbound queue
  into a durable rejected store (`_kora_sync_rejected`, survives a page refresh)
  rather than being retried forever or lost on the batch ack, and a
  `sync:operation-rejected` event fires. `app.sync.getRejectedOperations()` and
  `app.sync.clearRejectedOperations()` let the app surface failed submissions and
  reconcile (roll back the optimistic write or resubmit). Convergence holds: the
  authoritative state is defined purely by accepted operations, so every synced
  device agrees without the rejected op, and the submitter is told rather than
  diverging silently. See the new "Server-side operation validation" guide.

### Patch Changes

- Fix a lost-update bug where three or more concurrent atomic writes (`op.increment`,
  `op.max`, ...) to the same field failed to converge on clients.

  The client apply pipeline composed a remote atomic op through the merge engine's
  pairwise rule (`base + localDelta + remoteDelta`), which is correct only for exactly
  two concurrent writes from a shared base. With a third concurrent writer, the current
  row already folded in an earlier remote delta, and re-deriving the value from the base
  plus the local device's own delta silently dropped that earlier delta. Three devices
  each incrementing a shared counter by 5, 3, and 2 could settle at 7/5/5 across devices
  instead of 10.

  The client now materializes atomic-op fields by folding the record's operation log in
  HLC order through the same atomic-aware replay the server uses (moved into
  `@korajs/core` as `replayOperationsForRecord` so both sides share one definition).
  The fold composes a same-type atomic chain and resolves anything else — including a
  plain set breaking the chain — by last-write-wins, so every replica converges to the
  same value regardless of how many concurrent atomic writers there were or which device
  authored them, including a passive device that only observes the writes. Non-atomic
  fields are unaffected.

- Add a gap-free server-to-client delivery watermark, so no operation the server holds is
  ever lost on its way to a client, even across drops, reconnects, restarts, and scoped
  sync.

  Previously the server drove server-to-client sync from the version vector. Under a lossy
  transport this could strand an operation permanently: if a relayed operation was dropped
  while a later operation from the same node was delivered, the client's version vector
  advanced past the gap, and version-vector delta on the next connection never re-sent the
  missing one. The paginated initial-sync resume cursor had the mirror problem: a retriable
  apply failure let the cursor advance past the failed operation, skipping it on resume.

  The server now assigns every stored operation a monotonic delivery sequence in commit
  order and drives each client's stream from a durable, per-client delivery watermark. On
  Postgres the sequence is assigned from a counter row locked inside the append
  transaction, so delivery order equals visibility order and a `> watermark` scan can never
  skip an operation that later becomes visible below the cursor, even across concurrent
  server instances. Each server-to-client batch chains `base -> max` delivery sequences;
  the client applies a batch only when its watermark equals the base and advances the
  watermark only when every operation applied, so a dropped or failed batch stalls the
  watermark and is recovered contiguously rather than skipped. The watermark advances live
  during streaming and is persisted on the client, so a reconnect resends only what was
  genuinely missed. Because a causal dependency is always committed (and thus sequenced)
  before its dependent, delivery order respects causal order and needs no reordering.

  The watermark also advances live during streaming (a client's watermark tracks the
  server frontier while connected, so a reconnect resends only the true delta), a client's
  own operations are not echoed back to it during streaming (they are still included in a
  full resync so a client that lost its local store recovers its own history), and a client
  whose persisted watermark is ahead of the server's frontier (the server restored an older
  backup) resets to a full resync instead of stalling above a frontier that no longer
  exists.

  All wire fields are optional and additive: an old client omits its watermark and gets the
  version-vector delta unchanged, and a new client against an old server keeps its version
  vector, so both still converge. The version vector remains authoritative for the
  client-to-server direction and for local deduplication. On Postgres the schema setup and
  delivery-sequence backfill run under an advisory-locked transaction, so simultaneous
  cold start of multiple server replicas against a fresh database is safe.

  Correctness characteristics worth knowing when adopting:

  - The delivery watermark is tracked per view (a stable signature of the active scope plus
    query subscriptions), so changing the scope or registering a new query subscription
    back-fills that view at most once and returning to a previously-synced view resumes from
    its own watermark instead of re-scanning it. A widened scope can expose operations below
    the current watermark, so the first visit to a view scans from zero; any back-fill is
    deduplicated, so operations already applied under another view are re-received but not
    re-applied.
  - Per-view watermarks are retained under a bounded, least-recently-used cap (default and
    live views are never evicted), so a client that churns through many distinct views (for
    example a search that registers a fresh subscription per keystroke) cannot accumulate an
    unbounded number of persisted watermark rows. Eviction is a storage tradeoff only, never
    a correctness one: an evicted cold view simply back-fills from zero (deduplicated) the
    next time it is visited.
  - An inbound operation that cannot be applied (for example a scope that includes a child
    record but excludes its parent) surfaces as a visible, recoverable sync stall rather
    than being silently skipped: the watermark holds and the operation is re-fetched until
    it applies. This upholds the no-silent-loss guarantee.
  - A dropped or unacknowledged streaming batch is recovered by re-sending from the client's
    last acknowledged position, so recovery does not depend on a bounded retransmit buffer.
  - Backup export preserves delivery (commit) order, so restoring a backup keeps causal
    order and a resumed client never receives a dependent before its dependency.

- Storage persistence failures are no longer silent. When OPFS is unavailable the
  store falls back to a non-persistent in-memory database so the app keeps working,
  but anything written that session is lost on reload — previously with no signal.
  The SQLite WASM worker now classifies why OPFS could not be used (`lock-conflict`,
  `timeout`, or `unsupported`) and the store emits a `store:opfs-unavailable` event,
  so the condition is observable instead of a quiet data-loss trap. The most common
  cause, `lock-conflict`, is two runtimes on one origin contending for the same
  database.

  A `store:db-name-collision` event now fires when a runtime attaches to a database
  name another runtime on the same origin already owns. That is expected for
  multiple tabs of the same app (they share one leader), and the exact clue a
  developer needs when two logically separate apps accidentally share the default
  store name and should each use a distinct one. Both events surface in DevTools and
  via `app.events`. See the new "Multi-runtime storage and isolation" guide.

- Fix multi-tenant scoped sync dropping any update that does not restate the scope
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

- Fix two convergence bugs around deleted records that could leave replicas
  permanently disagreeing on whether a record exists.

  A remote update landing on a tombstone was only handled when the tombstone came
  from a LOCAL delete (resolved via the pairwise merge engine). A device that merely
  observed a delete and then a newer update relayed from other devices kept the record
  hidden (`_deleted` stayed set) while the authoring devices and the server showed it
  alive — a permanent, arrival-order-dependent divergence. The same path also
  materialized a resurrecting op's raw value instead of the composed atomic chain, so
  increments before and after a delete were mis-counted on resurrection.

  The client now resolves any remote update on a tombstone by folding the record's
  whole operation log in HLC order — the same fold the server uses — so every device
  agrees on whether the update resurrects the record and on its field values, and
  atomic deltas on both sides of a delete compose correctly.

  A stale update that loses to a newer delete is now appended to the log via a new
  log-only apply (so a later fold — e.g. an atomic resurrection composing its delta —
  is complete) while leaving the tombstone untouched: no zombie fields, no version
  regression. Previously such an op was dropped, which could lose an atomic delta
  needed by a subsequent resurrection.

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @korajs/sync@1.0.0-beta.5
  - @korajs/store@1.0.0-beta.5
  - @korajs/core@1.0.0-beta.5
  - @korajs/merge@1.0.0-beta.5
  - @korajs/react@1.0.0-beta.5
  - @korajs/svelte@1.0.0-beta.5
  - @korajs/vue@1.0.0-beta.5
  - @korajs/devtools@1.0.0-beta.5

## 1.0.0-beta.0

### Minor Changes

- Reclaim storage from blobs no record references any more. Blob bytes are content-addressed and deduplicated, so a blob can outlive the record that created it (and be shared by several records); garbage collection frees the truly orphaned bytes without touching shared ones.

  - `@korajs/store` adds `collectBlobGarbage(store, liveRefs, { dryRun })`, a mark-and-sweep collector. The live set is closed over the reference graph — each live `BlobRef` retains its blob hash, its manifest hash, and every chunk hash the manifest names — so a chunk still referenced by any surviving blob is kept. Mark-and-sweep (not reference counting) is deliberate: it is correct under concurrent edits and CRDT merges, where counts are fragile. The `ContentAddressedBlobStore` interface gains `list()`, implemented by the memory, OPFS, and filesystem stores. `extractBlobRefs(record)` pulls the references out of a materialized record.
  - `korajs`: `app.blobs.gc()` sweeps the local blob store against the live records in every collection that has a `blob` field. `{ dryRun: true }` previews what would be collected. Returns a summary (scanned, live, collected, and the collected hashes).
  - `@korajs/server`: `KoraSyncServer.getLiveBlobRefs()` returns the live references across all server-side records, so a self-hosted server can GC its central blob store by passing them to `collectBlobGarbage`.

  Proven end to end: an orphaned blob is collected after its record is deleted (client and server), a blob is kept while still referenced, and a chunk shared by a surviving blob is never collected.

- Pull a blob's bytes knowing only its reference. This closes the last gap in blob sync: a device that receives a `BlobRef` in a synced record can now fetch the bytes with no separate manifest hand-off.

  - `@korajs/core`'s `BlobRef` gains an optional `manifestHash` — the content hash of the blob's chunk manifest. Because it is a content address like `hash`, the manifest is fetched and integrity-verified over the same channel as the chunks. It rides inside the reference that already syncs in the record, so no new protocol or operation-log surface is needed.
  - `@korajs/store` adds `putBlobForTransfer` (stage chunks + store the full blob + store the manifest as its own content-addressed object, returning a ref that carries `manifestHash`), `resolveBlobManifest` / `fetchBlobManifest` (fetch and verify a manifest by hash before pulling), and the canonical `serializeBlobManifest` / `parseBlobManifest`. The manifest is served over the existing chunk channel with no special casing — it is just another content-addressed object.
  - `korajs`: `app.blobs.put` now stores the manifest and returns a ref carrying `manifestHash`, and `app.blobs.pull` accepts that `BlobRef` directly (resolving the manifest by hash) or an explicit `BlobManifest`. The "attach a file, it appears everywhere" path now needs only the reference from the synced record.

  Proven end to end over the live server relay: a blob authored on device A is pulled on device B from the reference alone — B resolves the manifest by `manifestHash`, then fetches only the chunks it is missing and verifies integrity against the blob hash.

- Transfer blob bytes over the live sync connection. Blob fields already synced their content-addressed `BlobRef` through the operation log; now the referenced bytes move out of band over the same WebSocket, so a blob inserted on one device becomes downloadable on another with no second connection and no server-side blob storage required.

  - `@korajs/sync` adds two ephemeral `SyncMessage` variants (`blob-chunk-request` / `blob-chunk-response`) and a `BlobChunkChannel` side channel on the `SyncEngine` (`getBlobChunkChannel()`), mirroring the richtext doc channel. Unlike ephemeral presence messages, blob chunks carry durable user data, so they are fully represented on the protobuf wire (not JSON-only) and round-trip byte-for-byte, with a `hasBytes` flag distinguishing a held chunk from "not held".
  - `@korajs/server` routes chunks between peers with a new `BlobChunkRelay`. By default the server is a pure relay: it forwards a chunk request to peer sessions and routes the first peer's answer back to the requester by `requestId`, never storing or inspecting blob bytes. A new optional `resolveBlobChunk(hash)` server config lets central-store deployments answer chunk requests directly from their own storage, falling back to peer relay on a miss.
  - `korajs` adds `createSyncEngineChunkPort(syncEngine)`, which binds `@korajs/store`'s transport-agnostic `ChunkMessagePort` to the live sync connection, plus re-exports the blob toolkit (`createRemoteChunkProvider`, `receiveBlob`, `prepareBlobForSend`, `MemoryBlobStore`, `createBlobRef`, and related types) so an app can pull and serve blob bytes with `app.getSyncEngine()`.
  - `@korajs/test` devices gain a blob store and `stageBlob` / `pullBlob` / `getBlobBytes` helpers, backing an end-to-end two-device test: a multi-chunk blob authored on device A transfers to device B over the real server relay, resumes fetching only missing chunks after a partial transfer, and verifies integrity against the manifest hash.

  Security note: possessing a chunk hash is itself the capability to request it. Hashes are learned only from `BlobRef`s inside records a peer already received through its scope-filtered sync, and SHA-256 preimage resistance makes guessing one infeasible, so the relay needs no separate blob ACL.

- Keep blobs available after the authoring device goes offline. A self-hosted server can now persist blob bytes centrally, and clients upload the bytes behind their `blob` fields automatically as records sync — so a blob authored on one device is retrievable by others even once the author disconnects.

  - `@korajs/server` gains an optional `persistBlobChunk(hash, bytes)` config. When set, the server advertises central blob storage at handshake, verifies every uploaded chunk against its content hash before storing, and serves stored blobs through the same relay used for peer transfer (`resolveBlobChunk`). With no persistence configured the server stays a pure peer relay, unchanged.
  - `@korajs/store` adds `toServerBlobCallbacks(store)` (and `createMemoryServerBlobStore()`), which adapt any `ContentAddressedBlobStore` — for example a `FilesystemBlobStore` — into the server's read/persist callbacks, so a server can back central blob storage with a durable store without `@korajs/server` depending on `@korajs/store`.
  - `@korajs/sync` adds a `blob-chunk-push` message (client → server upload) and a `blobStorageEnabled` handshake-response flag, both fully represented on the JSON and protobuf wire. `SyncEngine` exposes `isBlobStorageEnabled()` and `uploadBlobChunk()`.
  - `korajs`: when the connected server advertises blob storage, the app automatically uploads a blob's manifest and chunks as its operation is sent — including on reconnect for blobs authored offline — deduplicated per session. No developer wiring.

  Proven end to end: a blob authored on device A auto-uploads to the server as its record syncs, device A disconnects entirely, and device B still pulls the bytes from the server using only the reference from the synced record.

- Clock integrity: protection against wrong device clocks at every layer.

  - HLC now validates remote timestamps BEFORE adopting them (`RemoteClockDriftError`),
    so a far-future timestamp can no longer poison a replica's clock.
  - Local timestamp generation never throws and never blocks writes: drift is
    reported through callbacks and `sync:clock-skew` events instead.
  - The sync handshake now carries `serverTime`; clients measure their own skew,
    pause sync with a new `clock-error` status when the device clock is more than
    60s fast (local writes keep queuing), and warn via events when it is very slow.
  - `SyncStatusInfo` gains `clockSkewMs`; the store's HLC receives the measured
    offset so remote validation works even on devices with wrong clocks.
  - Scaffolded templates render a plain-language banner telling end users how to
    fix their device clock. See the new Clock Integrity guide.
  - Automatic timestamp rebase: after the clock is corrected, the next handshake
    clears the clock block on its own and re-stamps queued never-acknowledged
    operations (new content-addressed ids, causal deps remapped, original order
    preserved) so sync resumes immediately instead of waiting for real time to
    catch up. A new `sync:clock-rebase` event reports `rebasedCount` and
    `maxSkewMs`. Safe because unacknowledged operations are private to the
    device — like rewriting unpushed git commits.
  - Bounded logical counter with carry: the HLC logical counter is capped at
    99,999 (`MAX_LOGICAL`, exported from `@korajs/core`) so serialized timestamps
    always sort lexicographically identically to `HybridLogicalClock.compare`.
    Overflow carries into wallTime (+1ms, counter resets) in `now()`, `receive()`,
    and `advanceTo()`; malformed timestamps (non-integer/negative fields, logical
    past the cap) are rejected with `InvalidTimestampError`
    (`INVALID_TIMESTAMP_FIELDS`) before any clock state changes, both at the
    replica and at server ingest.
  - Canonical binary encoding in op payloads: richtext `Uint8Array`/`ArrayBuffer`
    values are normalized to a tagged `{ $koraBytes: base64 }` form in
    `op.data`/`op.previousData` at operation creation, BEFORE content hashing, so
    the hash input, persisted JSON, and wire payload are the identical value and
    operation ids survive persistence round-trips. Plain-string richtext values
    are untouched (existing operation ids are unaffected); apply paths decode the
    tagged form (and tolerate the pre-fix numeric-key shape from dev databases)
    back to bytes.

- Add `object` and `json` field types that merge as convergent CRDTs.

  Structured data is no longer an opaque last-write-wins blob. Two devices that edit different keys of the same object offline both keep their edits on reconnect.

  - `t.object({ ...nested field schema })`: a structured field whose keys each merge by their own kind (scalars via LWW, nested arrays add-wins, nested objects recursively). Nested values are validated against the declared schema.
  - `t.json<T>()`: a dynamic-key JSON field with the same convergent semantics, resolved structurally, carrying a compile-time shape `T`.

  Merge is a 3-way LWW map with add-wins key presence: per key, one side's write to a key the other left untouched survives; concurrent writes to the same key resolve by HLC (or recurse for nested objects / add-wins for nested arrays); a write always wins over a concurrent delete of that key, so an edit is never silently dropped. The strategy is proven commutative, idempotent, and deterministic with fast-check property tests, and validated end-to-end through the real store + sync path (two devices editing different keys of an object converge). Values persist as JSON (`TEXT`) and cross the existing wire unchanged.

- Persist blobs in the browser and expose a first-class `app.blobs` API, closing the gap between "blobs sync" and "blobs sync with zero developer effort".

  - `@korajs/store` adds `OpfsBlobStore`, a durable content-addressed blob store backed by the browser Origin Private File System (the same storage the SQLite adapter uses). Blobs survive reloads, are sharded by hash prefix, deduplicated, and integrity-verified on read; writes commit atomically so a torn write is never trusted. Its logic runs against a small `OpfsBlobDirectory` port, so it is fully unit-tested without a browser, and `createOpfsBlobStore()` gives the real navigator.storage-backed instance (best-effort requesting persistent storage to resist eviction).
  - `korajs` now holds a blob store on every app and exposes `app.blobs`: `put` (store bytes, returning the `BlobRef` to attach to a record plus the manifest a peer needs to pull), `get` / `has` / `delete` for local bytes, and `pull(manifest)` to fetch a blob's bytes from peers over the live sync connection, fetching only missing chunks and verifying integrity. The backend is chosen by environment — OPFS in the browser, in-memory elsewhere — and is overridable via `blob.store` in `createApp` config. When sync is enabled, the app automatically serves the chunks it holds, so a blob authored on one device is pullable on another with no wiring.

  The default is durable and offline-first: local blob reads and writes work with no connection, and a browser that advertises OPFS but fails to open it degrades to in-memory with a warning rather than failing startup.

  Known boundary: `pull` takes a manifest today. Pulling from a bare `BlobRef` alone (resolving its manifest by hash) is a deliberate next step, since it requires a manifest-distribution decision (embed in the ref, a manifest object addressed by its own hash, or carry it in the operation log).

- Encrypt/hash `secret` fields at rest, end to end. `secret` fields are now secure at rest, not just redacted in traces.

  - The mutation pipeline transforms secret fields to their at-rest form before the operation is built, so plaintext never enters the store, the operation log, or the sync stream. `encrypted` fields are stored as AES-256-GCM ciphertext; `hashed` fields as a one-way salted hash. Verified end to end: after inserting a record, both the materialized column and the op-log JSON contain only ciphertext, never the plaintext.
  - Encrypted secret fields reuse the app's `sync.encryption.key` (a passphrase string or an async provider). A schema with encrypted secret fields but no key configured throws `MissingSecretKeyError` on write rather than silently storing plaintext.
  - `@korajs/core` exposes `transformSecretFieldsForWrite` (the pipeline transform), `revealSecret` (decrypt an encrypted field on demand — reads otherwise return the at-rest form), and `verifySecretValue` (check a candidate against a hashed field, since hashed secrets are one-way and cannot be revealed), plus the `SecretKeyProvider` type.

  Reads return the at-rest form by default; call `revealSecret` at the point of use so plaintext is never spread across query results or subscriptions. This completes the `secret` field: redaction in merge traces (already shipped), the crypto primitives, and now automatic at-rest protection on every write.

### Patch Changes

- Package export hygiene and auth secret-handling hardening.

  - Every published package now exposes `./package.json` in its `exports` map. Previously `require.resolve('@korajs/core/package.json')` (and the same for every other package) failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`, which breaks tooling that reads a package's manifest or version at runtime.
  - `createKoraAuthServer` now warns loudly when it falls back to an ephemeral random JWT secret outside production, so a deployment that never set `NODE_ENV=production` no longer silently regenerates its signing key on every restart (which invalidates all existing tokens) without any signal.
  - `KORA_AUTH_SECRET` set to an empty or whitespace-only string is now treated as unset rather than as an invalid secret, so it triggers the intended dev fallback / production guard instead of crashing `TokenManager` with a "secret too short" error.

- Fix silent data loss and divergence on concurrent cross-device edits.

  Two connected devices editing the same record while briefly offline could
  permanently drop one edit and diverge, violating the "no operation is ever
  lost" guarantee. This release closes that bug and every adjacent defect found
  while auditing the apply path:

  - **Per-field LWW register.** Materialized rows now carry `_field_versions`
    (field → last-writer HLC). Remote updates resolve field-by-field, atomically,
    inside the write transaction: deterministic, order-independent, commutative,
    and idempotent. Concurrent edits to different fields both survive; same-field
    conflicts converge to one agreed winner on every node.
  - **Optimistic-concurrency guard for merge results.** Richtext, add-wins-set,
    constraint, and custom-resolver merges are computed from a version snapshot
    and applied only if the row is unchanged; otherwise the merge recomputes from
    fresh state (bounded retries). A local edit can no longer slip between a
    merge's read and its write.
  - **Operation-log integrity.** Merge results are no longer persisted under the
    original operation's content-addressed id. The log always stores the
    canonical operation; only the materialized row reflects merged values.
  - **Insert collisions.** A remote insert targeting an existing record id no
    longer crashes with a primary-key violation (or silently drops the merged
    result on a timestamp tie) — it resolves per-field like an update, with
    `createdAt` converging to the max insert wall time.
  - **Deterministic add-wins ordering.** Concurrent array edits previously
    converged on membership but diverged on element ORDER across devices
    (local-before-remote ordering flips per device). Additions now order
    deterministically, so merged arrays are byte-identical everywhere.
  - **Transaction serialization.** The better-sqlite3 adapter serializes async
    transactions through a mutex, eliminating nested-BEGIN collisions that could
    silently drop a relayed operation applied during a local write.
  - **Atomic increment composition.** Concurrent `op.increment` updates now
    compose to the sum of both deltas through the real sync path (previously one
    side's delta could be lost to last-write-wins, and the merge engine's
    synthetic local operation carried the REMOTE op's intent metadata, doubling
    the remote delta whenever atomic composition ran).
  - **Out-of-order delivery.** An update or delete delivered before its insert
    (reordering transports) no longer vanishes from the materialized row: when
    the insert lands, already-logged operations for that record are folded in
    timestamp order inside the same transaction, matching in-order devices
    exactly. Ops tables gained a `record_id` index to keep record-scoped
    lookups fast.

  Clock rebases re-stamp per-field versions, and backups round-trip them, so
  field-level LWW stays correct across clock corrections and restores.

- Multi-tenant sync guardrail, and keep the Node SQLite adapter out of browser bundles.

  - `@korajs/server` now warns (once per auth provider) when an authenticated session resolves to no sync scopes at all. With a real auth provider configured, "no scopes" means every user syncs every other user's data, so this surfaces a silent cross-tenant exposure. The warning is intentionally skipped for local-first apps (no auth provider) and for `NoAuthProvider` (dev/testing), where unscoped sync is the intended behavior. The message is explicit that declaring `sync` rules in the schema is not sufficient on its own: the per-user scope values must come from the auth provider (for example `KoraAuthProvider`'s `resolveScopes`).
  - `korajs`'s adapter resolver no longer lets the Node-only `better-sqlite3` adapter branch get pulled into browser bundles. The dynamic import specifier is now assembled at runtime so bundlers cannot statically follow it, while remaining a real `import()` that still resolves under Node and test runners. Previously a browser build of an app using `korajs` would drag `better-sqlite3` and its native bindings into the graph, forcing apps to add a manual alias/shim to exclude it.

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @korajs/store@1.0.0-beta.0
  - @korajs/core@1.0.0-beta.0
  - @korajs/merge@1.0.0-beta.0
  - @korajs/sync@1.0.0-beta.0
  - @korajs/devtools@1.0.0-beta.0
  - @korajs/react@1.0.0-beta.0
  - @korajs/vue@1.0.0-beta.0
  - @korajs/svelte@1.0.0-beta.0

## 0.6.1

### Patch Changes

- Updated dependencies [5d2afa8]
  - @korajs/react@0.6.1
  - @korajs/sync@0.6.1
  - @korajs/svelte@0.6.1
  - @korajs/vue@0.6.1

## 0.6.0

### Minor Changes

- Public beta 0.6.0: Vue 3 and Svelte 5 bindings with shared QueryStore, sync-status controller, and richtext controller; `@korajs/core/bindings` shared types; `@korajs/auth` org hooks and providers for React/Vue/Svelte; presence/collaboration hooks; CLI scaffolds; `korajs/vue` and `korajs/svelte` meta-package re-exports; Svelte component precompile and KoraProvider context bridge fix.

### Patch Changes

- Updated dependencies
  - @korajs/core@0.6.0
  - @korajs/devtools@0.6.0
  - @korajs/merge@0.6.0
  - @korajs/react@0.6.0
  - @korajs/store@0.6.0
  - @korajs/svelte@0.6.0
  - @korajs/sync@0.6.0
  - @korajs/vue@0.6.0

## 0.5.0

### Minor Changes

- b909e5a: v0.5 internal beta: structured apply results and sync apply-failure events, audit trace export, benchmark gates in CI, release-gate script, and E2E fixture hardening (SQLite worker + local multi-tab Playwright project).

### Patch Changes

- Updated dependencies [b909e5a]
  - @korajs/core@0.5.0
  - @korajs/store@0.5.0
  - @korajs/merge@0.5.0
  - @korajs/sync@0.5.0
  - @korajs/devtools@0.5.0

## 0.4.0

### Minor Changes

- ff155cd: Add framework enhancements and 9 completeness features

  **Phase 1-5 features:**

  - `op.increment()`, `op.decrement()`, `op.max()`, `op.min()`, `op.append()`, `op.remove()` — atomic field operations
  - `t.number().merge('counter')`, `.merge('max')`, `.merge('min')`, `t.array().merge('append-only')`, `.merge('server-authoritative')` — schema-level merge strategies
  - `app.transaction()` and `app.mutation()` — atomic multi-collection operations
  - `app.sequences.next()`, `.current()`, `.reset()` — offline-safe formatted sequences
  - `buildScopeMap()` — sync scope computation from schema
  - `migrate()` / `MigrationBuilder` — programmatic schema migration builder
  - `@korajs/test` — testing harness with `createTestNetwork()`, `TestDevice`, `expectConverged()`

  **Framework completeness features:**

  - E2E sync encryption (AES-256-GCM, PBKDF2 key derivation)
  - Bloom filter subscription optimization for high-volume reactive queries
  - Referential integrity enforcement during merge (cascade, set-null, restrict)
  - Sync diagnostics and metrics (bandwidth estimation, RTT tracking, percentiles)
  - Migration rollbacks with auto-generated inverse steps
  - Sync scope filtering for operation-level access control
  - State machine constraints on enum fields with `.transitions()` API
  - Awareness/presence protocol with `usePresence()` and `useCollaborators()` React hooks
  - Protobuf code generation from schema definitions

  **Fixes:**

  - Resolved all biome lint errors across the entire codebase

### Patch Changes

- Updated dependencies [ff155cd]
  - @korajs/core@0.4.0
  - @korajs/store@0.4.0
  - @korajs/merge@0.4.0
  - @korajs/sync@0.4.0
  - @korajs/devtools@0.4.0

## 0.3.5

### Patch Changes

- d6f6289: fix: use @vite-ignore dynamic import for @korajs/tauri instead of new Function to resolve module URL errors in Tauri webview context

## 0.3.1

### Patch Changes

- fix(server): use BIGINT for PostgreSQL timestamp columns to prevent overflow

  - **server**: Fixed critical bug where PostgreSQL `INTEGER` columns overflowed for millisecond timestamps (wall_time, received_at, last_seen_at). Now uses `BIGINT`.
  - **server**: Added `/health` endpoint to production server.
  - **auth**: Added `UserStore` interface with `createSqliteUserStore` and `createPostgresUserStore` factory functions.
  - **core**: Added `sync:auth-failed` event for detecting stale auth tokens.
  - **sync**: Sync engine now emits `sync:auth-failed` when the server rejects authentication.
  - **cli**: Added AWS ECS Fargate and Lightsail Container deploy adapters.
  - **cli**: Docker builds now use `--platform linux/amd64` for Apple Silicon compatibility.
  - **cli**: Lightsail adapter forwards `DATABASE_URL`, `AUTH_SECRET`, `PUBLIC_URL` environment variables to containers.
  - **cli**: Fixed trailing slash in Lightsail URLs causing double-slash in sync endpoint.

- Updated dependencies
  - @korajs/core@0.3.1
  - @korajs/sync@0.3.1
  - @korajs/devtools@0.3.1
  - @korajs/merge@0.3.1
  - @korajs/store@0.3.1

## 0.3.0

### Patch Changes

- 6a05e88: Performance: Replace O(n²) topological sort with binary heap in @korajs/core (19x faster sync for large operation sets).

  New: @korajs/auth package with sessions, TOTP MFA, organizations, RBAC, passkeys, encrypted tokens, and E2E operation encryption (912 tests).

  New: Full Preact-based DevTools UI panel with sync timeline, conflict inspector, operation log, and network status.

  Docs: Comprehensive documentation refinement — added API references for merge, sync, auth, and devtools; added authentication guide; expanded sync configuration guide; updated all package descriptions.

- Updated dependencies [6a05e88]
  - @korajs/core@0.3.0
  - @korajs/devtools@0.3.0
  - @korajs/store@0.3.0
  - @korajs/merge@0.3.0
  - @korajs/sync@0.3.0

## 0.1.2

### Patch Changes

- Fix template path resolution in create-kora-app and add package READMEs
- Updated dependencies
  - @korajs/core@0.1.2
  - @korajs/store@0.1.2
  - @korajs/merge@0.1.2
  - @korajs/sync@0.1.2
  - @korajs/devtools@0.1.2

## 0.1.0

### Minor Changes

- Initial release

### Patch Changes

- Updated dependencies
  - @korajs/devtools@0.1.0
  - @korajs/merge@0.1.0
  - @korajs/store@0.1.0
  - @korajs/core@0.1.0
  - @korajs/sync@0.1.0
