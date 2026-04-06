# Deployment

Kora's sync server is a lightweight Node.js process that relays operations between clients. This guide covers self-hosting the server, configuring storage backends, and setting up authentication.

## Self-Hosting the Sync Server

### Quick Start

Install the server package:

```bash
pnpm add @korajs/server
```

Create a server file (`server.ts`):

```typescript
import { createKoraServer, createSqliteServerStore } from '@korajs/server'

const store = createSqliteServerStore({ filename: './kora-server.db' })

const server = createKoraServer({
  store,
  port: 3001,
})

server.start()
```

Run it:

```bash
npx tsx server.ts
```

Your sync server is now running at `ws://localhost:3001`. Point your client at it:

```typescript
const app = createApp({
  schema,
  sync: {
    url: 'ws://localhost:3001',
  },
})
```

### Server Configuration

```typescript
import {
  createKoraServer,
  createPostgresServerStore,
  TokenAuthProvider,
} from '@korajs/server'

const store = await createPostgresServerStore({
  connectionString: process.env.DATABASE_URL,
})

const server = createKoraServer({
  store,

  // Port to listen on (default: 4567)
  port: 3001,

  // Host to bind to (default: '0.0.0.0')
  host: '0.0.0.0',

  // Authentication provider
  auth: new TokenAuthProvider({
    verify: async (token) => {
      const payload = await verifyJWT(token)
      return {
        userId: payload.sub,
        teamId: payload.teamId,
      }
    },
  }),

  // Logging level
  logLevel: 'info',  // 'debug' | 'info' | 'warn' | 'error'
})

server.start()
```

## Storage Backends

The server needs a storage backend to persist the operation log and relay operations to clients. Kora provides three built-in options.

### MemoryServerStore

Stores operations in memory. All data is lost when the server restarts. Use only for development and testing.

```typescript
import { createKoraServer, MemoryServerStore } from '@korajs/server'

const server = createKoraServer({
  store: new MemoryServerStore(),
})
```

This is the default if no `store` is specified.

### SQLite (createSqliteServerStore)

Stores operations in a local SQLite database file. Good for single-server deployments and prototyping. Data survives server restarts.

```typescript
import { createKoraServer, createSqliteServerStore } from '@korajs/server'

const store = createSqliteServerStore({
  filename: './data/kora.db',
})

const server = createKoraServer({ store })
```

### PostgreSQL (createPostgresServerStore)

Stores operations in PostgreSQL. Recommended for production deployments. Requires the `postgres` package:

```bash
npm install postgres
```

```typescript
import { createKoraServer, createPostgresServerStore } from '@korajs/server'

const store = await createPostgresServerStore({
  connectionString: 'postgresql://user:pass@localhost:5432/kora',
})

const server = createKoraServer({ store })
```

Tables are created automatically on first connection.

### Choosing a Store

| Store | Persistence | Performance | Use Case |
|-------|-------------|-------------|----------|
| `MemoryServerStore` | None | Fastest | Development, tests |
| `createSqliteServerStore` | File | Fast | Single-server, prototyping |
| `createPostgresServerStore` | Database | Production-grade | Production, multi-instance |

For a detailed guide on storage configuration, multiple apps, and switching databases, see [Storage Configuration](/guide/storage-configuration).

## Authentication

### TokenAuthProvider

`TokenAuthProvider` validates tokens sent by clients during the sync handshake. The `verify` function receives the raw token string and returns a user context object.

```typescript
import { TokenAuthProvider } from '@korajs/server'

const auth = new TokenAuthProvider({
  verify: async (token) => {
    // Validate the token (JWT, session token, API key, etc.)
    const payload = await verifyJWT(token, { secret: process.env.JWT_SECRET })

    // Return user context (available in sync scopes)
    return {
      userId: payload.sub,
      teamId: payload.teamId,
      role: payload.role,
    }
  },
})
```

The returned context object is passed to sync scope functions, allowing you to filter data per user:

```typescript
scopes: {
  todos: (ctx) => ({ where: { userId: ctx.userId } }),
  projects: (ctx) => ({ where: { teamId: ctx.teamId } }),
},
```

### Client-Side Auth

On the client, provide an async `auth` function in the sync config:

```typescript
const app = createApp({
  schema,
  sync: {
    url: 'wss://my-server.com/kora',
    auth: async () => ({
      token: await getAccessToken(),
    }),
  },
})
```

Kora calls this function before each connection attempt. If the token expires during a session, Kora will call `auth` again on reconnection.

### No Authentication

If you omit the `auth` option on the server, no authentication is required. Any client can connect. This is suitable for local development but should never be used in production.

## Production Checklist

Before deploying to production, verify the following.

### Use TLS

Always use `wss://` (WebSocket over TLS) in production:

```typescript
// Client
sync: {
  url: 'wss://my-server.com/kora',
}
```

Run the Kora server behind a reverse proxy (Nginx, Caddy, Cloudflare) that terminates TLS. The server itself listens on plain WebSocket internally.

### Configure Authentication

Never run without authentication in production. Use `TokenAuthProvider` with a proper token verification strategy (JWT, OAuth, session tokens).

### Use PostgreSQL

For production, use `createPostgresServerStore` for durable, scalable storage. Back up the database regularly.

### Set Sync Scopes

Without scopes, every client receives every operation. In a multi-tenant or multi-user app, always configure scopes to limit data access:

```typescript
scopes: {
  todos: (ctx) => ({ where: { userId: ctx.userId } }),
},
```

### Monitor the Server

The server emits events you can use for monitoring:

```typescript
server.on('client:connected', (event) => {
  console.log(`Client ${event.nodeId} connected`)
})

server.on('client:disconnected', (event) => {
  console.log(`Client ${event.nodeId} disconnected: ${event.reason}`)
})

server.on('sync:completed', (event) => {
  console.log(`Synced ${event.operationCount} ops with ${event.nodeId}`)
})
```

Integrate these events with your logging and alerting infrastructure.

### Resource Limits

For large deployments, configure resource limits:

```typescript
const store = await createPostgresServerStore({
  connectionString: process.env.DATABASE_URL,
})

const server = createKoraServer({
  store,
  maxConnections: 10000,
  maxBatchSize: 1000,       // Max operations per sync batch
  heartbeatInterval: 30000, // Milliseconds between keepalive pings
})
```

## Deploying with Docker

A minimal Dockerfile for the sync server:

```dockerfile
FROM node:20-slim

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm && pnpm install --prod

COPY . .

ENV PORT=3000
ENV DATABASE_URL=postgresql://user:pass@db:5432/kora

EXPOSE 3000

CMD ["node", "--import", "tsx", "server.ts"]
```

```yaml
# docker-compose.yml
services:
  kora-server:
    build: .
    ports:
      - "3000:3000"
    environment:
      - DATABASE_URL=postgresql://kora:kora@postgres:5432/kora
    depends_on:
      - postgres

  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: kora
      POSTGRES_PASSWORD: kora
      POSTGRES_DB: kora
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
```

## Scaling

### Horizontal Scaling

The Kora server is stateless once configured with `createPostgresServerStore`. You can run multiple instances behind a load balancer. Use sticky sessions (based on client node ID) to minimize reconnection overhead, but the protocol works correctly without them since all state is in the database.

### Operation Compaction

Over time, the operation log grows. Compaction reduces storage by collapsing sequential operations on the same record into a single snapshot:

```typescript
// Run periodically (e.g., nightly cron job)
await server.compact({
  olderThan: Date.now() - 30 * 24 * 60 * 60 * 1000, // 30 days
})
```

Compaction preserves the current state and recent history while removing redundant intermediate operations. It is a safe operation that does not affect connected clients.
