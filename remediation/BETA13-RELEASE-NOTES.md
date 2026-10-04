# Kora 1.0.0-beta.13: security, data-safety and convergence release (draft)

> Draft. Publish together with `remediation/SECURITY-ADVISORY-DRAFT.md`. This release is **breaking** by design: the maintainer approved breaking changes to close multi-tenant security holes found in beta.12 and to make every replica compute the same data.
>
> beta.13 is the first release after 1.0.0-beta.12 and contains the whole remediation programme (Phases 1 to 4). The Phase 1 merge (33bca46) was never published; where these notes say "beta.12" they mean beta.12 and every earlier release.

## Why upgrade

beta.12 let a client of a multi-user sync server read and modify other users' data, could silently lose writes in common offline flows, could leave devices and the server permanently disagreeing about a record, and its end-to-end encryption never worked across devices. beta.13 fixes all of it:

- **Security (Phase 1):** every known P0 multi-tenant hole is closed. The server decides who may sync and write what.
- **No silent data loss (Phase 2):** every write is durable, sequenced, uploaded once, and either applied or visibly refused.
- **One fold, everywhere (Phase 3):** every replica (device, server, restored backup) computes a record with the same deterministic per-field CRDT fold, so replicas holding the same operations hold the same record. Protocol v2 carries verifiable operation ids and a bound encryption envelope.
- **Encryption, types and developer experience (Phase 4):** encryption works across a user's devices, `insert`/`where`/`orderBy` are typed from the schema, scaffolded apps open offline, and the legacy paths are verified against the real beta.12 (clients, servers and databases upgraded in place).

Each fix is proven by a reproduction test that failed before it (`remediation/tracker.json`, `remediation/STATUS.md`), and every phase was attacked by independent red-team rounds whose findings were fixed by root cause.

## Security

- **The handshake comes first.** The sync server refuses every message until the authenticated handshake completes (`HANDSHAKE_REQUIRED`). This covers operations, acknowledgments, rich-text, presence and blobs, on both WebSocket and HTTP.
- **The server decides what you may write.** Authorization uses the stored record and the resulting record, never values the client sends (`previousData`). It is re-checked inside the store's write path on memory, SQLite and Postgres.
- **The server decides what you may sync.** Scopes are granted by the server from verified identity, and a client handshake can only narrow them. Unresolved bindings and null/undefined grant values fail closed (`SCOPE_REQUIRED`, `INVALID_SCOPE_PREDICATE`). A token provider that returns no scopes on a schemaless server now syncs unscoped with a one-time warning instead of silently granting nothing (RT-89); multi-tenant deployments must give the server the schema or explicit scopes.
- **Devices own their node ids.** Operations must come from the session's own node (`NODE_ID_MISMATCH`). Node ids are claimed per user, and anonymous devices get a secret node token.
- **No device can act as the server** (RT-61). A handshake presenting any `kora:` node id, the server's node id or an authoritative id (current, legacy or revoked) is refused `INVALID_NODE_ID`. Server authority is a property of the reserved `kora:server:` namespace; extra authorities are explicit, persisted and revocable (`revokedAuthoritativeNodeIds`, RT-81).
- **Every uploaded id is verified** (CORE-1, RT-64). An operation id is the content hash of what it declares; a mismatch is refused `INVALID_OPERATION_ID`. Server-derived ids (cascades, set-nulls, corrections) are keyed with a deployment secret, so no client can predict one.
- **A duplicate must be the same operation** (RT-77). An upload that reuses a stored id is a duplicate only when every hashed field is equal; otherwise it is refused `FORGED_DUPLICATE` with no effect, logged, emitted (`sync:forged-duplicate`) and counted.
- **Side channels are isolated per tenant.** Rich-text updates, presence and blobs are authorized and delivered only within scope. Blob references must point at content the writer can read or has uploaded.
- **References to other tenants are refused.** Foreign keys must point at parents inside the writer's scope. Cascades are authorized, and restrict refusals reveal nothing (`RESTRICTED`).
- **History stays with its owner.** Visibility is judged per operation, from the scope values recorded when it was applied, so ownership transfer does not disclose earlier history. Records moving into scope arrive complete.
- **HTTP long-poll sessions are bound to the user.** Every request is authenticated, using a server-issued session id (`x-kora-session`).
- **Credentials are revocable everywhere.** One `authenticateAccess` check guards every route. Device and user revocation take effect immediately and across server instances; live sessions are ended on revocation, expiry or scope change. Refresh rotation is atomic and safe across tabs.
- **Account flows are hardened.** OAuth state is bound to the browser and purpose; invitations require the verified invited email; MFA is enforced at sign-in; reset tokens are never disclosed; sign-in timing no longer reveals whether an account exists, and rate limiting is per account and per IP; webhooks are signed with a timestamp and refuse private targets; passkeys require user verification.
- **Local store queries are injection-safe** (SEC-7, SEC-9b). `orderBy` direction is whitelisted, `limit`/`offset` are bound parameters, and DDL defaults and enum checks are quoted by one literal generator.
- **Defaults are safer.** Tokens are no longer sent in WebSocket URLs, `X-Forwarded-For` is trusted only from configured proxies, and messages, batches, operations and blob uploads have size limits.

## Data safety

- **Offline users stay signed in.** Network errors, timeouts, 5xx responses, rate limits and captive portals no longer sign anyone out or destroy tokens. An explicit `authenticated-offline` state opens the user's own database offline.
- **Every local write gets a unique sequence number.** Single writes, `app.transaction` entries and cascades go through one write path that reserves sequence numbers inside the commit. Concurrent transactions no longer share numbers, and concurrent atomic increments no longer lose updates.
- **An operation counts as synced only when the server has it.** Uploads are tracked per batch, and the device keeps a contiguous "stored on the server" prefix. Pending counts are accurate and `waitForSettled` resolves promptly.
- **Nothing is uploaded before it is durable on the device.** If local storage keeps failing, uploads continue and the status reports `localDurability: 'degraded'`. Kora never silently runs in memory: it emits `store:durability-lost` and refuses writes unless you opt in.
- **Nothing delivered is skipped.** Server-to-client delivery is a gap-free stream with a durable watermark. Operations the device cannot apply yet (unknown collection, failed decrypt, far-future timestamp, a schema it cannot transform yet) are kept in a durable quarantine and replayed, never silently dropped.
- **Refused stays refused, and is undone on its author.** A permanently rejected write is never applied later; the author re-folds the record without it and converges to the server, and `sync:operation-rejected` explains it.
- **Edits outside your upload scope are reported** (`OUT_OF_UPLINK_SCOPE`) instead of silently staying local.
- **Devices and servers recover from each other.** A device that lost its newest writes gets them back from the server. A server restored from an older backup gets the missing writes re-uploaded. Cloned databases are detected and moved to a fresh node.
- **Writes belong to the user who made them.** On shared devices, writes are bound to the signed-in user and are never uploaded under another account. Writes whose author cannot be known are held and reported for the app to assign or discard.
- **Retiring a schema transform can no longer erase data** (RT-103). Server stores and local databases refuse to start (`OperationTransformCoverageError`, `OPERATION_TRANSFORM_MISSING`, naming the versions) when a schema version in their operation log has no transform path to the current schema, instead of folding those operations as absent. Keep every transform registered.
- **One meaning for `where` values, one query key** (RT-102). `undefined` adds no condition (it is dropped, also when it would have overridden an earlier condition), `null` means `IS NULL`, and `NaN`/`Infinity` throw `QueryError`. The store's query cache and the React, Vue and Svelte bindings use one canonical key (`queryKey`), so two components never share results of different queries. Behaviour change: `where({ field: undefined })` used to match nothing; it now matches everything the rest of the query matches.
- **Every tab's live queries see every change** (RT-98). A refused write undone in the syncing tab, a scope retraction, settled cascades, re-folds, re-materialization and backup restores now refresh the live queries of the other tabs on the same database too (one "records changed" funnel from the store's commit path feeds the cross-tab bus).
- **Tabs and OPFS.** Closed tabs' writes are uploaded by the next tab (`isolation: 'per-tab'`). Each OPFS database has its own storage pool held under a Web Lock; a hung or frozen leader tab no longer blocks other tabs. Many per-user databases on one device no longer stop all writes.
- **Kora never deletes your data on its own.** `app.storage.listDatabases()` and `deleteDatabase()` refuse to delete a database with unsynced writes. Storage persistence is requested in the background and never blocks `ready` (`app.storage.persistence`, NEW-STORE-4).
- **Secret fields are protected in transactions**, and writes after `app.transaction` are no longer wrongly reported as synced.
- **Every accepted value is stored unchanged** (RT-86, RT-87). One value domain is enforced at write time on every replica; a value a database still refuses is a per-operation `UNSTORABLE_VALUE` refusal, never a wedged upload stream. U+0000 and lone surrogates are stored losslessly on the server (RT-65). Oversized operations throw `OperationTooLargeError` before anything is written.
- **Backups restore exactly** (STORE-5, RT-66). Restores keep timestamps and never copy the source device's identity; backup format 2 carries fold base states and compacted history; merge and replace restores on another device (also offline) keep every record and field. Merge-mode imports never apply the server's own decisions from a file.
- **The server is gap-free, bounded and exact.** First sync streams in chunks with backpressure (100k ops: peak heap 18.7 MB to 4.8 MB); dead connections are detected by heartbeats; Postgres version vectors are read from the database, duplicates are refused atomically, sequence columns are BIGINT; the startup log-integrity scan quarantines unreadable rows instead of folding them; restarts re-fold only stale records, and re-materialization never overwrites live writes during a rolling deploy (NEW-SRV-4, NEW-SRV-5). An unreachable Postgres makes `createPostgresServerStore()` reject with `ServerStoreUnavailableError` instead of an unhandled rejection (RT-88).

## Merge semantics

Every replica now computes a record with one deterministic per-field CRDT fold (`@korajs/core` `mergeOp` / `foldRecord`). A record depends only on the set of operations a replica holds, never on their arrival order. These are deliberate changes in what merged data means; each one was a case where replicas could disagree permanently in beta.12.

- **Arrays are multisets merged per element occurrence.** Duplicates are kept (`["a", "a"]` stays two elements; removing one copy removes one). The merged order is the order elements were first added. A removal beats a device that merely kept the element (MERGE-1, NEW-MERGE-1).
- **Objects / json merge per top-level key**; values nested under a key are replaced as a whole (last write wins).
- **Re-sending an unchanged field is not a write.** An update whose value equals its own `previousData` no longer wins last-write-wins for that field.
- **Custom resolvers** are called once per write, in HLC order, with `local` = the value merged so far, `remote` = the write's value and `base` = the write's `previousData`. They no longer need to be commutative. A throwing resolver, or one returning a value with no JSON form, falls back to the write's value and is reported on the merge trace.
- **Insert onto an existing record merges per field** instead of resetting fields the insert does not carry. An update whose insert never arrived does not create a row.
- **`merge('server-authoritative')` lets the server win**: writes by `kora:server:` nodes and the explicit authoritative ids beat any device write of the field regardless of HLC.
- **`merge('counter' | 'max' | 'min' | 'append-only')` fold over every write**, so three or more concurrent writers no longer lose updates. `op.append` of a value already present adds a copy; `op.remove` removes every copy the writer saw.
- **Delete vs update is unchanged**: the later of the newest delete and the newest write decides. Cascades of a remote delete are stamped right after the delete, so a later write to the child wins on every replica. Receiving devices no longer upload cascade copies: a remote delete's cascades are local provisional effects, settled when the server's copy arrives or the delivery stream catches up, including after every applied stream batch while connected (RT-69, RT-93, RT-94).
- **Scope entries join the server's fold state** (`op.foldState`), so counters, richtext, resolvers and arrays keep a device's concurrent edits when a record enters its sync scope.
- **Schema transforms run at fold time** (RT-84, RT-85). Operations are stored and synced exactly as written; every replica judges and folds the operation's view (`operationSchemaView`). Pass the same transforms to the sync server (`operationTransforms`) and to `createApp` (`sync.operationTransforms`).
- **Cross-record constraints are decided by the server** (refusal at ingest, then corrections); devices no longer resolve them locally.
- **One canonical operation body** (RT-79, RT-80, RT-83). `update(id, { field: undefined })` clears the field (as beta.12 applied it); a `Date` inside a json value is its ISO string; values with no JSON form (`Map`, `Set`, class instances, `NaN`, cycles) are refused at validation with `NON_CANONICAL_VALUE` instead of silently becoming `{}`.
- **Re-materialization on upgrade.** The first open with beta.13 rebuilds every record from its log (`store:rematerialized`), repairing devices that diverged under beta.12; visible values can change on such devices. A compacted log uses the current rows as base snapshots, listed by `store.getSnapshotRecords()` until one full resync brings their history back. Changing a field's merge kind re-folds that collection once (RT-63). Compaction is safe (STORE-14).
- **Comparing with the old pipeline.** For this one release, `createApp({ experimental: { legacyMerge: true } })` runs the beta.12 pairwise pipeline instead. Switching it on or off re-materializes the database on open. It is removed in the next release, together with the deprecated `MergeEngine` and `addWinsSet` exports of `@korajs/merge`.

## Protocol v2 and encryption

- **Protocol v2** is one wire bump carrying every wire change: content-hash version 2 ids (covering `previousData`, `sequenceNumber`, `causalDeps` and `schemaVersion`, with `hashVersion` on the wire), the encryption envelope v2, sequence reservation, and server-authored metadata (`authoritativeNodeIds`, `revokedAuthoritativeNodeIds`, `foldState`). Reference: `docs/guide/sync-protocol.md` (fields, protobuf numbers, compatibility matrix).
- **Protocol-1 (beta.12) clients are accepted by beta.13 servers for this release only**, with a deprecation warning (`session.protocol_deprecated`, `sync:protocol-deprecated`). Their version-1 ids are verified where beta.12's hash form can be rebuilt (`undefined` members, binary values, a `Date` inside a json value, RT-71, RT-90); the rest are stored unverified for that session's own node (`unverifiedLegacyOperations`). The next release refuses protocol 1.
- **Protobuf is lossless and no longer negotiated** (SYNC-9). Clients speak JSON; `ProtobufMessageSerializer` is an explicit choice on both ends of a transport you control. The unused `DynamicProtobufSerializer` is removed (NEW-DX-2).
- **Encryption works across devices** (ENC-1). Every user has a keyring of random 256-bit data keys, wrapped by a key derived from the user's passphrase (PBKDF2-SHA256, 600,000 iterations, per-user salt). The server stores only the wrapped record (`kora_encryption_keys`, compare-and-set) and serves it before any operation is exchanged; it never holds a usable key. Every device of a user decrypts everything the others wrote. New: `app.encryption` (`unlock`, `lock`, `getStatus`, rotation, passphrase change, optional recovery key), the `encryption:status` event, `sync:suspended` with reason `encryption-locked`.
- **The envelope is bound to its operation** (ENC-3, NEW-ENC-1). Ciphertext lives in `op.encrypted` with AES-GCM additional data binding operation, record, member and key version; schema-aware servers store it opaquely, on memory, SQLite and Postgres. With encryption enabled, plaintext and protocol-1 payloads are refused (`PLAINTEXT_REJECTED`, `LEGACY_ENCRYPTED_PAYLOAD`) unless `allowPlaintextMigration` is set; the server can enforce the same (`encryption: { required: true }`).
- **Enforced foreign keys must be cleartext** under encryption: `createApp` refuses a sealed cascade/set-null/restrict foreign key with `SealedRelationFieldError`, so the server can enforce referential rules for every device.

## Types

- **Records and inputs are typed from the schema** (DX-1). Required, optional, defaulted and auto fields are distinct: `insert` requires required fields, omits auto fields and refuses `null` for optional ones; records read optional fields as `T | null` and `t.timestamp()` as number milliseconds; updates accept `op.*` sentinels where they apply.
- **Queries and hooks are typed** (DX-2). `where`, `orderBy` and `include`, transactions and `useCollection` are typed; `korajs/react` exports `createKoraHooks<typeof app>()`. `createdAt` / `updatedAt` are queryable (STORE-11). After `include()`, `where` and `orderBy` accept only the collection's own fields, never the included relation (RT-100). The flagship React template uses the typed path.

## Developer experience

- **Reactive queries notify only on real changes and report errors** (STORE-12): results are diffed per field kind; `subscribe(cb, { onError })`, the `query:error` event and `getError()` on query stores replace swallowed failures.
- **React hooks are stable and SSR-safe** (DX-5, DX-6, NEW-DX-1). `useMutation`, `useSyncStatus` and `useRichText` keep stable identities (no resubscribe per render, StrictMode-safe); `useQuery`, `useMutation`, `useSyncStatus` and `useCollaborators` render on the server. `createApp` is inert where there is no `window` (`ServerRenderingAppError` on `app.ready`; see the Next.js App Router guide).
- **Vue and Svelte queries follow their inputs** (DX-7): Vue `useQuery` takes refs or getters; Svelte query stores take a readable query.
- **Clear errors early.** `findById` before `ready` throws `AppNotReadyError` like every other call (DX-4); a collection shadowed by an app property warns once in development (DX-9); a write too large for the server throws before it is written.
- **Documentation matches the code** (DX-3). Every guide and API reference was checked against the source; documentation code blocks are typechecked; there is an error-code reference; `korajs` re-exports only the everyday core API.

## Tooling and offline app shell

- **Scaffolded apps open offline** (NEW-DX-3). The `koraServiceWorker()` Vite plugin (`@korajs/cli/vite`, used by the templates) precaches the app shell and the SQLite WASM files at build time; navigations fall back to the cached shell, sync and auth endpoints are never cached, and updates wait for the user's consent.
- **The production static server is correct** (NEW-SRV-8, RT-99): content-derived ETags (a SHA-256 of the bytes, so a redeploy with unchanged sizes and normalised mtimes is never answered 304; revalidated files ignore `If-Modified-Since`; compressed bodies are cached per content hash and pre-compressed siblings are used only when they hold the current bytes), brotli/gzip, immutable caching only for content-hashed names, real 404s for missing assets (SPA fallback only for navigations), and correct MIME types including `.webmanifest` and `.wasm`.
- **`kora deploy` offers only working platforms** (DX-8): Render and Docker are labelled "coming soon" and refused before anything is written.
- **Postgres tests run under vitest** (RT-30), and the store benchmarks measure the real browser path (STORE-16). The browser worker no longer claims WAL on OPFS (NEW-STORE-11).

## Breaking changes and how to migrate

**Upgrade order: servers first, then clients.** A beta.13 server accepts beta.12 clients for this release (with the exceptions in the table). A beta.13 client against a beta.12 server syncs plaintext only, without verification or encryption: do not run that way.

| Change | What to do |
|---|---|
| Sync scopes are granted by the server | With `@korajs/auth`: schema-scoped collections bind to the verified `userId` automatically. Supply other bindings with `scopeValues: async ({ userId }) => ({ orgId })` or a full `resolveScopes`. Custom providers must return scopes for scoped collections, or sessions are refused with `SCOPE_REQUIRED`. Client `syncScope` can only narrow. A schemaless server with a token provider that returns no scopes syncs unscoped: give multi-tenant servers the schema (`store.setSchema`) or explicit scopes. |
| Clients cannot move records out of their scope | Use a server route (`request.kora` without scope, or an admin path) for ownership transfer. |
| Ops must come from the session's own node; node ids are claimed per user | Use a fresh node id per signed-in user on shared devices. Anonymous clients must persist the issued node token. While `allowLegacyAnonymousClaims` is `true` (default in beta.13, `false` from the next release), anonymous devices whose node predates claims, including every node of a beta.12 server database, are re-issued with a warning. |
| Upgrading a beta.12 server database with authentication | beta.12 recorded no node claims, so signed-in devices are refused `NODE_ID_CLAIMED` for nodes with history. A beta.13 client moves to a fresh node automatically and uploads what the old server never acknowledged. A beta.12 client cannot: release its node with `server.releaseNodeClaim(nodeId)` (procedure in the production-server guide), or upgrade the client with the server. |
| HTTP long-poll protocol | Your HTTP endpoint must pass `sessionId` (from the `x-kora-session` header) and `authorization` to `handleHttpRequest`, and return `x-kora-session`. Cross-origin endpoints must expose that header. Upgrade old HTTP clients. |
| Token not in the WebSocket URL | Set `tokenInUrl: true` only if a proxy requires it. |
| `request.ip` behind a proxy | Set `trustProxy` (hop count or CIDR list). |
| Persistent auth stores required in production | Use `createSqliteUserStore` / `createPostgresUserStore` (revocation storage included), or set `allowInMemory: true` deliberately. |
| `TokenRevocationStore` interface | Custom stores must implement `consume`, `isConsumed` and revocation cut-offs. `isDeviceRevoked` is removed. |
| OAuth | Callbacks need the flow binding (cookie). Linking starts at `POST /auth/oauth/:provider/link/start`. |
| Invitations | Custom OrgStores implement `listMyInvitations(userId)` and `revokeInvitation(orgId, id)`. |
| MFA | MFA users get `MfaRequiredError` at sign-in and complete it with `verifyMfa`. |
| Webhooks | The signature format is `t=…,v1=…`. Verify it with the timestamp tolerance. |
| Passkeys | User verification is required by default. |
| Password reset | Configure `onResetRequested`. Tokens are exposed only with `exposeTokenForDevelopment` (never in production). Wire `onPasswordChanged: authServer.revokeAllForUser` and `new AdminApi({ revokeAllForUser })`. |
| Blob references | A blob field may reference only content you can read or have uploaded. Clients upload bytes before the operation that references them (automatic). Bytes uploaded before the upgrade have no owner: existing references keep working, new references need a re-upload. |
| Durable storage | If OPFS or IndexedDB durability cannot be obtained, writes are refused with `StorageDurabilityError`. Set `store: { allowNonDurable: true }` to accept in-memory storage knowingly. |
| Limits | WebSocket messages over 32 MiB are refused (`maxMessageBytes`); batches are capped at `maxOpsPerBatch` (1000); operations at `maxOperationBytes` (256 KiB; set `store.maxOperationBytes` in `createApp` to match the server); blob pushes and requests are limited (`blobLimits`). |
| Value domain | `t.timestamp()` accepts only integer milliseconds in the `Date` range; `t.number()` refuses `±Infinity`; json/object values nest at most 64 levels and may not hold `__proto__`; values with no JSON form (`Map`, `Set`, class instances, `NaN`, cycles) throw `SchemaValidationError` (`NON_CANONICAL_VALUE`). Route writes are held to the same domain. |
| Merge semantics | Arrays are multisets, objects merge per top-level key, custom resolvers run once per write in HLC order (see Merge semantics). Review custom resolvers. `experimental.legacyMerge` compares against the beta.12 pipeline for this release only. |
| Schema transforms | Transforms run at fold time and must be pure; they may rewrite only `data`, `previousData`, `atomicOps` and `schemaVersion`. Pass the same `operationTransforms` to the sync server and to `createApp`. |
| Server node id | The store `nodeId` option is deprecated: the server authors under `kora:server:<deploymentId>:<instanceId>`. A configured value becomes a legacy authoritative id. Set a distinct `instanceId` per Postgres instance only if you need a stable one. Removing an id from `authoritativeNodeIds` does not revoke it: use `revokedAuthoritativeNodeIds`. |
| Encryption | Use `sync.encryption: { enabled: true }` and `app.encryption.unlock(passphrase)` (or `key`). The server must be beta.13 (key service, protocol v2). beta.12 encrypted data was never readable on another device: rewrite such records from a device that holds them. Encrypted beta.12 clients cannot sync with a beta.13 server. List the foreign keys of enforced relations in `cleartextFields`. |
| Scope helpers | `previousData` is ignored unless you pass `{ includePreviousData: true }`. |
| `AuthSyncState.token` | May be `null` while authenticated-offline. `AuthBoundKoraProvider` gains a `locked` state. |
| SSR | `createApp` is inert without `window`; opt out with `ssr: false` or an explicit `store.adapter: 'better-sqlite3'`. |
| Deploy | `kora deploy` refuses Render and Docker (coming soon). |
| Protobuf | Not negotiated any more; `DynamicProtobufSerializer` is removed. |
| One-time client migration | On first open: duplicate sequence numbers are repaired, old index names replaced, OPFS databases moved into per-database pools, every record re-materialized from its log, beta.12 `undefined` clears made explicit, and each device re-uploads its own history once (the server deduplicates it). A tab still running beta.12 makes the upgraded tab wait (`store:storage-blocked`): ask users to close other tabs. |
| One-time server migration | Postgres converts sequence columns to BIGINT (an exclusive table rewrite, once; schedule it). New columns and tables (`scope_snapshot`, `blob_owners`, `node_claims`, `kora_server_meta`, `operation_resolutions`, `sequence_pairs`, `operations_quarantine`, `kora_encryption_keys`, fold state) are created automatically; the first start backfills scope snapshots, scans the log once for integrity, records legacy authoritative ids and folds every record. |
| `SEQUENCE_CONFLICT` | A different op under an existing (node, sequence) is refused for clients of this release. Clients recover automatically. |
| Held writes | Writes on a never-synced database made before the app knew the signed-in user are held: call `app.sync.assignHeld(nodeId, 'current-user')` or `app.sync.discardHeld(nodeId)`. `status.heldOperations` and `status.heldNodes` report them. |
| `app.storage` | A collection named `storage` must be reached through `app.collections.storage`. |
| Enum `.transitions()` | A single enum field with `.transitions()` now defines the collection's state machine (mode `reject`), enforced for transaction writes too. |
| Client-side scope filtering | Removed. The server is the only scope authority. |
| Removed internals | `LocalMutationHandler.commitTransaction` and the `TransactionBufferedEntry`/`TransactionCommitBatch`/`TransactionCommitResult` types. |
| New server options | `heartbeatIntervalMs`, `appHeartbeatIntervalMs`, `handshakeTimeoutMs`, `maxBufferedBytes`, `deliveryHighWaterBytes`, `perMessageDeflate` (on by default), `maxRequestBodyBytes` (1 MiB, 413), `maxBackupBytes`, `maxConnections` (default 10,000), `maxOpsPerMinutePerUser`, `operationTransforms`, `encryption: { required, allowPlaintextMigration }`; store options `instanceId`, `authoritativeNodeIds`, `revokedAuthoritativeNodeIds`. |
| New events and status | `store:storage-blocked`, `store:storage-migrated`, `store:quota-exceeded`, `store:durability-lost`, `store:rematerialized`, `storage:persistence`, `query:error`, `encryption:status`, `sync:apply-failed`, `sync:apply-recovered`, `sync:apply-blocked`, `sync:durability-degraded` / `sync:durability-restored`, `sync:local-node`, `sync:node-id-rotated`, `sync:operation-rejected` (`OUT_OF_UPLINK_SCOPE`), `sync:forged-duplicate`, `sync:protocol-deprecated`; status `localDurability`, `heldOperations`, `heldNodes`. |

## Known limitations

See `remediation/STATUS.md` and `remediation/evidence/compat-beta12.md`.

- **Mixed fleets during the upgrade.** A beta.12 client keeps beta.12 merge semantics for concurrent edits (arrays, objects, increments through a beta.12 server) until it upgrades; its first open of beta.13 re-folds every record and it converges. A beta.12 client applies a scope entry as a plain insert, so a concurrent offline edit on that client can lose until the record's next write. beta.12 Node clients can crash on a dropped socket (fixed by upgrading).
- **beta.12 `toJSON` values.** A `URL` or date-library instance that beta.12 stored in a json value is unverifiable when an upgraded device uploads it from its pre-upgrade log (refused `INVALID_OPERATION_ID`). Let beta.12 devices sync before upgrading them if they store such values.
- **Authenticated beta.12 clients** stay refused after a server database upgrade until an admin releases their node; with `MixedAuthProvider` and `allowLegacyAnonymousClaims`, an anonymous device can take a signed-in user's pre-claims node (as on beta.12). Set the option to `false` if that matters more.
- **Encryption** covers the wire and the server, not the device's local database. Scope entries cannot restate sealed values, so an encrypted device quarantines them: sync whole scopes from the start.
- **Client SQLite store** turns a lone UTF-16 surrogate into U+FFFD (the server stores it losslessly).
- **Browser benchmark gates** are measured but not yet blocking in CI until a CI-hardware baseline is recorded.
- **Android background freeze** of a leader tab is verified only by simulated events in headless Chromium; a real-device run is pending.
- **Planned for the next release:** protocol 1 is refused, `experimental.legacyMerge` and the deprecated `MergeEngine` / `addWinsSet` exports are removed, and `allowLegacyAnonymousClaims` defaults to `false`.
