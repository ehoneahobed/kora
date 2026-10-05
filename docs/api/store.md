---
title: Store API
description: "@korajs/store API reference: collections, the query builder, reactive subscriptions, transactions, sequences, storage adapters, blobs and store errors."
---

# Store API Reference

`@korajs/store` is the local data layer: persistence (SQLite WASM on OPFS, IndexedDB, native
SQLite), the record fold, reactive queries and the operation log. `createApp()` creates and opens
the store; you use it through the app.

<!-- docs-check-prelude
import { createApp, defineSchema, t } from 'korajs'
const schema = defineSchema({
  version: 1,
  collections: {
    todos: {
      fields: {
        title: t.string(),
        completed: t.boolean().default(false),
        assignee: t.string().optional(),
        projectId: t.string().optional(),
        createdAt: t.timestamp().auto(),
      },
    },
    projects: { fields: { name: t.string() } },
    orders: { fields: { total: t.number() } },
    lineItems: { fields: { orderId: t.string(), product: t.string(), qty: t.number() } },
  },
  relations: {
    todoBelongsToProject: { from: 'todos', to: 'projects', type: 'many-to-one', field: 'projectId', onDelete: 'set-null' },
  },
})
const app = createApp({ schema })
declare const id: string
-->

```typescript
await app.ready
const todo = await app.todos.insert({ title: 'Hello' })
```

---

## Collections

Every schema collection is available as `app.<name>` and always as `app.collections.<name>`. With a
schema from `defineSchema()` every method is typed (see [Type inference](/api/core#type-inference)).
Every method rejects with `AppNotReadyError` (`APP_NOT_READY`) before `app.ready` resolves; inside
`<KoraProvider app={app}>` the app is ready before children render.

| Method | Returns | Description |
|--------|---------|-------------|
| `insert(data)` | `Promise<Record>` | Validates, applies defaults and `t.timestamp().auto()`, generates a UUID v7 `id`, writes the record and its operation in one transaction. |
| `update(id, data)` | `Promise<Record>` | Writes only the fields that change (an unchanged value is not a write). Accepts [atomic ops](/api/core#atomic-ops). Throws `RecordNotFoundError` for a missing or deleted record. |
| `delete(id)` | `Promise<void>` | Deletes the record (relations apply their `onDelete`). Throws `RecordNotFoundError` when it does not exist. |
| `findById(id)` | `Promise<Record \| null>` | The record, or `null`. |
| `where(filter)` | `QueryBuilder` | Starts a query (see below). |

Records also carry `createdAt` and `updatedAt` (milliseconds): the insert time and the last write
time, readable and queryable even when the schema does not declare them (a schema field of the same
name wins). The names are exported as `VIRTUAL_TIMESTAMP_FIELDS`.

Writes are refused before anything is stored when a value is outside its field's domain
(`SchemaValidationError`), the serialized operation exceeds `maxOperationBytes` (256 KiB by
default, `OperationTooLargeError`), a state machine forbids the transition
(`InvalidStateTransitionError`), or the database cannot be made durable
(`StorageDurabilityError`).

### Reserved collection names {#reserved-names}

These names belong to the app object: `ready`, `events`, `on`, `collections`, `sync`,
`encryption`, `sequences`, `blobs`, `storage`, `getStore`, `getSyncEngine`, `getQueryStoreCache`,
`storeInfo`, `close`, `transaction`, `mutation`, `exportBackup`, `importBackup`, `replayTo`,
`exportAudit` (exported as `RESERVED_APP_PROPERTIES`). A collection with one of these names works,
but only as `app.collections.<name>` (and `tx.<name>` in transactions). `createApp()` warns in
development, and with a typed schema `app.<name>.insert(...)` is a type error.

---

## Query builder

Queries are immutable builders: every method returns a new builder, and the methods can be chained
in any order before `exec()`, `count()` or `subscribe()`.

| Method | Description |
|--------|-------------|
| `where(filter)` | Field equality, or operators `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`. Conditions are AND-ed; calling `where` again adds conditions (a repeated field replaces the earlier condition). A value of `undefined` adds no condition (`where({ projectId: selected })` with nothing selected lists everything, and does not replace an earlier condition); `null` matches missing values (`IS NULL`; `$ne: null` is `IS NOT NULL`, and `$ne: v` also excludes rows where the field is null). `NaN`/`Infinity` and `undefined` inside `$in` throw `QueryError`. |
| `orderBy(field, direction = 'asc')` | Any schema field, `id`, `createdAt` or `updatedAt`. Any direction other than `'asc'`/`'desc'` throws `QueryError`. |
| `limit(n)` / `offset(n)` | Non-negative safe integers (otherwise `QueryError`), bound as SQL parameters. |
| `include(...targets)` | Adds related records (see below). |
| `exec()` | `Promise<Record[]>`. |
| `count()` | `Promise<number>`. |
| `subscribe(callback, { onError? })` | Live results; returns an unsubscribe function. |

```typescript
const page = await app.todos
  .where({ completed: false, assignee: { $in: ['alice', 'bob'] } })
  .orderBy('createdAt', 'desc')
  .limit(10)
  .offset(10)
  .exec()

// Two equal queries share one live result set: React, Vue and Svelte bindings and the
// store's query cache all identify a query by the same canonical key (`queryKey`).
const startOfDay = new Date().setHours(0, 0, 0, 0)
const changedToday = await app.todos.where({ updatedAt: { $gte: startOfDay } }).count()
```

### include()

A target names a relation's other collection, in plural or singular form:

- For a relation **from** this collection (many-to-one, one-to-one), each row gets the singular
  property holding the parent or `null`: `todos.include('project')` (or `'projects'`) adds
  `project`.
- For a relation **to** this collection (one-to-many), each row gets the plural property holding
  the children: `projects.include('todos')` adds `todos`.

An unknown target throws `QueryError`. Related records are fetched in one batch per target.
The included property exists on the result rows only: `where` and `orderBy` after `include()`
still take the collection's own fields (the typed API refuses the relation property at
compile time).

```typescript
const withProject = await app.todos.where({ completed: false }).include('project').exec()
withProject[0]?.project?.name
```

### subscribe()

The callback runs immediately with the current results and again whenever the results change,
after local writes or applied sync operations. Re-evaluation is batched in a microtask, and results
are compared value by value (arrays, objects and rich text included), so a write that leaves the
results equal does not call it.

If a query fails, the subscription stays registered and keeps its last results; the failure goes
to `onError` (`{ error, phase: 'initial' | 'refresh' | 'callback', collection, queryId }`) and the
`query:error` event (and is logged when there is no `onError`). The next successful run is always
delivered. Always call the returned function when you stop listening; the framework hooks do this
for you.

```typescript
const unsubscribe = app.todos
  .where({ completed: false })
  .orderBy('createdAt')
  .subscribe(
    (todos) => console.log(todos.length),
    { onError: (failure) => console.error(failure.error) },
  )
unsubscribe()
```

---

## Transactions

`app.transaction(fn)` writes several records atomically: every write is validated when called
(errors surface at the call site, and `insert` returns its id at once), then all of them commit in
one storage transaction with one `transactionId` and a contiguous block of sequence numbers. If
`fn` throws, nothing is written. Subscribers are notified once, after the commit.

```typescript
const operations = await app.transaction(async (tx) => {
  const order = await tx.orders.insert({ total: 99.99 })
  await tx.lineItems.insert({ orderId: order.id, product: 'Widget', qty: 2 })
})

await app.mutation('create-order', async (tx) => {
  await tx.orders.insert({ total: 150 })
})
```

`tx.<collection>` has `insert`, `update`, `delete` and `findById` (which sees the transaction's own
uncommitted writes); there are no queries inside a transaction. `app.mutation(name, fn)` is a
transaction whose operations carry `mutationName` for DevTools. Both resolve to the created
operations.

---

## Sequences

`app.sequences` produces formatted counters (receipt and invoice numbers) offline. Each device keeps
its own counter per `(name, scope)`, so two devices can produce the same counter value: include
`{node4}` or `{node8}` in the format when values must be unique across devices.

| Method | Description |
|--------|-------------|
| `next(name, { format?, scope?, startAt? })` | `Promise<string>`: increments atomically and formats. Default format: the name, a hyphen and `{seq:4}` (`order-0001`); `startAt` defaults to 1. |
| `current(name, { scope? })` | `Promise<number>`: the counter without incrementing (0 when unused). |
| `reset(name, { scope?, to? })` | Sets the counter to `to` (default 0); the next value is `to + 1`. |

| Token | Output |
|-------|--------|
| `{seq}` | counter zero-padded to 4 digits (`0042`) |
| `{seq:N}` | counter zero-padded to N digits |
| `{date}` | `YYYYMMDD` (UTC) |
| `{node4}` / `{node8}` | first 4 / 8 characters of this device's node id |

```typescript
await app.sequences.next('order') // 'order-0001' (unique on this device only)
await app.sequences.next('receipt', { scope: 'store-1', format: 'R-{date}-{node4}-{seq}' })
// 'R-20261003-a1b2-0001' (unique across devices)
```

---

## State machine validation

Local writes enforce state machines (see [State Machines](/guide/state-machines)). The helpers are
exported for custom write paths:

<!-- docs-check: signature @korajs/store @korajs/core -->
```typescript
function validateStateTransition(
  collectionName: string,
  recordId: string,
  stateMachine: StateMachineDefinition,
  currentState: string | null,   // null for an insert (always valid)
  newState: string,
): { valid: boolean; allowedStates: string[] }
// Invalid with onInvalidTransition 'reject': throws InvalidStateTransitionError.
// Invalid with 'last-valid-state': returns { valid: false }.

function validateUpdateStateMachine(
  collectionName: string,
  recordId: string,
  collectionDef: CollectionDefinition,
  currentRecord: Record<string, unknown>,
  updateData: Record<string, unknown>,
): Record<string, unknown>
// Returns updateData, without the state field when the transition is invalid
// and the mode is 'last-valid-state'.
```

`InvalidStateTransitionError` (`INVALID_STATE_TRANSITION`) has `collection`, `recordId`, `field`,
`fromState`, `toState` and `allowedStates`.

---

## App storage helpers

| Member | Description |
|--------|-------------|
| `app.storeInfo()` | `{ baseName, databaseName, authUserId, persistence, durable, isolationState }`, without reading records. |
| `app.storage.listDatabases()` / `app.storage.deleteDatabase(name, { force? })` | Manage this origin's local databases. See [Storage Configuration](/guide/storage-configuration#managing-local-databases). |
| `app.exportBackup()` / `app.importBackup()` | See [Backup and Restore](/guide/backup-restore). |

---

## Storage adapters

`createApp()` picks and opens the adapter; see
[Storage Configuration](/guide/storage-configuration) for selection, durability, multi-tab
behaviour and the `store` options. The adapters ship as separate entry points so a browser bundle
never includes Node code:

| Adapter id | Import | Class | Environment |
|------------|--------|-------|-------------|
| `'sqlite-wasm'` | `@korajs/store/sqlite-wasm` | `SqliteWasmAdapter` | Browser with OPFS (SQLite in a worker, `opfs-sahpool` VFS) |
| `'indexeddb'` | `@korajs/store/indexeddb` | `IndexedDbAdapter` | Browser without usable OPFS |
| `'better-sqlite3'` | `@korajs/store/better-sqlite3` | `BetterSqlite3Adapter` | Node.js, Electron |
| `'tauri-sqlite'` | `@korajs/tauri` | | Tauri apps |

Without `store.adapter`, Kora uses `tauri-sqlite` in Tauri, `better-sqlite3` in Node.js,
`sqlite-wasm` in browsers with OPFS and `indexeddb` otherwise. A browser that cannot acquire OPFS
at open falls back to IndexedDB (`store:storage-fallback`). When nothing durable can open, Kora
emits `store:durability-lost` and refuses writes with `StorageDurabilityError`; it never runs in
memory silently (`store: { allowNonDurable: true }` accepts that explicitly).

A custom adapter implements `StorageAdapter`:

<!-- docs-check: signature @korajs/store @korajs/core -->
```typescript
interface StorageAdapter {
  open(schema: SchemaDefinition): Promise<void>
  close(): Promise<void>
  execute(sql: string, params?: unknown[]): Promise<void>
  query<T>(sql: string, params?: unknown[]): Promise<T[]>
  transaction(fn: (tx: Transaction) => Promise<void>): Promise<void>
  migrate(from: number, to: number, migration: MigrationPlan): Promise<void>
  /** Post-open state of adapters that can degrade at runtime. */
  getStorageOpenState?(): StorageOpenState | null
  /** Resolves once earlier commits are durable; required for adapters that persist asynchronously. */
  ensureDurable?(): Promise<void>
}
```

### StoreConfig

The `Store` constructor's configuration, built by `createApp()`. You need it only when using
`Store` directly (tests, custom runtimes).

| Field | Description |
|-------|-------------|
| `schema`, `adapter` | Required. `adapter` is a `StorageAdapter` instance. |
| `dbName` | Database name (default `'kora-db'`). |
| `isolation` | `'shared'` (one node id per database) or `'per-tab'`. |
| `nodeId` | Fixed node id (otherwise loaded or generated). |
| `emitter` | `KoraEventEmitter` for operation, merge, query and storage events. |
| `secretKeyProvider` | Key for encrypted `t.secret()` fields. |
| `operationTransforms` | Schema transforms applied at fold time (pass the sync engine's list). |
| `maxOperationBytes` | Largest local operation (default 256 KiB, the server default). |
| `materialization` | `'fold'` (default) or `'legacy'` (the 1.0.0-beta.12 merge, for comparison only; removed in a later release). |
| `localMutationHandler`, `onQuerySubscribed` | Hooks used by `createApp()`. |

---

## Blobs

A `t.blob()` field stores a content-addressed `BlobRef`; the bytes live in a blob store and move
between devices over the sync connection, once per content hash.

`app.blobs`:

| Method | Description |
|--------|-------------|
| `put(bytes, { mimeType?, filename? })` | Stores the bytes and prepares them for transfer. Returns `{ ref, manifest }`; put `ref` in the record. |
| `get(hash)` / `has(hash)` / `delete(hash)` | Local bytes. |
| `pull(refOrManifest)` | Fetches the missing chunks over the live sync connection and verifies them. |
| `gc({ dryRun? })` | Deletes local bytes no live record references. |
| `store` | The underlying `ContentAddressedBlobStore`. |

```typescript
const avatarSchema = defineSchema({
  version: 1,
  collections: { users: { fields: { name: t.string(), avatar: t.blob().optional() } } },
})
const avatarApp = createApp({ schema: avatarSchema })
await avatarApp.ready

const { ref } = await avatarApp.blobs.put(new Uint8Array([1, 2, 3]), { mimeType: 'image/png' })
await avatarApp.users.insert({ name: 'Ada', avatar: ref })
```

Every backend implements `ContentAddressedBlobStore` (`put`, `get`, `has`, `delete`, `size`,
`list`). Reads are integrity-checked: bytes that do not hash to their key throw
`BlobIntegrityError` (with `expectedHash` and `actualHash`).

| Class | Import | Persistence |
|-------|--------|-------------|
| `MemoryBlobStore` | `@korajs/store` | memory (tests) |
| `OpfsBlobStore`, `createOpfsBlobStore(rootDirName = 'kora-blobs')` | `@korajs/store` | browser OPFS |
| `FilesystemBlobStore(dir)` | `@korajs/store/blob-fs` | Node.js filesystem, sharded by hash prefix, atomic writes |

The server side of blob transfer is configured on the sync server; see
[Production Server](/guide/production-server).

---

## Errors

| Error | Code | Cause |
|-------|------|-------|
| `QueryError` | `QUERY_ERROR` | Invalid query (unknown include target, bad `orderBy` direction, bad `limit`). |
| `RecordNotFoundError` | `RECORD_NOT_FOUND` | `update` or `delete` of a missing record. |
| `StorageDurabilityError` | `STORAGE_DURABILITY_LOST` | No durable storage; writes are refused. |
| `SchemaVersionAheadError` | `SCHEMA_VERSION_AHEAD` | The database's stored schema version is newer than the code's (a newer build migrated it); the store refused to open it and changed nothing. |
| `StorageInUseError` | `STORAGE_IN_USE` | Deleting a database that is open in some tab or worker; close it everywhere and retry. |
| `UnsyncedDataError` | `UNSYNCED_DATA` | Deleting a database with unsynced writes (without `force`). |
| `StorageBackendMismatchError` | `STORAGE_BACKEND_MISMATCH` | The database's data lives in a backend this runtime cannot read (for example OPFS is unavailable now); Kora refuses to start an empty copy. |
| `PersistenceError` | `PERSISTENCE_ERROR` | IndexedDB persistence failed. |
| `InvalidStateTransitionError` | `INVALID_STATE_TRANSITION` | A local write the state machine forbids. |

The [Error Codes reference](/api/errors#store) lists every store code, including the worker and
adapter errors.
