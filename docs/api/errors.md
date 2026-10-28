---
title: Error Codes
description: "Every Kora.js error code: the error class, what causes it, and how to fix it, for core, store, sync, server, auth and CLI, plus the codes the sync server sends."
---

# Error Codes

Every error Kora throws extends `KoraError` (from `@korajs/core`) and carries a stable `code` and a
`context` object with the details (collection, field, record id, ...). Match on `code`, not on the
message.

<!-- docs-check-prelude
import { createApp, defineSchema, t } from 'korajs'
const schema = defineSchema({ version: 1, collections: { todos: { fields: { title: t.string() } } } })
const app = createApp({ schema })
-->

```typescript
import { getKoraErrorFix, KoraError } from '@korajs/core'

try {
  await app.todos.insert({ title: 'Ship it' })
} catch (error) {
  if (error instanceof KoraError) {
    console.error(error.code, error.context, getKoraErrorFix(error.code) ?? '')
  }
}
```

`SyncError` uses the code `SYNC_ERROR` and puts the specific reason in `context.code` (for
example `HELD_ASSIGN_NO_USER`). Codes that reach the app as events (`sync:operation-rejected`,
`sync:apply-failed`) are listed under [Codes from the sync server](#wire-codes) and
[Quarantine codes](#quarantine).

## Core {#core}

| Code | Class | Cause | Fix |
|------|-------|-------|-----|
| `SCHEMA_VALIDATION` | `SchemaValidationError` | `defineSchema()` found an invalid schema, or a write has a value outside its field's domain (wrong type, an enum value not in the list, a fractional timestamp, a missing required field). `context` names the collection and field. | Fix the schema or the value. Timestamps are integer milliseconds; omit optional fields instead of passing `null` on insert. |
| `OPERATION_TOO_LARGE` | `OperationTooLargeError` | A local write's serialized operation exceeds `maxOperationBytes` (256 KiB by default). Nothing is written. | Store large content as a `t.blob()`, or split the record. Keep the store limit equal to the server's. |
| `OPERATION_ERROR` | `OperationError` | `createOperation` received invalid input, or a byte value could not be encoded. | Build operations through collections; check custom transports. |
| `NON_CANONICAL_VALUE` | `NonCanonicalValueError` | A value has no canonical JSON form (a function, a `Map`, a cyclic object, `NaN`). | Store plain JSON values. |
| `APP_NOT_READY` | `AppNotReadyError` | A collection method ran before `app.ready` resolved. | `await app.ready`, or render inside `<KoraProvider>`. |
| `SSR_INERT_APP` | `ServerRenderingAppError` | `app.ready` in a server render (no `window`): the app is inert there. | Use the app only in client code; pass `ssr: false` for Node programs that need a database. See [Server Rendering](/guide/nextjs-app-router). |
| `INVALID_TIMESTAMP_FIELDS` | `InvalidTimestampError` | A remote HLC timestamp has non-integer or negative fields, or a logical counter above 99 999. | None on the receiving side: the operation is quarantined. Do not hand-build timestamps. |
| `REMOTE_CLOCK_DRIFT` | `RemoteClockDriftError` | A remote timestamp is more than 5 minutes ahead of this device's corrected time. | The operation is quarantined and applies when time catches up. See [Clock Integrity](/guide/clock-integrity). |
| `FOLD_STATE_INVALID` | `FoldStateError` | A record's merge state cannot be read or joined (unknown format, a state of another record). | The operation is quarantined; upgrade Kora. |
| `FOLD_CONFIGURATION` | `FoldConfigurationError` | The fold was called without what it needs, for example a rich-text field with concurrent updates and no `richtext` merger. | Pass `{ richtext: mergeYjsUpdates }` (from `@korajs/store`) when calling the fold directly. |
| `INVALID_OPERATION_TRANSFORM` | `OperationTransformError` | An `OperationTransform` changed an operation's identity or produced a non-JSON body. | Transforms may only rewrite `data`, `previousData`, `atomicOps` and `schemaVersion`. |
| `OPERATION_TRANSFORM_MISSING` | `OperationTransformCoverageError` | A server store or local database holds operations of a schema version with no transform path to the current schema (`versions`, `missingFrom` in the context); starting would erase them from their records. | Register the retired transform again (transforms must stay registered while their source version is in the log), or register none. |
| `MIGRATION_ROLLBACK` | `MigrationRollbackError` | A migration step has no automatic inverse (`removeField` without a builder, `backfill` without a reverse transform). | Add `.down(...)`, the old field builder, or a reverse transform. |
| `STORAGE_ERROR`, `SYNC_ERROR` | `StorageError`, `SyncError` | Generic storage or sync failures; see `message` and `context.code`. | Depends on `context.code` (below). |
| `MERGE_CONFLICT`, `CLOCK_DRIFT` | `MergeConflictError`, `ClockDriftError` | Defined but not thrown in 1.0.0-beta.13: merges never fail, and a drifting clock is reported (`onDriftWarning`, `sync:clock-skew`) instead of blocking writes. | |

## Store {#store}

| Code | Class | Cause | Fix |
|------|-------|-------|-----|
| `RECORD_NOT_FOUND` | `RecordNotFoundError` | `update` or `delete` of a record that does not exist or is deleted. | Check `findById` first, or treat it as already done. |
| `QUERY_ERROR` | `QueryError` | An invalid query: unknown field or include target, bad `orderBy` direction, negative or fractional `limit`/`offset`. | Fix the query; typed hooks catch most of these at compile time. |
| `INVALID_STATE_TRANSITION` | `InvalidStateTransitionError` | A local write moves a state-machine field along a transition the schema does not allow. `context` has `fromState`, `toState`, `allowedStates`. | Offer only allowed transitions in the UI. |
| `REFERENTIAL_INTEGRITY` | `ReferentialIntegrityError` | Deleting a parent with live children under `onDelete: 'restrict'`. | Delete or move the children first. |
| `SCHEMA_VERSION_AHEAD` | `SchemaVersionAheadError` | The local database was migrated by a newer build of the app (its stored schema version is above `schema.version`), for example an old build served from a stale cache. The store refuses to open it before changing anything; `store:schema-ahead` fires and `app.ready` rejects. | Show a blocking state ("a newer version was installed; reload while online"). Never lower `schema.version` in a deployed app. |
| `STORAGE_DURABILITY_LOST` | `StorageDurabilityError` | No durable storage could open (OPFS locked by another runtime, IndexedDB unavailable): writes are refused instead of being lost on reload. `store:durability-lost` fires. | Show a blocking state ("close other tabs and reload"). `store: { allowNonDurable: true }` accepts memory storage explicitly. |
| `BUILD_SUPERSEDED` | `BuildSupersededError` | A tab of a newer build of the app (or a later deployment) is open: this tab retired and refuses writes (`collection` and `operation` say which; never the data). Nothing of the write was applied. `app:build-superseded` fired first. Retriable after a reload. A local refusal, never a server rejection. | Reload (`app.reloadForNewBuild()`); see [App Updates](/guide/app-updates). |
| `STORAGE_FORMAT_AHEAD` | `StorageFormatAheadError` | The database was opened by a build with a newer Kora storage format; this code does not know its layout and refuses before writing anything (`store:format-ahead`). | Run the newer build (reload while online). A format change cannot be rolled back by redeploying. |
| `TAB_COORDINATION_UNAVAILABLE` | `TabCoordinationUnavailableError` | The page is served over HTTPS (or localhost) but the browser has no Web Locks (an outdated browser), so tabs cannot be kept from overwriting each other's writes. On plain HTTP this error is not raised: browsers expose no Web Locks outside a secure context, so the version gate is off there with one console warning. | Use a current browser. Plain HTTP: serve over HTTPS or from localhost to turn the gate on. Tests in jsdom or happy-dom: `store: { allowUncoordinatedTabs: true }`. |
| `VERSION_GATE_CLOSED` | `VersionGateClosedError` | The app (or adapter) was closed while its open still waited on the version gate. | None: the open was abandoned on purpose. |
| `STORAGE_IN_USE` | `StorageInUseError` | `app.storage.deleteDatabase()` on a database open in a tab or worker. | Close it everywhere (or `app.close()`), then retry. |
| `UNSYNCED_DATA` | `UnsyncedDataError` | `deleteDatabase()` on a database with writes the server never acknowledged. | Sync first, or pass `{ force: true }` to discard them. |
| `STORAGE_BACKEND_MISMATCH` | `StorageBackendMismatchError` | The database's data lives in a backend this runtime cannot read (it was written to OPFS and OPFS is unavailable now). Kora refuses to start an empty copy. | Open the app where that backend works, or export a backup there. |
| `PERSISTENCE_ERROR` | `PersistenceError` | The IndexedDB fallback could not persist. With `context.code: 'UNSAVED_WRITES'`: `app.close()` (or `store.close()`) was refused because this tab is handing the database to a newer build and its latest changes are not saved yet. | Check storage settings and quota. `UNSAVED_WRITES`: Retry or Export from the prompt, then close. |
| `OPTIMISTIC_LOCK` | `OptimisticLockError` | Internal: a row changed while a merge result was being written; the write rolled back and is retried. | None; it is retried automatically. |
| `RESERVED_NODE_ID` | `ReservedNodeIdError` | A node id in the reserved `kora:` namespace (server identities) was configured for a device store. | Use a generated node id. |
| `STORE_NOT_OPEN` | `StoreNotOpenError` | A `Store` used before `open()` (custom runtimes). | Call `open()`; with `createApp`, await `app.ready`. |
| `ADAPTER_ERROR` | `AdapterError` | A storage adapter failed (`context` has the cause). | See the message; often quota or a closed database. |
| `WORKER_INIT_ERROR`, `WORKER_TIMEOUT` | `WorkerInitError`, `WorkerTimeoutError` | The SQLite WASM worker did not start or did not answer. | Check `store.workerUrl` (it must point at the worker script; see [Storage Configuration](/guide/storage-configuration)) and the COOP/COEP headers. |
| `NO_LEADER`, `LEADER_UNRESPONSIVE` | `NoLeaderError`, `LeaderUnresponsiveError` | A follower tab could not reach the tab that owns the database, or the owner hung; a new owner is elected. | Retry; the request is not applied twice. |
| `BRIDGE_TERMINATED`, `REQUEST_ABORTED` | `BridgeTerminatedError`, `RequestAbortedError` | The cross-tab channel closed while a request was in flight (the tab or app closed). | Retry after reopening. |
| (none) | `BackupFormatError` | `importBackup` was given an unknown or corrupt backup. | Use a backup made by `exportBackup`; a format-1 file is converted on import (or with `convertBackupV1`). |
| (none) | `BlobIntegrityError` | Blob bytes do not hash to their key (corruption or tampering). | Pull the blob again from the server. |
| `BLOB_CHUNK_TIMEOUT` | `BlobTransferError` | `app.blobs.pull` got no answer for a chunk within 2 minutes, after re-sending it (or was throttled for longer than 10 minutes). `hash`, `attempts` and `lastReason` say which and why. | Pull again later: chunks already received are kept. |
| `BLOB_CHUNK_UNAVAILABLE` | `BlobTransferError` | No reachable peer or server holds the chunk, or may share it with this device. | Pull again when the author's device is online, or enable server blob storage (`resolveBlobChunk` / `persistBlobChunk`). |
| `BLOB_CHUNK_CANCELLED` | `BlobTransferError` | The app (or the chunk provider) closed while a pull waited. | Pull again after reopening. |
| `NODE_OWNED_BY_ANOTHER_USER` | `NodeOwnedByAnotherUserError` | A local write while the store's pinned node (the auth device id) belongs to another user than the one signed in, on a browser two users share, or after the sync server refused the pinned node as another user's. It would upload as the device owner's, so it is refused (F9). | Sign in as the device's owner, or use the account on its own device. |

## Sync client {#sync}

Thrown by `app.sync` methods or reported in `sync:*` events and `status.reason`.

| Code | Where | Cause | Fix |
|------|-------|-------|-----|
| `SCHEMA_MISMATCH_BLOCKED` | `context.code` of a `SyncError` from `connect()` | The server does not accept this schema version (`status: 'schema-mismatch'`, `sync:schema-mismatch`). | Ship the app with a schema version the server supports, then `app.sync.clearSchemaBlock()` and `connect()`. |
| `AUTH_REFRESH_PENDING` | `context.code` | The server ended the session as expired or revoked; sync waits for a refreshed token. | None; it reconnects after the auth client refreshes. |
| `PRINCIPAL_CHANGED` | `context.code` | The signed-in user changed during the connection attempt; the attempt was abandoned so nothing uploads as the wrong user. | None; it reconnects as the new user. |
| `HELD_ASSIGN_NO_USER` | `assignHeld` | Nobody is signed in. | Sign in first. |
| `HELD_NODE_NOT_ASSIGNABLE`, `HELD_NODE_NOT_DISCARDABLE` | `assignHeld`, `discardHeld` | The node holds no unassigned writes (writes of another user stay with that user). | Act only on nodes with `reason: 'unassigned'`. |
| `OUT_OF_UPLINK_SCOPE` | `sync:operation-rejected` | A local write on a synced collection is outside what this session may upload. It is kept locally and in `getRejectedOperations()`. | Write only records the user's grant covers, or widen the grant on the server. |
| `SCOPE_RETRACTED` | `sync:scope-retracted` | A record left this device's sync scope; its unsynced operations are set aside. | Review them with `getRejectedOperations()`. |
| `ENCRYPTION_LOCKED` | `EncryptionKeyError` | Sync with encryption enabled before the keyring was unlocked. | `app.encryption.unlock(passphrase)`. |
| Keyring status codes | `app.encryption.getStatus().code`, `encryption:status` | `NO_PASSPHRASE`, `AWAITING_SERVER`, `LOCKED_BY_APP`, `WRONG_PASSPHRASE`, `PASSPHRASE_REQUIRED`, `KEY_RECORD_INVALID`, `KEY_RECORD_ROLLBACK`, `KEY_RECORD_MISSING`, `KEY_RING_FORK`, `KEY_SERVICE_FORBIDDEN`, `KEY_SERVICE_UNSUPPORTED`, `RECOVERY_FAILED` | See [Sync Encryption](/guide/sync-encryption#error-handling). |
| `UPLOAD_NOT_DURABLE`, `DURABILITY_DEGRADED` | `store:persistence-error`, `sync:durability-degraded` | Local writes could not be made durable before upload; after repeated failures uploads continue so the server holds a durable copy. | Free storage; stay online until `sync:durability-restored`. |
| `WRITE_NOT_DURABLE` | `WriteNotDurableError`, `store:write-durability` | The local transaction committed, but the IndexedDB fallback could not confirm a durable snapshot before the write promise returned. | Do not retry blindly. Keep the app open, free storage if needed, and wait for a `restored` event. |
| `NODE_REGISTRY_FAILED`, `NODE_ROTATION_FAILED`, `CLOCK_REBASE_FAILED`, `ADOPTION_SCHEDULE_FAILED`, `ACCEPTED_SCOPE_SAVE_FAILED`, `SETTLE_AFTER_CATCH_UP_FAILED` | `store:persistence-error` | A sync bookkeeping write failed; the step is retried at the next session. | Check storage health if it repeats. |
| `WRONG_RECOVERY_KEY` | `KeyUnwrapError` from `app.encryption.recover()` | The recovery key is malformed, belongs to another ring, or is a release-candidate `kora-rk1-`/`kora-rk2-` key (`context.reason: 'RECOVERY_KEY_RETIRED'`). | Use the `kora-rk3-` key of this ring; after a merge or with an old key, call `enableRecovery()` again from a device that is unlocked. |
| `SEALED_RELATION_FIELD` | `SealedRelationFieldError` | The encryption config encrypts a foreign key of an enforced relation, which the server must read. | List the field in `encryption.cleartextFields`. |
| `INVALID_SCOPE`, `SCOPE_VIOLATION` | `InvalidScopeError`, `ScopeViolationError` | A malformed scope map, or a write outside the scope (custom engines). | Fix the scope map. |
| `DECRYPTION_ERROR`, `ENCRYPTION_ERROR`, `KEY_DERIVATION_ERROR`, `KEY_UNWRAP_ERROR`, `ENCRYPTION_KEY_ERROR` | encryption classes | Low-level encryption failures (wrong key, tampered data, invalid configuration such as `INVALID_CONFIG`). | See the message and [Sync Encryption](/guide/sync-encryption). |

### Quarantine codes {#quarantine}

An operation the device cannot apply yet is quarantined, not dropped (`sync:apply-failed`), and
applied later: `DECRYPT_FAILED` (with `KEY_ID_MISMATCH`, `PLAINTEXT_REJECTED` or
`LEGACY_ENCRYPTED_PAYLOAD`), `INVALID_OPERATION_ID`, `SCHEMA_TRANSFORM_UNAVAILABLE`,
`SCHEMA_TRANSFORM_INVALID`, `REMOTE_CLOCK_DRIFT`, `INVALID_TIMESTAMP_FIELDS`,
`FOLD_STATE_INVALID` and `REFERENTIAL_INTEGRITY`. Each one's cause and release condition is in
[Sync Protocol: Quarantine](/guide/sync-protocol#quarantine). A failure that may be transient
(`APPLY_FAILED`) stalls delivery instead (`sync:apply-blocked`, `status.blockedFailure`) and is
retried.

## Codes from the sync server {#wire-codes}

### Refused operations

Sent per operation; the device keeps it in `app.sync.getRejectedOperations()` and emits
`sync:operation-rejected` with `{ code, message, retriable }`. Of the server's own codes only
`RATE_LIMIT` is retriable; a `validateOperation` rejection may set `retriable` itself, and a
validator that throws is reported as a retriable `VALIDATION_ERROR`.

| Code | Cause | Fix |
|------|-------|-----|
| `SCOPE_VIOLATION` | The stored record, or the record after the write, is outside the session's uplink grant (including moving a record out of the user's own scope). | Change ownership through a server route; check the grant. |
| `CONSTRAINT_VIOLATION` | The write breaks a `unique`, `capacity` or `referential` constraint as the server folds it. | Pick another value; show the message to the user. |
| `RESTRICTED` | A delete of a parent that still has live children under `onDelete: 'restrict'`. | Delete the children first. |
| `REFERENTIAL_INTEGRITY` | A foreign key points at a parent outside the writer's scope or that does not exist. | Reference records the user can see. |
| `SCHEMA_VALIDATION_ERROR`, `VALIDATION_ERROR` | The operation's values do not match the server's schema. | Align client and server schema versions. |
| `OPERATION_TOO_LARGE` | Larger than the server's `maxOperationBytes`. | As for the local error. |
| `RATE_LIMIT` | More than `maxOpsPerMinute` per connection (or `maxOpsPerMinutePerUser`). | Retried automatically after the window. |
| `INVALID_TIMESTAMP` | Stamped more than 60 s ahead of server time. | Fix the device clock; queued writes are re-stamped automatically. |
| `INVALID_OPERATION_ID` | The id is not the content hash of the operation. | A bug or tampering; the operation is never stored. |
| `FORGED_DUPLICATE` | The upload reuses the id of a stored operation but differs from it in a hashed field. Nothing is applied; the server logs it and emits `sync:forged-duplicate`. | A bug or tampering. |
| `INVALID_OPERATION`, `INVALID_SEQUENCE_NUMBER`, `INVALID_NODE_ID`, `INVALID_IDENTIFIER`, `MISSING_RECORD_ID`, `UNKNOWN_COLLECTION`, `UNSTORABLE_VALUE` | Malformed operation. | Upgrade the client; check custom transports. |
| `NODE_ID_MISMATCH` | The operation's node is not the session's node. | None; the device re-sends under its own node. |
| `SEQUENCE_CONFLICT` | The server holds a different operation under this node and sequence number. | None; the device renumbers the write and re-sends it. When another live copy of the database uses the same node id, the device moves to a fresh node id; a store with a pinned node id (`createKoraAuthSync`, `StoreConfig.nodeId`) cannot, and reports `NODE_ROTATION_FAILED`. |
| `PLAINTEXT_REJECTED` | A plaintext operation where the server requires encryption. | Enable `sync.encryption` on the client. |
| `SCHEMA_TRANSFORM_UNAVAILABLE`, `SCHEMA_TRANSFORM_INVALID` | No transform from the operation's schema version, or a transform broke its contract. | Register the transform on the server. |
| `BLOB_REFERENCE_FORBIDDEN`, `BLOB_QUOTA_EXCEEDED`, `BLOB_CHUNK_TOO_LARGE` | A `t.blob()` reference to content the user may not read, or over the blob limits. | Upload the bytes first; check `blobLimits`. |
| your codes | `validateOperation` returned `{ action: 'reject', code }`. | App-defined. |

Route writes report the same codes in `{ ok: false, code }`; `applyConditional` adds
`CONDITION_NOT_MET` (or your `reject.code`) when its predicate does not hold.

### Session errors

Sent before closing or refusing a session (`sync:disconnected`, `sync:auth-failed`,
`sync:suspended`):

| Code | Cause | Fix |
|------|-------|-----|
| `AUTH_FAILED` | The auth provider refused the token. | Sign in again. |
| `AUTH_EXPIRED`, `AUTH_REVOKED` | The credential expired or was revoked during the session. | None; the client refreshes and reconnects (or signs out on a definitive refusal). |
| `SCOPE_CHANGED` | The user's grant changed (for example removed from a team). | None; the client reconnects with the new grant. |
| `UNSCOPED_SHARING_REFUSED` | The server runs with `unscopedSharing: 'refuse'` and this signed-in session's grant restricts no collection. | Return per-user scopes from the auth provider and bind them with schema sync rules. |
| `SCOPE_REQUIRED`, `INVALID_SCOPE_PREDICATE`, `SCOPE_PREDICATE_LIMIT` | The grant has a missing value for a scoped collection, a `null`/`undefined` predicate, or more `$in` values than `maxScopePredicateValues` (default 100). The session is refused instead of matching too much. | Return complete grants from `scopeValues` / `resolveScopes`; raise `maxScopePredicateValues` for large grants (see [the trade-off](/guide/production-server#large-grants-the-in-value-limit)). |
| `NODE_ID_CLAIMED` | The device's node id belongs to another user, or has history from before node claims existed. From beta.14 the error carries `nodeOwnership`: `'other-principal'` or `'unowned'`; a store with a pinned node id refuses local writes after `'other-principal'` (`NODE_OWNED_BY_ANOTHER_USER`). | None for new nodes (the device rotates; a pinned node id, as with `createKoraAuthSync`, cannot: it stays refused and reports `NODE_ROTATION_FAILED`). Legacy nodes from a beta.12 server: from beta.14 a signed-in device whose verified device id is the node id takes it over automatically; on beta.13, bind auth-bound devices to their owners with the [one-time script](/guide/production-server#upgrading-a-beta-12-server-database-with-authentication); for other devices an administrator calls `releaseNodeClaim(nodeId)`. |
| `NODE_RELEASED` | An administrator released the node claim while the device was connected (retriable). | None; the device reconnects. |
| `HANDSHAKE_REQUIRED`, `HANDSHAKE_TIMEOUT`, `DUPLICATE_HANDSHAKE` | Protocol misuse or a slow client. | Retried automatically. |
| `MAX_CONNECTIONS` | The server is at `maxConnections`. | Retried with backoff. |
| `CLIENT_TOO_OLD` | The schema declares access rules and the client predates them (Kora before 1.0.0-beta.15, or no delivery watermark). | Upgrade the app. |
| `ACCESS_RULES_CHANGED` | Access rules are not in force for this session: they were installed after it started, the server is rebuilding its membership index (a schema change or a backup restore in progress, on any instance), or rebuilt it since the session started. Retriable. | None; the client reconnects and syncs under the rules. |
| `ACCESS_RULES_UNSUPPORTED_STORE` | The schema declares access rules, but the server store keeps no membership index (a custom store without `getMembershipIntervals` and `getAccessIndexState`). The server also refuses to start. | Use a built-in store, or implement the index methods. |
| `BATCH_TOO_LARGE` | A batch exceeded `maxOpsPerBatch` (1000 by default). | The client splits batches; upgrade old clients. |
| `PROTOCOL_V1_DEPRECATED` | A warning for Kora 1.0.0-beta.12 clients. | Upgrade the client. |
| schema mismatch (`reason` starts with `SCHEMA_MISMATCH_PREFIX`) | The client's schema version is outside `supportedSchemaVersions`. | See `SCHEMA_MISMATCH_BLOCKED`. |

## Server {#server}

| Code | Class | Cause | Fix |
|------|-------|-------|-----|
| `INVALID_SERVER_IDENTITY` | `ServerIdentityError` | An invalid `nodeId`, `instanceId` or authoritative node list. | See [Server identity](/guide/production-server#server-identity). |
| `BACKUP_INVALID_OPERATION` | `BackupValidationError` | A backup import contains an operation that fails ingest validation. | Restore a backup made by Kora. |
| `BACKUP_INVALID_KEY_RECORD` | `KoraError` | A server backup's encryption key records (`encryption_keys`) are malformed; nothing is imported. | Restore an unmodified backup made by `exportBackup()`. |
| `SCOPE_REQUIRED`, `INVALID_SCOPE_PREDICATE`, `SCOPE_PREDICATE_LIMIT` | `ScopeRequiredError`, `InvalidScopePredicateError`, `ScopePredicateLimitError` | Thrown while resolving a session grant (see Session errors). | |
| `ACCESS_INDEX_NOT_READY` | `SyncError` (code in `context.code`) | `server.access.roleOf` or `tx.roleOf` while the membership index is rebuilt (a schema install, a transform change or a restore, on any instance) or after a rebuild failed part-way. Retriable. | Try again shortly; after a failure, complete the restore or restart the server with the schema. |
| `INVALID_DIAGNOSTIC_OPTIONS` | `InvalidDiagnosticOptionsError` | `findJsonStringValues` got a `pageSize` that is not a positive integer or a `sampleSize` that is not a non-negative one. | Pass whole numbers (`pageSize` at least 1). |
| `IN_MEMORY_AUTH_STORE` | `InMemoryAuthStoreError` (`@korajs/auth/server`) | `createKoraAuthServer` with in-memory user or revocation stores under `NODE_ENV=production`. | Use `createSqliteUserStore` / `createPostgresUserStore`, or `allowInMemory: true` deliberately. |

## Auth {#auth}

Client (`@korajs/auth`): `AUTH_MFA_REQUIRED` (`MfaRequiredError`: complete with
`verifyMfa(mfaToken, { code })`), `AUTH_DEVICE_IDENTITY_ERROR`, `DEVICE_IDENTITY_ERROR`,
`DEVICE_KEY_STORE_ERROR`, `CRYPTO_UNAVAILABLE` (Web Crypto missing: use a secure context),
`ENCRYPTED_TOKEN_STORE_ERROR`, `ENCRYPTION_ERROR`, `KEY_DERIVATION_ERROR`,
`OPERATION_ENCRYPTION_ERROR`, `PASSKEY_ERROR`, `PASSKEY_UNSUPPORTED` (check `isPasskeySupported()`
first). `AuthError` from a route carries the server's code.

Route responses (`{ error, code }`):

| Code | Cause | Fix |
|------|-------|-----|
| `INVALID_CREDENTIALS` | Wrong email or password (the response does not say which). | Ask again. |
| `RATE_LIMITED` | Too many sign-in attempts for the account or from the IP. | Wait; the client shows the message. |
| `ACCESS_TOKEN_REQUIRED`, `ACCESS_TOKEN_INVALID` | Missing, expired or revoked access token. | The client refreshes; sign in again if refresh fails. |
| `REFRESH_TOKEN_INVALID` | The refresh token is unknown, expired, revoked or reused. | Sign in again. |
| `REFRESH_IN_PROGRESS` | Another refresh of the same token is running. | Retried automatically. |
| `MFA_TOKEN_INVALID`, `MFA_CODE_INVALID` | The MFA session expired, or the code is wrong. | Sign in again, or re-enter the code. |
| `DEVICE_OWNERSHIP_CONFLICT` | The device id is registered to another user. | `createKoraAuth()` offers every device id the browser holds and the server picks one of the account's own, so this means none fits (a custom device identity offering one id, or a server from before candidates refusing them all). Use a fresh device identity. |

Server classes (`@korajs/auth/server`) and their codes: sessions (`SESSION_NOT_FOUND`,
`SESSION_EXPIRED`, `SESSION_LIMIT_EXCEEDED`, `SESSION_MFA_REQUIRED`), TOTP (`TOTP_INVALID_CODE`,
`TOTP_LOCKED` after 5 wrong codes, `TOTP_NOT_ENABLED`, `TOTP_ALREADY_ENABLED`, `TOTP_NOT_VERIFIED`,
`TOTP_RECOVERY_EXHAUSTED`), organizations (`ORG_NOT_FOUND`, `ORG_SLUG_TAKEN`,
`MEMBERSHIP_NOT_FOUND`, `MEMBER_ALREADY_EXISTS`, `INSUFFICIENT_ROLE`, `CANNOT_REMOVE_OWNER`,
`INVITATION_NOT_FOUND`, `INVITATION_EXPIRED`), RBAC (`INVALID_PERMISSION`, `ROLE_NOT_FOUND`,
`CIRCULAR_INHERITANCE`), OAuth (`OAUTH_STATE_MISMATCH`: the callback does not belong to this
client's flow; `OAUTH_CODE_EXCHANGE_FAILED`; `OAUTH_USER_INFO_FAILED`; `OAUTH_PROVIDER_NOT_FOUND`;
`DUPLICATE_LINKED_IDENTITY`), password reset and change (`RESET_TOKEN_INVALID`, `RESET_TOKEN_EXPIRED`,
`PASSWORD_TOO_SHORT`, `PASSWORD_TOO_LONG`, `CURRENT_PASSWORD_INCORRECT`, and `PASSWORD_RESET_STORE_UNSUPPORTED` when a custom `UserStore` lacks `updatePasswordIf` or `markEmailVerifiedIfEmail`; `PASSWORD_CHANGE_STORE_UNSUPPORTED` when it lacks `updatePasswordIf`), email verification (`VERIFICATION_TOKEN_EXPIRED`,
`VERIFICATION_TOKEN_INVALID`, `VERIFICATION_WRONG_ACCOUNT`, `VERIFICATION_RATE_LIMITED`,
`EMAIL_DELIVERY_FAILED`, and `EMAIL_VERIFICATION_STORE_UNSUPPORTED` when a custom `UserStore` lacks `markEmailVerifiedIfEmail`), users (`DUPLICATE_EMAIL`, `DEVICE_OWNERSHIP_CONFLICT`), passkeys
(`PASSKEY_VERIFICATION_ERROR`), external providers (`AUTH_EXTERNAL_TOKEN_INVALID`,
`AUTH_EXTERNAL_OPERATION_NOT_SUPPORTED`), admin and webhooks (`ADMIN_USER_NOT_FOUND`,
`ADMIN_UNAUTHORIZED`, `WEBHOOK_ENDPOINT_NOT_FOUND`, `WEBHOOK_TARGET_REFUSED`: the webhook URL is not
public `https`). See the [Auth API reference](/api/auth#errors).

## CLI and Tauri {#cli}

| Code | Class | Cause | Fix |
|------|-------|-------|-----|
| `PROJECT_EXISTS` | `ProjectExistsError` | `create` into a directory that already exists. | Choose another name or remove the directory. |
| `SCHEMA_NOT_FOUND` | `SchemaNotFoundError` | No schema file found. | Pass `--schema` or set `schema` in `kora.config.ts`. |
| `INVALID_PROJECT` | `InvalidProjectError` | The directory is not a Kora project. | Run inside the project. |
| `DEV_SERVER_ERROR` | `DevServerError` | Vite or the sync server failed to start in `kora dev`. | See the output; check ports. |
| `DEPLOY_PLATFORM_UNAVAILABLE` | `DeployPlatformUnavailableError` | `render`, `docker` or `kora-cloud` were chosen. | Use `fly`, `railway`, `aws-ecs` or `aws-lightsail`. |
| `CLI_ERROR` | `CliError` | Other CLI failures. | See the message. |
| `TAURI_ADAPTER_ERROR`, `STORE_NOT_OPEN` | `TauriAdapterError`, `TauriStoreNotOpenError` | The Tauri SQLite plugin failed or the database is not open. | Check the `kora-sqlite:default` capability and the plugin build. |
