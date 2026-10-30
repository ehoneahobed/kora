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
| `operationalAuth` | `{ adminToken?, metricsToken?, backupToken?, allowPublic? }`; endpoints without a token are disabled under `NODE_ENV=production` (403) unless `allowPublic`, public otherwise |
| `crossOriginEmbedderPolicy` | `'credentialless'` |
| `trustProxy` | `false`: `request.ip` is the socket address unless the proxy is trusted |
| `maxRequestBodyBytes` | 1 MiB for `httpRoutes` bodies (larger requests get 413) |
| `maxBackupBytes` | 256 MiB for `/__kora/backup/import` |

The handle (`ProductionServer`) has `start()` (resolves to the URL), `stop()`, `kora` (the
[route context](#route-context)), `getLiveBlobRefs()`, `refreshScopes(userId)`,
`revalidateSessions()`, `forceFullResync({ userId?, nodeId? })` and `onOperationsCommitted(handler)` (see the `KoraSyncServer` methods below). `/health` is always public and answers `{ status, version, authRequired, protocolVersion, uptime, connectedClients, totalOperations, timestamp }`. `authRequired` is a boolean (true when an `auth` provider other than `NoAuthProvider` guards the sync handshake) and `protocolVersion` is the highest sync protocol the server speaks (2 from 1.0.0-beta.13); neither reveals a credential. `kora doctor --production --url` reads them. Both are also in `getStatus()` and `/__kora/status`; `/__kora/*`
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
| `refreshScopes(userId)` | Re-checks one user's live sessions now, after a membership change; a session whose grant changed ends with a retriable `SCOPE_CHANGED` and reconnects with the new grant. Returns how many ended. This process only. |
| `revalidateAccessSessions()` | Ends every live session whose access rules are no longer in force (the store is rebuilding its membership index, or rebuilt it since the session started) with a retriable `ACCESS_RULES_CHANGED`; each reconnects and is re-scoped. Runs on every delivery poll and after `/__kora/backup/import`; call it after `store.importBackup(...)` in your own code. |
| `releaseNodeClaim(nodeId)` | Releases a device node id so the next principal can claim it. |
| `forceFullResync({ userId?, nodeId? })` | Makes every device of a user, or one device node, download everything again: its next handshake restarts delivery from 0 (the path a restored server uses), and this instance's live sessions end with a retriable `RESYNC_REQUIRED` so they reconnect now. Stored in the server store (request tokens come from a counter there, shared by every instance), so a device that is offline or on another instance resyncs when it next connects, once per request in each delivery view (scope and query subsets) it streams under. A custom store must implement `requestFullResync`, `getFullResyncState` and `completeFullResync` together, or it refuses with `FULL_RESYNC_UNSUPPORTED`. Use it to repair devices that kept data a fixed bug should have removed (re-scoping does not: it judges the device's own values). Watermark clients only (1.0.0-beta.5 and later). Returns how many live sessions ended. |
| `applyLocalOperation(...)`, `relayServerOperations(operations)` | Server-authored writes and their fan-out (prefer the route context). Both report to `onOperationsCommitted`. |
| `onOperationsCommitted(handler)` | Runs `handler` after every committed batch on this instance; returns an unsubscribe function. See [Reacting to committed writes](#operations-committed). |
| `getKoraContext()` | The route context. |
| `getStatus()` | `{ running, connectedClients, port, totalOperations, uptime, version, schemaVersion, connectedNodeIds, peakConnections, connectionsTotal }`. |
| `getConnectionCount()`, `getMetricsCollector()`, `getLogger()`, `getLiveBlobRefs()` | Introspection. |
| `authoritativeNodeIds` | Node ids whose writes win `merge('server-authoritative')` fields. |

`KoraSyncServerConfig` fields (`auth`, `emitter`, `schemaVersion`, `supportedSchemaVersions`,
`operationTransforms`, `encryption`, `validateOperation`, `onOperationsCommitted`, size and rate limits, heartbeats,
`sessionRevalidationIntervalMs`, blob callbacks, `logger`, ...) are listed with their defaults in
[Server options](/guide/production-server#server-options).

## Read-through endpoint {#read-through}

`POST <syncPath>/read` (default `/kora-sync/read`) answers a query from the server's current
state, for a device that has not replicated yet. It is mounted by `createProductionServer`; with
`KoraSyncServer` alone, map the request to `handleReadRequest(request)`
(`method`, `authorization`, `body`, `contentType`, and for cookie credentials `hasCookie`,
`koraReadHeader`, `origin`, `host`; `clientKey` for the pre-authentication limit).

It is authenticated like a handshake and the grant is the server's: scopes come from the verified
identity, access rules and membership intervals apply, and the request's `where` can only narrow
them. A read never returns more than the sync stream would deliver to the same session.

```json
{ "v": 1, "schemaVersion": 1,
  "queries": [{ "key": "q1", "collection": "lessons", "where": { "published": true },
                "orderBy": [{ "field": "title", "direction": "asc" }],
                "limit": 50, "include": ["course"], "known": ["l1"], "cursor": "..." }] }
```

The 200 answer is `{ frontier, grantKey, results }`. `frontier` is the delivery sequence the
rows reflect: it is read after the rows, so no row reflects a later operation. `grantKey` changes
when the grant does. Each result has:

- `status`: `ok` only when the answer is complete. `partial` is incomplete (more rows with a
  `cursor`, or rows left out for another `reason`); `unsupported` means the server did not answer
  the query; `denied` means the grant does not cover the collection (an unknown collection answers
  alike).
- `reason` (when not `ok`): `row-cap`, `byte-budget`, `query-row-cap`, `too-many-candidates`,
  `work-budget`, `scope-too-wide`, `encrypted-records`, `encryption-required`, `unsupported-shape`,
  `include-incomplete`, `known-truncated`, `records-changed`, `cursor-invalid`, `cursor-too-large`.
- `records` (`id`, `values`, `fieldVersions`, `created`, `latest`), `included`, and
  `includedStatus` per included collection (`ok`, `partial`, `unsupported`, `denied`, with a
  `reason`). An include that is not `ok` makes the result `partial`.
- `refreshed` (readable `known` ids that left the query) and `absent` (`known` ids the principal
  cannot read, or that do not exist: one list, so it is no oracle).
- `cursor`, a signed keyset continuation bound to the query, the principal and the grant. A
  cursor that does not verify (another instance, a restart, a changed grant) answers that query
  alone `unsupported` with reason `cursor-invalid`: ask again without it. `maxQueryRows` counts
  from the start of the query, offset included.
- `absent` lists only ids that are gone or outside the grant (every `known` id for a `denied` or
  `encryption-required` answer); a limit of the server never lists any, and an id served as a
  record is never also absent.
- A record that was deleted, or moved out of the grant, while the answer was being built is never
  served and never makes a short page look complete: the answer is built again once, and if rows
  still drop out the result is `partial` with reason `records-changed` (with a `cursor` when more
  rows follow). A `known` id that drops out is `absent`.
- A paged chain is not one snapshot. Every page reflects its own `frontier`, and the chain is
  only as fresh as its earliest page: a row updated between two pages so that it sorts before
  the cursor is not served by the later page, and a device that needs the newest state asks again
  from the first page.

For a shape the evaluator cannot judge, `unsupported` carries the scoped candidates as a superset
for the client's SQL. For a scope wider than `maxCandidates`, or a request past `maxWork`, it
carries no rows. A record with an encrypted operation is never served: only that record is left
out and the result is `partial` (`encrypted-records`).

| Status | Code | Meaning |
|--------|------|---------|
| 400 | `INVALID_READ_REQUEST` | Malformed body. (A cursor that is forged or belongs to another query or user is not an error: that query answers `unsupported`, reason `cursor-invalid`, with status 200.) |
| 401 | | Missing, rejected, expired or revoked credential (`WWW-Authenticate: Bearer`). |
| 403 | | Access rules not satisfiable, or a cookie request without the `x-kora-read` header or from another origin. |
| 404 | | Endpoint disabled, or the server has no schema. |
| 405 / 415 | | Not `POST`, or not `application/json`. |
| 408 | `REQUEST_TIMEOUT` | The body did not arrive within 10 seconds. |
| 409 | `SCHEMA_MISMATCH`, `ACCESS_RULES_CHANGED`, `READ_CONFLICT` | Other schema version (not retriable); the grant changed during the read, or a record kept changing while it was read (retriable). |
| 413 | `REQUEST_TOO_LARGE` | Body past `maxRequestBytes`; never buffered or parsed. |
| 429 | `RATE_LIMITED`, `TOO_MANY_READS`, `AUTH_BUSY` | Token bucket, in-flight cap, too many bodies being received, or (`AUTH_BUSY`) a first request with a token the server has not seen while the global cap on auth-provider calls is spent; `Retry-After` is set. |
| 503 | `AUTH_UNAVAILABLE` | The auth provider threw or did not answer within `authGuard.timeoutMs`; retriable. |

Configure with `readThrough` (all optional):

| Option | Default | |
|--------|---------|---|
| `enabled` | `true` | `false` answers 404. |
| `maxRows` / `maxBytes` | 500 / 1 MiB | Per query; past them the answer is `partial` with a cursor. |
| `maxCandidates` | 10,000 | Scoped rows read per store query; a wider scope answers `unsupported`. |
| `maxWork` | 30,000 | Work per request: rows loaded, 5 per store query, version and row re-reads (retries included), encrypted-record checks. |
| `maxQueryRows` | 5,000 | Rows one query may page through. |
| `maxRequestBytes` | 512 KiB | Request body. |
| `cursorSecret` | random per process | Signs cursors. Set the same value on every instance behind a load balancer, or a cursor only continues on the instance that issued it. |
| `rate.perSecond` / `rate.burst` | 20 / 20 | Token bucket per principal. |
| `rate.concurrent` / `rate.maxConcurrent` | 4 / 64 | Reads in flight per principal / server. |
| `rate.anonymous` | 200/s, burst 200, 16 | Reads without an identity (no auth provider or an anonymous principal), one bucket per address. |
| `authGuard.ttlMs` | 5,000 | How long an authentication is remembered, never past the credential's expiry. `0` turns the cache off. |
| `authGuard.maxConcurrent` / `perSecond` / `burst` | 16 / 100 / 100 | Global cap on auth-provider calls for tokens the server has not seen (a quarter of it is a separate lane for addresses that recently failed). |
| `authGuard.timeoutMs` | 8,000 | Deadline of one provider call; past it the slot is freed and the read answers 503. A late answer is not cached. |

Authentication is bounded by the token, not the address. A fingerprint (an HMAC; the token is
never stored) of every bearer token that authenticated is remembered for `authGuard.ttlMs`, so a
signed-in user's reads skip the provider and every address check, and concurrent first requests
with one token share a single provider call. A repeated bad token is answered from a negative
cache for at most two seconds (so a token refused and then made valid is still refused for that
long). Only calls for tokens not seen before are capped globally (`AUTH_BUSY`, retriable).

What the cap does and does not promise: a user is safe from it only within `authGuard.ttlMs` of
their last read. A user with no cache entry (a first visit, an idle tab) is subject to it, and a
flood of distinct garbage tokens from many addresses (or from any address when `trustProxy` is
unset) can make cold reads answer 429 `AUTH_BUSY`. Addresses that recently failed draw from a
separate quarter of the budget, which stops one noisy address, not a distributed flood. A
Kora client waits for replication when it gets `AUTH_BUSY`.

Staleness: the cache is dropped for a user by `refreshScopes(userId)`, and for everyone by
`terminateSessions` (which an auth provider's `onRevoke` feed calls), the periodic
`revalidateSessions`, and a change of the membership index generation. An authentication that
was in flight during an eviction is used once and not cached. A provider whose scopes or
revocations change without calling the server is stale for up to `authGuard.ttlMs`. Set it to
`0` to ask the provider on every read.

Failed sign-ins are charged to the client address only when `trustProxy` is set on
`createProductionServer` (the address is then a real client's), keyed by the IPv6 /64; an address
out of failure tokens is refused with 429 before the provider is asked. With `trustProxy` unset
there is no per-address charge, because behind a reverse proxy or platform router (Fly,
Railway, ...) every user has the proxy's address, and the server warns at start. The request
body is parsed only after authentication and the principal's rate check.

Answers are never cacheable (`Cache-Control: no-store, private`, `Vary: Authorization, Cookie`).
A custom `ServerStore` must implement `recordsWithEncryptedOperations` to be read through;
without it every collection answers `unsupported`. Design: `docs/design/first-visit-parity.md`
(S2 result).

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
| `applyRemoteOperation(op, options?)` | Ingest path used by the sync server. With `authorize` and `previewResult`, the store folds the operation onto the record in the same critical section and passes the resulting record to `authorize` as `context.resulting` (access rules judge it). A custom store without it limits atomic intents in access-ruled collections to 4 per operation. |
| `getMaxDeliverySequence()`, `getOperationsAfterDelivery(after, limit)` | The delivery sequence behind gap-free downloads. |
| `exportBackup()`, `importBackup(data, merge?)` | The operation log plus the users' encryption key records (`merge: false` replaces the log, `true` merges into it); an import reconciles key records (replace mode takes the backup's; merge mode adds missing ones and advances an older revision of the same ring). Used by `/__kora/backup/*` and `kora backup`. With access rules, call `server.revalidateAccessSessions()` after an `importBackup` you run yourself (the backup route does). |
| `getMembershipIntervals(userId)`, `getAccessIndexState()`, `isAccessIndexReady()`, `accessIndexGeneration()` | The membership index access rules are judged against: a user's intervals; the index state (`frontier`, `generation`, `rebuilding`); `false` while this store rebuilds the index or another instance's restore is rebuilding it; the generation this instance last saw. A custom store needs the first two for access rules (`ACCESS_RULES_UNSUPPORTED_STORE` otherwise). The other two are optional: without them, sessions follow the generation and rebuilding state `getAccessIndexState()` reports at every delivery poll, so a rebuild reaches them within one poll instead of at their next send. |
| `refoldOutdatedRecords(limit?)` | Optional. Re-folds a batch of records an instance on another fold plan wrote (a rolling deploy that changed transforms or merge rules), when this instance runs the plan the database records; returns how many. The sync server calls it on every delivery poll. The built-in SQLite and Postgres stores implement it. |
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
| `applyConditional({ collection, id, if?, update?, also?, reject?, idempotencyKey? }, { scope? })` | Reads the target, checks the predicate (`$eq`, `$ne`, `$lt`, `$lte`, `$gt`, `$gte`, `$in`) and commits the update plus every `also` mutation only if it holds, at most once per `idempotencyKey`. All or nothing, on every store. |
| `transaction(async (tx) => mutations \| tx.reject(code, message), { scope? })` | Read, decide and write as one step: no other write commits between the reads `tx` makes (`findById`, `query`, `roleOf`) and the commit, and the mutations commit together or not at all. Resolves like `applyConditional` without `idempotent`. |
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

### Transactions {#transactions}

`kora.transaction` is for decisions that must hold when they commit: the last seat, a stock
level, an invitation that must still be valid. Every write waits while a transaction decides, on
every server instance sharing the database, so keep the decision short. The decision may run more
than once (on SQLite it is made again when another process committed meanwhile), so it must have
no effect besides the result it returns. Return writes from the
decision instead of starting them inside it: `kora.apply` or `server.access.grant` called there
throws `RouteTransactionReentryError` (use `server.access.prepareGrant(tx, ...)` to add a
membership change to the transaction).

<!-- docs-check: continue -->
```typescript
const booking = await server.kora.transaction(async (tx) => {
  const seat = await tx.findById('seats', 'seat-1')
  if (!seat || seat.takenBy) return tx.reject('TAKEN', 'This seat is taken.')
  return [
    { collection: 'seats', type: 'update', recordId: 'seat-1', data: { takenBy: 'user-1' } },
    { collection: 'bookings', type: 'insert', data: { seatId: 'seat-1', userId: 'user-1' } },
  ]
})
if (!booking.ok) console.warn(booking.code, booking.message)
```

Each mutation is checked like any other write (schema, constraints, relations, scope), against the
state the whole transaction leaves: a parent inserted with its child passes, two inserts with one
unique value are refused, and children removed in the same transaction do not block deleting
their parent. `tx.roleOf(userId, group)` reads the access index (see
[Access Rules](/guide/access-rules)). A custom `ServerStore` without `transact` runs the decision
and the writes one after the other, without isolation.

## Reacting to committed writes {#operations-committed}

`onOperationsCommitted(operations, context)` runs once per batch of operations after they are
durably committed. Use it for work that must follow a write that really happened: a share was
revoked, so re-check live sessions with `server.revalidateSessions()` and clean up your own rows.
`validateOperation` cannot do this, because it runs before the commit and the write may still be
refused.

<!-- docs-check: continue -->
```typescript
const committedServer = createProductionServer({
  store,
  syncOptions: {
    schemaVersion: schema.version,
    onOperationsCommitted: (operations, { source, auth }) => {
      if (operations.some((op) => op.collection === 'todos' && op.type === 'delete')) {
        console.log(`todos deleted by ${source === 'sync' ? auth?.userId : 'the server'}`)
      }
    },
  },
})
// More handlers, registered later; each call returns its unsubscribe function.
const stopListening = committedServer.onOperationsCommitted(async () => {
  await committedServer.revalidateSessions()
})
```

| Write path | `context.source` | `context.auth` / `context.sessionId` |
|------------|------------------|--------------------------------------|
| Device uploads over WebSocket or HTTP long-polling | `'sync'` | The session's `AuthContext` and id |
| `server.kora.apply`, `applyConditional`, `transaction`, `server.access`, the `@korajs/spaces` routes, writes a validator makes through `context.kora`, `applyLocalOperation`, `relayServerOperations` | `'server'` | `null` / `null` |
| Backup restore (`/__kora/backup/import`, `store.importBackup`) | not called | |

- **One call per batch, after the commit.** An upload batch, one `kora.apply`, one transaction
  or one `applyConditional` set is one call (on a custom store without `transact`, which commits
  a set one mutation at a time, one call per mutation). The referential side effects (cascade, set-null) and
  cross-record corrections a write causes are in the same call, after it. A batch that stops part
  way (a store error, the session ending, a cascade or correction failing after the write
  committed) still reports and delivers everything it committed before the failure; a
  `kora.apply` whose follow-up failed rejects, but its committed write is reported.
- **Only what was committed.** Refused, ignored (`validateOperation` returned `ignore`) and
  duplicate operations never appear, and a batch in which nothing committed makes no call.
- **Operations as stored.** Each handler gets its own deep, frozen copy of the operations (in
  commit order) and of the context, `auth` included: neither can be changed, and nothing a
  handler does reaches the session's credential, other devices or the next handler. The copy is a
  `structuredClone`; when `auth` holds something that cannot be cloned (a function in `metadata`,
  say), only that is left out (dropped from an object, `Map` or `Set`, `undefined` in an array),
  and `Date`s, `Map`s, `Set`s and typed arrays elsewhere are kept as they are. A device on
  an older schema version wrote its operation in that version (`op.schemaVersion`), and an
  end-to-end encrypted operation carries its data only in `op.encrypted`. To act on the current
  record, read it with `server.kora.findById`.
- **Never in the way of the write.** The handler is not awaited, so calls can overlap and are not
  ordered across sessions. A handler that throws or rejects is logged as
  `operations.commit_hook_failed`, counted in the error metrics and emitted on the server's
  `emitter` as `server:commit-hook-failed`; the commit, the acknowledgment and the delivery to
  other devices are unaffected. Keep synchronous work short: it runs on the server's event loop.
- **This instance only.** With several server instances, each batch is reported on the instance
  that committed it. A process that stops between the commit and the call does not report it, so
  for work that must not be missed, also reconcile periodically (as a sweep on start-up).
- **A restore is not reported.** It replaces or merges the whole log; re-derive whatever your
  handler maintains after one.

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
| `accessGrants` | Capability grants under access rules: `[{ group, role, expiresAt? }]`, roles in groups this credential holds without a membership (a share link). See [Capability grants](/guide/access-rules#capability-grants-share-links). |

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
