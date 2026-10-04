---
title: Storage Configuration
description: "Configure Kora.js storage: SQLite WASM with OPFS, the IndexedDB fallback, native SQLite, database naming, and multi-tab behavior."
---

# Storage Configuration

Kora uses two separate storage systems: **client-side storage** for the browser (or Node.js) and **server-side storage** for the sync server. This guide covers how to configure both, run multiple apps, and switch between database backends.

<!-- docs-check-prelude
import { createApp, defineSchema, t } from 'korajs'
const schema = defineSchema({ version: 1, collections: { todos: { fields: { title: t.string() } } } })
const todoSchema = schema
const notesSchema = schema
declare function showBackupReminder(): void
declare const button: HTMLButtonElement
const app = createApp({ schema })
-->

## Client-Side Storage

### How It Works

When you call `createApp()`, Kora automatically detects and sets up a local database adapter for your app:

1. **Tauri native SQLite** (Tauri desktop apps via `@korajs/tauri`), auto-detected
2. **Native SQLite** (Node.js and Electron via `better-sqlite3`)
3. **SQLite WASM + OPFS** (browsers), in a dedicated Web Worker
4. **IndexedDB** (durable browser fallback: a hand-written adapter that runs SQLite WASM in memory and persists the database to IndexedDB)

You don't need to configure anything for the default case:

```typescript
const autoApp = createApp({ schema })
// Kora auto-detects the best storage adapter
```

In a browser, pass `store.workerUrl` (the scaffolded `src/kora-worker.ts`, imported with
`?worker&url`) so the SQLite worker is bundled correctly.

::: tip Durable fallback, never silent memory
If OPFS cannot be acquired at runtime, `createApp()` falls back to the durable IndexedDB adapter
before app code observes the store and emits `store:storage-fallback`. Kora never silently runs in
memory: when no durable storage can be obtained at all (at open, or when a tab is promoted to
storage leader), it emits the blocking `store:durability-lost` event (and `store:opfs-unavailable`)
and refuses writes with `StorageDurabilityError` (`STORAGE_DURABILITY_LOST`). Show a blocking state
(for example "close other tabs and reload"). Set `store: { allowNonDurable: true }` only to accept
in-memory storage knowingly.
:::

### Multi-tab Durability

Multi-tab durability uses one dedicated worker owned by a leader tab. Other tabs relay SQLite requests to that leader over browser cross-tab messaging, and a follower is promoted if the leader tab closes. A leader that hangs or is frozen (a background tab on mobile) is detected and replaced, so it no longer blocks other tabs; requests to it fail with `LeaderUnresponsiveError` instead of waiting forever, and closing a tab hands off cleanly.

**One owner per OPFS database.** Each database has its own OPFS storage pool, held under a Web Lock
by the worker that installed it for the pool's whole life. A second owner (a tab still shutting
down, or a tab running an older Kora that does not take part in the protocol) makes the open wait
and report it (`store:storage-blocked`, `state: 'waiting'`, then `'resolved'`) instead of falling
back. Databases created by earlier releases in the shared pool move into their own pools
automatically on first open (`store:storage-migrated`). Many per-user databases on one device no
longer exhaust a shared pool.

This is the only durable SQLite WASM multi-tab path. OPFS synchronous access handles are available only in dedicated Web Workers, not the main thread or SharedWorker. A SharedWorker-hosted database cannot be durable, so Kora does not offer it as a storage mode. The old `sharedWorkerUrl` option is deprecated and ignored; remove it from app config.

Kora also keeps open tabs reactive on this path. Local operations committed in one tab are announced over a database-scoped same-origin channel, and sibling tabs invalidate only the affected queries. The operation is not re-applied by receivers; the shared local database remains the source of truth. Worker RPC is serialized across complete transaction spans at the leader boundary, and abandoned follower spans are rolled back so closing a tab mid-transaction cannot freeze the database for other tabs. The crash-case idle reclaim defaults to 10s.

### Per-tab isolation

`store: { isolation: 'per-tab' }` gives each tab its own sync node id (the default `'shared'` uses
one node per database). The writes of a closed tab are uploaded by the next tab that runs (it
adopts the orphaned node), never lost.

### Journal Mode

Browser databases on OPFS use SQLite's default rollback journal (`journal_mode = delete`), not WAL. WAL needs shared-memory support from the file system layer, and the OPFS SyncAccessHandle pool (`opfs-sahpool`) that Kora uses does not provide it: SQLite keeps `delete` whatever is requested. Earlier releases issued `PRAGMA journal_mode = WAL` there, which silently had no effect. Each open database holds one OPFS pool slot at rest plus one transient slot for its `-journal` file during a write transaction. The IndexedDB fallback runs SQLite in memory (`journal_mode = memory`). Native SQLite (`better-sqlite3` on Node.js and Electron) runs in WAL mode.

The adapter reports the mode it actually got as `journalMode` in `getStorageOpenState()`.

### Durable Storage (`persist()`)

Browsers may evict an origin's storage under storage pressure unless the origin was granted persistent storage. Kora never puts that permission request on the startup path: in Firefox, `navigator.storage.persist()` shows a prompt and does not settle until the user answers, so awaiting it would hold `app.ready`.

- At startup Kora only checks `navigator.storage.persisted()`, which never prompts, in the background.
- With `store.persistence: 'auto'` (the default) Kora requests persistence in the background, never awaited, after a sign-in, after the first local write, or at startup when the page runs as an installed app.
- With `store.persistence: 'manual'` Kora only requests it when you call `app.storage.persistence.request()`, for example from a "Keep my data on this device" button.

```typescript
const { state, persisted } = app.storage.persistence.status()
// state: 'unknown' | 'persisted' | 'best-effort' | 'unsupported' | 'error'

app.on('storage:persistence', (event) => {
  if (!event.persisted) showBackupReminder()
})

button.onclick = () => app.storage.persistence.request()
```

Every check and request is also a `storage:persistence` event. `request()` never throws.

### Managing local databases

Kora never deletes a database on its own. `app.storage` lists and explicitly deletes this origin's
local databases (for example the per-user databases of `store.namespaceByAuthUser` on a shared
device):

```typescript
for (const db of await app.storage.listDatabases()) {
  console.log(db.dbName, db.backend, new Date(db.lastOpenedAt))
}

// Refuses with UnsyncedDataError (UNSYNCED_DATA) while the database holds writes the server
// never acknowledged, and with StorageInUseError (STORAGE_IN_USE) while any tab has it open.
const deleted = await app.storage.deleteDatabase('kora-db:user-123')
```

Pass `{ force: true }` to delete despite unsynced writes. `app.storeInfo()` reports the current
database's name, backend, whether it is durable and its isolation state, without exposing records.
A collection named `storage` must be reached through `app.collections.storage`.

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
const explicitApp = createApp({
  schema,
  store: {
    adapter: 'sqlite-wasm',   // Browser: SQLite WASM + OPFS
    // adapter: 'indexeddb',   // Browser: IndexedDB fallback
    // adapter: 'better-sqlite3', // Node.js: better-sqlite3
    // adapter: 'tauri-sqlite',   // Tauri desktop: native SQLite (auto-detected)
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
| `adapter` | `'sqlite-wasm' \| 'indexeddb' \| 'better-sqlite3' \| 'tauri-sqlite'` | Auto-detected | Storage backend to use. |
| `name` | `string` | `'kora-db'` | Database name. Must be unique per app on the same origin. |
| `workerUrl` | `string \| URL` | | URL of the SQLite WASM worker script. Required for the browser adapters. |
| `namespaceByAuthUser` | `boolean` | `false` | One physical database per signed-in user (with `sync.authClient`), for shared browser profiles. |
| `isolation` | `'shared' \| 'per-tab'` | `'shared'` | One sync node per database, or one per tab. |
| `allowNonDurable` | `boolean` | `false` | Accept in-memory storage when nothing durable is available, instead of refusing writes. |
| `maxOperationBytes` | `number` | 256 KiB | Largest operation a write may produce; set it to the server's value. |
| `persistence` | `'auto' \| 'manual'` | `'auto'` | When Kora asks the browser for persistent storage. See [Durable Storage](#durable-storage-persist). Never delays `app.ready`. |
| `workerResponseTimeoutMs` | `number` | `30000` | Longest wait for a worker reply (for example `open`). |
| `sharedWorkerUrl` | `string \| URL` | | Deprecated and ignored. SharedWorker-hosted SQLite cannot use OPFS SyncAccessHandle and is never durable. |

---

## Server-Side Storage

The sync server has its own storage for the operation log and version vectors. Kora provides three server store options.

### SQLite (Recommended for Getting Started)

Persists data to a local file. Survives server restarts. Good for single-server deployments and development.

<!-- docs-check-prelude -->

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
| `instanceId` | `string` | Persisted (`1`) | Instance id within the deployment. Leave unset: one SQLite database has one server process. |
| `nodeId` | `string` | | Deprecated. Leave unset. A value set before beta.13 is kept as a legacy server id (its earlier decisions keep their authority). |
| `authoritativeNodeIds` | `string[]` | -- | Extra node ids whose writes win `merge('server-authoritative')` fields (for example a back-office service). An id listed once stays authoritative, on the server and on every device, until it is revoked: removing it from this list does not revoke it. |
| `revokedAuthoritativeNodeIds` | `string[]` | -- | Explicit authoritative ids to revoke. They stop winning on the server, every handshake tells devices to drop them (devices re-fold the affected records), and they are never accepted as device node ids. Permanent: a revoked id cannot be configured as authoritative again. |

The server authors its writes (route mutations, cascades, constraint corrections) under the node id `kora:server:<deploymentId>:<instanceId>`. Both parts are stored in the database (`kora_server_meta`) on first start, so the id survives restarts, and devices keep treating earlier server decisions as the server's.

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
| `instanceId` | `string` | New per start | Stable id of this instance within the deployment (`[A-Za-z0-9._-]`, at most 64 characters). It must be different on every running instance. Unset, each start draws a fresh one from a counter in the database. |
| `nodeId` | `string` | | Deprecated. Leave unset. A value set before beta.13 is kept as a legacy server id. |
| `authoritativeNodeIds` | `string[]` | -- | Extra node ids whose writes win `merge('server-authoritative')` fields (for example a back-office service). An id listed once stays authoritative, on the server and on every device, until it is revoked: removing it from this list does not revoke it. |
| `revokedAuthoritativeNodeIds` | `string[]` | -- | Explicit authoritative ids to revoke. They stop winning on the server, every handshake tells devices to drop them (devices re-fold the affected records), and they are never accepted as device node ids. Permanent: a revoked id cannot be configured as authoritative again. |

Every instance that shares the database belongs to one deployment (its id and a derivation secret live in `kora_server_meta`). Each instance authors under its own `kora:server:<deploymentId>:<instanceId>` node id, so instances never collide on sequence numbers, and every `kora:server:` id is authoritative on every replica. Strings are stored losslessly: U+0000 and unpaired UTF-16 surrogates, which Postgres `TEXT` and `JSONB` cannot hold, are escaped in materialized rows.

The required tables are created automatically on first connection. Use a UTF8 database (the
default); the first start of 1.0.0-beta.13 also converts sequence columns to `BIGINT`, an exclusive
table rewrite done once (schedule it). See
[Production Server](/guide/production-server#postgres) for the full list.

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

<!-- docs-check-prelude
import { createApp, defineSchema, t } from 'korajs'
const todoSchema = defineSchema({ version: 1, collections: { todos: { fields: { title: t.string() } } } })
const notesSchema = todoSchema
-->

```typescript
// In todo-app/src/main.tsx
const app = createApp({
  schema: todoSchema,
  store: { name: 'todo-app', workerUrl: new URL('./kora-worker.ts', import.meta.url) },
})

// In notes-app/src/main.tsx
const notesApp = createApp({
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

**SQLite**: use different filenames:

```typescript
import { createKoraServer, createPostgresServerStore, createSqliteServerStore } from '@korajs/server'

// Todo app server
const todoStore = createSqliteServerStore({ filename: './data/todos.db' })
const todoServer = createKoraServer({ store: todoStore, port: 3001 })

// Notes app server
const notesStore = createSqliteServerStore({ filename: './data/notes.db' })
const notesServer = createKoraServer({ store: notesStore, port: 3002 })
```

**PostgreSQL**: use different databases or schemas:

```typescript
import { createPostgresServerStore } from '@korajs/server'

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
The server stores are interchangeable: they implement the same `ServerStore` interface. You can switch between them without any client-side changes. Clients don't know or care what database the server uses.
:::

::: warning
Switching storage backends does not migrate data. If you have existing data in SQLite, it won't automatically appear in PostgreSQL. For new projects, choose your production backend early. For existing projects, export a backup from the old store (`await oldStore.exportBackup()`, or `kora backup create`) and import it into the new one (`importBackup(data, false)`, or `kora backup restore`): operations and encryption key records move, and the new store re-folds every record.
:::

## Related guides

- [Multi-runtime Storage](/guide/multi-runtime-storage) covers running more than one runtime on a single origin safely: store names, multi-tab coordination, the OPFS single-writer model, and the diagnostics that make a silent in-memory fallback observable.
