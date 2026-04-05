# Deployment

Kora's sync server is a lightweight Node.js process that relays operations between clients. This guide covers self-hosting the server, configuring storage backends, and setting up authentication.

## Self-Hosting the Sync Server

### Quick Start

Install the server package:

```bash
pnpm add @kora/server
```

Create a server file (`server.ts`):

```typescript
import { createServer } from '@kora/server'
import schema from './schema'

const server = createServer({
  schema,
  port: 3000,
})

server.start()
```

Run it:

```bash
npx tsx server.ts
```

Your sync server is now running at `ws://localhost:3000`. Point your client at it:

```typescript
const app = createApp({
  schema,
  sync: {
    url: 'ws://localhost:3000',
  },
})
```

### Server Configuration

```typescript
import { createServer, PostgresStore, TokenAuthProvider } from '@kora/server'
import schema from './schema'

const server = createServer({
  // Required: same schema as the client
  schema,

  // Port to listen on (default: 3000)
  port: 3000,

  // Host to bind to (default: '0.0.0.0')
  host: '0.0.0.0',

  // Server-side storage backend
  store: new PostgresStore({
    connectionString: process.env.DATABASE_URL,
  }),

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

  // Sync scopes (server-side filtering)
  scopes: {
    todos: (ctx) => ({ where: { userId: ctx.userId } }),
  },

  // Logging level
  logLevel: 'info',  // 'debug' | 'info' | 'warn' | 'error'
})

server.start()
```

## Storage Backends

The server needs a storage backend to persist the operation log and relay operations to clients. Kora provides three built-in options.

### MemoryStore

Stores operations in memory. All data is lost when the server restarts. Use only for development and testing.

```typescript
import { MemoryStore } from '@kora/server'

const server = createServer({
  schema,
  store: new MemoryStore(),
})
```

This is the default if no `store` is specified.

### SQLiteStore

Stores operations in a local SQLite database file. Good for single-server deployments and prototyping.

```typescript
import { SQLiteStore } from '@kora/server'

const server = createServer({
  schema,
  store: new SQLiteStore({
    path: './data/kora.db',
  }),
})
```

### PostgresStore

Stores operations in PostgreSQL. Recommended for production deployments.

```typescript
import { PostgresStore } from '@kora/server'

const server = createServer({
  schema,
  store: new PostgresStore({
    connectionString: 'postgresql://user:pass@localhost:5432/kora',
  }),
})
```

The `PostgresStore` uses Drizzle ORM under the hood. It creates the necessary tables automatically on first run.

### Choosing a Store

| Store | Persistence | Performance | Use Case |
|-------|-------------|-------------|----------|
| `MemoryStore` | None | Fastest | Development, tests |
| `SQLiteStore` | File | Fast | Single-server, prototyping |
| `PostgresStore` | Database | Production-grade | Production, multi-instance |

## Authentication

### TokenAuthProvider

`TokenAuthProvider` validates tokens sent by clients during the sync handshake. The `verify` function receives the raw token string and returns a user context object.

```typescript
import { TokenAuthProvider } from '@kora/server'

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

### Use PostgresStore

For production, use `PostgresStore` for durable, scalable storage. Back up the database regularly.

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
const server = createServer({
  schema,
  store: new PostgresStore({ connectionString: process.env.DATABASE_URL }),
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

The Kora server is stateless once configured with `PostgresStore`. You can run multiple instances behind a load balancer. Use sticky sessions (based on client node ID) to minimize reconnection overhead, but the protocol works correctly without them since all state is in the database.

### Operation Compaction

Over time, the operation log grows. Compaction reduces storage by collapsing sequential operations on the same record into a single snapshot:

```typescript
// Run periodically (e.g., nightly cron job)
await server.compact({
  olderThan: Date.now() - 30 * 24 * 60 * 60 * 1000, // 30 days
})
```

Compaction preserves the current state and recent history while removing redundant intermediate operations. It is a safe operation that does not affect connected clients.
