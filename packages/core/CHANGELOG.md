# @korajs/core

## 1.0.0-beta.5

### Minor Changes

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

## 1.0.0-beta.0

### Minor Changes

- Add a `blob` field type backed by a content-addressed store (data model + store core).

  Files no longer belong in the operation log. A `blob` field carries a small content-addressed reference, and the bytes live in a deduplicated, integrity-checked store keyed by their hash.

  - `t.blob()` fields hold a `BlobRef` (`{ hash, size, mimeType?, filename? }`), a hex SHA-256 content address plus metadata. Values persist as JSON (`TEXT`) and converge by last-write-wins on the reference (the bytes are immutable and deduplicated by hash, so the reference is the only thing that can change).
  - `@korajs/core` exposes `hashBlob`, `createBlobRef`, and `isBlobRef` (reusing the same SHA-256 content addressing as operation ids).
  - `@korajs/store` adds a `ContentAddressedBlobStore` interface and a `MemoryBlobStore` backend: `put` deduplicates identical content (stored once, same hash), and `get` verifies the stored bytes hash to the requested key, throwing `BlobIntegrityError` on corruption rather than returning bad data.

  Proven with unit tests (content addressing, dedup, integrity, buffer-isolation) and validated end-to-end through the real store + sync path (a blob reference round-trips through insert and converges under concurrent replacement). The out-of-band, resumable, chunked byte-transfer channel and persistent backends (OPFS, filesystem/S3) build on top of this reference model.

- Pull a blob's bytes knowing only its reference. This closes the last gap in blob sync: a device that receives a `BlobRef` in a synced record can now fetch the bytes with no separate manifest hand-off.

  - `@korajs/core`'s `BlobRef` gains an optional `manifestHash` — the content hash of the blob's chunk manifest. Because it is a content address like `hash`, the manifest is fetched and integrity-verified over the same channel as the chunks. It rides inside the reference that already syncs in the record, so no new protocol or operation-log surface is needed.
  - `@korajs/store` adds `putBlobForTransfer` (stage chunks + store the full blob + store the manifest as its own content-addressed object, returning a ref that carries `manifestHash`), `resolveBlobManifest` / `fetchBlobManifest` (fetch and verify a manifest by hash before pulling), and the canonical `serializeBlobManifest` / `parseBlobManifest`. The manifest is served over the existing chunk channel with no special casing — it is just another content-addressed object.
  - `korajs`: `app.blobs.put` now stores the manifest and returns a ref carrying `manifestHash`, and `app.blobs.pull` accepts that `BlobRef` directly (resolving the manifest by hash) or an explicit `BlobManifest`. The "attach a file, it appears everywhere" path now needs only the reference from the synced record.

  Proven end to end over the live server relay: a blob authored on device A is pulled on device B from the reference alone — B resolves the manifest by `manifestHash`, then fetches only the chunks it is missing and verifies integrity against the blob hash.

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

- Add a `secret` field type with mandatory trace redaction and field-level cryptography (security core).

  Secrets (passwords, tokens, API keys) get first-class handling instead of living in plain `string` fields that leak into logs and DevTools.

  - `t.secret()` fields choose their at-rest protection with `.hashed()` (one-way, for passwords) or `.encrypted()` (reversible, for tokens); the default is `encrypted`. On input the value is a plaintext string; the framework applies the transform.
  - Merge traces redact secret fields. A secret's value never appears in a `MergeTrace` — not in `inputA`/`inputB`/`base`/`output`, and not inside the embedded `operationA`/`operationB` (whose `data`/`previousData` are redacted too). This closes a real leak where plaintext secrets appeared in DevTools, logs, and audit exports. Non-secret fields are unaffected.
  - `@korajs/core` exposes the field-level crypto primitives (standard WebCrypto, no `@korajs/auth` dependency): `encryptSecret` / `decryptSecret` (AES-256-GCM with a per-value random salt and IV, wrong-key decryption fails), and `hashSecret` / `verifySecret` (PBKDF2-SHA-256, salted, one-way, constant-time verification).

  Secret values merge by last-write-wins on the stored representation (ciphertext or hash), never on plaintext. The write-time transform wiring (apply the hash/encrypt on write via a key provider, decrypt on read) is the remaining integration step; these primitives and the redaction are the security core it builds on.

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

## 0.6.0

### Minor Changes

- Public beta 0.6.0: Vue 3 and Svelte 5 bindings with shared QueryStore, sync-status controller, and richtext controller; `@korajs/core/bindings` shared types; `@korajs/auth` org hooks and providers for React/Vue/Svelte; presence/collaboration hooks; CLI scaffolds; `korajs/vue` and `korajs/svelte` meta-package re-exports; Svelte component precompile and KoraProvider context bridge fix.

## 0.5.0

### Minor Changes

- b909e5a: v0.5 internal beta: structured apply results and sync apply-failure events, audit trace export, benchmark gates in CI, release-gate script, and E2E fixture hardening (SQLite worker + local multi-tab Playwright project).

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

## 0.3.0

### Patch Changes

- 6a05e88: Performance: Replace O(n²) topological sort with binary heap in @korajs/core (19x faster sync for large operation sets).

  New: @korajs/auth package with sessions, TOTP MFA, organizations, RBAC, passkeys, encrypted tokens, and E2E operation encryption (912 tests).

  New: Full Preact-based DevTools UI panel with sync timeline, conflict inspector, operation log, and network status.

  Docs: Comprehensive documentation refinement — added API references for merge, sync, auth, and devtools; added authentication guide; expanded sync configuration guide; updated all package descriptions.

## 0.1.2

### Patch Changes

- Fix template path resolution in create-kora-app and add package READMEs

## 0.1.0

### Minor Changes

- Initial release
