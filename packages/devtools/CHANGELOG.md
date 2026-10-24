# @korajs/devtools

## 1.0.0-beta.15

### Patch Changes

- 714ebd2: Blob pulls no longer hang on a lost message. A blob chunk request was sent only while the sync engine was `streaming`, so a pull started while the initial sync was still arriving (when its rows are already visible) was silently dropped; it then waited 30 s and failed with a plain `Error`, and neither a lost answer nor a reconnect led to a retry.

  - Blob chunk messages go out as soon as the handshake is accepted (`syncing` or `streaming`); servers since 1.0.0-beta.13 already accept them then. `BlobChunkChannel.send` returns whether the message was sent, and `onReady(handler)` runs after each accepted handshake.
  - `createRemoteChunkProvider` re-sends an unanswered request under the same request id after 5 s, then a wait doubling to 30 s (20% jitter), re-sends every pending request when the connection is ready again, and fails only after 2 minutes without any answer (`deadlineMs`; `timeoutMs` is a deprecated alias). Failures reject with `BlobTransferError` (a `KoraError`: `BLOB_CHUNK_TIMEOUT`, `BLOB_CHUNK_UNAVAILABLE`, `BLOB_CHUNK_CANCELLED`, with `hash`, `attempts` (requests actually sent: tries made offline are not counted), `lastReason`); `receiveBlob` and `fetchBlobManifest` report a chunk nobody holds as `BLOB_CHUNK_UNAVAILABLE`. The provider takes an injectable `clock` and `random`, and `close()` cancels pending requests and clears their timers (called on `app.close()`).
  - New events `blob:request-retried`, `blob:request-failed` and `blob:handler-error`, recorded by DevTools. A blob channel handler that throws no longer stops the other handlers (or the message from reaching the chunk provider); its error is emitted as `blob:handler-error`, or logged when the engine has no emitter.
  - The sync server's blob relay always answers a connected requester: "not held" once every peer it asked said not held or left, and when a request expires (counted from its first arrival, so client re-sends do not extend it, on a timer rather than when the next request arrives); `throttled` (with `retryAfterMs`) over the per-session pending cap, when bytes are ready but the session may not receive them, and for a request id pending for another session. Counters are kept per answer kind (`BlobChunkRelay.getStats()`: each delivered answer once under its kind, a request whose requester left once under `requesterGone`), and the pending-cap and duplicate-id cases are logged.

  No wire or protocol change: every answer is a `blob-chunk-response` of a shape servers already send (`throttled` since 1.0.0-beta.13, whose clients retry on it). An older client against a new server gets an answer instead of silence (a beta.12 client reads `throttled` as "not held", as it already does for the request budget); a new client against an older server recovers through its retries.

- 95f5a26: `useMutation` reports writes the sync server refuses. In React, Vue and Svelte, `useMutation(fn, { onRejected })` and a `rejected` state (`{ code, message, collection, recordId, operationId, operationIds, reverted, args }`) tell the component that made a write when the server permanently refuses it, even hours later after an offline period, so an app can show "this change was undone, and why" without listening to sync events. One `mutate()` call is one write: every operation it committed, including a delete's cascades and a whole `app.transaction()`; it is reported once. `reverted` is false only for the refusals the device keeps locally (`OUT_OF_UPLINK_SCOPE`, `NODE_ID_MISMATCH`, `SEQUENCE_CONFLICT`). Retriable rejections are not reported. A hook reports nothing after it unmounts, and tracks at most 500 unsynced writes; the app-level `sync:operation-rejected` event and `app.sync.getRejectedOperations()` still report every refusal. Tracking needs `<KoraProvider app={app}>`. Svelte's mutation also gains `subscribeRejected(fn)`.

  Two new sync events support it: `sync:operations-acknowledged` (`operationIds` the server stored) and `sync:operations-rewritten` (`reason`, `idMapping`: unsent operations re-authored under new ids by a clock rebase, a node-id rotation or a sequence renumbering).

- 89cb4c4: A record deleted on the server while outside a device's view no longer comes back on that device, or on a new device, through a stale write. An operation after which the record is deleted (a delete, or a write older than the record's newest delete) is now delivered by the record's folded state and by what each session's view held of the record, not by the operation's own values: a delete reaches every view in which the record was live at some point (including `scopeExit: 'retain'` devices, retracted records, query-subset views and access-rules members who joined after the last write), and a stale write is sent only to such a view, when its values are in view, after the record's newest delete (sent once per delivery pass).

  The decision costs one batched read of a bounded per-record summary (`kora_record_live_views`) over the fields the server's own grants read, never the record's history. A summary is trusted only while the record's fold state records that it accounts for the record's newest operation (`lv_through` beside `covered_op_id`); a write by an instance that does not maintain it (an older version during a rolling deploy), a re-fold or a restore leaves it unknown until a background rebuild, and a later write never makes it current again. A write that changes neither the record's liveness nor a tracked value touches no summary. Scope snapshots gain an additive `deleted` field. Summaries and the tombstone state of existing data are filled by a background backfill after start (short, guarded transactions; no startup rebuild, the snapshot fingerprint is unchanged). While unknown, a delete is delivered as in 1.0.0-beta.14, and a write older than the record's delete is delivered as before when its values are in view, preceded by the record's newest delete (the fold keeps its fields, so a device without it would diverge after a revival); for an access-rules collection, only to a member whose membership began before the record was deleted (judged at the first delete after its last live write, so a second delete does not move it: read from the stored tombstone state, else decided by a bounded replay of the record's history; never withheld on a guess, since the watermark would pass the write. If it still cannot be decided, only that write is held (the watermark does not pass it; the rest of the member's stream and other devices of the author flow on) and the record rebuilt, judged again with a 500 ms to 5 s backoff from a per-operation cache shared by all sessions, and after 15 seconds the write is sent as before, which means a member who joined after the delete can be shown that one stale write once the hold expires (logged and emitted); at most 1,024 writes are held per session, the rest are sent; clients without a delivery watermark are refused when access rules apply, so no path sends past a hold). Tracked fields come from the server's grant before any client narrowing; a replace-mode restore or a snapshot wipe by this version bumps an epoch that voids rebuilds in flight (a wipe by an older instance does not; its snapshot fills are guarded by the snapshot they read, and its summary writes by the fold state); a fold state invalidated in place (`covered_seq = -1`) leaves its summary unknown. Stores gain the optional `registerLiveViewFields`, `getRecordLiveViews`, `requestLiveViewRebuild` and `whenLiveViewsIdle`; a custom store without them keeps the previous behavior. An undetermined deletion point is logged (`session.tombstone_delivery_undetermined`), counted in `errorCount` when it is a failed read or a send, and emitted as the new `server:tombstone-delivery-undetermined` event.

  A delete that carries the record it removed (a delete made through a server route) reaches a view that only held an earlier version of the record, before it moved elsewhere, without that record: the copy keeps the id, drops `previousData` and declares no hash version (clients do not check the id of such a server-rewritten operation). A write onto a tombstone still has to pass the access history gate (membership at the write), also on the known-summary path. A replace-mode restore resets the live-view backfill cursors and rebuilds the summaries of the restored log. A held write that resolves sends the operations scanned beyond it again in the chain that moves the watermark past them, and a version-vector delta carries a replayed delete once.

  For an access-rules collection, every outbound path (the delivery stream, a live relay and a version-vector delta) now cuts a delete's `previousData` unless the delete's own delivery sequence is known and the session's history gate admits the content at it; an unknown sequence is never replaced by the end of the log (that admitted a membership opened after the delete), so the content is cut and the delete still arrives. `ServerStore.findStoredOperations` returns the delivery sequence as an optional field. A write onto a tombstone also has to pass the membership-predates-the-tombstone gate when the record's summary is known, not only when it is unknown.

- 0b461fa: The sync server reports committed writes: `createKoraServer({ onOperationsCommitted(operations, context) })` (also `syncOptions.onOperationsCommitted`) and `server.onOperationsCommitted(handler)` on `KoraSyncServer` and `createProductionServer` (returns an unsubscribe function) run once per batch after it is durably committed. Device uploads over WebSocket and HTTP long-polling arrive with `source: 'sync'` and the session's `auth` and `sessionId`; server-authored writes (`server.kora.apply`, `applyConditional`, `transaction`, `server.access`, the spaces routes, writes a validator makes through `context.kora`, `applyLocalOperation`, `relayServerOperations`) with `source: 'server'`. The referential side effects and cross-record corrections a write causes are in its batch. Refused, ignored and duplicate operations never appear, and a backup restore does not call it. Each handler gets its own deep, frozen copy of the operations as stored and of the context (the session's `auth` included, so a handler cannot change the credential that decides the session's later reads and writes), are not awaited, and fire on the instance that committed; a handler that throws or rejects is logged (`operations.commit_hook_failed`), counted as an error and emitted on the server's `emitter` as the new `server:commit-hook-failed` event, and never affects the commit, the acknowledgment or the fan-out. Apps that wrapped `store.applyRemoteOperation` to see committed writes can use it instead (that wrapper missed transactions, conditional applies and server writes).

  An upload batch that stops part way (a store error, the session ending because a grant was deleted) now relays the operations it committed before stopping to the other connected sessions, as a completed batch does; before, a protocol-1 client missed them until it reconnected. A `kora.transaction` and the side effects it causes are fanned out together.

  Operations committed before a follow-up step fails (a cascade or set-null write, a cross-record correction, the side effects of a transaction) are now relayed to connected devices and reported to `onOperationsCommitted`; before, a failing follow-up left the committed write unannounced until the next delivery poll (and a protocol-1 client until it reconnected). A `kora.apply` whose follow-up failed still rejects.

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

- Updated dependencies [99cedc4]
- Updated dependencies [4ec1bc5]
  - @korajs/core@1.0.0-beta.14

## 1.0.0-beta.13

### Minor Changes

- Show the new storage, sync, encryption and query events (quarantine, apply-blocked, rejected
  and forged operations, protocol deprecation, durability and encryption status).

See the [1.0.0-beta.13 release notes](https://github.com/ehoneahobed/kora/blob/main/docs/releases/v1.0.0-beta.13.md) and the [upgrade guide](https://github.com/ehoneahobed/kora/blob/main/docs/guide/upgrading-to-beta13.md) (servers first, then clients).

## 1.0.0-beta.9

### Patch Changes

- Updated dependencies [b657130]
  - @korajs/core@1.0.0-beta.9

## 1.0.0-beta.5

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @korajs/core@1.0.0-beta.5

## 1.0.0-beta.0

### Patch Changes

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

### Minor Changes

- 6a05e88: Performance: Replace O(n²) topological sort with binary heap in @korajs/core (19x faster sync for large operation sets).

  New: @korajs/auth package with sessions, TOTP MFA, organizations, RBAC, passkeys, encrypted tokens, and E2E operation encryption (912 tests).

  New: Full Preact-based DevTools UI panel with sync timeline, conflict inspector, operation log, and network status.

  Docs: Comprehensive documentation refinement — added API references for merge, sync, auth, and devtools; added authentication guide; expanded sync configuration guide; updated all package descriptions.

### Patch Changes

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
