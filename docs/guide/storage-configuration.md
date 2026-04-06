# Storage Configuration

Kora uses two separate storage systems: **client-side storage** for the browser (or Node.js) and **server-side storage** for the sync server. This guide covers how to configure both, run multiple apps, and switch between database backends.

## Client-Side Storage

### How It Works

When you call `createApp()`, Kora automatically sets up a local database for your app. By default, it uses:

1. **SQLite WASM + OPFS** (browsers with OPFS support) -- best performance
2. **IndexedDB** (fallback when OPFS is unavailable)
3. **Native SQLite** (Node.js and Electron via `better-sqlite3`)

You don't need to configure anything for the default case:

```typescript
const app = createApp({ schema })
// Kora auto-detects the best storage adapter
```

### Database Name

Each app has a database name that defaults to `'kora-db'`. If you're running multiple Kora apps on the same domain, you **must** set a unique name for each app to avoid data collisions:

```typescript
// App A
const appA = createApp({
  schema: todoSchema,
  store: {
    name: 'todo-app',
    workerUrl: new URL('./kora-worker.ts', import.meta.url),
  },
})

// App B (different app, same domain)
const appB = createApp({
  schema: notesSchema,
  store: {
    name: 'notes-app',
    workerUrl: new URL('./kora-worker.ts', import.meta.url),
  },
})
```

### Choosing an Adapter

You can explicitly select a storage adapter:

```typescript
const app = createApp({
  schema,
  store: {
    adapter: 'sqlite-wasm',   // Browser: SQLite WASM + OPFS
    // adapter: 'indexeddb',   // Browser: IndexedDB fallback
    // adapter: 'sqlite-native', // Node.js: better-sqlite3
    name: 'my-app',
    workerUrl: new URL('./kora-worker.ts', import.meta.url),
  },
})
```

::: tip
In most cases, let Kora auto-detect the adapter. Only override when you have a specific requirement (e.g., forcing IndexedDB in testing).
:::

### Store Configuration Reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `adapter` | `'sqlite-wasm' \| 'indexeddb' \| 'sqlite-native'` | Auto-detected | Storage backend to use. |
| `name` | `string` | `'kora-db'` | Database name. Must be unique per app on the same origin. |
| `workerUrl` | `string \| URL` | -- | URL to the SQLite WASM worker script. Required for `sqlite-wasm` adapter in browsers. |

---

## Server-Side Storage

The sync server has its own storage for the operation log and version vectors. Kora provides three server store options.

### SQLite (Recommended for Getting Started)

Persists data to a local file. Survives server restarts. Good for single-server deployments and development.

```typescript
import { createKoraServer, createSqliteServerStore } from '@korajs/server'

const store = createSqliteServerStore({
  filename: './kora-server.db',
})

const server = createKoraServer({ store, port: 3001 })
await server.start()
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `filename` | `string` | `':memory:'` | Path to the SQLite database file. Use `':memory:'` for in-memory (testing only). |
| `nodeId` | `string` | Auto-generated | Server node ID. Usually left to auto-generate. |

### PostgreSQL (Recommended for Production)

Stores operations in PostgreSQL. Best for production deployments, especially when running multiple server instances.

First, install the `postgres` package:

```bash
npm install postgres
```

Then configure the store:

```typescript
import { createKoraServer, createPostgresServerStore } from '@korajs/server'

const store = await createPostgresServerStore({
  connectionString: 'postgresql://user:password@localhost:5432/mydb',
})

const server = createKoraServer({ store, port: 3001 })
await server.start()
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `connectionString` | `string` | -- | PostgreSQL connection URL. Required. |
| `nodeId` | `string` | Auto-generated | Server node ID. |

The required tables are created automatically on first connection.

### In-Memory (Testing Only)

Stores operations in memory. All data is lost when the server restarts. Use only for development and testing.

```typescript
import { createKoraServer, MemoryServerStore } from '@korajs/server'

const store = new MemoryServerStore()
const server = createKoraServer({ store, port: 3001 })
```

### Choosing a Server Store

| Store | Persistence | Scalability | Use Case |
|-------|-------------|-------------|----------|
| `createSqliteServerStore` | File on disk | Single server | Development, prototyping, small deployments |
| `createPostgresServerStore` | PostgreSQL | Multi-instance | Production |
| `MemoryServerStore` | None | Single server | Automated tests |

---

## Running Multiple Apps

### Client-Side Isolation

If you run two Kora apps on the same domain (e.g., `localhost` during development), each app needs a unique `store.name`:

```typescript
// In todo-app/src/main.tsx
const app = createApp({
  schema: todoSchema,
  store: { name: 'todo-app', workerUrl: new URL('./kora-worker.ts', import.meta.url) },
})

// In notes-app/src/main.tsx
const app = createApp({
  schema: notesSchema,
  store: { name: 'notes-app', workerUrl: new URL('./kora-worker.ts', import.meta.url) },
})
```

Without unique names, both apps would read and write to the same local database, causing data corruption.

::: warning
Apps deployed to different domains (e.g., `todo.example.com` vs `notes.example.com`) are already isolated by the browser's same-origin policy. You only need unique names when multiple apps share the same origin.
:::

### Server-Side Isolation

Each app should have its own sync server with its own database:

**SQLite** -- use different filenames:

```typescript
// Todo app server
const todoStore = createSqliteServerStore({ filename: './data/todos.db' })
const todoServer = createKoraServer({ store: todoStore, port: 3001 })

// Notes app server
const notesStore = createSqliteServerStore({ filename: './data/notes.db' })
const notesServer = createKoraServer({ store: notesStore, port: 3002 })
```

**PostgreSQL** -- use different databases or schemas:

```typescript
// Todo app
const todoStore = await createPostgresServerStore({
  connectionString: 'postgresql://user:pass@localhost:5432/todos',
})

// Notes app
const notesStore = await createPostgresServerStore({
  connectionString: 'postgresql://user:pass@localhost:5432/notes',
})
```

---

## Switching from SQLite to PostgreSQL

The scaffolded `server.ts` ships with SQLite by default. To switch to PostgreSQL:

1. Install the `postgres` package:

```bash
npm install postgres
```

2. Update `server.ts`:

```typescript
import { createKoraServer, createPostgresServerStore } from '@korajs/server'

// Replace SQLite:
// const store = createSqliteServerStore({ filename: './kora-server.db' })

// With PostgreSQL:
const store = await createPostgresServerStore({
  connectionString: process.env.DATABASE_URL || 'postgresql://user:password@localhost:5432/mydb',
})

const server = createKoraServer({ store, port: 3001 })
await server.start()
```

::: tip
The server stores are interchangeable -- they implement the same `ServerStore` interface. You can switch between them without any client-side changes. Clients don't know or care what database the server uses.
:::

::: warning
Switching storage backends does not migrate data. If you have existing data in SQLite, it won't automatically appear in PostgreSQL. For new projects, choose your production backend early. For existing projects, you would need to export operations from the old store and import them into the new one.
:::
