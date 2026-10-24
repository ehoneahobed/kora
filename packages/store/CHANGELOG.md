# @korajs/store

## 1.0.0-beta.15

### Minor Changes

- 24f5531: Scope grants may be disjunctive: a collection scope is a conjunction of field predicates or `{ $or: [conjunction, ...] }` (up to 8 branches), so "my own records OR records in spaces I belong to" is one grant. Every decision (delivery, live relay, scope snapshots, uploads, reference checks, route queries, presence partition keys, the client's upload pre-check and local scope narrowing) goes through one matcher in `@korajs/core`, which fails closed on any malformed scope. Equivalent grants normalize to one canonical form; a handshake can only narrow each branch. First step of the beta.15 access rules.

  Clients now declare `supportsScopeDisjunction` at handshake. A server refuses a client that does not (Kora beta.14 and earlier) with `CLIENT_TOO_OLD` when its resolved grant contains a disjunction, because an older client would read `$or` as a field name and treat every record as outside its scope. Grants without `$or` are unaffected.

  A grant whose field predicate is an object other than exactly `{ $in: [...] }` (for example `{ $in: [...], $ne: ... }` or `{ $ne: ... }`) is now refused at handshake (`SCOPE_PREDICATE_LIMIT`) instead of being normalized to its `$in` part.

  With a disjunctive upload grant, a write must keep the record in every branch it matched before: a team member cannot move a shared record out of the team into their own branch (moving between branches is a server write). A `null` or non-object collection grant now denies that collection instead of being read as `{}`, and grant normalization keeps `0`, `-0`, `NaN` and `±Infinity` distinct.

- 946dd42: With `experimentalAccessRules`, the download stream follows membership changes. When a session's stream reaches a change to the user's memberships, it re-reads them and sends what changed as one re-scope unit at that delivery sequence, starting a batch: a narrowing (the grant now in force per access collection, new `accessNarrowing` batch field) that the client applies to the records it holds, judged on its own values and keeping records with unsent writes, then scope entries (current values) for records the user may now read, filtered by the client's query view. Narrowing on the client removes records that moved or were deleted while the user was revoked, which the server cannot name. A group revoked and granted again, or a membership whose role changed in place since the client's watermark (tracked by a new `role_seq` index column, added to existing databases on open), is re-sent in full. History is gated by the open membership interval: a late joiner receives a group's current state, never the operations written before they joined, on a live session, a reconnect and a fresh device alike. What a reconnecting client holds is rebuilt from the membership intervals at its watermark, so a reconnect after changes made while offline resumes from the watermark. Access collections are reported to clients as unrestricted, so a client's view and its watermark stay the same across membership changes; the server alone enforces the grant. Records leaving an access collection's grant are always retracted. The delivery poll refreshes each session's memberships, so rich-text, presence and blob channels follow a change within one poll interval even when a client's stream is not progressing. `server.access.grant` no longer writes `expiresAt` when the memberships collection does not declare it.

  Rule types (`OwnerRule`, `MemberRule`, `OrRule`, ...) are exported from `@korajs/core` and `korajs`, so a schema module with declaration emit can export a schema that uses access rules.

  `@korajs/sync` applies a batch's `accessNarrowing` before its retractions and operations (`SyncStore.applyCollectionNarrowing`, implemented by `@korajs/store`); a failure stalls the delivery watermark so the batch is re-sent.

  A device keeps the key of the read rules it was last fully re-scoped under (`accessRulesKey`, sent at the handshake and carried by the batch that re-scopes it); a server running other read rules (a deploy, or another instance mid-rollout) narrows every access collection and sends everything it may read again, and a collection whose rules were dropped is re-sent under the session's own scope. Index reconciles, which write no operation, take a delivery sequence of their own, and the stream advances caught-up clients past it. When a client's own accepted write leaves an existing record outside what it may read (a write rule broader than the read rule), the server retracts that record from the client; records the client created stay. Records a narrowing kept for unsent writes are remembered on the device and removed once those writes are refused, unless the server sent them again meanwhile.

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

- 95f5a26: `useMutation` reports writes the sync server refuses. In React, Vue and Svelte, `useMutation(fn, { onRejected })` and a `rejected` state (`{ code, message, collection, recordId, operationId, operationIds, reverted, args }`) tell the component that made a write when the server permanently refuses it, even hours later after an offline period, so an app can show "this change was undone, and why" without listening to sync events. One `mutate()` call is one write: every operation it committed, including a delete's cascades and a whole `app.transaction()`; it is reported once. `reverted` is false only for the refusals the device keeps locally (`OUT_OF_UPLINK_SCOPE`, `NODE_ID_MISMATCH`, `SEQUENCE_CONFLICT`). Retriable rejections are not reported. A hook reports nothing after it unmounts, and tracks at most 500 unsynced writes; the app-level `sync:operation-rejected` event and `app.sync.getRejectedOperations()` still report every refusal. Tracking needs `<KoraProvider app={app}>`. Svelte's mutation also gains `subscribeRejected(fn)`.

  Two new sync events support it: `sync:operations-acknowledged` (`operationIds` the server stored) and `sync:operations-rewritten` (`reason`, `idMapping`: unsent operations re-authored under new ids by a clock rebase, a node-id rotation or a sequence renumbering).

### Patch Changes

- a5c61ff: Retractions apply in stream order within a delivery batch. A client applied every retraction of
  a batch before the batch's operations, so a record that entered the device's view and left it
  again within one batch (inserted, then moved out of scope) was retracted before its insert and
  then materialized: the device kept a record outside its view. This affects access-rule
  collections and `scopeExit: 'retract'`.

  - Each retraction now carries `afterOperations`, its position among the batch's operations, and
    the client applies operations and retractions in that order. The client declares this with
    `orderedRetractions` in its handshake.
  - For a client that does not declare it, the server cuts the delivery batch (and splits a relay)
    before a retraction whose record has an earlier operation in it, so older clients converge
    too.
  - A retraction without a position (from an older server) still applies before the operations.
  - A retracted record's visibility follows delivery order. Delivery batches carry each
    operation's delivery sequence and each retraction's; whichever is later, the record's latest
    delivered operation or its latest retraction, decides. A quarantined insert (undecryptable,
    no schema transform yet, a far-future timestamp) replayed after its record's retraction stays
    hidden, a duplicate re-delivery of an earlier operation does not show it, and any operation
    delivered after the retraction shows it again (`@korajs/store`, `@korajs/sync`).
  - An insert onto an existing record (an explicit-id server write) now enters and leaves a
    device's view like an update: it gets a scope entry, or a retraction. Before, a record moved
    out of scope by such an insert was never retracted.
  - For a client without the delivery watermark, a relay that retracts a record is sent only
    after every earlier relay carrying an operation of that record is acknowledged. A client that
    stops acknowledging is disconnected; its relays go to the bounded per-instance re-relay
    buffer.

  Devices that already kept such a record are not repaired by re-scoping: the access narrowing,
  a rules change and the `scopeExit: 'retract'` handshake narrowing all judge the record by the
  values the device holds, which are its last in-scope values. Replaying the delivery stream from
  watermark 0 against an upgraded server repairs them. The new
  `KoraSyncServer.forceFullResync({ userId })` (or `{ nodeId }`) does that for already-shipped
  watermark clients (1.0.0-beta.5 and later): their next handshake restarts delivery from 0, and live
  sessions reconnect at once. It completes per delivery view, so a device with several scopes or
  query-subset views restarts each one when it next streams under it. It needs a store that
  implements `requestFullResync`, `getFullResyncState` and `completeFullResync` (all built-in stores
  do); a custom store missing any of them is refused with `FULL_RESYNC_UNSUPPORTED`.

- fa1a971: A follower tab no longer declares a live leader tab absent without asking it. The liveness watchdog now pings the leader as soon as a request starts waiting without a recent sign of life, and on every quiet tick; before, a timer tick that fired a millisecond early skipped the only ping, so the next tick failed the request with a retriable `NoLeaderError` while a healthy leader was open.
- c5ef367: IndexedDB fallback: snapshots saved from two tabs can no longer overwrite each other out of order, and `ensureDurable()` no longer resolves for a write that was lost. Every tab persists the same leader-owned SQLite database, but each tab's save was an unconditional put, so a follower's snapshot taken earlier could reach IndexedDB after a newer one and replace it; a write whose `ensureDurable()` (or `flushPersistence()`) had already resolved was then missing after a reload.

  - Every in-memory worker database is a lineage: when it starts (first open, reload, leader promotion), one IndexedDB `readwrite` transaction claims an epoch higher than every earlier one, reads the snapshot it restores from, and stores a fence version for it. A commit counter in the database counts its write transactions and is read in the same transaction as the snapshot data.
  - Saves are a compare-and-put: one IndexedDB `readwrite` transaction stores the JSON dump, the binary image and the version together only when the snapshot is newer. A snapshot the stored one already covers is skipped. One from a replaced worker database (taken before a leader change, or before the database was deleted) is refused with a `PersistenceError` whose `context.code` is `SNAPSHOT_SUPERSEDED`, reported on `store:persistence-error` with `code: 'SNAPSHOT_SUPERSEDED'`.
  - `ensureDurable()` is tied to the worker database each write was made in. It resolves only when a saved snapshot of that database holds the write (a save by another tab counts). When that database was replaced before such a snapshot was saved, the write is gone and the barrier rejects with `SNAPSHOT_SUPERSEDED` instead of resolving on the new database's snapshot.
  - A snapshot transaction that aborts at commit (for example a quota failure while writing to disk) now rejects with a `PersistenceError` instead of leaving later flushes and barriers waiting forever.
  - Deleting the database keeps its epoch counter, so a tab that resumes after the delete can never save over a recreated database. The delete removes everything else it wrote and writes nothing; opening writes only the small version records, never a copy of the data.
  - A lost write stays lost for the tab's session: every later `ensureDurable()` of that tab rejects with `SNAPSHOT_SUPERSEDED` (it still covers the lost write) instead of only the first one, so sync keeps uploading in its degraded mode. A reload opens the database in a new lineage and starts clean; no new API is needed.
  - Only transactions that changed the database count as writes. A read-only `transaction()` (a backup snapshot, a fold-state read) gets no commit count and schedules no snapshot, so it can never be reported lost across a leader change.
  - A tab's unsaved writes keep their proof of being saved however many leader changes follow: the stored ancestry keeps the 32 most recent lineages plus every older one a live tab still has unsaved writes in (each tab pins those lineages and the one it writes in now in a small `::pins` record, rewritten only when that set changes and released when the adapter closes; at most 64 tabs' pins are kept).
  - `execute()` and `migrate()` run the write and its commit count in one transaction span. With the multi-tab transaction isolation fix, a storage leader change in between fails the call with a retriable `BridgeTerminatedError` instead of counting the write under the new leader's database.

  Snapshots written by earlier releases (no version) load as before and are replaced by the next save; a worker database opened by an earlier release in another tab is versioned on its first save from this release. The ordering guarantee holds once every open tab runs this release: a tab still running an earlier build saves without comparing versions, and can still overwrite a newer snapshot while it stays open during a deployment (addressed by the version gate planned for 1.0.0-beta.15, `docs/design/version-gate.md`). OPFS and native SQLite storage are unchanged.

- d19c7f7: Multi-tab storage: a transaction span stays exclusive until its owner commits or rolls back. Before, an error inside a tab's transaction released the span while SQLite's transaction was still open, so another tab's write could run inside it, be acknowledged, and then be rolled back. A follower tab's transaction is now bound to the leader worker that answered its BEGIN. If the leader changes mid-transaction, the rest of it is refused with a retriable `BridgeTerminatedError` instead of autocommitting statement by statement on the new leader's worker.
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

- 0388bd7: Version gate, stage 1 (`docs/design/version-gate.md`): one build of an app writes a browser database at a time. When a tab running a newer build opens, every tab of an older build stops writing before the newer tab writes, and no write a stored snapshot confirmed (IndexedDB fallback) or that committed (OPFS) is lost.

  - Every tab declares `{ build, format, openSeq, tabId }` and holds a Web Lock named after it (`kora-tab:<db>:<identity>`) for its life; `navigator.locks.query()` is the roster, so silent followers and tabs that have not processed a message are seen. `openSeq` comes from an IndexedDB counter (`kora-gate`), never the clock. The ordering key is `(format, openSeq)`.
  - A tab retires when it learns of a tab of another build with a higher key (discovery, a `kora-build-hello`, or the leader heartbeat, which now carries the leader's identity): it refuses new writes with `BuildSupersededError` (`code: 'BUILD_SUPERSEDED'`, retriable, carries `collection` and `operation`, never data), waits for every write it started, makes them durable (IndexedDB fallback: a failed barrier keeps the tab lock and retries; `SNAPSHOT_SUPERSEDED` does not hold it; from the moment retirement starts, `close()` first waits for admitted writes and saves them with the throwing barrier, and is refused with `PersistenceError` `context.code: 'UNSAVED_WRITES'` when that fails, instead of handing the database over without them; `Store.prepareClose()` runs that check), gives up its storage roles (a leader first waits for its old-build followers to retire, then stops its worker; a follower withdraws its queued promotion) and releases its tab lock. Reads keep working through the newer build's leader. A retiring fallback tab with no storage worker left (its leader closed) settles its writes against the stored snapshot version, read from IndexedDB without a worker. Inbound delivery batches (`Store.applyRemoteBatch`) go through the same write gate: a retired tab applies none.
  - A tab opens storage only when no tab of another build with a lower key holds its tab lock, and no storage leader of another build is alive (the leader marker carries the leader's identity, `kora-gated-leader-id:<db>:<identity>`, so a leader whose tab lock is gone is still waited for); there is no deadline. After 10 s it reports `store:build-gate-waiting` (`reason: 'live-writer' | 'unsaved-writes' | 'legacy-build'`). A tab granted the leader lock checks the roster first and releases it unopened when a newer build is listed, so an old-build worker never starts after a newer tab appeared.
  - Page lifecycle: on `freeze` / bfcache `pagehide` a tab releases its storage roles, then its tab lock, as before the gate (the IndexedDB fallback included: writes after its last stored snapshot are lost if another tab takes over, reported as `SNAPSHOT_SUPERSEDED`). A tab still opening, promoting or closing keeps both. A tab resuming after a newer build opened never re-attaches: requests queued behind its suspension fail retriably and it retires.
  - Missing coordination APIs fail closed: without `BroadcastChannel`, one tab at a time (`kora-db:<db>`, `store:tab-exclusive`); without Web Locks in a secure context (an old browser), storage open refuses with `TabCoordinationUnavailableError` unless `allowUncoordinatedTabs` is set. On plain HTTP (not HTTPS, not localhost) browsers expose no Web Locks: there the gate does not apply, as before it, with one console warning (serve over HTTPS or localhost to turn it on). Outside a browser page the gate does not apply.
  - Kora storage format `1` (`KORA_STORAGE_FORMAT`): stored once in `_kora_meta('storage_format')` and in the IndexedDB snapshot version record, never written by older code. A newer stored format refuses the open (`StorageFormatAheadError`, `store:format-ahead`) before any DDL or write (`--kora:format-ceiling` DDL directive).
  - A leader running a pre-gate build is detected by the gated-leader marker lock it does not hold; the newer tab waits for its leader lock (`store:legacy-build-detected`). Builds without a build id fall back to a schema fingerprint (`store:build-unidentified`).
  - New: `VersionGate`, `Store.trackWrite()`, `StorageAdapter.getVersionGate()`, adapter options `versionGate`, `build`, `allowUncoordinatedTabs`, and events `store:format-ahead`, `store:build-gate-waiting`, `store:build-unidentified`, `store:legacy-build-detected`, `store:tab-exclusive`, `store:tab-coordination-unavailable`.

- 68cbb70: Version gate, stage 2: the app API. `createApp({ build })` names the deployment (otherwise the build id the `@korajs/cli/vite` plugins inject, read from `globalThis.__KORA_BUILD__` or `<meta name="kora-build">`; never the package version). In a browser, createApp creates the database's version gate and:

  - announces supersession with `app:build-superseded` (`{ currentBuild, newerBuild, preventDefault() }`) before any write is refused, then shows "A new version of this app is available. Reload to continue." with a Reload button, unless a listener called `preventDefault()`, the app set `store.onBuildSuperseded`, `store.buildPrompt` is false, or the app handles the offline shell's `kora:update-available` event (reused for this prompt);
  - shows "Your latest changes are not saved yet. Retry, or Export them." with Retry and Export (a JSON download of the in-memory database) while a failed IndexedDB barrier holds retirement, naming the reason when it is known (`QUOTA_EXCEEDED`: storage is full; `STORAGE_UNAVAILABLE`: no storage worker left), and waiting / other-tab messages in a tab whose gate is closed; from the moment retirement starts, `app.close()` saves every admitted write first and is refused (`PersistenceError`, `context.code: 'UNSAVED_WRITES'`) before anything is torn down when that fails;
  - stops sync as a retirement step: the engine is destroyed (a permanent fence: an auth reconnect or a `connect()` already in flight never opens a session or touches persisted sync state), and retirement waits (bounded) for those attempts before releasing the tab lock; inbound operations refused meanwhile stall without a `sync:apply-blocked` report. Every sync API that connects or changes persisted sync state (`connect`, `reconnect`, `retryNow`, `setQuerySubsets`, `clearRejectedOperations`, `assignHeld`, `discardHeld`) then refuses with `BuildSupersededError`; `app.sync.connect()` and `reconnect()` then refuse with `BuildSupersededError`, and no automatic reconnect starts. Queued operations stay in the outbound queue and the new build uploads them;
  - refuses blob writes (`app.blobs.put`, `delete`, `pull`, `gc`, and `put` / `delete` on `app.blobs.store`) like every other write.

  New: `app.reloadForNewBuild()` (emits `app:before-build-reload` synchronously; under the offline shell it checks for (within 10 s) and activates the newer build's waiting service worker, `KORA_SW_SKIP_WAITING`, and reloads on `controllerchange`; it never reloads under the worker that served the page's own build: when no newer worker is ready (offline, a failed update) it resolves false and the prompt offers Try again; otherwise a plain reload), `store.onBuildSuperseded`, `store.buildPrompt`, `store.allowUncoordinatedTabs`, exports `BuildSupersededError`, `StorageFormatAheadError`, `TabCoordinationUnavailableError`. `BUILD_SUPERSEDED` is a local refusal: it is a mutation's `error`, never its server `rejected` state. A storage format or schema ahead, a superseded tab and missing Web Locks are never answered with an in-memory database. On plain HTTP (not HTTPS, not localhost) the gate is off, as before it, with one console warning. A failed initialization whose cleanup close is refused with `UNSAVED_WRITES` keeps the gate (the retirement releases it once the writes are saved).

- Updated dependencies [24f5531]
- Updated dependencies [6c72c04]
- Updated dependencies [6fd998a]
- Updated dependencies [946dd42]
- Updated dependencies [8667762]
- Updated dependencies [003d7bf]
- Updated dependencies [0b461fa]
- Updated dependencies [8411be3]
- Updated dependencies [714ebd2]
- Updated dependencies [180923d]
- Updated dependencies [95f5a26]
- Updated dependencies [89cb4c4]
- Updated dependencies [0b461fa]
- Updated dependencies [b378fb9]
- Updated dependencies [0388bd7]
- Updated dependencies [68cbb70]
- Updated dependencies [df7a430]
- Updated dependencies [b7f964a]
  - @korajs/core@1.0.0-beta.15

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
- 99cedc4: Smaller fixes from the beta.13 rollout:

  - `defineSchema` refuses a unique or capacity constraint whose `where` holds an operator object,
    an array, or an unknown field: none could ever match, so the constraint was silently disabled
    (F2).
  - `PostgresUserStore.close()` ends the connections of a store made by `createPostgresUserStore`,
    so scripts exit (F11).
  - `/health` and `getStatus()` report the real `@korajs/server` version instead of
    `1.0.0-beta.0` (F13).
  - A `sqlite3.wasm` download or compile failure fails the store open within seconds with a
    `WorkerInitError` naming the binary, instead of waiting out the 60-second init timeout, and a
    failed SQLite load is not cached, so the next open tries again (F15).
  - `undefined` inside a `t.json()` value is written the way JSON writes it (a member is absent, an
    array element is `null`), as the server already stored it, instead of failing the write on the
    device (F12a).

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
- a0965d3: Rich-text controller never drops local edits. Saves write the full live Y.Doc instead of a base
  snapshot plus tracked deltas, so a stored change arriving during the save debounce no longer
  discards the waiting typing. A refused save keeps the edits in the document; the next edit or the
  new `retrySave()` saves them, and the first successful save clears `error`. Edits still waiting
  when the editor is destroyed are saved. New `hasUnsavedChanges` and `getUnsavedState()` (for a
  recovery copy) on the controller and on `useRichText` in React, Vue and Svelte. Saves run one at
  a time.
- 88654fa: A browser two users share can no longer store one user's writes as the other's (F9). While the
  store's pinned node id (the auth device id) belongs to another user than the one signed in, a
  cached session of the second user, local writes throw `NodeOwnedByAnotherUserError`
  (`NODE_OWNED_BY_ANOTHER_USER`) instead of landing under the owner's node, from which they would
  later upload as the owner's. Transactions also honour a configured `maxOperationBytes` now
  (they used the default).
- Updated dependencies [99cedc4]
- Updated dependencies [4ec1bc5]
  - @korajs/core@1.0.0-beta.14

## 1.0.0-beta.13

### Major Changes

- **Breaking.** One write path reserves sequence numbers inside the commit (single writes,
  transactions, cascades); duplicate sequence numbers from beta.12 are repaired on first open.
- No silent in-memory fallback: without durable storage, writes are refused
  (`StorageDurabilityError`, `store:durability-lost`) unless `allowNonDurable` is set.
- Each OPFS database has its own `opfs-sahpool` pool under a Web Lock and uses SQLite's rollback
  journal; a hung or frozen leader tab is replaced; every change reaches other tabs' live queries.
- Records are materialized with the core fold and re-materialized once on upgrade
  (`store:rematerialized`); stores refuse to open when a logged schema version has no transform
  path (`OPERATION_TRANSFORM_MISSING`) or the database is newer than the code
  (`SchemaVersionAheadError`).
- Queries are injection-safe (whitelisted `orderBy` direction, bound `limit`/`offset`, quoted DDL
  literals); `where` treats `undefined` as no condition, `null` as `IS NULL` and refuses
  `NaN`/`Infinity`; one canonical `queryKey`; reactive queries diff results and report errors
  (`subscribe(cb, { onError })`, `query:error`).
- beta.12 enum `CHECK` / `NOT NULL` constraints are relaxed once; backup format 2 restores exactly
  (`convertBackupV1` for older backups); `OperationTooLargeError` is thrown before anything is
  written.
- Security fixes are described in the [security advisory](https://github.com/ehoneahobed/kora/blob/main/docs/releases/security-advisory-beta13.md).

See the [1.0.0-beta.13 release notes](https://github.com/ehoneahobed/kora/blob/main/docs/releases/v1.0.0-beta.13.md) and the [upgrade guide](https://github.com/ehoneahobed/kora/blob/main/docs/guide/upgrading-to-beta13.md) (servers first, then clients).

### Patch Changes

- Client stores keep hand-written CHECK constraints when relaxing beta.12 enum checks.

## 1.0.0-beta.12

### Minor Changes

- Add local-view retraction and scope-narrowing materialization support.

## 1.0.0-beta.9

### Patch Changes

- b657130: Harden the framework paths surfaced by production-style E2E usage.

  - Fix generated app templates so auth routes proxy correctly, dev database writes do not trigger Vite full reloads, and cross-origin isolation can be configured for embedded media.
  - Keep React auth subscriptions stable through StrictMode remounts, and keep `useQuery` from transiently reporting an empty result while a replacement query subscription is still settling.
  - Add query-store snapshot readiness so adapters can distinguish "not emitted yet" from an authoritative empty result.
  - Serialize `json`, `object`, and `blob` fields during server materialization, and fail loudly instead of acknowledging an operation whose persistence failed.
  - Serialize sync start/stop transitions and retry pending outbound operations when an auth/session transition leaves the connection idle.
  - Register broad and unsupported-only live queries as collection-wide sync subsets, so mixed narrow and `where({})` subscriptions cannot starve admin-style broad views.
  - Invalidate a client's delivery watermark when the server resolves a different authoritative scope than the client requested, forcing a scoped backfill instead of skipping operations hidden under the old view.
  - Treat retryable per-operation rejections as unacknowledged on the client, and have the server acknowledge only through the last safely processed operation. Stale-scope pushes now remain queued for rescope/retry instead of being silently dropped.
  - Make delivery-stream retransmission stale-aware so slow or large server-to-client batches are not re-sent on every retry tick while the original ack is still in flight.
  - Add a serialized `sync.reconnect()` control and use it for auth-driven scope refreshes and query-subset reconnects, avoiding app-level disconnect/connect races during permission changes.
  - Load local `.env` files in `kora dev` and generated sync servers before auth/server setup, so first-run auth configuration mounts consistently whether the app is started by the CLI or the server is run directly.
  - Update generated template docs to use `/kora-sync` WebSocket endpoints for `VITE_SYNC_URL`, avoiding noisy root-path WebSocket retries from copied defaults.
  - Pin `create-kora-app` template dependencies to the exact Kora prerelease when the CLI itself is a prerelease, avoiding accidental stable-range resolution or split beta installs.
  - Improve JSON schema validation errors by reporting the exact invalid nested path, including `undefined`, non-finite numbers, and circular objects.
  - Fix IndexedDB fallback persistence so logical dumps are durable when binary SQLite export is unavailable, stale binary snapshots cannot shadow newer dumps, and dump-only databases restore correctly.
  - Allow production server COEP policy configuration and document route access to the owned Kora data plane.

- Updated dependencies [b657130]
  - @korajs/core@1.0.0-beta.9

## 1.0.0-beta.6

### Minor Changes

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

## 1.0.0-beta.6

### Minor Changes

- Retire SharedWorker-hosted SQLite as a durable storage path. OPFS
  SyncAccessHandle is dedicated-worker-only in browsers, so Kora now uses the
  dedicated-worker leader/follower path as the single durable multi-tab SQLite
  WASM path. `sharedWorkerUrl` is deprecated and ignored.

- When OPFS SyncAccessHandle cannot be acquired, `createApp()` now falls back to
  the durable IndexedDB adapter before app code observes the store. Kora emits
  `store:storage-fallback` for this recovered state. `store:opfs-unavailable` is
  reserved for the last-resort case where both OPFS and IndexedDB are unavailable
  and the app is running in memory.

- Multi-tab local storage now serializes worker access across complete
  transaction spans at the leader boundary, preventing concurrent leader and
  follower writes from interleaving between `begin` and `commit`. The serializer
  also reclaims abandoned follower spans with an inner-worker rollback, so a tab
  closing mid-transaction cannot freeze the shared local database. The idle
  backstop defaults to 10s.

- Same-origin app instances using the same local database now receive local
  operation invalidations over a database-scoped channel, so reactive queries in
  already-open sibling tabs update without network sync.

## 1.0.0-beta.5

### Minor Changes

- Harden multi-tab SQLite WASM storage coordination.

  - Fix a response mis-correlation bug in the SharedWorker host: it correlated the
    inner worker's replies by `request.id`, which is `0` for every request from
    every tab, so overlapping requests could resolve each other's responses. The
    host now mints a unique inner id per request and correlates on it. The routing
    core is extracted as `createSharedWorkerHost` and unit-tested for concurrency.
  - Add leader liveness and a readiness handshake to the leader/follower fallback:
    the leader relay answers `ping` with `pong`, followers expose `waitForLeader()`
    so a follower opened during a leader's startup race retries the handshake instead
    of firing into the void, and a stalled follower RPC now fails fast with
    `NoLeaderError` when the leader is confirmed absent instead of waiting out the
    full timeout.
  - Add automatic failover: a follower queues a blocking lock request and, when the
    previous leader releases the storage lock (its tab closed or crashed), is promoted
    to leader and rebuilds its own worker (safe under the OPFS single-writer rule
    because the lock is only granted once the old leader is gone).

- Fix the SharedWorker storage path, which previously hung forever on `open` (so
  `app.ready` never resolved).

  Two real bugs plus a browser limitation, all found by reproducing in headless
  Chromium:

  - The host tried to spawn a nested dedicated `Worker` inside the SharedWorker, but
    `Worker` is not defined in `SharedWorkerGlobalScope` in Chromium. The SQLite
    logic is now extracted into a reusable core (`createSqliteWasmCore`) that the
    SharedWorker host runs directly in its own scope, one core per `dbName`. The
    dedicated worker uses the same core. This also removes the inner-id correlation
    bookkeeping, since each request is answered by a Promise from the core.
  - The client created `new SharedWorker(url, { name })` without `{ type: 'module' }`.
    The host is an ES module, so a classic SharedWorker could not parse it and failed
    silently. It is now created as a module worker.

  Browser limitation surfaced by this work: OPFS `createSyncAccessHandle` is not
  available in a SharedWorker in Chromium, so the SharedWorker path cannot persist to
  OPFS there. It runs in memory and emits `store:opfs-unavailable`, and the
  dedicated-worker leader/follower path remains the persistent multi-tab default.
  Applications that need offline persistence should use the leader/follower path, not
  the SharedWorker path, on Chromium.

  The SharedWorker host entry must set `__KORA_SQLITE_WASM_URL` (via a `?url` import
  of the sqlite wasm binary) the same way the dedicated worker entry does, so the
  core can locate the hashed WASM asset in production builds.

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

- Fix atomic operations that arrive before their insert (reordered delivery) being
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

- Fix non-deterministic merges of plain-string richtext values, which could diverge
  replicas.

  When a richtext field is set to a plain string (a full replacement rather than a
  collaborative Yjs edit), the merge engine converted it to a Yjs update with a random
  clientId at merge time. Two replicas merging the same values could therefore produce
  different bytes, a non-deterministic merge that never converges.

  A plain-string richtext value is now resolved by last-write-wins (deterministic),
  since a string replacement is not a collaborative edit. The CRDT merge is used only
  when both sides are Yjs byte updates, which carry stable, baked-in clientIds. The
  store also encodes a plain string to richtext bytes with a fixed clientId, so the same
  string materializes to identical bytes on every device.

- Surface SharedWorker inner-worker failures instead of hanging. When the inner
  SQLite worker spawned by the SharedWorker host fails to load or throws at the top
  level (for example the module script or the SQLite WASM binary cannot be fetched
  in the nested worker context), the host now relays a `SHARED_WORKER_ERROR` (or
  `SHARED_WORKER_SPAWN_FAILED` for a synchronous spawn failure) to every waiting
  client and drops the pool so the next request respawns. Previously such a failure
  left `open` (and therefore `app.ready`) hanging until the RPC timeout, with no
  observable error.
- SQL identifiers are now quoted everywhere they are generated, so a collection or
  field name that is valid JavaScript always produces valid SQL. camelCase
  (`formResponses`), PascalCase (`UserProfiles`), and names that happen to be SQL
  reserved words (`order`, `select`) now work end to end across the client store,
  both server stores, migrations, and CLI-generated migration files. Previously a
  camelCase collection was rejected at `defineSchema` and a reserved-word name
  produced a runtime SQL syntax error.

  A new `quoteIdent` helper is exported from `@korajs/core`. Schema validation
  still fails fast for genuinely malformed names (empty, or containing characters
  that are not letters, numbers, or underscores). Existing all-lowercase schemas
  are unaffected: quoting a lowercase identifier is a no-op in both SQLite and
  Postgres.

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
  - @korajs/core@1.0.0-beta.5

## 1.0.0-beta.0

### Minor Changes

- Add a transport-agnostic request/response protocol for pulling blob chunks over any message channel. This is the wire piece that lets a device fetch a blob's content out of band from a peer that holds it (the sync WebSocket in production, an in-memory pair in tests), rather than inlining bytes into the operation stream.

  - `createRemoteChunkProvider(port)` returns a `ChunkProvider` that requests chunks by hash over a `ChunkMessagePort`, correlates each answer to its request by `requestId`, and times a stalled request out (default 30s) so a dropped response cannot hang a transfer. Because transfers are resumable, a timed-out request is simply retried on the next pull.
  - `serveBlobChunks(port, blobStore)` answers incoming chunk requests from a content-addressed store. A chunk the store does not hold (or whose stored bytes fail their integrity check on read) is reported as unavailable rather than crashing the connection, so a corrupt server-side chunk surfaces to the receiver as a missing chunk instead of a silent bad transfer.
  - `createChunkPortPair()` provides a connected in-memory duplex pair of ports with asynchronous (next-microtask) delivery, modeling a real transport for tests.

  Composes with the existing `receiveBlob`/`prepareBlobForSend` resumable transfer: skip-already-staged chunks are never requested, and only missing chunks cross the port.

- Add a `blob` field type backed by a content-addressed store (data model + store core).

  Files no longer belong in the operation log. A `blob` field carries a small content-addressed reference, and the bytes live in a deduplicated, integrity-checked store keyed by their hash.

  - `t.blob()` fields hold a `BlobRef` (`{ hash, size, mimeType?, filename? }`), a hex SHA-256 content address plus metadata. Values persist as JSON (`TEXT`) and converge by last-write-wins on the reference (the bytes are immutable and deduplicated by hash, so the reference is the only thing that can change).
  - `@korajs/core` exposes `hashBlob`, `createBlobRef`, and `isBlobRef` (reusing the same SHA-256 content addressing as operation ids).
  - `@korajs/store` adds a `ContentAddressedBlobStore` interface and a `MemoryBlobStore` backend: `put` deduplicates identical content (stored once, same hash), and `get` verifies the stored bytes hash to the requested key, throwing `BlobIntegrityError` on corruption rather than returning bad data.

  Proven with unit tests (content addressing, dedup, integrity, buffer-isolation) and validated end-to-end through the real store + sync path (a blob reference round-trips through insert and converges under concurrent replacement). The out-of-band, resumable, chunked byte-transfer channel and persistent backends (OPFS, filesystem/S3) build on top of this reference model.

- Add a persistent filesystem-backed blob store (`@korajs/store/blob-fs`).

  `FilesystemBlobStore` implements the `ContentAddressedBlobStore` contract on disk, so blobs survive process restarts instead of living only in memory. It is a node-only subpath export (like the better-sqlite3 adapter) so `node:fs` never enters a browser bundle.

  - Blobs are stored at `<dir>/<hash[0:2]>/<hash>`, sharded by hash prefix so a single directory never holds millions of entries.
  - Writes are atomic (temp file then rename), so a crash mid-write can never leave a partial blob under a hash that readers would then trust.
  - Same content-addressed guarantees as `MemoryBlobStore`: `put` deduplicates identical content, and `get` verifies the on-disk bytes hash to the requested key (throwing `BlobIntegrityError` on corruption). It drops into the blob transfer path (chunk staging, blob destination) unchanged.

- Reclaim storage from blobs no record references any more. Blob bytes are content-addressed and deduplicated, so a blob can outlive the record that created it (and be shared by several records); garbage collection frees the truly orphaned bytes without touching shared ones.

  - `@korajs/store` adds `collectBlobGarbage(store, liveRefs, { dryRun })`, a mark-and-sweep collector. The live set is closed over the reference graph — each live `BlobRef` retains its blob hash, its manifest hash, and every chunk hash the manifest names — so a chunk still referenced by any surviving blob is kept. Mark-and-sweep (not reference counting) is deliberate: it is correct under concurrent edits and CRDT merges, where counts are fragile. The `ContentAddressedBlobStore` interface gains `list()`, implemented by the memory, OPFS, and filesystem stores. `extractBlobRefs(record)` pulls the references out of a materialized record.
  - `korajs`: `app.blobs.gc()` sweeps the local blob store against the live records in every collection that has a `blob` field. `{ dryRun: true }` previews what would be collected. Returns a summary (scanned, live, collected, and the collected hashes).
  - `@korajs/server`: `KoraSyncServer.getLiveBlobRefs()` returns the live references across all server-side records, so a self-hosted server can GC its central blob store by passing them to `collectBlobGarbage`.

  Proven end to end: an orphaned blob is collected after its record is deleted (client and server), a blob is kept while still referenced, and a chunk shared by a surviving blob is never collected.

- Add out-of-band, resumable, chunked blob transfer (the byte-transfer half of the `blob` field).

  Blob bytes move on a dedicated content-addressed channel, not in the operation log, so large files sync without bloating or re-sending the log.

  - `chunkBlob(bytes, chunkSize?)` splits a blob into content-addressed chunks and produces a `BlobManifest` (blob hash, size, ordered chunk hashes, metadata). Identical chunks collapse to one stored entry while the ordered hash list still reproduces the exact bytes.
  - `reassembleBlob(manifest, chunkStore)` rebuilds the blob with integrity checks at both levels: each chunk is verified on read, and the reassembled whole is verified against the manifest's blob hash.
  - `receiveBlob(manifest, provider, { chunkStore, blobStore })` performs a resumable transfer: chunks already staged (from a prior interrupted transfer) are skipped, each fetched chunk is verified to hash to its expected value before staging, and the completed blob is written to the destination store. The transfer is idempotent, deduplicates repeated chunks, and rejects tampered or missing chunks (`BlobIntegrityError`).
  - `prepareBlobForSend(bytes, chunkStore, options?)` stages a blob's chunks and returns a manifest plus a `ChunkProvider` that serves them.

  The protocol is transport-agnostic (proven with an in-memory provider and property-style resumability/idempotency tests). Wiring it onto the live sync connection, plus persistent chunk/blob backends (OPFS, filesystem/S3), is the remaining integration step.

- Pull a blob's bytes knowing only its reference. This closes the last gap in blob sync: a device that receives a `BlobRef` in a synced record can now fetch the bytes with no separate manifest hand-off.

  - `@korajs/core`'s `BlobRef` gains an optional `manifestHash` — the content hash of the blob's chunk manifest. Because it is a content address like `hash`, the manifest is fetched and integrity-verified over the same channel as the chunks. It rides inside the reference that already syncs in the record, so no new protocol or operation-log surface is needed.
  - `@korajs/store` adds `putBlobForTransfer` (stage chunks + store the full blob + store the manifest as its own content-addressed object, returning a ref that carries `manifestHash`), `resolveBlobManifest` / `fetchBlobManifest` (fetch and verify a manifest by hash before pulling), and the canonical `serializeBlobManifest` / `parseBlobManifest`. The manifest is served over the existing chunk channel with no special casing — it is just another content-addressed object.
  - `korajs`: `app.blobs.put` now stores the manifest and returns a ref carrying `manifestHash`, and `app.blobs.pull` accepts that `BlobRef` directly (resolving the manifest by hash) or an explicit `BlobManifest`. The "attach a file, it appears everywhere" path now needs only the reference from the synced record.

  Proven end to end over the live server relay: a blob authored on device A is pulled on device B from the reference alone — B resolves the manifest by `manifestHash`, then fetches only the chunks it is missing and verifies integrity against the blob hash.

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

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @korajs/core@1.0.0-beta.0

## 0.6.0

### Minor Changes

- Public beta 0.6.0: Vue 3 and Svelte 5 bindings with shared QueryStore, sync-status controller, and richtext controller; `@korajs/core/bindings` shared types; `@korajs/auth` org hooks and providers for React/Vue/Svelte; presence/collaboration hooks; CLI scaffolds; `korajs/vue` and `korajs/svelte` meta-package re-exports; Svelte component precompile and KoraProvider context bridge fix.

### Patch Changes

- Updated dependencies
  - @korajs/core@0.6.0

## 0.5.0

### Minor Changes

- b909e5a: v0.5 internal beta: structured apply results and sync apply-failure events, audit trace export, benchmark gates in CI, release-gate script, and E2E fixture hardening (SQLite worker + local multi-tab Playwright project).

### Patch Changes

- Updated dependencies [b909e5a]
  - @korajs/core@0.5.0

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

## 0.3.1

### Patch Changes

- Updated dependencies
  - @korajs/core@0.3.1

## 0.3.0

### Patch Changes

- 6a05e88: Performance: Replace O(n²) topological sort with binary heap in @korajs/core (19x faster sync for large operation sets).

  New: @korajs/auth package with sessions, TOTP MFA, organizations, RBAC, passkeys, encrypted tokens, and E2E operation encryption (912 tests).

  New: Full Preact-based DevTools UI panel with sync timeline, conflict inspector, operation log, and network status.

  Docs: Comprehensive documentation refinement — added API references for merge, sync, auth, and devtools; added authentication guide; expanded sync configuration guide; updated all package descriptions.

- Updated dependencies [6a05e88]
  - @korajs/core@0.3.0

## 0.1.2

### Patch Changes

- Fix template path resolution in create-kora-app and add package READMEs
- Updated dependencies
  - @korajs/core@0.1.2

## 0.1.0

### Minor Changes

- Initial release

### Patch Changes

- Updated dependencies
  - @korajs/core@0.1.0
