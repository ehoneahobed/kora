# @korajs/store

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
