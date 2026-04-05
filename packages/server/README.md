# @korajs/server

Self-hosted sync server for Kora.js applications. Accepts WebSocket and HTTP connections from Kora clients, stores operations, and relays changes between devices. Supports multiple storage backends via Drizzle ORM.

## Install

```bash
pnpm add @korajs/server
```

## Quick Start

```typescript
import { createKoraServer, MemoryServerStore } from '@korajs/server'

const server = createKoraServer({
  store: new MemoryServerStore(),
  port: 4567,
})

await server.start()
// Kora sync server listening on ws://localhost:4567
```

## Production Setup with PostgreSQL

```typescript
import { createKoraServer, PostgresServerStore } from '@korajs/server'

const server = createKoraServer({
  store: new PostgresServerStore({
    connectionString: process.env.DATABASE_URL,
  }),
  port: 4567,
  auth: async (token) => {
    // Validate JWT or session token
    const user = await verifyToken(token)
    return { userId: user.id }
  },
  scopes: {
    todos: (ctx) => ({ where: { userId: ctx.userId } }),
  },
})

await server.start()
```

## Storage Backends

| Backend | Package | Use Case |
|---------|---------|----------|
| `MemoryServerStore` | Built-in | Development and testing |
| `SqliteServerStore` | Built-in | Small deployments, prototyping |
| `PostgresServerStore` | Built-in | Production |

## Configuration

```typescript
createKoraServer({
  store: serverStore,         // Required: storage backend
  port: 4567,                 // Default: 4567
  auth: async (token) => {},  // Optional: authentication handler
  scopes: {},                 // Optional: per-collection data scoping
  maxBatchSize: 1000,         // Optional: max operations per sync batch
})
```

## License

MIT

See the [full documentation](https://github.com/ehoneahobed/kora) for guides, API reference, and examples.
