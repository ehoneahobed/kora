# Kora 1.0.0-beta.13: security and data-safety release (draft)

> Draft. Publish together with `remediation/SECURITY-ADVISORY-DRAFT.md`. This release is **breaking** by design: the maintainer approved breaking changes to close multi-tenant security holes found in beta.12.

## Why upgrade

beta.12 let a client of a multi-user sync server read and modify other users' data, and could silently lose or diverge data in common offline flows. beta.13 closes every known P0 security issue (Phase 1) and the "no silent data loss" programme (Phase 2) of the remediation tracker. Each fix is proven by a reproduction test that failed on beta.12, and each phase was attacked three times by independent red-team reviews.

## Security fixes (summary)

- **The handshake comes first.** The sync server refuses every message until the authenticated handshake completes. This covers operations, acknowledgments, rich-text, presence and blobs, on both WebSocket and HTTP.
- **The server decides what you may write.** Authorization uses the stored record and the resulting record, never values the client sends (`previousData`). It is re-checked inside the store's write path on memory, SQLite and Postgres.
- **The server decides what you may sync.** Scopes are granted by the server from verified identity, and a client handshake can only narrow them. Unresolved bindings and null/undefined grant values fail closed (`SCOPE_REQUIRED`, `INVALID_SCOPE_PREDICATE`).
- **Devices own their node ids.** Operations must come from the session's own node (`NODE_ID_MISMATCH`). Node ids are claimed per user, and anonymous devices get a secret node token.
- **Side channels are isolated per tenant.** Rich-text updates, presence and blobs are authorized and delivered only within scope. Blob references must point at content the writer can read or has uploaded.
- **References to other tenants are refused.** Foreign keys must point at parents inside the writer's scope. Cascades are authorized, and restrict refusals reveal nothing (`RESTRICTED`).
- **History stays with its owner.** Visibility is judged per operation, from the scope values recorded when it was applied, so ownership transfer does not disclose earlier history. Records moving into scope arrive complete, with per-field versions.
- **HTTP long-poll sessions are bound to the user.** Every request is authenticated, using a server-issued session id (`x-kora-session`).
- **Credentials are revocable everywhere.** One `authenticateAccess` check guards every route. Device and user revocation take effect immediately and across server instances; live sessions are ended on revocation, expiry or scope change. Refresh rotation is atomic and safe across tabs.
- **Account flows are hardened.**
  - OAuth state is bound to the browser and purpose.
  - Invitations require the verified invited email.
  - MFA is enforced at sign-in.
  - Reset tokens are never disclosed.
  - Sign-in timing no longer reveals whether an account exists, and rate limiting is per account and per IP.
  - Webhooks are signed with a timestamp and refuse private targets.
  - Passkeys require user verification.
- **Defaults are safer.** Tokens are no longer sent in WebSocket URLs, `X-Forwarded-For` is trusted only from configured proxies, and messages, batches and blob uploads have size limits.

## Data-safety fixes (summary)

- **Offline users stay signed in.** Network errors, timeouts, 5xx responses, rate limits and captive portals no longer sign anyone out or destroy tokens. An explicit `authenticated-offline` state opens the user's own database offline.
- **Edits that leave a reactive query are uploaded.** Local edits outside your upload scope are reported (`sync:operation-rejected`, `OUT_OF_UPLINK_SCOPE`) instead of silently staying local.
- **Secret fields are protected in transactions.** Secret fields written in `app.transaction` / `app.mutation` are hashed or encrypted, as with single writes.
- **Writes after a transaction sync.** Writes made after `app.transaction` are no longer wrongly reported as synced.
- **Array removals stick.** A removal on one device is no longer undone by another device's unchanged copy, and client and server agree.
- **Shared devices keep working.** Many per-user databases on one device no longer stop all writes, because OPFS pool capacity is reserved. Kora never silently runs in memory: it emits `store:durability-lost` and refuses writes unless you opt in.

## No silent data loss (Phase 2)

- **Every local write gets a unique sequence number.** Single writes, `app.transaction` entries and cascades all go through one write path that reserves sequence numbers inside the commit. Concurrent transactions no longer share numbers, and concurrent atomic increments no longer lose updates. Transaction writes stamp per-field versions and pass state-machine checks like single writes.
- **An op counts as synced only when the server has it.** Uploads are tracked per batch, and the device keeps a contiguous "stored on the server" prefix. Pending counts are accurate and `waitForSettled` resolves promptly.
- **Nothing is uploaded before it is durable on the device.** If local storage keeps failing, uploads continue and the status reports `localDurability: 'degraded'`.
- **Nothing delivered is skipped.** Ops the device cannot apply yet (unknown collection, failed decrypt, far-future timestamp, rejected apply) are kept in a durable quarantine and replayed, never silently dropped. Decrypt failures no longer end the session.
- **Refused stays refused.** A permanently rejected write is never applied later, even if a device resubmits it.
- **Devices and servers recover from each other.** A device that lost its newest writes gets them back from the server. A server restored from an older backup gets the missing writes re-uploaded. Cloned databases are detected and moved to a fresh node.
- **Writes belong to the user who made them.** On shared devices, writes are bound to the signed-in user and are never uploaded under another account. Writes whose author cannot be known are held and reported for the app to assign or discard.
- **Closed tabs' writes are uploaded** by the next tab (`isolation: 'per-tab'`).
- **One owner per OPFS database.** Each database has its own storage pool held under a Web Lock; contention waits and reports instead of falling back. Existing databases move into their own pools automatically. A hung or frozen leader tab no longer blocks other tabs, and closing hands off cleanly.
- **Kora never deletes your data on its own.** `app.storage.listDatabases()` and `deleteDatabase()` refuse to delete a database with unsynced writes.
- **The server is gap-free and bounded.** Live delivery chains from a send cursor and retransmits only on timeout. First sync streams in chunks with backpressure (100k ops: peak heap 18.7 MB to 4.8 MB). Dead connections are detected by heartbeats, and connections, bodies and buffers have limits.
- **Postgres is exact.** Version vectors are read from the database (correct across instances), duplicate ops are refused atomically, and sequence columns are BIGINT.

## Breaking changes and how to migrate

| Change | What to do |
|---|---|
| Sync scopes are granted by the server | With `@korajs/auth`: schema-scoped collections bind to the verified `userId` automatically. Supply other bindings with `scopeValues: async ({ userId }) => ({ orgId })` or a full `resolveScopes`. Custom providers must return scopes for scoped collections, or sessions are refused with `SCOPE_REQUIRED`. Client `syncScope` can only narrow. |
| Clients cannot move records out of their scope | Use a server route (`request.kora` without scope, or an admin path) for ownership transfer. |
| Ops must come from the session's own node; node ids are claimed per user | Use a fresh node id per signed-in user on shared devices. Devices whose node has history from before claims existed are refused with `NODE_ID_CLAIMED` until an admin calls `server.releaseNodeClaim(nodeId)`. Anonymous clients must persist the issued node token. Legacy anonymous clients are accepted with a warning while `allowLegacyAnonymousClaims` is true (default in beta.13, planned to become false). |
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
| Blob references | A blob field may reference only content you can read or have uploaded. Clients upload bytes before the operation that references them (automatic in beta.13 clients). Bytes uploaded before the upgrade have no owner: existing references keep working, but new references need a re-upload. |
| Durable storage | If OPFS or IndexedDB durability cannot be obtained, writes are refused with `StorageDurabilityError`. Set `store: { allowNonDurable: true }` to accept in-memory storage knowingly. |
| Limits | WebSocket messages over 32 MiB are refused (`maxMessageBytes`). Batches are capped at `maxOpsPerBatch` (1000). Blob pushes and requests are limited (`blobLimits`). |
| Scope helpers | `previousData` is ignored unless you pass `{ includePreviousData: true }`. |
| `AuthSyncState.token` | May be `null` while authenticated-offline. `AuthBoundKoraProvider` gains a `locked` state. |
| Server storage | New `scope_snapshot` column, plus `blob_owners`, `node_claims` and `kora_server_meta` tables. They are created automatically. Snapshots are recomputed once on first start. |
| **Upgrade order** | Upgrade sync servers first, then clients. Old clients keep working against the new server. |
| One-time client migration | On first open, duplicate sequence numbers are repaired, old index names are replaced, OPFS databases move into per-database pools, and each device re-uploads its own history once (the server deduplicates it). A tab still running beta.12 makes the upgraded tab wait (`store:storage-blocked`): ask users to close other tabs. |
| One-time server migration | Postgres converts sequence columns to BIGINT (an exclusive table rewrite, once; schedule it). New `operation_resolutions` and `sequence_pairs` tables and a `seq_unique` column are created automatically. |
| `SEQUENCE_CONFLICT` | A different op under an existing (node, sequence) is refused for clients of this release. Clients recover automatically. |
| Held writes | Writes on a never-synced database made before the app knew the signed-in user are held: call `app.sync.assignHeld(nodeId, 'current-user')` or `app.sync.discardHeld(nodeId)`. `status.heldOperations` and `status.heldNodes` report them. |
| `app.storage` | A collection named `storage` must be reached through `app.collections.storage`. |
| Enum `.transitions()` | A single enum field with `.transitions()` now defines the collection's state machine (mode `reject`), enforced for transaction writes too. |
| Client-side scope filtering | Removed. The server is the only scope authority. |
| Removed internals | `LocalMutationHandler.commitTransaction` and the `TransactionBufferedEntry`/`TransactionCommitBatch`/`TransactionCommitResult` types. |
| New server options | `heartbeatIntervalMs`, `appHeartbeatIntervalMs`, `handshakeTimeoutMs`, `maxBufferedBytes`, `deliveryHighWaterBytes`, `perMessageDeflate` (on by default), `maxRequestBodyBytes` (1 MiB, 413), `maxBackupBytes`, `maxConnections` (default 10,000), `maxOpsPerMinutePerUser`. |
| New events and status | `store:storage-blocked`, `store:storage-migrated`, `store:quota-exceeded`, `sync:apply-failed`, `sync:durability-degraded` / `sync:durability-restored`, `sync:local-node`; status `localDurability`, `heldOperations`, `heldNodes`. |
| Wire protocol | New optional fields (protobuf envelope 39–45, `fieldVersions` on scope-entry ops, a `heartbeat` message). beta.12 clients interoperate only where noted above. Upgrade clients and server together. |
| New events | `store:durability-lost`, `sync:node-id-rotated`, `sync:operation-rejected` (`OUT_OF_UPLINK_SCOPE`). |

## Known limitations carried into later phases

See `remediation/STATUS.md`; every item has an owner, a phase and a test. The notable ones:
- **Array and object merges** can still diverge under some multi-device orderings (MERGE-2, Phase 3).
- **Backup restore** is unsafe (STORE-5, Phase 3).
- **End-to-end encryption** does not yet work across devices (ENC-1, Phase 4).
- **The app shell** does not yet open offline (NEW-DX-3, Phase 4).
- **Android background freeze** of a leader tab is verified only by simulated events in headless Chromium; a real-device run is pending.
