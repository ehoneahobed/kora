---
title: Server API
description: "@korajs/server API reference: the self-hosted sync server, memory, SQLite, and Postgres stores, sync rules, rate limits, and backups."
---

# Server API Reference

`@korajs/server` is the self-hosted sync server for Kora clients.

## Imports

```typescript
import {
  createKoraServer,
  createProductionServer,
  KoraSyncServer,
  MemoryServerStore,
  SqliteServerStore,
  PostgresServerStore,
  createSqliteServerStore,
  createPostgresServerStore,
  NoAuthProvider,
  TokenAuthProvider,
  MixedAuthProvider,
  KoraAuthProvider,
  AwarenessRelay,
  RETRIABLE_REJECTION_CODES,
  isRetriableRejection,
} from '@korajs/server'
```

Type-only exports for the validation and route-context surfaces are imported the same way:

```typescript
import type {
  OperationValidator,
  OperationValidationContext,
  OperationDecision,
  OperationRejection,
  ProductionServer,
  ProductionHttpRouteContext,
  RouteMutation,
  RouteScopeOptions,
  RouteApplyResult,
} from '@korajs/server'
```

## `createKoraServer(config)`

Creates a `KoraSyncServer`.

```typescript
function createKoraServer(config: KoraSyncServerConfig): KoraSyncServer
```

### `KoraSyncServerConfig`

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `store` | `ServerStore` | Yes | -- |
| `port` | `number` | No | none (required for standalone `start()`; omit for attach mode via `handleConnection()`) |
| `host` | `string` | No | `'0.0.0.0'` |
| `path` | `string` | No | `'/'` |
| `auth` | `AuthProvider` | No | `NoAuthProvider` behavior |
| `batchSize` | `number` | No | `100` |
| `maxConnections` | `number` | No | `0` (unlimited) |
| `schemaVersion` | `number` | No | `1` |
| `maxOperationBytes` | `number` | No | `262144` (256 KiB) |
| `maxOpsPerMinute` | `number` | No | `600` |
| `validateOperation` | `OperationValidator` | No | -- (all operations accepted) |

`maxOperationBytes` is the maximum serialized byte size of a single client operation accepted at sync ingest; operations larger than this are rejected before materialization. `maxOpsPerMinute` is the maximum operations accepted per connected client per minute (sliding window); operations beyond the limit are rejected with a retriable `RATE_LIMIT` rejection until the window resets. Both are enforced per connection across every connected client. `validateOperation` is covered under [Operation Validation](#operation-validation).

### Example

```typescript
import {
  createKoraServer,
  createPostgresServerStore,
  TokenAuthProvider,
} from '@korajs/server'

const store = await createPostgresServerStore({
  connectionString: process.env.DATABASE_URL!,
})

const auth = new TokenAuthProvider({
  validate: async (token) => {
    const payload = await verifyJWT(token)
    if (!payload) return null
    return {
      userId: payload.sub,
      scopes: {
        todos: { userId: payload.sub },
      },
    }
  },
})

const server = createKoraServer({ store, port: 3001, auth })
await server.start()
```

## `createProductionServer(config)`

Creates one HTTP server for static frontend assets, WebSocket sync, health checks, observability, dashboard, and backup endpoints.

```typescript
import { createProductionServer, createSqliteServerStore } from '@korajs/server'
import schema from './src/schema'

const store = createSqliteServerStore({ filename: './kora-server.db' })
await store.setSchema(schema)

const server = createProductionServer({
  store,
  port: Number(process.env.PORT) || 3001,
  staticDir: './dist',
  syncPath: '/kora-sync',
  httpRoutes: [
    // Example: mount @korajs/auth with createKoraAuthServer()
    // { path: '/auth', handle: auth.handleRequest },
  ],
  operationalAuth: {
    adminToken: process.env.KORA_ADMIN_TOKEN,
    metricsToken: process.env.KORA_METRICS_TOKEN,
    backupToken: process.env.KORA_BACKUP_TOKEN,
  },
})

await server.start()
```

### `ProductionServerConfig`

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `store` | `ServerStore` | Yes | -- |
| `port` | `number` | No | `3001` or `process.env.PORT` |
| `staticDir` | `string` | No | `'./dist'` |
| `syncPath` | `string` | No | `'/kora-sync'` |
| `syncOptions` | `Omit<KoraSyncServerConfig, 'store' \| 'port' \| 'host' \| 'path'>` | No | -- |
| `httpRoutes` | `ProductionHttpRoute[]` | No | -- |
| `operationalAuth` | `ProductionOperationalAuth` | No | Public endpoints |

`/health` is always public for hosting platform health checks. Operational endpoints under `/__kora/*` are protected when the matching token is configured. Send tokens with `Authorization: Bearer <token>`.

`httpRoutes` are mounted before static file serving and are useful for auth routes, webhooks, and small app APIs without adding a separate HTTP framework.

| Token | Protects |
|-------|----------|
| `adminToken` | `/__kora`, `/__kora/status`, `/__kora/events` |
| `metricsToken` | `/__kora/metrics`; falls back to `adminToken` when omitted |
| `backupToken` | `/__kora/backup/export`, `/__kora/backup/import`; falls back to `adminToken` when omitted |

### `ProductionServer`

The handle returned by `createProductionServer()`.

| Member | Type | Description |
|--------|------|-------------|
| `start()` | `Promise<string>` | Start listening. Resolves to the URL the server is available at. |
| `stop()` | `Promise<void>` | Stop the server gracefully. |
| `kora` | `ProductionHttpRouteContext` | Trusted, scoped data-plane access for server-side callers with no HTTP request (background jobs, scheduled tasks, seeding scripts). Same context handed to custom HTTP routes as `request.kora`. |
| `getLiveBlobRefs()` | `Promise<BlobRef[]>` | Every blob reference still reachable from a live record across all collections that declare a `blob` field. Pass it to `collectBlobGarbage(blobStore, refs)` from `@korajs/store` to reclaim bytes no record points at any more. |

#### Route context (`server.kora` / `request.kora`)

`ProductionHttpRouteContext` runs mutations through the same validated pipeline as sync (Tier 2 constraints, referential integrity, materialization, and fan-out to connected clients), so server-side callers and custom HTTP routes cannot bypass validation, constraints, or tenant isolation.

| Method | Signature | Description |
|--------|-----------|-------------|
| `apply` | `(mutation: RouteMutation, options?: RouteScopeOptions) => Promise<RouteApplyResult>` | Apply a mutation through the validated pipeline and relay the resulting operation to connected clients. |
| `query` | `(collection: string, options?: CollectionQueryOptions & RouteScopeOptions) => Promise<MaterializedRecord[]>` | Read materialized records from a collection, optionally scoped. |
| `findById` | `(collection: string, id: string, options?: RouteScopeOptions) => Promise<MaterializedRecord \| null>` | Read a single materialized record by id, optionally scoped. |

`RouteMutation`:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `collection` | `string` | Yes | Target collection. |
| `type` | `'insert' \| 'update' \| 'delete'` | Yes | Mutation type. |
| `recordId` | `string` | No | Optional for inserts (a UUID v7 is generated when omitted); required for updates and deletes. |
| `data` | `Record<string, unknown> \| null` | No | Field values. For updates, only the changed fields. |

`RouteScopeOptions`:

| Field | Type | Description |
|-------|------|-------------|
| `scope` | `Record<string, Record<string, unknown>>` | Per-actor scope enforced exactly like a sync session's scope: `apply()` rejects a mutation whose resulting record falls outside it, and `query()` / `findById()` only return records inside it. Omit for genuinely public routes where no per-actor isolation applies. |

`RouteApplyResult` is a discriminated union on `ok`:

- `{ ok: true; operation: Operation; record: MaterializedRecord | null }`
- `{ ok: false; code: string; message: string; retriable: boolean }`

Custom HTTP routes receive this context as `request.kora` on `ProductionHttpRouteRequest`, alongside `method`, `path`, `body`, `headers`, `query`, and `ip`.

## `KoraSyncServer`

Main server class.

### Methods

- `start(): Promise<void>`: starts WebSocket server mode.
- `stop(): Promise<void>`: gracefully stops server and sessions.
- `handleConnection(transport): string`: attach a server transport manually.
- `handleHttpRequest(request): Promise<HttpSyncResponse>`: HTTP sync endpoint handler.
- `getStatus(): Promise<ServerStatus>`: returns runtime status.
- `getConnectionCount(): number`: returns active connection count.

## Stores

All stores implement the `ServerStore` interface which extends the sync protocol's `SyncStore` with materialization support.

### `MemoryServerStore`

In-memory only (testing/development). Data is lost when the process restarts.

```typescript
const store = new MemoryServerStore()
```

### `createSqliteServerStore(options)` / `SqliteServerStore`

SQLite persistence for local or small deployments.

```typescript
const store = createSqliteServerStore({ filename: './kora-server.db' })
```

### `createPostgresServerStore(options)` / `PostgresServerStore`

PostgreSQL persistence for production.

```typescript
const store = await createPostgresServerStore({
  connectionString: process.env.DATABASE_URL!,
})
```

### Delivery sequence (gap-free server-to-client sync)

Every store assigns each stored operation a monotonic **delivery sequence** in commit order. This is the substrate for the [server-to-client delivery watermark](../guide/sync-configuration.md#delivery-guarantees-server-to-client) that guarantees no operation is ever lost on its way to a client. Two `ServerStore` methods expose it (you rarely call them directly; the sync server uses them):

| Method | Description |
|--------|-------------|
| `getMaxDeliverySequence(): Promise<number>` | The highest delivery sequence currently stored (0 when empty). |
| `getOperationsAfterDelivery(afterDeliverySequence, limit): Promise<DeliveredOperation[]>` | Operations with a delivery sequence above the cursor, in delivery order, up to `limit`. |

Operational notes:

- **Automatic migration.** On first startup after upgrading, each store adds a `delivery_seq` column and backfills existing operations deterministically (ordered by receipt time, then sequence number, then id). This runs once and needs no manual step. On SQLite and Postgres it is idempotent and safe to re-run.
- **Postgres and commit order.** On Postgres the delivery sequence is assigned from a counter row locked inside the append transaction, so delivery order equals commit (visibility) order even across multiple server instances sharing one database. This serializes appends through one counter row, a deliberate correctness-over-throughput choice; it is not a bottleneck for typical sync workloads, but is worth knowing if you drive a single Postgres at very high sustained write rates.
- **Concurrent cold start.** Schema setup and the delivery-sequence backfill run under an advisory-locked transaction, so starting several server replicas at once against a fresh database is safe.

---

## Materialized Collections

By default, the server stores data as an append-only operation log. For efficient queries (e.g., looking up records by field values), enable **materialized collections** by calling `setSchema()`. This creates actual SQL tables for each collection, with proper indexes, and dual-writes every synced operation to both the log and the collection table.

### `store.setSchema(schema)`

Creates collection tables and indexes from your schema definition. If operations already exist in the log, backfills the materialized tables automatically.

```typescript
import { defineSchema, t } from '@korajs/core'

const schema = defineSchema({
  version: 1,
  collections: {
    todos: {
      fields: {
        title: t.string(),
        completed: t.boolean().default(false),
        userId: t.string(),
      },
      indexes: ['userId', 'completed'],
    },
  },
})

// Call after creating the store, before starting the server
await store.setSchema(schema)
```

::: tip
Always call `setSchema()` before starting the sync server. The schema enables materialized tables to be created and backfilled before clients connect.
:::

### `store.queryCollection(collection, options?)`

Query records from a materialized collection with filtering, ordering, and pagination. Returns an array of `MaterializedRecord` objects.

```typescript
// Get all published forms
const forms = await store.queryCollection('forms', {
  where: { status: 'published' },
  orderBy: 'createdAt',
  orderDirection: 'desc',
  limit: 10,
  offset: 0,
})
```

#### `CollectionQueryOptions`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `where` | `Record<string, unknown>` | -- | Exact-match filters on field values |
| `orderBy` | `string` | -- | Field name to sort by |
| `orderDirection` | `'asc' \| 'desc'` | `'asc'` | Sort direction |
| `limit` | `number` | -- | Maximum records to return |
| `offset` | `number` | -- | Records to skip (for pagination) |
| `includeDeleted` | `boolean` | `false` | Include soft-deleted records |

### `store.findRecord(collection, id)`

Find a single record by ID. Returns `null` if not found or deleted.

```typescript
const form = await store.findRecord('forms', 'form-123')
if (form) {
  console.log(form.title)
}
```

### `store.countCollection(collection, where?)`

Count records, optionally filtered.

```typescript
// Total responses
const total = await store.countCollection('responses')

// Responses for a specific form
const formResponses = await store.countCollection('responses', {
  formId: 'form-123',
})
```

### `store.materializeCollection(collection)`

Get all records from a collection. When schema is set, reads from the collection table. Otherwise falls back to replaying the operation log.

```typescript
const allTodos = await store.materializeCollection('todos')
```

::: warning
`materializeCollection()` returns ALL records. For large collections, use `queryCollection()` with `limit` and `offset` for pagination.
:::

---

## Authentication

### `NoAuthProvider`

Accepts all connections. Every connection gets `userId: 'anonymous'`. Use for development/testing or apps that don't need auth.

```typescript
const server = createKoraServer({ store })
// NoAuthProvider is the default when no auth is specified
```

### `TokenAuthProvider`

Validates tokens with your custom function. Returns `null` to reject a connection.

```typescript
const auth = new TokenAuthProvider({
  validate: async (token) => {
    const user = await verifyToken(token)
    return user ? { userId: user.id } : null
  },
})
```

### `MixedAuthProvider`

Accepts both authenticated and anonymous connections. Authenticated users get full access; anonymous users get restricted access via scoped collections.

**This is the recommended provider for apps with public-facing features**, for example a form builder where authenticated users create forms but anyone can submit responses.

```typescript
import { MixedAuthProvider } from '@korajs/server'

const auth = new MixedAuthProvider({
  // Primary auth validates tokens for authenticated users
  primary: authRoutes.toSyncAuthProvider(),

  // Anonymous users can only sync the 'responses' collection
  anonymousScopes: {
    responses: {},
  },
})

const server = new KoraSyncServer({ store, auth })
```

On the client side, return an empty token for unauthenticated users (or use `createKoraAuthSync`):

```typescript
import { createKoraAuthSync } from '@korajs/auth'

const app = createApp({
  schema,
  sync: {
    url: 'wss://my-server.com/kora',
    authClient: createKoraAuthSync({ authClient, schema }),
  },
})
```

#### Options

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `primary` | `AuthProvider` | -- | Auth provider for authenticated users |
| `anonymousScopes` | `Record<string, Record<string, unknown>>` | -- | Collections anonymous users can sync. Use `{}` for unrestricted access to a collection. |
| `anonymousPrefix` | `string` | `'anon'` | Prefix for generated anonymous user IDs |

See the [Common Patterns guide](/guide/common-patterns#anonymous-public-data-access) for a complete walkthrough.

### `KoraAuthProvider`

Bridges `@korajs/auth` with the sync server. Validates JWTs issued by `TokenManager`, checks user existence, updates device timestamps, and resolves sync scopes.

```typescript
import { KoraAuthProvider } from '@korajs/server'
import { TokenManager } from '@korajs/auth/server'

const auth = new KoraAuthProvider({
  tokenValidator: tokenManager,
  userLookup: userStore,
  deviceTracker: userStore,    // optional
  resolveScopes: async (userId) => ({
    todos: { userId },
  }),
})
```

### `AuthContext`

The return type from `authenticate()`:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `userId` | `string` | Yes | Unique user identifier |
| `scopes` | `Record<string, Record<string, unknown>>` | No | Per-collection sync scope filters |
| `metadata` | `Record<string, unknown>` | No | Arbitrary metadata (device info, email, etc.) |

When `scopes` is provided, the server only sends/accepts operations matching the scope filters. For example, `{ todos: { userId: 'user-1' } }` means the user only syncs todos where `userId` equals `'user-1'`.

## Operation Validation

The `validateOperation` config hook adjudicates untrusted client operations before they become authoritative. It runs at sync ingestion for every incoming client operation, after HLC ordering and the built-in guards (timestamp, rate, size), and before materialization. This is what lets Kora serve public / multi-tenant apps where the client is not trusted. Omit it and every operation is accepted.

```typescript
import { createProductionServer } from '@korajs/server'
import type { OperationValidator } from '@korajs/server'

const validateOperation: OperationValidator = async (operation, context) => {
  // Anonymous submitters can only insert into 'responses'
  if (!context.auth && operation.collection !== 'responses') {
    return { action: 'reject', code: 'SCOPE_VIOLATION', message: 'Not allowed' }
  }
  return { action: 'accept' }
}

const server = createProductionServer({
  store,
  syncOptions: { validateOperation },
})
```

### `OperationValidator`

```typescript
type OperationValidator = (
  operation: Operation,
  context: OperationValidationContext,
) => Promise<OperationDecision> | OperationDecision
```

### `OperationValidationContext`

The context passed to the validator.

| Field | Type | Description |
|-------|------|-------------|
| `auth` | `AuthContext \| null` | The authenticated actor for the submitting session, or `null` for an anonymous / unauthenticated connection. |
| `kora` | `ProductionHttpRouteContext` | Trusted, scoped data-plane access (the same context as `server.kora` / `request.kora`). Use `kora.query` / `kora.findById` to read current authoritative state while deciding, and `kora.apply` to author a derived server operation. Authoring a new operation is preferred over mutating the incoming one, which must stay immutable so content-addressing and convergence hold. |

### `OperationDecision`

The verdict a validator returns for one incoming operation. A discriminated union on `action`:

| Variant | Shape | Meaning |
|---------|-------|---------|
| accept | `{ action: 'accept' }` | Let the operation materialize as-is and relay to connected clients. |
| reject | `{ action: 'reject'; code: string; message: string; retriable?: boolean }` | Refuse it. The operation never enters the authoritative log; a structured rejection travels back to the submitter tied to the operation id, and the submitter keeps the op in a durable rejected store. `retriable` defaults from the shared taxonomy for the code. |
| ignore | `{ action: 'ignore' }` | The server handled the operation out of band (for example the validator already authored a derived op via `context.kora`). No rejection is sent; the submitter treats it as handled and drops it from its pending queue. |

## Rejection Taxonomy

The shared vocabulary for why the server refused an operation. The `retriable` flag answers whether resubmitting the identical operation may later succeed: `true` for transient conditions (for example a rate limit), `false` for permanent ones (a constraint violation, referential conflict, malformed mutation, or scope violation).

### `OperationRejection`

| Field | Type | Description |
|-------|------|-------------|
| `code` | `string` | Stable, machine-readable reason code (for example `CONSTRAINT_VIOLATION`). |
| `message` | `string` | Human-readable explanation with enough context to debug without reproduction. |
| `retriable` | `boolean` | Whether resubmitting the identical operation may later succeed. |

### `RETRIABLE_REJECTION_CODES`

```typescript
const RETRIABLE_REJECTION_CODES: ReadonlySet<string>
```

The set of reason codes whose underlying condition is transient. Everything not listed is treated as permanent (the safe default). Currently contains `RATE_LIMIT`, the code the session emits when a client exceeds its per-minute operation budget.

### `isRetriableRejection(code)`

```typescript
function isRetriableRejection(code: string): boolean
```

Returns `true` when resubmitting the identical operation may later succeed (that is, when `code` is in `RETRIABLE_REJECTION_CODES`).

## Awareness Relay

`AwarenessRelay` broadcasts ephemeral presence/awareness state between connected clients. It does not persist any data -- awareness is purely real-time.

### `AwarenessRelay`

```typescript
import { AwarenessRelay } from '@korajs/server'

const relay = new AwarenessRelay()
```

The `KoraSyncServer` integrates the awareness relay automatically. When a client sends an awareness update, the server relays it to all other connected clients.

| Method | Description |
|--------|-------------|
| `addClient(clientId, send)` | Register a client connection for awareness broadcasts |
| `removeClient(clientId)` | Remove a client and broadcast their departure |
| `handleUpdate(clientId, state)` | Process an awareness state update from a client |
| `getStates()` | Get all current awareness states |

Awareness messages are lightweight and bypass the operation log -- they are not persisted, not synced on reconnect, and do not affect the operation DAG. See the [Presence guide](/guide/presence) for the full client-server flow.
