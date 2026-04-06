# Deployment

Kora sync server is a small Node.js process that stores operations and relays them between clients.

## Quick Start

Install:

```bash
pnpm add @korajs/server
```

Create `server.ts`:

```typescript
import { createKoraServer, createSqliteServerStore } from '@korajs/server'

const store = createSqliteServerStore({ filename: './kora-server.db' })

const server = createKoraServer({
  store,
  port: 3001,
})

await server.start()
```

Run:

```bash
npx tsx server.ts
```

## Client Connection

```typescript
const app = createApp({
  schema,
  sync: { url: 'ws://localhost:3001' },
})

await app.ready
await app.sync?.connect()
```

## Storage Backends

### Memory (development only)

```typescript
import { createKoraServer, MemoryServerStore } from '@korajs/server'

const server = createKoraServer({
  store: new MemoryServerStore(),
  port: 3001,
})
```

### SQLite

```typescript
import { createKoraServer, createSqliteServerStore } from '@korajs/server'

const store = createSqliteServerStore({ filename: './data/kora.db' })
const server = createKoraServer({ store, port: 3001 })
```

### PostgreSQL

Install dependency:

```bash
npm install postgres
```

Use store:

```typescript
import { createKoraServer, createPostgresServerStore } from '@korajs/server'

const store = await createPostgresServerStore({
  connectionString: process.env.DATABASE_URL!,
})

const server = createKoraServer({ store, port: 3001 })
```

## Authentication

Use `TokenAuthProvider` for production:

```typescript
import { createKoraServer, createPostgresServerStore, TokenAuthProvider } from '@korajs/server'

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

const server = createKoraServer({
  store,
  port: 3001,
  auth,
})
```

## Server Config (Current)

Supported `createKoraServer` fields:

- `store` (required)
- `port`
- `host`
- `path`
- `auth`
- `batchSize`
- `maxConnections`
- `schemaVersion`

## Production Checklist

- Use `wss://` behind TLS termination.
- Use `TokenAuthProvider` (do not run open auth in production).
- Use PostgreSQL for production persistence.
- Set sensible limits (`maxConnections`, `batchSize`).

## Docker (Minimal)

```dockerfile
FROM node:20-slim
WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm && pnpm install --prod

COPY . .
ENV PORT=3001

CMD ["node", "--import", "tsx", "server.ts"]
```
