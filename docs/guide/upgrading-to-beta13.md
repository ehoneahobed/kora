---
title: Upgrading to beta.13
description: "Upgrade a Kora.js app from 1.0.0-beta.12 to 1.0.0-beta.13: servers first, then clients; every breaking change with the code change it needs, the one-time migrations, and what to monitor."
---

# Upgrading to 1.0.0-beta.13

1.0.0-beta.13 is the security, data-safety and convergence release that follows 1.0.0-beta.12.
It is **breaking by design**: beta.12 let a client of a multi-user sync server read and modify
other users' data, could silently lose writes, could leave devices and the server disagreeing
about a record forever, and its end-to-end encryption never worked across devices. This page
takes an app from beta.12 to beta.13 step by step. The complete list of changes is in the
[release notes](https://github.com/ehoneahobed/kora/blob/main/docs/releases/v1.0.0-beta.13.md).

**Order: servers first, then clients.** A beta.13 server accepts beta.12 clients for this
release (with a deprecation warning and the exceptions below). A beta.13 client against a beta.12
server syncs plaintext only, without operation verification or encryption: never run that way.

## 0. Before you start

- **Back up the server.** `kora backup create --url https://sync.example.com --token "$KORA_BACKUP_TOKEN"`
  (see [Backup and Restore](/guide/backup-restore)). Keep a copy of the database files too.
- **Schedule the server's first start.** On Postgres it converts sequence columns to `BIGINT`, an
  exclusive table rewrite done once, then folds every record once (in 500-record transactions,
  safe during a rolling deploy). Plan a window proportional to your operation log.
- **Read the custom code you own.** Custom `AuthProvider`s, `ServerStore`s, `TokenRevocationStore`s,
  `OrgStore`s, HTTP sync endpoints, custom merge resolvers and schema transforms all have contract
  changes below.
- **Install the beta tag** everywhere: `pnpm add korajs@beta @korajs/server@beta ...`. Upgrade
  `korajs` and every `@korajs/*` package of an app or server together (they release together; do
  not mix releases in one process).

## 1. Upgrade the sync server

### Give the server the schema and an auth provider

The server now decides who may sync and write what. It needs your schema to authorize writes
against the stored record, to enforce scopes, relations and constraints, and to fold records:

<!-- docs-check-prelude
import { defineSchema, t } from 'korajs'
const schema = defineSchema({
  version: 2,
  collections: {
    todos: { fields: { title: t.string(), userId: t.string() } },
    projects: { fields: { name: t.string(), orgId: t.string() } },
  },
})
declare function orgOf(userId: string): Promise<string>
-->

```typescript
import { createKoraAuthServer, createSqliteUserStore } from '@korajs/auth/server'
import { createProductionServer, createSqliteServerStore } from '@korajs/server'

const store = createSqliteServerStore({ filename: './kora-server.db' })
await store.setSchema(schema)

const authServer = createKoraAuthServer({
  // Persistent: an in-memory user store is refused under NODE_ENV=production.
  userStore: await createSqliteUserStore({ filename: './auth.db' }),
  jwtSecret: process.env.KORA_AUTH_SECRET,
  // Schema-scoped collections bind to the verified { userId } automatically.
  // Every other scope key must come from the server:
  scopeValues: async ({ userId }) => ({ orgId: await orgOf(userId) }),
})

const server = createProductionServer({
  store,
  httpRoutes: [{ path: '/auth', handle: authServer.handleRequest }],
  trustProxy: 1, // only if a reverse proxy sets X-Forwarded-For (hop count or CIDR list)
  syncOptions: { auth: authServer.auth, schemaVersion: schema.version },
  operationalAuth: {
    adminToken: process.env.KORA_ADMIN_TOKEN,
    backupToken: process.env.KORA_BACKUP_TOKEN,
  },
})
```

What changed and what to do:

| beta.12 behaviour | beta.13 | What to do |
|---|---|---|
| The client's scope decided what it synced | The server grants scopes; the client can only narrow them | Supply non-`userId` bindings with `scopeValues` (or a full `resolveScopes`). A custom `AuthProvider` must return `scopes` for every scoped collection, or sessions are refused `SCOPE_REQUIRED`. A `null`/`undefined` grant value fails closed (`INVALID_SCOPE_PREDICATE`). |
| A schemaless server with a token provider | Syncs unscoped, with a one-time warning | Multi-tenant servers must call `store.setSchema(schema)` or return explicit scopes. |
| Writes judged on client-sent `previousData` | Judged on the stored and the resulting record | Ownership transfer (moving a record out of the writer's scope) goes through a server route (`request.kora.apply` without a scope, or an admin path). |
| Any node id in an upload | Operations must come from the session's own node; node ids are claimed per user | Nothing for beta.13 clients. See [beta.12 devices](#beta-12-devices-after-the-server-upgrade) below. |
| In-memory auth stores everywhere | Refused in production (`IN_MEMORY_AUTH_STORE`) | `createSqliteUserStore` / `createPostgresUserStore` (their revocation storage is used automatically), or `allowInMemory: true` deliberately. |
| `X-Forwarded-For` trusted | Trusted only from `trustProxy` | Set `trustProxy` behind a proxy, or `request.ip` is the proxy's address. |
| Token in the WebSocket URL | Sent in the handshake | A proxy that needs it in the URL: `tokenInUrl: true` on a `WebSocketTransport` you build. |

### Auth contracts

| Area | What to do |
|---|---|
| `TokenRevocationStore` | Custom stores implement `consume`, `isConsumed` and the revocation cut-offs; `isDeviceRevoked` is removed. |
| `OrgStore` | Custom stores implement `listMyInvitations(userId)` and `revokeInvitation(orgId, id)`. Invitations require the verified invited email. |
| OAuth | Callbacks need the flow-binding cookie set at the start of the flow (same browser). Linking starts at `POST /auth/oauth/:provider/link/start`. |
| MFA | Users with MFA get `MfaRequiredError` at sign-in; complete it with `verifyMfa(mfaToken, { code })`. |
| Password reset | Configure `onResetRequested` (tokens are returned only with `exposeTokenForDevelopment`, never in production). Wire `onPasswordChanged: authServer.revokeAllForUser` and `new AdminApi({ userStore, revokeAllForUser: authServer.revokeAllForUser })`. |
| Webhooks | Signatures are `t=…,v1=…`; verify them with the timestamp tolerance. Private targets are refused. |
| Passkeys | User verification is required by default. |
| Revocation | Device and user revocation end live sessions on every instance. Nothing to wire when the sync server uses `authServer.auth`; for a wrapped provider call `authServer.bindSyncServer(syncServer)`. |

### An HTTP long-poll endpoint

`createProductionServer` serves WebSocket sync. If you mapped HTTP long-polling yourself with
`handleHttpRequest`, every request must now carry the credential and the server-issued session
id, and the response must return that id:

<!-- docs-check-prelude
import type { AuthProvider } from '@korajs/server'
declare const auth: AuthProvider
-->

```typescript
import { createServer } from 'node:http'
import { createKoraServer, createSqliteServerStore } from '@korajs/server'

const sync = createKoraServer({ store: createSqliteServerStore({ filename: './kora-server.db' }), auth })

createServer(async (req, res) => {
  const chunks: Uint8Array[] = []
  for await (const chunk of req) chunks.push(chunk as Uint8Array)
  const header = (name: string): string | undefined => {
    const value = req.headers[name]
    return Array.isArray(value) ? value[0] : value
  }
  const response = await sync.handleHttpRequest({
    method: req.method === 'POST' ? 'POST' : 'GET',
    body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
    contentType: header('content-type'),
    ifNoneMatch: header('if-none-match'),
    authorization: header('authorization'), // checked on EVERY request now
    sessionId: header('x-kora-session'), // issued by the handshake response
  })
  res.writeHead(response.status, {
    ...response.headers, // carries x-kora-session after the handshake
    'access-control-expose-headers': 'x-kora-session', // for cross-origin clients
  })
  res.end(response.body)
}).listen(3001)
```

Old HTTP clients must be upgraded: they do not send the session header.

<!-- docs-check-prelude -->

### Schema transforms, limits and new options

- **Transforms run at fold time** on every replica. Operations are stored and synced as written;
  pass the **same** `operationTransforms` to the server (`syncOptions.operationTransforms`, or
  `store.setSchema(schema, { operationTransforms })`) and to `createApp`
  (`sync.operationTransforms`). Transforms must be pure and may rewrite only `data`,
  `previousData`, `atomicOps` and `schemaVersion`. **Never retire a transform** while operations of
  its source version are in a log: the server and devices refuse to start
  (`OPERATION_TRANSFORM_MISSING`) rather than fold those operations as absent.
- **Limits:** WebSocket messages over 32 MiB (`maxMessageBytes`), batches over 1000 operations
  (`maxOpsPerBatch`), operations over 256 KiB (`maxOperationBytes`), and blob traffic
  (`blobLimits`) are refused. Raise them on the server and set the same `store.maxOperationBytes`
  in `createApp`.
- **New server options** (defaults are production-safe): `heartbeatIntervalMs`,
  `appHeartbeatIntervalMs`, `handshakeTimeoutMs`, `maxBufferedBytes`, `deliveryHighWaterBytes`,
  `perMessageDeflate`, `maxRequestBodyBytes`, `maxBackupBytes`, `maxConnections`,
  `maxOpsPerMinutePerUser`, `encryption: { required, allowPlaintextMigration }`. See
  [Server options](/guide/production-server#server-options).
- **Server identity:** the store option `nodeId` is deprecated. The server authors under
  `kora:server:<deploymentId>:<instanceId>`; a configured `nodeId` becomes a legacy authoritative
  id so earlier server decisions keep winning. On Postgres set a distinct `instanceId` per instance
  only if you need a stable one. Removing an id from `authoritativeNodeIds` does not revoke it: use
  `revokedAuthoritativeNodeIds`. See [Server identity](/guide/production-server#server-identity).
- **Protobuf** is no longer negotiated (clients speak JSON); `ProtobufMessageSerializer` is an
  explicit choice on both ends, and `DynamicProtobufSerializer` is removed.
- **Custom `ServerStore`s** implement the key service (`getEncryptionKeyRecord`,
  `putEncryptionKeyRecord`, and `getEncryptedKeyIds` / `listEncryptionKeyRecords`) to support
  encryption, and their `exportBackup()` / `importBackup()` carry key records.

### Database migrations generated by an earlier `kora migrate`

A migration generated by beta.12's `kora migrate` that rebuilds a table
(`_kora_mig_<collection>_new`) is refused on Postgres, where it never worked, and on SQLite it
dropped Kora's internal columns, foreign keys and indexes. Regenerate it: restore
`kora/schema.snapshot.json` to the version it migrates from, delete its files and run
`kora migrate` again. New migrations use `--kora:evolve-table` and `--kora:relax-value-domain`
steps that change only what the schema changed ([CLI reference](/api/cli#migrate)).

### What the first start does

Automatic, idempotent, and logged:

- New tables and columns: `scope_snapshot`, `blob_owners`, `node_claims`, `kora_server_meta`,
  `operation_resolutions`, `sequence_pairs`, `operations_quarantine`, `kora_encryption_keys`, the
  fold state. Postgres sequence columns become `BIGINT`.
- Scope snapshots are backfilled, legacy authoritative ids recorded, and the log is scanned once
  for integrity: unreadable rows move to `operations_quarantine` instead of being folded
  (`store.getLogIntegrityReport()`).
- beta.12 enum `CHECK` and `NOT NULL` table constraints are relaxed once (the value domain is
  enforced by validation now, so a schema upgrade can add enum values or make a field optional).
- Every record is re-folded from its log with the beta.13 merge semantics. Later starts re-fold
  only records whose fold state is missing or stale.

### beta.12 devices after the server upgrade

- **Protocol 1 is accepted for this release only**, with a deprecation warning
  (`session.protocol_deprecated` in the server log). The next release refuses it: upgrade clients
  within this release.
- **Signed-in devices:** beta.12 recorded no node claims, so every node with history is ownerless
  and a signed-in device is refused `NODE_ID_CLAIMED`. What happens next depends on how the
  client gets its node id:
  - **`@korajs/auth` apps (`authClient: createKoraAuthSync(...)`, the default in every sync
    template):** the node id is the signed-in device id and **cannot change**. Without a server
    step, these devices keep reconnecting ("sync needs attention") and their offline writes never
    upload, on beta.12 and on beta.13 clients alike. **Before the upgraded server accepts
    connections, bind each node to the user who owns that device** (one script, below). Nothing
    else is needed; queued offline writes then upload.
  - **Token apps (`sync.auth`):** a beta.13 client moves to a fresh node automatically and
    re-uploads what the old server never acknowledged. A beta.12 client cannot; upgrade the client
    with the server, or release its node with `server.releaseNodeClaim(nodeId)` (the next
    principal to present a released node gets it).

  Procedure and script: [Upgrading a beta.12 server database](/guide/production-server#upgrading-a-beta-12-server-database-with-authentication).
- **Anonymous devices:** `allowLegacyAnonymousClaims` (default `true` in beta.13, `false` from the
  next release) re-issues pre-claims nodes with a warning. Set it to `false` once every client is
  on beta.13.
- **Encrypted beta.12 clients cannot sync** with a beta.13 server: their per-device ciphertext was
  never readable elsewhere (see [Encryption](#encryption) below).
- **Mixed fleets:** a beta.12 client keeps beta.12 merge semantics for concurrent edits until it
  upgrades, and applies a scope entry as a plain insert. Its first beta.13 open re-folds every
  record and it converges.

## 2. Upgrade the clients

### Code changes

<!-- docs-check-prelude
import { createApp, defineSchema, t } from 'korajs'
const schema = defineSchema({
  version: 1,
  collections: {
    todos: { fields: { title: t.string(), projectId: t.string(), ownerId: t.string() } },
    projects: { fields: { name: t.string(), ownerId: t.string() } },
  },
  relations: {
    todoProject: { from: 'todos', to: 'projects', type: 'many-to-one', field: 'projectId', onDelete: 'cascade' },
  },
})
declare const passphrase: string
-->

```typescript
const app = createApp({
  schema,
  store: {
    // Writes are refused (StorageDurabilityError) when no durable storage opens.
    // allowNonDurable: true accepts in-memory storage knowingly.
    maxOperationBytes: 256 * 1024, // keep equal to the server's maxOperationBytes
  },
  sync: {
    url: 'wss://sync.example.com/kora-sync',
    autoConnect: true,
    operationTransforms: [], // the same list as the server's
    encryption: {
      enabled: true,
      // Foreign keys of cascade / set-null / restrict relations must be cleartext,
      // or createApp throws SealedRelationFieldError.
      cleartextFields: { todos: ['ownerId', 'projectId'], projects: ['ownerId'] },
    },
  },
})

await app.ready
await app.encryption?.unlock(passphrase)

// Writes made on a never-synced database before the app knew the signed-in user are held:
for (const node of (await app.sync?.getHeldOperations()) ?? []) {
  if (node.reason === 'unassigned') await app.sync?.assignHeld(node.nodeId, 'current-user')
}
```

| Change | What to do |
|---|---|
| Durable storage | If OPFS and IndexedDB both fail, writes are refused (`StorageDurabilityError`, `store:durability-lost`) instead of silently living in memory. Show a blocking state, or set `store.allowNonDurable: true`. |
| Value domain | `t.timestamp()` takes integer milliseconds in the `Date` range; `t.number()` refuses `±Infinity`; json/object values nest at most 64 levels and may not hold `__proto__`; values with no JSON form (`Map`, `Set`, class instances, `NaN`, cycles) throw `SchemaValidationError` (`NON_CANONICAL_VALUE`). `update(id, { field: undefined })` clears the field. |
| `where` values | `undefined` adds no condition (it used to match nothing); `null` means `IS NULL`; `NaN`/`Infinity` throw `QueryError`. Check filters built from optional UI state. |
| Merge semantics | Arrays are multisets (duplicates kept, one removal removes one copy), objects merge per top-level key, `counter`/`max`/`min`/`append-only` fold over every write. **Review custom resolvers:** they are called once per write in HLC order (`local` = merged so far, `remote` = the write's value, `base` = its `previousData`). See [Conflict Resolution](/guide/conflict-resolution). To compare with beta.12 for this release only: `experimental: { legacyMerge: true }`. |
| Encryption | Use `sync.encryption: { enabled: true }` with `app.encryption.unlock(passphrase)` (or `key`). The server must be beta.13. List enforced foreign keys and scope keys in `cleartextFields`. See [Sync Encryption](/guide/sync-encryption). |
| Held writes | `status.heldOperations` and `status.heldNodes` report them; assign or discard them, or set `sync.unassignedWrites: 'assign-to-first-user'` in single-user apps. |
| Out-of-scope edits | A local write outside the session's upload scope is reported (`sync:operation-rejected`, `OUT_OF_UPLINK_SCOPE`) and kept in `getRejectedOperations()`. Client-side scope filtering is removed. |
| `app.storage` | A collection named `storage` is reached through `app.collections.storage`. |
| Enum `.transitions()` | A single enum field with `.transitions()` now defines the collection's state machine (mode `reject`), enforced for transaction writes too. |
| SSR | `createApp` is inert without `window` (`ServerRenderingAppError` on `app.ready`). Node programs that need a database pass `ssr: false` or `store.adapter: 'better-sqlite3'`. See [Server Rendering](/guide/nextjs-app-router). |
| `@korajs/auth` client | `AuthSyncState.token` may be `null` while `authenticated-offline`; `AuthBoundKoraProvider` gains a `locked` state. Network errors no longer sign users out. |
| Scope helpers | `operationMatchesScope` and friends ignore `previousData` unless you pass `{ includePreviousData: true }`. |
| Blob references | A blob field may reference only content the writer can read or uploaded (uploads before the reference are automatic). Bytes uploaded before the upgrade have no owner: existing references keep working, new references need a re-upload. |
| Backup files | Backups exported by beta.12 or earlier (format 1) are refused, and `app.importBackup` **does not throw**: it returns `{ success: false, errorCode: 'BACKUP_FORMAT_OUTDATED' }`. Check the result, and on that code run `convertBackupV1(bytes)` (exported by `korajs`) and import again. Code that ignores the result restores nothing and reports success. |
| Rich text size | A rich-text save writes the whole document state, so with the default 256 KiB `maxOperationBytes` saves fail (`OPERATION_TOO_LARGE`) once a document's text passes about 100 KB. Raise `maxOperationBytes` on the server and `store.maxOperationBytes` on the client to the same value. |
| Constraint `where` | Operators in a constraint's `where` are not supported: values match by plain equality, so `{ status: { $ne: 'draft' } }` matches no record and the constraint is not enforced as written. Use equality values only, or enforce the rule in a server route. |
| Removed internals | `LocalMutationHandler.commitTransaction` and the `TransactionBufferedEntry` / `TransactionCommitBatch` / `TransactionCommitResult` types. |
| `kora deploy` | Render and Docker are "coming soon" and refused; use Fly.io, Railway or AWS. |

### What the first open does

On the first open with beta.13, each device, in its own transactions:

- repairs duplicate sequence numbers and replaces old index names;
- moves OPFS databases into their own per-database pools (`store:storage-migrated`);
- relaxes beta.12 enum `CHECK` / `NOT NULL` table constraints;
- makes beta.12 `undefined` clears explicit and re-materializes every record from its log
  (`store:rematerialized`): devices that diverged under beta.12 converge, so visible values can
  change there;
- re-uploads its own history once (the server deduplicates it).

A tab still running beta.12 makes the upgraded tab wait (`store:storage-blocked`): ask users to
close other tabs, for example from a `store:storage-blocked` listener.

### Encryption

beta.12 derived the key from the passphrase with a random salt in every process, so encrypted data
was never readable on another device. With beta.13 every user has one keyring, wrapped by their
passphrase and stored (wrapped only) by the server. beta.12 ciphertext on the server cannot be
decrypted by anyone and is quarantined (`LEGACY_ENCRYPTED_PAYLOAD`). The device that wrote such
records still holds them in plaintext locally: rewrite them from that device (for example, copy
each into a new record) to share them. Details: [Migrating from 1.0.0-beta.12 Encryption](/guide/sync-encryption#migrating-from-1-0-0-beta-12-encryption).

## 3. What to monitor

On the server (structured log events of the `logger` option):

- The first start: the one-time migrations and the log-integrity scan
  (`store.getLogIntegrityReport()` lists quarantined rows).
- `session.protocol_deprecated`: a beta.12 client is still connected. `session.unverified_legacy_operation`:
  a beta.12 operation whose id could not be verified was stored for its own node only.
- `session.legacy_anonymous_claim`: a pre-claims node was re-issued to an anonymous device (see
  `allowLegacyAnonymousClaims`); `node_claim.released` follows each `releaseNodeClaim`.
- `session.forged_duplicate`: an upload reused a stored id with different content (tampering or a
  broken client).
- `session.revalidation_failed`, `session.delivery_stalled`, `connection.rejected`
  (`max_connections`): grant checks, slow consumers and capacity.

The server answers a refused operation to its author and does not log it; devices report each
refusal (below), so forward `sync:operation-rejected` to your telemetry. A burst of `SCOPE_REQUIRED` session refusals after the
upgrade means a scope binding is missing from `scopeValues` / `resolveScopes`.

On devices (forward these events to your telemetry):

| Event | Meaning |
|---|---|
| `store:durability-lost`, `sync:durability-degraded` | No durable local storage, or persisting keeps failing. |
| `store:storage-blocked`, `store:storage-migrated`, `store:rematerialized` | The one-time client migration (a beta.12 tab is still open; pools moved; records re-folded). |
| `sync:operation-rejected` | The server refused a write (`code`, `retriable`); it is undone on its author. |
| `sync:apply-failed`, `sync:apply-blocked`, `sync:apply-recovered` | Quarantined or stalled inbound operations, and their recovery. |
| `sync:node-id-rotated`, `sync:local-node` | The device moved to a fresh node (claims, clones, held writes). |
| `encryption:status`, `sync:suspended` (`encryption-locked`) | The keyring needs the passphrase. |
| `sync:protocol-deprecated` | This client talks to an older server: upgrade the server. |

`useSyncStatus()` (or `app.sync.getStatus()`) also reports `heldOperations`, `localDurability` and
`blockedFailure`. See [Error Codes](/api/errors) for every code.

## Planned for the next release

Protocol 1 (beta.12 clients) is refused, `experimental.legacyMerge` and the deprecated
`MergeEngine` / `addWinsSet` exports are removed, and `allowLegacyAnonymousClaims` defaults to
`false`. Upgrade every client during the beta.13 cycle.
