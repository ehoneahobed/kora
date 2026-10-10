# @korajs/server

## 1.0.0-beta.15

### Minor Changes

- 24f5531: Scope grants may be disjunctive: a collection scope is a conjunction of field predicates or `{ $or: [conjunction, ...] }` (up to 8 branches), so "my own records OR records in spaces I belong to" is one grant. Every decision (delivery, live relay, scope snapshots, uploads, reference checks, route queries, presence partition keys, the client's upload pre-check and local scope narrowing) goes through one matcher in `@korajs/core`, which fails closed on any malformed scope. Equivalent grants normalize to one canonical form; a handshake can only narrow each branch. First step of the beta.15 access rules.

  Clients now declare `supportsScopeDisjunction` at handshake. A server refuses a client that does not (Kora beta.14 and earlier) with `CLIENT_TOO_OLD` when its resolved grant contains a disjunction, because an older client would read `$or` as a field name and treat every record as outside its scope. Grants without `$or` are unaffected.

  A grant whose field predicate is an object other than exactly `{ $in: [...] }` (for example `{ $in: [...], $ne: ... }` or `{ $ne: ... }`) is now refused at handshake (`SCOPE_PREDICATE_LIMIT`) instead of being normalized to its `$in` part.

  With a disjunctive upload grant, a write must keep the record in every branch it matched before: a team member cannot move a shared record out of the team into their own branch (moving between branches is a server write). A `null` or non-object collection grant now denies that collection instead of being read as `{}`, and grant normalization keeps `0`, `-0`, `NaN` and `±Infinity` distinct.

- 4ddcff5: Server stores keep a membership index for access rules: one interval per membership, opened and closed at the delivery sequence of the operation that changed it, inside that operation's write transaction (memory, SQLite and Postgres, including Postgres conditional applies). Memberships come from the schema's memberships collection and from the owners of group records (`access.groups`), who are members for as long as they own the record, deleted or not. The index is reconciled from each record's current state, never from deltas, and the whole index is reconciled after a schema change, a transform re-fold and a backup restore: intervals that still hold keep their join sequence, memberships of a newly indexed collection count as held from the start, anything else changes at the current sequence. During a rolling deploy, writes made by an instance still on the previous rules are reconciled when an instance with the new rules starts. `getMembershipIntervals(userId)` reads it. Access rules are still not enforced by the sync server.
- 6fd998a: Experimental: the sync server can enforce access rules (`experimentalAccessRules: true` on the server, `{ accessRulesEnforced: true }` on `store.setSchema`). Uploads to access collections are decided by the rules against the writer's memberships read inside the store's write transaction, so a revoke refuses the next write at once; cascades and rich-text updates follow the same rules. A client insert onto an existing group id is refused (`GROUP_EXISTS`), stamped fields must be present and equal to the writer (`STAMP_REQUIRED`, `STAMP_MISMATCH`), and the memberships collection is server-written (`SERVER_OWNED`). A session's read grant over access collections is compiled from its memberships at handshake (a user always reads their own membership rows); it does not yet follow membership changes until the client reconnects. `server.access.grant`, `revoke`, `transfer` and `sweepExpired` change memberships with logged server writes, and a sweeper ends expired memberships (`accessSweepIntervalMs`). Clients that cannot follow access rules are refused with `CLIENT_TOO_OLD`.
- 946dd42: With `experimentalAccessRules`, the download stream follows membership changes. When a session's stream reaches a change to the user's memberships, it re-reads them and sends what changed as one re-scope unit at that delivery sequence, starting a batch: a narrowing (the grant now in force per access collection, new `accessNarrowing` batch field) that the client applies to the records it holds, judged on its own values and keeping records with unsent writes, then scope entries (current values) for records the user may now read, filtered by the client's query view. Narrowing on the client removes records that moved or were deleted while the user was revoked, which the server cannot name. A group revoked and granted again, or a membership whose role changed in place since the client's watermark (tracked by a new `role_seq` index column, added to existing databases on open), is re-sent in full. History is gated by the open membership interval: a late joiner receives a group's current state, never the operations written before they joined, on a live session, a reconnect and a fresh device alike. What a reconnecting client holds is rebuilt from the membership intervals at its watermark, so a reconnect after changes made while offline resumes from the watermark. Access collections are reported to clients as unrestricted, so a client's view and its watermark stay the same across membership changes; the server alone enforces the grant. Records leaving an access collection's grant are always retracted. The delivery poll refreshes each session's memberships, so rich-text, presence and blob channels follow a change within one poll interval even when a client's stream is not progressing. `server.access.grant` no longer writes `expiresAt` when the memberships collection does not declare it.

  Rule types (`OwnerRule`, `MemberRule`, `OrRule`, ...) are exported from `@korajs/core` and `korajs`, so a schema module with declaration emit can export a schema that uses access rules.

  `@korajs/sync` applies a batch's `accessNarrowing` before its retractions and operations (`SyncStore.applyCollectionNarrowing`, implemented by `@korajs/store`); a failure stalls the delivery watermark so the batch is re-sent.

  A device keeps the key of the read rules it was last fully re-scoped under (`accessRulesKey`, sent at the handshake and carried by the batch that re-scopes it); a server running other read rules (a deploy, or another instance mid-rollout) narrows every access collection and sends everything it may read again, and a collection whose rules were dropped is re-sent under the session's own scope. Index reconciles, which write no operation, take a delivery sequence of their own, and the stream advances caught-up clients past it. When a client's own accepted write leaves an existing record outside what it may read (a write rule broader than the read rule), the server retracts that record from the client; records the client created stay. Records a narrowing kept for unsent writes are remembered on the device and removed once those writes are refused, unless the server sent them again meanwhile.

- 5a2e9df: Access rules: `createProductionServer` exposes the access API as `server.access` and to custom routes as `request.access`, so an "accept invitation" route can grant a membership; `AccessApi`, `GrantInput`, `GroupRef` and `AccessApiError` are exported from `@korajs/server`. New guide: Access Rules.
- 28ec1ef: Shared links preview the page they point at. New `shellMeta` option on `createProductionServer` writes each URL's title, description and Open Graph tags into the app shell (values escaped; `null` or a throw serves the shell unchanged), with `applyShellMeta` and `metaExcerpt` exported. Link-preview crawlers and search engines asking for `*/*` now get the shell for extensionless app routes instead of a 404 (an app's own `fetch()` and paths under `/api/` and `/__kora` keep real 404s; `spaFallback: 'strict'` restores the beta.14 behavior). Custom routes may answer `html` or `raw` bytes as well as JSON.

### Patch Changes

- Updated dependencies [24f5531]
- Updated dependencies [6c72c04]
- Updated dependencies [6fd998a]
- Updated dependencies [946dd42]
- Updated dependencies [8667762]
  - @korajs/core@1.0.0-beta.15
  - @korajs/sync@1.0.0-beta.15
  - @korajs/merge@1.0.0-beta.15

## 1.0.0-beta.14

### Patch Changes

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

- 8b7de83: Make the `$in` scope predicate limit configurable (F17): `maxScopePredicateValues` (default 100)
  in the sync server options. Large grants got cheaper: membership in a normalized `$in` list of 32
  or more values is a set lookup instead of a scan, the canonical order no longer uses
  locale-aware comparison, and session revalidation compares already-normalized grants without
  normalizing them again. `pnpm --filter @korajs/server bench:scope-in` measures handshake,
  revalidation and delivery cost for 100, 1,000 and 5,000 values on SQLite and Postgres.
- 4ec1bc5: Protocol 1 (beta.12 clients), `experimental.legacyMerge` and the `allowLegacyAnonymousClaims`
  default stay as in beta.13: each would break part of the beta.12 upgrade path this release
  completes. The deprecation messages now say a later release refuses them, announced in its notes.
- f0f5375: Automatic device handover after a beta.12 server upgrade (F1). A signed-in device presenting a
  node id with history but no owner (beta.12 recorded no node claims), or one an administrator
  released, now claims it when the node id equals the device id the auth provider verified for that
  user (`metadata.deviceId`, from the token's `dev` claim with `@korajs/auth`). `@korajs/auth` apps
  no longer need the bind script: refused devices reconnect and their queued writes upload. The
  claim is one atomic store step, the new optional `ServerStore.claimUnownedNode` (SQLite, Postgres
  and memory); a node another principal owns is never taken, and another user presenting the node
  id is still refused. Logged as `node_claim.handover`; `deviceNodeHandover: false` restores the
  beta.13 refusal. The legacy anonymous re-claim uses the same atomic step when the store has it.
- 2c35276: New `findJsonStringValues(store)` diagnostic (F14): after an upgrade from a server older than
  beta.13, it lists the `t.json()` / `t.object()` fields whose rows hold JSON-encoded strings (which
  old servers decoded one layer of when building rows), with counts and sample ids. Values are not
  rewritten automatically, since a string is also a valid json value.
  It refuses a `pageSize` that is not a positive integer (`InvalidDiagnosticOptionsError`), which
  would otherwise loop forever.
- a1e5765: A `NODE_ID_CLAIMED` refusal now says whether another user owns the node
  (`nodeOwnership: 'other-principal'`) or it only has history with no recorded owner
  (`'unowned'`). A store with a pinned node id (the `createKoraAuthSync` device id) cannot move to
  a fresh node, so after `'other-principal'` it refuses local writes (`NODE_OWNED_BY_ANOTHER_USER`)
  instead of storing them under a node whose writes could only upload as its owner; the server
  accepting the node again lifts it. An `'unowned'` refusal (a beta.12 node awaiting handover or a
  bind) keeps writes on.
- ddafafb: Relay presence per record (F16). An awareness state whose cursor names a record now reaches every
  session whose download scope contains that record, the rule the Yjs doc channel already used, so
  collaborators with different grants see each other's carets on the documents they share. A cursor
  on a record the sender cannot read, or a malformed cursor, reaches nobody. A state without a cursor
  stays within sessions holding the identical download scope and never reaches or leaves anonymous
  sessions. A session shown an earlier state that it may no longer see receives a removal.
  `AwarenessRelay.handleUpdate` takes an optional audience callback. When the record a
  cursor names changes on the server (an upload, a server-authored write, or a write through another
  instance), the audience is decided again (`AwarenessRelay.updateAudience`): sessions that may no
  longer read the record get a removal and later catch-ups skip it.
- 4ec1bc5: Presence and side-channel writes are decided on the stored record (F16, round 3).

  - A delivery pass's prefetched rows are passed down the pass instead of held on the session, so
    nothing running meanwhile reuses them. Before, a Yjs doc update could be authorized against a
    row the pass read before the record moved out of the writer's grant, and reach the new owner's
    devices; an upload's reference check and the presence decisions could read such a row too.
  - Presence re-decisions after a write run one per record and never let an older read finishing
    last override a newer one; a cursor whose record moved while it was being read is read again.
    A row that writes keep overtaking is never used: the state is shown to nobody until a read
    that no write overtook decides it.
    Every write is noted before presence reads, through a shared `PresenceRecords` reader: one store
    read per burst of writes to a record however many cursors name it, cached until a write touches
    the record (one second at most), at most 16 at once.
  - An awareness update the relay drops (stamped with another client's id) no longer repoints the
    sender's presence at the record it named. New `AwarenessRelay.accepts`.

- f0f662d: `createProductionServer` no longer serves operational endpoints without a token in production
  (F5). With `NODE_ENV=production`, a group whose token is unset (`/__kora` dashboard and status,
  metrics, backup export and import) answers `403 OPERATIONAL_ENDPOINT_DISABLED`;
  `operationalAuth.allowPublic: true` restores the old behaviour on purpose. Every start logs
  `server.operational_endpoints_unprotected` when a group has no token.
- ecb9e77: Add `refreshScopes(userId)` to `KoraSyncServer` and the `ProductionServer` handle, and expose
  `revalidateSessions()` on `ProductionServer`. After a membership change, an app re-resolves the
  user's grant at once instead of waiting for the 30-second revalidation: sessions whose scope
  changed end with a retriable `SCOPE_CHANGED`, reconnect with the new grant and apply their
  `scopeExit` policy. A session still in its handshake re-checks once established.
- 3ce9411: New `spaFallback` option on `createProductionServer` (F7): `'extensionless'` answers every
  missing path without a file extension (outside `/assets/`) with the app shell, so a service
  worker can warm app routes with a plain `fetch(url)`. The default, `'navigation'`, keeps the
  shell for browser navigations only, and the guide shows the `Accept: text/html` header that
  makes a service-worker fetch count as one.
- 7e3df2f: One default location for the template databases (F8, F10): every template, the Tauri one
  included, now uses `./.kora/kora-server.db` and `./.kora/kora-auth.db` in `server.ts`,
  `.env.example` and its README (the Tauri server used `./kora-server.db`, and two different
  auth paths). `createSqliteServerStore`, `createSqliteUserStore` and `createSqliteOAuthStores`
  create the directory of their database file, so these defaults work on a fresh checkout.
- 267fa9f: A unique constraint's `where` now also selects the records a write is compared against, on
  devices and on the server: in "unique `slug` among `status: 'published'`" a draft no longer
  collides with a published form. When a write moves a record into the group and creates a
  duplicate (publishing a draft whose slug is taken), the server undoes that write (the status
  change) instead of deleting the record, and the winner is decided by when each record entered
  the group.
- 9c153b1: Restore the warning for signed-in servers that share every user's data (F4). beta.13 judged the
  provider's raw grant, and the built-in provider always returns a claims grant, so the warning never
  fired even when no schema sync rule bound it and every collection was granted whole. The server now
  judges the resolved grant. New `unscopedSharing` option: `'warn'` (default, once per provider),
  `'allow'` (silence it for apps whose users share one data set) or `'refuse'` (refuse the handshake
  with `UNSCOPED_SHARING_REFUSED`).
- Updated dependencies [afe97c6]
- Updated dependencies [99cedc4]
- Updated dependencies [8b7de83]
- Updated dependencies [4ec1bc5]
- Updated dependencies [a1e5765]
- Updated dependencies [267fa9f]
  - @korajs/sync@1.0.0-beta.14
  - @korajs/core@1.0.0-beta.14
  - @korajs/merge@1.0.0-beta.14

## 1.0.0-beta.13

### Major Changes

- **Breaking. Security:** nothing is accepted before the authenticated handshake
  (`HANDSHAKE_REQUIRED`); scopes are granted by the server and a client can only narrow them
  (`SCOPE_REQUIRED`); writes are authorized against the stored and resulting record, never
  client-sent `previousData`; operations must come from the session's own, per-user claimed node
  (`NODE_ID_MISMATCH`, `NODE_ID_CLAIMED`); uploaded ids are verified (`INVALID_OPERATION_ID`,
  `FORGED_DUPLICATE`); no client can act as the server (`INVALID_NODE_ID`); rich text, presence,
  blobs and foreign keys are isolated per tenant; history is visible per operation scope;
  revocation ends live sessions on every instance.
- Every stored operation carries a delivery sequence; first sync streams with backpressure;
  unreadable rows are quarantined; records are materialized with the core fold, and fields added
  later read their schema default.
- Protocol-1 (beta.12) clients are accepted for this release, with a deprecation warning.
- Encryption key service (`kora_encryption_keys`), optional `encryption: { required: true }`, key
  records in backups.
- Bounded sessions: message, batch, operation and body size limits, heartbeats, `maxConnections`,
  per-user rate limits; `X-Forwarded-For` is trusted only through `trustProxy`.
- One-time migration on first start (Postgres sequence columns to `BIGINT`, new tables, scope
  backfill, log-integrity scan, full fold); `ServerStoreUnavailableError` for an unreachable
  Postgres.
- Security fixes are described in the [security advisory](https://github.com/ehoneahobed/kora/blob/main/docs/releases/security-advisory-beta13.md).

See the [1.0.0-beta.13 release notes](https://github.com/ehoneahobed/kora/blob/main/docs/releases/v1.0.0-beta.13.md) and the [upgrade guide](https://github.com/ehoneahobed/kora/blob/main/docs/guide/upgrading-to-beta13.md) (servers first, then clients).

### Patch Changes

- Backup restore applies a newer revision of an encryption key record (replace mode takes the backup's record; merge mode advances an older record of the same ring) instead of keeping a stale one.
- The static file server serves a file, directory index or pre-compressed sibling only when its real path is inside the real `staticDir`; symlinks that escape it return 404.
- SQLite server stores keep hand-written CHECK constraints when relaxing beta.12 enum checks.

## 1.0.0-beta.12

### Minor Changes

- Fix false idle delivery stalls and add directional authorization and retractions.
- Treat uplink `SCOPE_VIOLATION` as a permanent per-operation rejection, acknowledge through it,
  continue evaluating the batch, and expose received-batch, newly materialized, duplicate, and
  rejected-operation counters.

## 1.0.0-beta.11

### Minor Changes

- Support canonical, bounded server-authoritative `$in` scope predicates across
  handshake, downlink, relay, backfill, and uplink validation. Empty `$in` is an
  explicit deny and excessive predicates fail closed.

## 1.0.0-beta.10

### Patch Changes

- Make SQLite delivery sequencing cross-instance safe by moving delivery sequence
  allocation from an in-memory counter to a durable `delivery_counter` table.
  Multiple `SqliteServerStore` instances sharing one database now allocate unique,
  monotonic delivery sequences, and backup restore reseeds the same counter.
- Add configurable `relayRetransmitIntervalMs` and `deliveryPollIntervalMs`
  options to `KoraSyncServerConfig`. The default remains 2000ms for backward
  compatibility, and `0` disables the corresponding periodic task.
- Split delivery-watermark polling from legacy relay retransmit. Live sync
  servers now poll the authoritative delivery log and wake connected
  delivery-watermark clients, so valid operations appended through another store
  instance can be delivered without restarting the server.
- Reject production-server listen errors instead of leaving `start()` pending
  forever when the port cannot be bound.

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
