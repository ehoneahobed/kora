# @korajs/test

## 1.0.0-beta.15

### Minor Changes

- 85954a4: New subpath `@korajs/test/playwright`: offline helpers for Playwright end-to-end tests, learned from koraforms. `goOffline`/`goOnline`, `firstVisitOffline`, `killTab` (CDP `Page.crash`, Chromium only), `openProfile`/`restartProfile` (relaunch the same persistent user data directory), `skewClock` (offsets `Date.now()`, `new Date()` and `Date()` only), `throttleNetwork` (CDP presets `slow-4g`, `fast-3g`, `slow-3g`, `2g`, `offline`, `none`), `blockServiceWorker`, `waitForOfflineStatus`/`readOfflineStatus`/`hasReason` (read `app.offline.status()` through a configurable accessor, default `app.offline`), and the offline-readiness contract as two helpers: `assertReadyMeansOffline` (when the status reads `ready`, reload offline and assert the shell, the data and a write that survives another reload) and `expectNeverReady` (records whether `ready` was ever observed while a negative scenario runs, in Node and in an in-page probe).

  `playwright-core` is an optional peer dependency used for types only; nothing is imported from it at runtime, and the main `@korajs/test` entry does not load the new subpath.

- 941c67e: Offline readiness knows whether the signed-in session survives an offline reload (A3). `AuthSyncBinding` gains `resolveOfflineRestore()`, which `createKoraAuthSync` implements from the stored tokens: restorable only with both tokens stored, on storage that survives a reload, with a refresh token that has not expired and an offline grace (`maxOfflineGraceMs`, measured from the stored refresh token's issue time) that has not run out. A wall clock set back reports `clock-rollback`, and a 30 second watchdog re-checks while the session is restorable. `AuthTokenStorage` gains an optional `durability` (`durable`, `session`, `memory`): the default `localStorage` store is durable, `createMemoryAuthTokenStorage` and `sessionStorage` are not, and a custom store that does not say is `unknown`, so `app.offline` is never `ready` on an assumption. `createAuthTokenStorage({ store, durability })` declares it.

  `createApp({ offline: { auth } })` declares restorability for apps with their own sign-in (a bare `sync.auth` token function cannot know). `app.offline.status().auth` is now `restorable`, `not-restorable`, `unknown`, `loading` or `n/a`, and `ready` flips off when the session's limit passes.

### Patch Changes

- 714ebd2: Blob pulls no longer hang on a lost message. A blob chunk request was sent only while the sync engine was `streaming`, so a pull started while the initial sync was still arriving (when its rows are already visible) was silently dropped; it then waited 30 s and failed with a plain `Error`, and neither a lost answer nor a reconnect led to a retry.

  - Blob chunk messages go out as soon as the handshake is accepted (`syncing` or `streaming`); servers since 1.0.0-beta.13 already accept them then. `BlobChunkChannel.send` returns whether the message was sent, and `onReady(handler)` runs after each accepted handshake.
  - `createRemoteChunkProvider` re-sends an unanswered request under the same request id after 5 s, then a wait doubling to 30 s (20% jitter), re-sends every pending request when the connection is ready again, and fails only after 2 minutes without any answer (`deadlineMs`; `timeoutMs` is a deprecated alias). Failures reject with `BlobTransferError` (a `KoraError`: `BLOB_CHUNK_TIMEOUT`, `BLOB_CHUNK_UNAVAILABLE`, `BLOB_CHUNK_CANCELLED`, with `hash`, `attempts` (requests actually sent: tries made offline are not counted), `lastReason`); `receiveBlob` and `fetchBlobManifest` report a chunk nobody holds as `BLOB_CHUNK_UNAVAILABLE`. The provider takes an injectable `clock` and `random`, and `close()` cancels pending requests and clears their timers (called on `app.close()`).
  - New events `blob:request-retried`, `blob:request-failed` and `blob:handler-error`, recorded by DevTools. A blob channel handler that throws no longer stops the other handlers (or the message from reaching the chunk provider); its error is emitted as `blob:handler-error`, or logged when the engine has no emitter.
  - The sync server's blob relay always answers a connected requester: "not held" once every peer it asked said not held or left, and when a request expires (counted from its first arrival, so client re-sends do not extend it, on a timer rather than when the next request arrives); `throttled` (with `retryAfterMs`) over the per-session pending cap, when bytes are ready but the session may not receive them, and for a request id pending for another session. Counters are kept per answer kind (`BlobChunkRelay.getStats()`: each delivered answer once under its kind, a request whose requester left once under `requesterGone`), and the pending-cap and duplicate-id cases are logged.

  No wire or protocol change: every answer is a `blob-chunk-response` of a shape servers already send (`throttled` since 1.0.0-beta.13, whose clients retry on it). An older client against a new server gets an answer instead of silence (a beta.12 client reads `throttled` as "not held", as it already does for the request budget); a new client against an older server recovers through its retries.

- c5de1d2: `createTestNetwork` and `createMixedTestNetwork` no longer leave their `kora-test-*` temporary directory behind. A network whose creation fails (a device that refuses to open, for example) now closes what it started and removes its directory before the error propagates; `close()` removes the directory even when closing a device or the server throws (that error is still raised, and a failure to remove the directory is reported instead of ignored); and a network that is never closed is closed (its devices and server) and then has its directory removed when the process is about to exit (`beforeExit`), so a platform that cannot remove a directory whose database files are open (Windows) can remove it. A removal that fails is retried once after closing, and a directory that still cannot be removed is kept for a last attempt at `exit` rather than forgotten.
- Updated dependencies [191930a]
- Updated dependencies [0c1f8f3]
- Updated dependencies [24f5531]
- Updated dependencies [6c72c04]
- Updated dependencies [4ddcff5]
- Updated dependencies [6fd998a]
- Updated dependencies [946dd42]
- Updated dependencies [8667762]
- Updated dependencies [5a2e9df]
- Updated dependencies [962db5d]
- Updated dependencies [003d7bf]
- Updated dependencies [2a267d4]
- Updated dependencies [0b461fa]
- Updated dependencies [047b788]
- Updated dependencies [8411be3]
- Updated dependencies [34b477d]
- Updated dependencies [a5c61ff]
- Updated dependencies [28ec1ef]
- Updated dependencies [714ebd2]
- Updated dependencies [70e0611]
- Updated dependencies [4237195]
- Updated dependencies [d988dda]
- Updated dependencies [b91b0ee]
- Updated dependencies [12ad88c]
- Updated dependencies [19cd5d9]
- Updated dependencies [180923d]
- Updated dependencies [fa1a971]
- Updated dependencies [d36239c]
- Updated dependencies [b8f9e6f]
- Updated dependencies [f16c664]
- Updated dependencies [ed1877a]
- Updated dependencies [16ed395]
- Updated dependencies [622e628]
- Updated dependencies [c5ef367]
- Updated dependencies [6470e48]
- Updated dependencies [9afd6a0]
- Updated dependencies [d45441e]
- Updated dependencies [4d5f2a2]
- Updated dependencies [3caff5e]
- Updated dependencies [daf696c]
- Updated dependencies [c9defbd]
- Updated dependencies [d19c7f7]
- Updated dependencies [95f5a26]
- Updated dependencies [92f08d3]
- Updated dependencies [dec63c6]
- Updated dependencies [ea9f219]
- Updated dependencies [941c67e]
- Updated dependencies [a5b3933]
- Updated dependencies [ab20522]
- Updated dependencies [2b9b8b5]
- Updated dependencies [89cb4c4]
- Updated dependencies [aa834a9]
- Updated dependencies [35d91bd]
- Updated dependencies [e9bba9b]
- Updated dependencies [678e2ff]
- Updated dependencies [87e09ca]
- Updated dependencies [0b461fa]
- Updated dependencies [2c44930]
- Updated dependencies [b378fb9]
- Updated dependencies [fe4d3cb]
- Updated dependencies [8816154]
- Updated dependencies [1c9dbe0]
- Updated dependencies [0388bd7]
- Updated dependencies [68cbb70]
- Updated dependencies [ad6fce2]
- Updated dependencies [df7a430]
- Updated dependencies [b7f964a]
  - @korajs/store@1.0.0-beta.15
  - korajs@1.0.0-beta.15
  - @korajs/core@1.0.0-beta.15
  - @korajs/sync@1.0.0-beta.15
  - @korajs/server@1.0.0-beta.15
  - @korajs/merge@1.0.0-beta.15

## 1.0.0-beta.14

### Patch Changes

- Updated dependencies [afe97c6]
- Updated dependencies [99cedc4]
- Updated dependencies [8b7de83]
- Updated dependencies [4ec1bc5]
- Updated dependencies [f0f5375]
- Updated dependencies [44ddf65]
- Updated dependencies [2c35276]
- Updated dependencies [a1e5765]
- Updated dependencies [ddafafb]
- Updated dependencies [4ec1bc5]
- Updated dependencies [f0f662d]
- Updated dependencies [ecb9e77]
- Updated dependencies [a0965d3]
- Updated dependencies [88654fa]
- Updated dependencies [3ce9411]
- Updated dependencies [7e3df2f]
- Updated dependencies [267fa9f]
- Updated dependencies [9c153b1]
  - @korajs/store@1.0.0-beta.14
  - @korajs/sync@1.0.0-beta.14
  - korajs@1.0.0-beta.14
  - @korajs/core@1.0.0-beta.14
  - @korajs/server@1.0.0-beta.14
  - @korajs/merge@1.0.0-beta.14

## 1.0.0-beta.13

### Minor Changes

- Test devices and networks use the deterministic fold, protocol v2 and the server's scope grants;
  the `legacyMerge` option compares against the beta.12 merge.

See the [1.0.0-beta.13 release notes](https://github.com/ehoneahobed/kora/blob/main/docs/releases/v1.0.0-beta.13.md) and the [upgrade guide](https://github.com/ehoneahobed/kora/blob/main/docs/guide/upgrading-to-beta13.md) (servers first, then clients).

## 1.0.0-beta.11

### Minor Changes

- Add `createTestAuthBinding()` for deterministic loading/sign-in/refresh/sign-out and multi-user
  transitions, plus `createTransportMetrics()` for connection, message, and byte-cost assertions.

## 1.0.0-beta.9

### Patch Changes

- Updated dependencies [b657130]
  - @korajs/core@1.0.0-beta.9
  - @korajs/server@1.0.0-beta.9
  - @korajs/store@1.0.0-beta.9
  - @korajs/sync@1.0.0-beta.9
  - korajs@1.0.0-beta.9
  - @korajs/merge@1.0.0-beta.9

## 1.0.0-beta.6

### Patch Changes

- Updated dependencies
  - @korajs/store@1.0.0-beta.6
  - korajs@1.0.0-beta.6

## 1.0.0-beta.5

### Patch Changes

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
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @korajs/sync@1.0.0-beta.5
  - korajs@1.0.0-beta.5
  - @korajs/store@1.0.0-beta.5
  - @korajs/core@1.0.0-beta.5
  - @korajs/server@1.0.0-beta.5
  - @korajs/merge@1.0.0-beta.5

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
  - @korajs/server@1.0.0-beta.0
  - korajs@1.0.0-beta.0
  - @korajs/sync@1.0.0-beta.0

## 0.6.1

### Patch Changes

- Updated dependencies [5d2afa8]
  - @korajs/sync@0.6.1
  - korajs@0.6.1
  - @korajs/server@0.6.1

## 0.6.0

### Minor Changes

- Public beta 0.6.0: Vue 3 and Svelte 5 bindings with shared QueryStore, sync-status controller, and richtext controller; `@korajs/core/bindings` shared types; `@korajs/auth` org hooks and providers for React/Vue/Svelte; presence/collaboration hooks; CLI scaffolds; `korajs/vue` and `korajs/svelte` meta-package re-exports; Svelte component precompile and KoraProvider context bridge fix.

### Patch Changes

- Updated dependencies
  - @korajs/core@0.6.0
  - @korajs/merge@0.6.0
  - @korajs/server@0.6.0
  - @korajs/store@0.6.0
  - @korajs/sync@0.6.0
  - korajs@0.6.0

## 0.5.0

### Minor Changes

- b909e5a: v0.5 internal beta: structured apply results and sync apply-failure events, audit trace export, benchmark gates in CI, release-gate script, and E2E fixture hardening (SQLite worker + local multi-tab Playwright project).

### Patch Changes

- Updated dependencies [b909e5a]
  - @korajs/core@0.5.0
  - @korajs/store@0.5.0
  - @korajs/merge@0.5.0
  - @korajs/sync@0.5.0
  - @korajs/server@0.5.0
  - korajs@0.5.0

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
  - @korajs/server@0.4.0
