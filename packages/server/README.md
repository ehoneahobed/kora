# @korajs/server

The self-hosted sync server for Kora.js: stores every operation, folds records exactly as devices
do, enforces scopes, constraints and your validators, and relays changes between devices over
WebSocket or HTTP long-polling. SQLite and Postgres stores are built in.

## Install

```bash
pnpm add @korajs/server@beta
```

## Quick start

<!-- docs-check: standalone -->
```typescript
import { createProductionServer, createSqliteServerStore } from '@korajs/server'
import { defineSchema, t } from 'korajs'

const schema = defineSchema({ version: 1, collections: { todos: { fields: { title: t.string() } } } })

const store = createSqliteServerStore({ filename: './kora-server.db' })
await store.setSchema(schema)

const server = createProductionServer({
  store,
  staticDir: './dist', // the built app, served with an offline app shell
  syncPath: '/kora-sync',
  syncOptions: { schemaVersion: schema.version },
  operationalAuth: { adminToken: process.env.KORA_ADMIN_TOKEN },
})

console.log(`Listening on ${await server.start()}`) // PORT, default 3001
```

For production use Postgres (`await createPostgresServerStore({ connectionString })`), an auth
provider (`createKoraAuthServer().auth` from `@korajs/auth/server`, or your own
`TokenAuthProvider`), and the operational tokens.

<!-- docs-check: standalone -->
```typescript
import { createPostgresServerStore, createProductionServer, TokenAuthProvider } from '@korajs/server'

declare function verifyToken(token: string): Promise<{ id: string } | null>

const server = createProductionServer({
  store: await createPostgresServerStore({ connectionString: process.env.DATABASE_URL ?? '' }),
  syncOptions: {
    auth: new TokenAuthProvider({
      validate: async (token) => {
        const user = await verifyToken(token)
        // The grant decides what this session may read and write.
        return user ? { userId: user.id, scopes: { todos: { userId: user.id } } } : null
      },
    }),
  },
})
```

## Stores

| Store | Use |
|-------|-----|
| `createSqliteServerStore({ filename })` | One server process |
| `await createPostgresServerStore({ connectionString })` | Production, several instances |
| `new MemoryServerStore()` | Tests |

`store.setSchema(schema)` creates one table per collection and enables scope, constraint and
relation checks; `queryCollection`, `findRecord` and `countCollection` read them. Server-side
writes go through `server.kora.apply(...)`, the same pipeline as sync.

## Testing

The store parity suite runs against Memory and SQLite, and against Postgres when `DATABASE_URL` is
set:

```bash
DATABASE_URL="postgres://user:pass@localhost:5432/kora_test" pnpm --filter @korajs/server test -- tests/integration/server-store-parity.test.ts
```

## Documentation

[Production Server](https://korajs.dev/guide/production-server),
[Server-side Validation](https://korajs.dev/guide/server-side-validation) and the
[Server API reference](https://korajs.dev/api/server).

## License

MIT
