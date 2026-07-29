# @korajs/server

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
  - Load local `.env` files in `kora dev` and generated sync servers before auth/server setup, so first-run auth configuration mounts consistently whether the app is started by the CLI or the server is run directly.
  - Update generated template docs to use `/kora-sync` WebSocket endpoints for `VITE_SYNC_URL`, avoiding noisy root-path WebSocket retries from copied defaults.
  - Improve JSON schema validation errors by reporting the exact invalid nested path, including `undefined`, non-finite numbers, and circular objects.
  - Fix IndexedDB fallback persistence so logical dumps are durable when binary SQLite export is unavailable, stale binary snapshots cannot shadow newer dumps, and dump-only databases restore correctly.
  - Allow production server COEP policy configuration and document route access to the owned Kora data plane.

- Updated dependencies [b657130]
  - @korajs/core@1.0.0-beta.9
  - @korajs/sync@1.0.0-beta.9
  - @korajs/merge@1.0.0-beta.9

## 1.0.0-beta.5

### Minor Changes

- Add `applyConditional` to the production route context: a conditional,
  multi-collection admission gate for custom HTTP routes.

  `request.kora.applyConditional({ collection, id, if, update, also, reject,
idempotencyKey })` reads the target record, evaluates the `if` predicate against
  its current materialized state, and only then applies the `update` to the target
  plus every mutation in `also` as one set. When the predicate fails it applies
  nothing and returns the structured `reject`. `idempotencyKey` names a record whose
  prior existence proves the set already committed, so a retry returns the earlier
  outcome instead of re-running non-idempotent counter increments. The predicate
  language (`$eq`, `$ne`, `$lt`, `$lte`, `$gt`, `$gte`, `$in`) is exported as
  `RoutePredicate`.

  This also fixes the route `apply` path to resolve atomic-op sentinels
  (`op.increment`, `op.max`, ...): `data` now carries the concrete resolved value
  and the operation carries the atomic intent, so server-authored atomic writes
  compose in the merge engine exactly like client writes instead of being stored as
  raw sentinel objects.

  The whole mutation set is built and scope-validated before any of it is committed,
  so a malformed mutation or scope violation in `also` cannot leave the target update
  (for example a counter increment) committed while the rest is rejected.

  Within one server instance the check and writes do not interleave with other route
  mutations. Cross-instance race-free admission and all-or-nothing across a mid-set
  crash require a store-level conditional transaction (a Postgres `WHERE ... < cap`
  commit with row locking), which is a follow-up that needs a live-Postgres
  integration environment to certify.

- Make conditional route apply (`request.kora.applyConditional`) race-free across
  server instances backed by the same Postgres database.

  Previously the admission gate (read the target, check the predicate, apply the
  update plus its `also` set) was atomic only within a single server instance. Two
  instances admitting to the same capped record concurrently could both pass a
  `responseCount < max` check and over-admit. The Postgres store now implements a
  store-level conditional transaction: a transaction-scoped advisory lock keyed on
  the target record serializes the read-decide-write cycle across every instance
  sharing the database, the idempotency key is checked under that same lock (so a
  retry is at-most-once even across instances), and the whole set commits or rolls
  back together.

  Two correctness details this depends on:

  - The increment op is re-resolved against the value read under the lock, and its
    HLC is advanced past the target record's latest committed operation, so
    last-write-wins materialization reflects the serialized commit order even when
    two instances commit in the same millisecond. Without the advance, a
    same-millisecond tie could let materialization pick an earlier resolved value
    and undercount the counter, admitting past the cap.
  - Server-originated sequence numbers are now reserved atomically on the Postgres
    store (`reserveSequenceNumber`), so two concurrent server operations can never be
    handed the same number (which would let one shadow the other during
    version-vector delta sync).

  Stores that serve writes on a single process (in-memory, SQLite) are unchanged:
  they keep the per-instance serialized path, which is correct because only one
  server operation is ever in flight.

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

- The production server handle now exposes the data plane it already owns, so
  background jobs and scheduled tasks no longer have to reach past it.

  `server.kora` gives server-side callers `apply`, `query`, and `findById` through
  the exact validated pipeline sync uses (Tier 2 constraints, referential
  integrity, materialization, and fan-out to connected clients), with no HTTP
  request needed. It is the same context custom HTTP routes receive as
  `request.kora`, so a job and a request share one code path.

  `server.getLiveBlobRefs()` returns every blob reference still reachable from a
  live record, which is the live set for a scheduled mark-and-sweep: pair it with
  `collectBlobGarbage` from `@korajs/store` to reclaim orphaned central blob bytes.

  `maxOperationBytes` and `maxOpsPerMinute` are now settable on
  `KoraSyncServerConfig` (and therefore via `createProductionServer({ syncOptions })`),
  so one payload-size cap and one per-client rate cap apply to every connected
  session instead of being configured session by session.

  Every apply rejection now carries a `retriable` flag through a single shared
  taxonomy (`OperationRejection`, `isRetriableRejection`): `true` for transient
  conditions like a rate limit, `false` for permanent ones like a constraint or
  referential conflict. This is the same `retriable` flag the sync protocol already
  sends clients on the wire, so server-side callers and remote clients read one
  classification. See the new "Production server" guide for the central-blob +
  scheduled-GC example.

- Compose atomic operations in the server's materialized view so it matches what
  clients converge to.

  Previously the server materialized records by last-write-wins over each operation's
  resolved `data`, and did not persist the atomic-op intent (`op.increment`,
  `op.max`, `op.min`, `op.append`, `op.remove`). Concurrent, independent atomic writes
  to the same field — two offline clients each incrementing a shared counter, then
  syncing — collapsed to a single winner in the server's view (materialized reads and
  initial-sync hydration), even though clients converge to the composed result.

  The server now persists atomic-op intent alongside each operation and composes it
  during materialization. Per field, an atomic op composes onto the running value when
  the previous writer on that field was an atomic op of the same type (a same-type
  chain: increments sum, maxes take the max, appends accumulate); any other write,
  including the first atomic write after a plain set, resolves by last-write-wins. This
  mirrors the client merge engine, so the server's materialized value equals the
  clients' converged value. Verified end to end against real client devices syncing
  through the server (`@korajs/test`), plus SQLite and Postgres persistence.

  Details:

  - `@korajs/core` exports `applyAtomicOp(currentValue, atomicOp)`, the single source
    of truth for atomic-op semantics that both the client write path (`resolveAtomicOp`)
    and the server materialization use.
  - The SQLite and Postgres operation logs gain a nullable `atomic_ops` column, added
    by a backward-compatible migration. Existing rows read as "no atomic ops" and keep
    materializing by last-write-wins exactly as before, so no data migration is required.
  - Materialization now orders operations by full HLC total order (wallTime, logical,
    nodeId), matching `HybridLogicalClock.compare`, so composition and last-write-wins
    see operations in the order the merge engine converges them.

  Operations that carry no atomic-op intent (the common case) materialize exactly as
  before.

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

- Make relay delivery durable across reconnects, closing the remaining window in the
  reliable-relay fix.

  Reliable relay retransmits unacknowledged relay batches while the connection stays up,
  but a relay dropped just before the client disconnected was lost with the session
  (and delta sync on reconnect could not recover it, because a later operation had
  advanced the client's version vector past the missing one). The server now buffers a
  disconnecting client's unacknowledged relay operations by node id and, when that client
  reconnects and reaches streaming, replays them through the normal relay path (re-filtered
  by the reconnected session's current scope). The buffer is deduped by operation id,
  bounded per node, and expired by age so a client that never returns cannot grow it.

- Make server-to-client relay reliable, closing a lost-operation bug under a lossy
  transport.

  Real-time relay was fire-and-forget: if the transport dropped a relayed operation
  batch, the client never received it. Because a later operation from the same node
  still advanced the client's version vector past the missing one, delta sync on the
  next handshake would never re-send it, so the operation was lost and that client
  diverged permanently (a violation of the "no operation is ever lost" guarantee).

  The server now tracks each relay batch until the client acknowledges it (clients
  already ack every applied batch by messageId) and retransmits anything still unacked
  on a periodic tick. Redelivering an already-applied operation is harmless because
  clients dedup by content-addressed id. The pending set is bounded per session and
  cleared on close.

  Note: this closes the common case where the connection stays up while individual
  messages drop. A drop immediately followed by a reconnect (before retransmit) is not
  yet covered — that requires delivery tracking durable across reconnects, tracked
  separately.

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
  - @korajs/core@1.0.0-beta.5
  - @korajs/merge@1.0.0-beta.5

## 1.0.0-beta.0

### Minor Changes

- Reclaim storage from blobs no record references any more. Blob bytes are content-addressed and deduplicated, so a blob can outlive the record that created it (and be shared by several records); garbage collection frees the truly orphaned bytes without touching shared ones.

  - `@korajs/store` adds `collectBlobGarbage(store, liveRefs, { dryRun })`, a mark-and-sweep collector. The live set is closed over the reference graph — each live `BlobRef` retains its blob hash, its manifest hash, and every chunk hash the manifest names — so a chunk still referenced by any surviving blob is kept. Mark-and-sweep (not reference counting) is deliberate: it is correct under concurrent edits and CRDT merges, where counts are fragile. The `ContentAddressedBlobStore` interface gains `list()`, implemented by the memory, OPFS, and filesystem stores. `extractBlobRefs(record)` pulls the references out of a materialized record.
  - `korajs`: `app.blobs.gc()` sweeps the local blob store against the live records in every collection that has a `blob` field. `{ dryRun: true }` previews what would be collected. Returns a summary (scanned, live, collected, and the collected hashes).
  - `@korajs/server`: `KoraSyncServer.getLiveBlobRefs()` returns the live references across all server-side records, so a self-hosted server can GC its central blob store by passing them to `collectBlobGarbage`.

  Proven end to end: an orphaned blob is collected after its record is deleted (client and server), a blob is kept while still referenced, and a chunk shared by a surviving blob is never collected.

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

- Add a scoped, validated data-plane context to custom HTTP routes (`request.kora`).

  `httpRoutes` handlers now receive a `kora` context on the request so server-side REST endpoints stop bypassing the guarantees the sync path enforces:

  - `kora.apply(mutation, { scope })` builds a server-originated operation and runs it through the same pipeline as sync — Tier 2 constraint validation, referential integrity and cascade side effects, materialization, and fan-out to connected clients. When a `scope` is supplied, a mutation whose resulting record falls outside it is rejected with `SCOPE_VIOLATION` instead of being written.
  - `kora.query(collection, { scope, ...options })` and `kora.findById(collection, id, { scope })` read materialized state and, when a scope is supplied, only return records inside it.
  - Mutations are serialized so concurrent requests cannot race on server sequence-number allocation.

  `KoraSyncServer` gains a public `applyLocalOperation(op)` that applies a server-originated operation through the validated pipeline and relays it to connected clients (each session still applies its own per-scope visibility filter). Previously the only way to create data from a REST handler was to write to the store directly, which skipped constraints, referential integrity, scope, and live fan-out.

### Patch Changes

- Package export hygiene and auth secret-handling hardening.

  - Every published package now exposes `./package.json` in its `exports` map. Previously `require.resolve('@korajs/core/package.json')` (and the same for every other package) failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`, which breaks tooling that reads a package's manifest or version at runtime.
  - `createKoraAuthServer` now warns loudly when it falls back to an ephemeral random JWT secret outside production, so a deployment that never set `NODE_ENV=production` no longer silently regenerates its signing key on every restart (which invalidates all existing tokens) without any signal.
  - `KORA_AUTH_SECRET` set to an empty or whitespace-only string is now treated as unset rather than as an invalid secret, so it triggers the intended dev fallback / production guard instead of crashing `TokenManager` with a "secret too short" error.

- Fix `createProductionServer` silently dropping POST/PUT/PATCH request bodies for `httpRoutes` handlers on some Node.js versions, and stop a single throwing route handler from crashing the entire server process.

  - `readBodyBuffer` now explicitly calls `req.resume()` (guarded by `req.readableFlowing`) after attaching its `data`/`end` listeners, and handles stream `error` events, so the request body reliably reaches `httpRoutes` handlers instead of resolving as an empty buffer.
  - The HTTP request listener passed to `http.createServer` is no longer an unawaited `async` callback. A thrown or rejected error inside a route handler is now caught and turned into a clean `500` response instead of becoming an unhandled promise rejection that takes down the whole process.
  - `@korajs/auth`'s built-in auth routes (`handleSignIn`, `handleSignUp`), `isValidEmail`, `sanitizeName`, `verifyJwt`, and the org routes' email validation now guard against non-string/undefined fields at runtime instead of assuming the compile-time `string` type holds for real network input, returning `400`/`401` responses instead of throwing.

  Reported by the KoraForms team: signup/signin requests built on `httpRoutes` were reaching handlers with `body: undefined`, causing `TypeError`s that crashed the server.

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
  - @korajs/core@1.0.0-beta.0
  - @korajs/merge@1.0.0-beta.0
  - @korajs/sync@1.0.0-beta.0

## 0.6.1

### Patch Changes

- Updated dependencies [5d2afa8]
  - @korajs/sync@0.6.1

## 0.6.0

### Minor Changes

- Public beta 0.6.0: Vue 3 and Svelte 5 bindings with shared QueryStore, sync-status controller, and richtext controller; `@korajs/core/bindings` shared types; `@korajs/auth` org hooks and providers for React/Vue/Svelte; presence/collaboration hooks; CLI scaffolds; `korajs/vue` and `korajs/svelte` meta-package re-exports; Svelte component precompile and KoraProvider context bridge fix.

### Patch Changes

- Updated dependencies
  - @korajs/core@0.6.0
  - @korajs/merge@0.6.0
  - @korajs/sync@0.6.0

## 0.5.0

### Minor Changes

- b909e5a: v0.5 internal beta: structured apply results and sync apply-failure events, audit trace export, benchmark gates in CI, release-gate script, and E2E fixture hardening (SQLite worker + local multi-tab Playwright project).

### Patch Changes

- Updated dependencies [b909e5a]
  - @korajs/core@0.5.0
  - @korajs/merge@0.5.0
  - @korajs/sync@0.5.0

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
  - @korajs/sync@0.4.0

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

## 0.3.0

### Patch Changes

- 6a05e88: Performance: Replace O(n²) topological sort with binary heap in @korajs/core (19x faster sync for large operation sets).

  New: @korajs/auth package with sessions, TOTP MFA, organizations, RBAC, passkeys, encrypted tokens, and E2E operation encryption (912 tests).

  New: Full Preact-based DevTools UI panel with sync timeline, conflict inspector, operation log, and network status.

  Docs: Comprehensive documentation refinement — added API references for merge, sync, auth, and devtools; added authentication guide; expanded sync configuration guide; updated all package descriptions.

- Updated dependencies [6a05e88]
  - @korajs/core@0.3.0
  - @korajs/sync@0.3.0

## 0.1.2

### Patch Changes

- Fix template path resolution in create-kora-app and add package READMEs
- Updated dependencies
  - @korajs/core@0.1.2
  - @korajs/sync@0.1.2

## 0.1.0

### Minor Changes

- Initial release

### Patch Changes

- Updated dependencies
  - @korajs/core@0.1.0
  - @korajs/sync@0.1.0
