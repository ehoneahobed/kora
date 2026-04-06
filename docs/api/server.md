# Server API Reference

`@korajs/server` provides a self-hosted sync server that coordinates operations between connected clients. It handles operation relay, persistence, authentication, and multi-transport support.

```typescript
import {
  createKoraServer,
  KoraSyncServer,
  MemoryServerStore,
  PostgresServerStore,
  SqliteServerStore,
  NoAuthProvider,
  TokenAuthProvider,
} from '@korajs/server'
```

---

## createKoraServer()

Creates and configures a Kora sync server. This is the primary entry point for setting up a server.

### Signature

```typescript
function createKoraServer(config: KoraSyncServerConfig): KoraSyncServer
```

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `config` | `KoraSyncServerConfig` | Server configuration object. |

#### KoraSyncServerConfig

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `store` | `ServerStore` | No | `MemoryServerStore` | Server-side storage for operations and state. |
| `port` | `number` | No | `4567` | Port to listen on. |
| `host` | `string` | No | `'0.0.0.0'` | Host to bind to. |
| `auth` | `AuthProvider` | No | `NoAuthProvider` | Authentication provider for client connections. |
| `transports` | `ServerTransport[]` | No | `[WsServerTransport]` | Array of transport layers to enable. |
| `schema` | `SchemaDefinition` | Yes | -- | The application schema. Must match the client schema version. |
| `onError` | `(error: Error) => void` | No | `console.error` | Error handler for unrecoverable server errors. |

### Returns

`KoraSyncServer` -- A configured server instance ready to be started.

### Example

```typescript
import { createKoraServer, PostgresServerStore, TokenAuthProvider } from '@korajs/server'
import { defineSchema, t } from 'korajs'

const schema = defineSchema({
  version: 1,
  collections: {
    todos: {
      fields: {
        title: t.string(),
        completed: t.boolean().default(false),
      },
    },
  },
})

const server = createKoraServer({
  schema,
  port: 4567,
  store: new PostgresServerStore({
    connectionString: 'postgresql://user:pass@localhost:5432/kora',
  }),
  auth: new TokenAuthProvider({
    verify: async (token) => {
      const user = await verifyJWT(token)
      return { userId: user.id }
    },
  }),
})

await server.start()
console.log('Kora sync server running on port 4567')
```

---

## KoraSyncServer

The sync server instance returned by `createKoraServer()`. Manages client connections, operation relay, and persistence.

### Methods

#### .start()

Starts the server and begins accepting client connections on all configured transports.

```typescript
start(): Promise<void>
```

```typescript
const server = createKoraServer({ schema, port: 4567 })
await server.start()
```

#### .stop()

Gracefully shuts down the server. Closes all active client connections and releases resources.

```typescript
stop(): Promise<void>
```

```typescript
await server.stop()
```

---

## Server stores

Server stores handle persistent storage of operations on the server side. Three implementations are provided.

### MemoryServerStore

In-memory storage. Operations are lost when the server restarts. Useful for development and testing.

```typescript
new MemoryServerStore()
```

No configuration options. This is the default store if none is specified.

```typescript
const server = createKoraServer({
  schema,
  store: new MemoryServerStore(),
})
```

### createPostgresServerStore()

Creates a PostgreSQL-backed server store using Drizzle ORM. Recommended for production deployments. Requires the `postgres` package (`npm install postgres`).

```typescript
async function createPostgresServerStore(options: {
  connectionString: string
  nodeId?: string
}): Promise<PostgresServerStore>
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `connectionString` | `string` | Yes | PostgreSQL connection URL. |
| `nodeId` | `string` | No | Server node ID. Auto-generated if omitted. |

```typescript
import { createPostgresServerStore } from '@korajs/server'

const store = await createPostgresServerStore({
  connectionString: 'postgresql://user:pass@localhost:5432/kora',
})
```

Tables are created automatically on first connection. No manual migration is needed.

### createSqliteServerStore()

Creates a SQLite-backed server store. Suitable for single-node deployments and development. Data persists to disk and survives server restarts.

```typescript
function createSqliteServerStore(options: {
  filename?: string
  nodeId?: string
}): SqliteServerStore
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `filename` | `string` | No | `':memory:'` | Path to the SQLite database file. Created if it does not exist. |
| `nodeId` | `string` | No | Auto-generated | Server node ID. |

```typescript
import { createSqliteServerStore } from '@korajs/server'

const store = createSqliteServerStore({
  filename: './data/kora.db',
})
```

---

## Transports

Transports define how clients connect to the server. Multiple transports can run simultaneously.

### WsServerTransport

WebSocket transport using the `ws` library. This is the default transport and is recommended for real-time sync.

```typescript
new WsServerTransport(options?: WsServerTransportOptions)
```

#### WsServerTransportOptions

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `path` | `string` | No | `'/kora'` | WebSocket endpoint path. |
| `maxPayloadSize` | `number` | No | `1048576` (1 MB) | Maximum message size in bytes. |
| `heartbeatInterval` | `number` | No | `30000` (30s) | Interval between keepalive pings in milliseconds. |

```typescript
import { WsServerTransport } from '@korajs/server'

const server = createKoraServer({
  schema,
  transports: [
    new WsServerTransport({ path: '/sync', heartbeatInterval: 15000 }),
  ],
})
```

Clients connect with:

```typescript
const app = createApp({
  schema,
  sync: { url: 'wss://my-server.com/sync' },
})
```

### HttpServerTransport

HTTP long-polling transport. Useful for environments where WebSocket connections are blocked or unreliable (e.g., restrictive corporate firewalls).

```typescript
new HttpServerTransport(options?: HttpServerTransportOptions)
```

#### HttpServerTransportOptions

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `path` | `string` | No | `'/kora/http'` | HTTP endpoint base path. |
| `pollTimeout` | `number` | No | `30000` (30s) | Long-poll timeout in milliseconds before returning an empty response. |
| `batchSize` | `number` | No | `100` | Maximum number of operations per response. |

```typescript
import { HttpServerTransport, WsServerTransport } from '@korajs/server'

const server = createKoraServer({
  schema,
  transports: [
    new WsServerTransport(),
    new HttpServerTransport(),    // Fallback for restricted environments
  ],
})
```

---

## Authentication

Auth providers validate client connections and extract identity context used for sync scoping.

### NoAuthProvider

Accepts all connections without authentication. Suitable only for development and testing.

```typescript
new NoAuthProvider()
```

This is the default if no `auth` option is specified.

### TokenAuthProvider

Validates clients using bearer tokens. The `verify` function receives the token and must return a context object or throw to reject the connection.

```typescript
new TokenAuthProvider(options: TokenAuthProviderOptions)
```

#### TokenAuthProviderOptions

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `verify` | `(token: string) => Promise<AuthContext>` | Yes | Async function that validates the token and returns an auth context object. Throw an error to reject the connection. |

#### AuthContext

The object returned by `verify`. Its properties are available in sync scope functions on the client.

```typescript
interface AuthContext {
  userId: string
  [key: string]: unknown  // Additional properties as needed
}
```

### Example with JWT

```typescript
import { TokenAuthProvider } from '@korajs/server'
import jwt from 'jsonwebtoken'

const auth = new TokenAuthProvider({
  verify: async (token) => {
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET)
      return { userId: payload.sub }
    } catch {
      throw new Error('Invalid token')
    }
  },
})
```

### Client-side auth configuration

On the client, provide an `auth` function in the sync configuration that returns an object with a `token` property:

```typescript
const app = createApp({
  schema,
  sync: {
    url: 'wss://my-server.com/kora',
    auth: async () => ({
      token: await getAuthToken(),
    }),
  },
})
```

The auth function is called on every connection attempt, allowing token refresh.

---

## ClientSession

Represents an active client connection on the server. Exposed through server events for monitoring and debugging.

```typescript
interface ClientSession {
  /** Unique session identifier. */
  id: string

  /** Node ID of the connected client. */
  nodeId: string

  /** Auth context returned by the auth provider. */
  authContext: AuthContext | null

  /** Client's version vector at the time of the last sync. */
  versionVector: VersionVector

  /** Transport type for this session ('websocket' | 'http'). */
  transport: string

  /** Timestamp of when the session was established. */
  connectedAt: number
}
```

---

## Full server example

A complete production-ready server setup:

```typescript
import {
  createKoraServer,
  createPostgresServerStore,
  TokenAuthProvider,
  WsServerTransport,
  HttpServerTransport,
} from '@korajs/server'

const store = await createPostgresServerStore({
  connectionString: process.env.DATABASE_URL,
})

const server = createKoraServer({
  store,
  port: Number(process.env.PORT) || 4567,
  auth: new TokenAuthProvider({
    verify: async (token) => {
      const user = await verifyToken(token)
      return { userId: user.id }
    },
  }),
  transports: [
    new WsServerTransport({ path: '/sync' }),
    new HttpServerTransport({ path: '/sync/http' }),
  ],
  onError: (error) => {
    console.error('Kora server error:', error)
  },
})

await server.start()
console.log(`Kora sync server running on port ${server.port}`)

// Graceful shutdown
process.on('SIGTERM', async () => {
  await server.stop()
  process.exit(0)
})
```
