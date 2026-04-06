# Server API Reference

`@korajs/server` is the self-hosted sync server for Kora clients.

## Imports

```typescript
import {
  createKoraServer,
  KoraSyncServer,
  MemoryServerStore,
  SqliteServerStore,
  PostgresServerStore,
  createSqliteServerStore,
  createPostgresServerStore,
  NoAuthProvider,
  TokenAuthProvider,
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
| `port` | `number` | No | `4567` |
| `host` | `string` | No | `'0.0.0.0'` |
| `path` | `string` | No | `'/'` |
| `auth` | `AuthProvider` | No | `NoAuthProvider` behavior |
| `batchSize` | `number` | No | `100` |
| `maxConnections` | `number` | No | `0` (unlimited) |
| `schemaVersion` | `number` | No | `1` |

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

## `KoraSyncServer`

Main server class.

### Methods

- `start(): Promise<void>` — starts WebSocket server mode.
- `stop(): Promise<void>` — gracefully stops server and sessions.
- `handleConnection(transport): string` — attach a server transport manually.
- `handleHttpRequest(request): Promise<HttpSyncResponse>` — HTTP sync endpoint handler.
- `getStatus(): Promise<ServerStatus>` — returns runtime status.
- `getConnectionCount(): number` — returns active connection count.

## Stores

### `MemoryServerStore`

In-memory only (testing/development).

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

## Authentication

### `NoAuthProvider`

Accepts all connections.

### `TokenAuthProvider`

Validates token with your `validate` function.

```typescript
const auth = new TokenAuthProvider({
  validate: async (token) => {
    const user = await verifyToken(token)
    return user ? { userId: user.id } : null
  },
})
```

Return shape:

- `userId` (required)
- `scopes` (optional, server-side filtering context)
- `metadata` (optional)
