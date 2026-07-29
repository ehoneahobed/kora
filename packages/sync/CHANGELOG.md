# @korajs/sync

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
  - @korajs/merge@1.0.0-beta.9

## 1.0.0-beta.5

### Minor Changes

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

- Add a deterministic targeted-drop hook to `ChaosTransport` (`ChaosConfig.dropPredicate`).
  When it returns true for a message and direction, that message is dropped
  unconditionally, independent of `dropRate`. This lets convergence tests reproduce an
  exact fault (for example dropping one specific operation to force a version-vector
  gap) instead of relying on probabilistic drops, keeping such tests deterministic per
  CLAUDE.md's no-timing-dependent-tests rule.
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

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @korajs/core@1.0.0-beta.5
  - @korajs/merge@1.0.0-beta.5

## 1.0.0-beta.0

### Minor Changes

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

### Patch Changes

- Package export hygiene and auth secret-handling hardening.

  - Every published package now exposes `./package.json` in its `exports` map. Previously `require.resolve('@korajs/core/package.json')` (and the same for every other package) failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`, which breaks tooling that reads a package's manifest or version at runtime.
  - `createKoraAuthServer` now warns loudly when it falls back to an ephemeral random JWT secret outside production, so a deployment that never set `NODE_ENV=production` no longer silently regenerates its signing key on every restart (which invalidates all existing tokens) without any signal.
  - `KORA_AUTH_SECRET` set to an empty or whitespace-only string is now treated as unset rather than as an invalid secret, so it triggers the intended dev fallback / production guard instead of crashing `TokenManager` with a "secret too short" error.

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

## 0.6.1

### Patch Changes

- 5d2afa8: Fix React StrictMode breaking useMutation, useSyncStatus, and useRichText.

  StrictMode's simulated unmount permanently destroyed the useMemo-cached
  controller, so every mutation in a freshly scaffolded app silently failed
  ("Mutation controller is destroyed") and the sync badge stayed stuck on
  "Offline". Controllers are now managed by a StrictMode-safe lifecycle
  helper (useController) that recreates them on remount.

  Also fix `korajs` failing to load in plain Node.js ESM: import
  `protobufjs/minimal.js` with an explicit extension (protobufjs has no
  exports map, so the extensionless subpath only resolves in bundlers).

## 0.6.0

### Minor Changes

- Public beta 0.6.0: Vue 3 and Svelte 5 bindings with shared QueryStore, sync-status controller, and richtext controller; `@korajs/core/bindings` shared types; `@korajs/auth` org hooks and providers for React/Vue/Svelte; presence/collaboration hooks; CLI scaffolds; `korajs/vue` and `korajs/svelte` meta-package re-exports; Svelte component precompile and KoraProvider context bridge fix.

### Patch Changes

- Updated dependencies
  - @korajs/core@0.6.0
  - @korajs/merge@0.6.0

## 0.5.0

### Minor Changes

- b909e5a: v0.5 internal beta: structured apply results and sync apply-failure events, audit trace export, benchmark gates in CI, release-gate script, and E2E fixture hardening (SQLite worker + local multi-tab Playwright project).

### Patch Changes

- Updated dependencies [b909e5a]
  - @korajs/core@0.5.0
  - @korajs/merge@0.5.0

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
  - @korajs/merge@0.4.0

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
  - @korajs/merge@0.3.1

## 0.3.0

### Patch Changes

- 6a05e88: Performance: Replace O(n²) topological sort with binary heap in @korajs/core (19x faster sync for large operation sets).

  New: @korajs/auth package with sessions, TOTP MFA, organizations, RBAC, passkeys, encrypted tokens, and E2E operation encryption (912 tests).

  New: Full Preact-based DevTools UI panel with sync timeline, conflict inspector, operation log, and network status.

  Docs: Comprehensive documentation refinement — added API references for merge, sync, auth, and devtools; added authentication guide; expanded sync configuration guide; updated all package descriptions.

- Updated dependencies [6a05e88]
  - @korajs/core@0.3.0
  - @korajs/merge@0.3.0

## 0.1.2

### Patch Changes

- Fix template path resolution in create-kora-app and add package READMEs
- Updated dependencies
  - @korajs/core@0.1.2
  - @korajs/merge@0.1.2

## 0.1.0

### Minor Changes

- Initial release

### Patch Changes

- Updated dependencies
  - @korajs/merge@0.1.0
  - @korajs/core@0.1.0
