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
import { createKoraServer, PostgresServerStore, TokenAuthProvider } from '@korajs/server'

const server = createKoraServer({
  store: new PostgresServerStore({
    connectionString: process.env.DATABASE_URL,
  }),
  port: 4567,
  auth: new TokenAuthProvider({
    validate: async (token) => {
      // Validate JWT or session token
      const user = await verifyToken(token)
      return { userId: user.id, scopes: { todos: { userId: user.id } } }
    },
  }),
})

await server.start()
```

## Storage Backends

| Backend | Package | Use Case |
|---------|---------|----------|
| `MemoryServerStore` | Built-in | Development and testing |
| `SqliteServerStore` | Built-in | Small deployments, prototyping |
| `PostgresServerStore` | Built-in | Production |

## Mixed Auth (Authenticated + Anonymous)

For apps where some users are authenticated and others are anonymous:

```typescript
import { MixedAuthProvider } from '@korajs/server'

const server = createKoraServer({
  store: serverStore,
  auth: new MixedAuthProvider({
    primary: authRoutes.toSyncAuthProvider(),
    anonymousScopes: { responses: {} },
  }),
})
```

## Materialized Collections

Enable server-side queries on your data:

```typescript
await store.setSchema(schema)

// Query with filters
const forms = await store.queryCollection('forms', {
  where: { status: 'published' },
  limit: 10,
})

// Count records
const count = await store.countCollection('responses', { formId: 'abc' })
```

## Configuration

```typescript
createKoraServer({
  store: serverStore,         // Required: storage backend
  port: 4567,                 // Default: 4567
  auth: authProvider,         // Optional: authentication provider
  batchSize: 1000,            // Optional: max operations per sync batch
  maxConnections: 0,          // Optional: 0 = unlimited
})
```

## Testing

Integration tests include **store parity** coverage for `MemoryServerStore` and `SqliteServerStore`. To run the same parity suite against a live PostgreSQL database:

```bash
DATABASE_URL="postgres://user:pass@localhost:5432/kora_test" pnpm --filter @korajs/server test -- tests/integration/server-store-parity.test.ts
```

Postgres tests are skipped when `DATABASE_URL` is unset.

## License

MIT

See the [full documentation](https://github.com/ehoneahobed/kora) for guides, API reference, and examples.
