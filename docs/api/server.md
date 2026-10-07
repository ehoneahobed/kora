---
title: Server API
description: "@korajs/server API reference: KoraSyncServer, createProductionServer, server stores, auth providers, operation validation, the route context, rejection codes and the awareness relay."
---

# Server API Reference

`@korajs/server` is the self-hosted sync server. The [Production Server guide](/guide/production-server)
explains every option and deployment concern; this page lists the API.

<!-- docs-check-prelude
import { createProductionServer, createSqliteServerStore } from '@korajs/server'
import { defineSchema, t } from '@korajs/core'
const schema = defineSchema({
  version: 1,
  collections: {
    todos: { fields: { title: t.string(), completed: t.boolean().default(false), userId: t.string() } },
    responses: { fields: { formId: t.string(), answer: t.string() } },
  },
})
-->

## createProductionServer(config)

One HTTP server for the built app (`staticDir`), WebSocket and HTTP sync (`syncPath`), custom routes,
health, metrics, the dashboard and backups.

```typescript
const store = createSqliteServerStore({ filename: './kora-server.db' })
await store.setSchema(schema)

const server = createProductionServer({
  store,
  staticDir: './dist',
  syncPath: '/kora-sync',
  httpRoutes: [],
  operationalAuth: { adminToken: process.env.KORA_ADMIN_TOKEN },
  syncOptions: { schemaVersion: schema.version },
})
const url = await server.start()
```

| Option | Default |
|--------|---------|
| `store` | required |
| `port` | `PORT` environment variable, else `3001` |
| `staticDir` | `'./dist'` (the SPA shell is served for unknown paths) |
| `syncPath` | `'/kora-sync'` |
| `syncOptions` | `KoraSyncServerConfig` without `store`, `port`, `host`, `path` |
| `httpRoutes` | `[]`: `{ path, handle(request) }`, mounted before static files |
| `operationalAuth` | `{ adminToken?, metricsToken?, backupToken? }`; endpoints without a token are public |
| `crossOriginEmbedderPolicy` | `'credentialless'` |
| `trustProxy` | `false`: `request.ip` is the socket address unless the proxy is trusted |
| `maxRequestBodyBytes` | 1 MiB for `httpRoutes` bodies (larger requests get 413) |
| `maxBackupBytes` | 256 MiB for `/__kora/backup/import` |

The handle (`ProductionServer`) has `start()` (resolves to the URL), `stop()`, `kora` (the
[route context](#route-context)) and `getLiveBlobRefs()`. `/health` is always public; `/__kora/*`
endpoints use the matching token as `Authorization: Bearer <token>`.

## KoraSyncServer

`new KoraSyncServer(config)` (or `createKoraServer(config)`) runs sync alone, standalone with
`start()` or attached to your HTTP server.

| Method | Description |
|--------|-------------|
| `start(wsServerImpl?)` / `stop()` | Standalone WebSocket server on `port`. |
| `handleWebSocket(ws)` / `handleConnection(transport)` | Attach a connection from your own server. |
| `handleHttpRequest(request)` | HTTP long-polling: map `method`, `body`, `contentType`, `ifNoneMatch`, `authorization` and the `x-kora-session` header (`sessionId`). The handshake response carries a server-issued session id; every request is authenticated and must match the session's user and device. Idle sessions close after `httpSessionIdleTimeoutMs` (2 minutes). |
| `terminateSessions({ userId?, deviceId?, code? })` | Ends matching live sessions (`AUTH_REVOKED` by default); returns how many. |
| `revalidateSessions()` | Re-checks every live session's credential and scope now (also runs every `sessionRevalidationIntervalMs`). |
| `releaseNodeClaim(nodeId)` | Releases a device node id so the next principal can claim it. |
| `applyLocalOperation(...)`, `relayServerOperations(operations)` | Server-authored writes and their fan-out (prefer the route context). |
| `getKoraContext()` | The route context. |
| `getStatus()` | `{ running, connectedClients, port, totalOperations, uptime, version, schemaVersion, connectedNodeIds, peakConnections, connectionsTotal }`. |
| `getConnectionCount()`, `getMetricsCollector()`, `getLogger()`, `getLiveBlobRefs()` | Introspection. |
| `authoritativeNodeIds` | Node ids whose writes win `merge('server-authoritative')` fields. |

`KoraSyncServerConfig` fields (`auth`, `emitter`, `schemaVersion`, `supportedSchemaVersions`,
`operationTransforms`, `encryption`, `validateOperation`, size and rate limits, heartbeats,
`sessionRevalidationIntervalMs`, blob callbacks, `logger`, ...) are listed with their defaults in
[Server options](/guide/production-server#server-options).

## Stores

| Store | Create |
|-------|--------|
| SQLite | `createSqliteServerStore({ filename?, ...identity })` (`SqliteServerStore`) |
| Postgres | `await createPostgresServerStore({ connectionString, ...identity })` (`PostgresServerStore`) |
| Memory (tests) | `new MemoryServerStore(options?)` |

Identity options (`nodeId`, `instanceId`, `authoritativeNodeIds`, `revokedAuthoritativeNodeIds`) are
described in [Server identity](/guide/production-server#server-identity).

Every store implements `ServerStore`:

| Method | Description |
|--------|-------------|
| `setSchema(schema, { operationTransforms? })` | Creates one table per collection, folds existing operations into it, and enables constraint, relation and scope checks. Call it before serving clients. |
| `queryCollection(collection, { where?, orderBy?, orderDirection?, limit?, offset?, includeDeleted? })` | Materialized records (`where` is exact match). |
| `findRecord(collection, id)` | One record, or `null` when missing or deleted. |
| `countCollection(collection, where?)` | Count. |
| `materializeCollection(collection)` | Every record (from the log when no schema is set). |
| `applyRemoteOperation(op, options?)` | Ingest path used by the sync server. |
| `getMaxDeliverySequence()`, `getOperationsAfterDelivery(after, limit)` | The delivery sequence behind gap-free downloads. |
| `exportBackup()`, `importBackup(data, merge?)` | The operation log plus the users' encryption key records (`merge: false` replaces the log, `true` merges into it); an import reconciles key records (replace mode takes the backup's; merge mode adds missing ones and advances an older revision of the same ring). Used by `/__kora/backup/*` and `kora backup`. |
| `getEncryptionKeyRecord`, `putEncryptionKeyRecord`, `getEncryptedKeyIds`, `listEncryptionKeyRecords` | The key service's storage (compare-and-set). A custom store without the first two makes the key service answer `unsupported`; see [Sync Encryption](/guide/sync-encryption#server-requirements). |

Server writes go through the same fold as devices; never write materialized tables directly. Use
the route context instead.

## Route context {#route-context}

`server.kora`, `request.kora` in custom routes, and `context.kora` in validators give trusted,
scoped access that runs every write through the sync pipeline (validation, constraints, relations,
fold, fan-out):

| Method | Description |
|--------|-------------|
| `apply({ collection, type, recordId?, data? }, { scope? })` | One mutation. Resolves to `{ ok: true, operation, record }` or `{ ok: false, code, message, retriable }`. |
| `applyConditional({ collection, id, if?, update?, also?, reject?, idempotencyKey? }, { scope? })` | Reads the target, checks the predicate (`$eq`, `$ne`, `$lt`, `$lte`, `$gt`, `$gte`, `$in`) and commits the update plus every `also` mutation only if it holds, at most once per `idempotencyKey`. |
| `query(collection, { ...queryOptions, scope? })` / `findById(collection, id, { scope? })` | Reads. |

`scope` (`{ collection: { field: value } }`) applies a caller's scope exactly like a sync session:
`apply` refuses a write whose resulting record falls outside it, and reads only return records inside
it. Omit it only for routes that are public by design.

<!-- docs-check: continue -->
```typescript
const result = await server.kora.apply(
  { collection: 'todos', type: 'update', recordId: 'todo-1', data: { completed: true } },
  { scope: { todos: { userId: 'user-1' } } },
)
if (!result.ok) console.warn(result.code, result.message)
```

## Authentication

An `AuthProvider` has `authenticate(token)` returning an `AuthContext` or `null`, and optional
`onRevoke(listener)`.

| `AuthContext` field | Description |
|---------------------|-------------|
| `userId` | Required. |
| `scopes` | Per-collection filters for both directions; collections it omits are denied. |
| `downlinkScopes` / `uplinkScopes` | Separate read and write grants (override `scopes`). |
| `metadata` | Free-form. |
| `anonymous` | Set by `MixedAuthProvider` for token-less sessions. |
| `expiresAt` | Credential expiry (ms); the session ends when it passes. |

| Provider | Description |
|----------|-------------|
| `NoAuthProvider` | Default without `auth`: every client is `userId: 'anonymous'` and shares one data space. |
| `TokenAuthProvider({ validate })` | Your own token check. |
| `KoraAuthProvider({ tokenValidator, userLookup, deviceTracker?, resolveScopes? })` | Bridges `@korajs/auth` stores. `createKoraAuthServer().auth` is the simpler path (see [Authentication](/guide/authentication)). |
| `MixedAuthProvider({ primary, anonymousScopes, anonymousPrefix? })` | A token is judged by `primary` (an invalid one is refused, not downgraded); only a client with no token is anonymous, with exactly `anonymousScopes`. |

Scope helpers: `resolveSessionScopes`, `resolveSessionScopeGrant`, `normalizeScopeMap`,
`operationMatchesScopes`, `authorizeUplinkWrite`, `claimScopes`. A grant value that is missing
fails closed (`ScopeRequiredError`, `INVALID_SCOPE_PREDICATE`); predicates are limited to
`DEFAULT_MAX_SCOPE_PREDICATE_VALUES` values (`ScopePredicateLimitError`).

## Operation validation

`validateOperation(operation, { auth, kora })` runs at ingest for every client operation, after the
built-in checks (id, timestamp, size, rate, scope) and before the fold. Return `{ action: 'accept' }`,
`{ action: 'reject', code, message, retriable? }` or `{ action: 'ignore' }` (handled out of band,
for example by writing a derived record through `kora`). See
[Server-side Validation](/guide/server-side-validation).

```typescript
import type { OperationValidator } from '@korajs/server'

const validateOperation: OperationValidator = (operation, context) => {
  if (!context.auth && operation.collection !== 'responses') {
    return { action: 'reject', code: 'SCOPE_VIOLATION', message: 'Sign in to edit this.' }
  }
  return { action: 'accept' }
}
```

## Rejections

A refused operation reaches its author as `sync:operation-rejected` with `{ code, message,
retriable }` and stays in `app.sync.getRejectedOperations()`. `RETRIABLE_REJECTION_CODES` contains
`RATE_LIMIT`; `isRetriableRejection(code)` tests membership. Every other code is permanent, for
example `SCOPE_VIOLATION`, `CONSTRAINT_VIOLATION`, `RESTRICTED`, `INVALID_OPERATION_ID`,
`OPERATION_TOO_LARGE` and `NODE_ID_MISMATCH`. The [Error Codes reference](/api/errors#wire-codes)
lists them all.

## Awareness relay

`AwarenessRelay` forwards presence between sessions without storing it (`addClient`, `hasClient`,
`removeClient`, `handleUpdate`, `getClientCount`, `clear`). `handleUpdate(sessionId, message,
audience?)` takes an optional `AwarenessAudience`, `(targetSessionId) => boolean`, deciding who may
see the state; without one the state stays in the sender's partition (`addClient`'s fourth
argument). `KoraSyncServer` runs one per server, relays only between sessions that completed a
handshake, and delivers a state whose cursor names a record to the sessions whose download scope
contains that record (a state without a cursor: identical download scope, never anonymous
sessions). See [Presence](/guide/presence#who-sees-a-presence-state).

## Logging

`createDefaultLogger()`, `createJsonLogger()`, `createPrettyLogger()` and `createSilentLogger()`
build a `Logger` for the `logger` option.
