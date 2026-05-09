# Store API Reference

`@korajs/store` provides the local storage layer and the collection API that developers interact with for all data operations. It manages persistence (SQLite WASM, IndexedDB), reactive queries, and operation creation.

You do not typically instantiate a `Store` directly. Instead, `createApp()` creates and configures one for you. The collection methods documented here are accessed through the app instance.

```typescript
import { createApp, defineSchema, t } from 'korajs'

const app = createApp({ schema })

// Collection methods are accessed through app.<collectionName>
await app.todos.insert({ title: 'Hello' })
```

---

## Collection methods

Every collection defined in your schema is accessible as a property on the app instance. Each collection provides the following methods.

### .insert(data)

Inserts a new record into the collection. Returns the full record including generated fields (`id`, auto-fields).

```typescript
insert(data: Partial<CollectionRecord>): Promise<CollectionRecord>
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `data` | `Partial<CollectionRecord>` | Field values for the new record. Fields with `.default()` or `.auto()` modifiers can be omitted. |

**Returns:** `Promise<CollectionRecord>` -- The inserted record with all fields populated, including the generated `id` (UUID v7) and any auto/default values.

```typescript
const todo = await app.todos.insert({
  title: 'Ship Kora v1',
  // completed defaults to false (from schema)
  // createdAt set automatically (t.timestamp().auto())
})

console.log(todo)
// {
//   id: '0190a6e0-7b3c-7def-8a12-4b5c6d7e8f90',
//   title: 'Ship Kora v1',
//   completed: false,
//   createdAt: 1712188800000
// }
```

### .update(id, data)

Updates an existing record. Only the specified fields are changed. An operation is created containing only the changed fields and their previous values (enabling 3-way merge).

```typescript
update(id: string, data: Partial<CollectionRecord>): Promise<CollectionRecord>
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | `string` | The record ID to update. |
| `data` | `Partial<CollectionRecord>` | Fields to change. Only include fields that are changing. |

**Returns:** `Promise<CollectionRecord>` -- The updated record with all fields.

```typescript
const updated = await app.todos.update('0190a6e0-7b3c-7def-8a12-4b5c6d7e8f90', {
  completed: true,
})
```

### .delete(id)

Deletes a record from the collection. Creates a delete operation that propagates to other devices via sync.

```typescript
delete(id: string): Promise<void>
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | `string` | The record ID to delete. |

```typescript
await app.todos.delete('0190a6e0-7b3c-7def-8a12-4b5c6d7e8f90')
```

### .findById(id)

Retrieves a single record by its ID. Returns `null` if not found.

```typescript
findById(id: string): Promise<CollectionRecord | null>
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | `string` | The record ID to look up. |

**Returns:** `Promise<CollectionRecord | null>` -- The record, or `null` if it does not exist.

```typescript
const todo = await app.todos.findById('0190a6e0-7b3c-7def-8a12-4b5c6d7e8f90')

if (todo) {
  console.log(todo.title)
}
```

---

## Query builder

The query builder provides a chainable API for constructing queries. Start with `.where()` on a collection and chain additional methods. Terminate with `.exec()` to run the query or `.subscribe()` to reactively watch results.

### .where(filter)

Begins a query with a filter condition. Fields in the filter object are matched with equality by default.

```typescript
where(filter: Partial<CollectionRecord>): QueryBuilder
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `filter` | `Partial<CollectionRecord>` | Key-value pairs to match against. All conditions are AND-ed. |

```typescript
const active = app.todos.where({ completed: false })
const assigned = app.todos.where({ assignee: 'alice', completed: false })
```

### .orderBy(field, direction?)

Sorts results by a field.

```typescript
orderBy(field: string, direction?: 'asc' | 'desc'): QueryBuilder
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `field` | `string` | -- | Field name to sort by. |
| `direction` | `'asc' \| 'desc'` | `'asc'` | Sort direction. |

```typescript
app.todos.where({ completed: false }).orderBy('createdAt', 'desc')
```

### .limit(n)

Limits the number of results returned.

```typescript
limit(n: number): QueryBuilder
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `n` | `number` | Maximum number of records to return. |

```typescript
app.todos.where({ completed: false }).orderBy('createdAt').limit(10)
```

### .offset(n)

Skips the first `n` results. Useful for pagination in combination with `.limit()`.

```typescript
offset(n: number): QueryBuilder
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `n` | `number` | Number of records to skip. |

```typescript
// Page 2 of 10 results per page
app.todos.where({ completed: false }).orderBy('createdAt').limit(10).offset(10)
```

### .include(relation)

Includes related records in the query results by following a relation defined in the schema.

```typescript
include(relation: string): QueryBuilder
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `relation` | `string` | Name of a relation target collection to include. |

```typescript
const todosWithProject = await app.todos
  .where({ completed: false })
  .include('project')
  .exec()

// Each todo now has a `project` property with the related record
console.log(todosWithProject[0].project.name)
```

### .count()

Returns the number of records matching the query instead of the records themselves.

```typescript
count(): Promise<number>
```

```typescript
const activeCount = await app.todos.where({ completed: false }).count()
console.log(activeCount) // 42
```

### .exec()

Executes the query and returns the matching records as an array.

```typescript
exec(): Promise<CollectionRecord[]>
```

```typescript
const todos = await app.todos
  .where({ completed: false })
  .orderBy('createdAt', 'desc')
  .limit(10)
  .exec()
```

### .subscribe(callback)

Subscribes to live query results. The callback is called immediately with the current results, and again whenever the result set changes due to local mutations or incoming sync operations.

```typescript
subscribe(callback: (results: CollectionRecord[]) => void): () => void
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `callback` | `(results: CollectionRecord[]) => void` | Function called with the current result set on every change. |

**Returns:** `() => void` -- An unsubscribe function. Call it to stop receiving updates.

```typescript
const unsubscribe = app.todos
  .where({ completed: false })
  .orderBy('createdAt')
  .subscribe((todos) => {
    console.log('Active todos:', todos.length)
  })

// Later: stop watching
unsubscribe()
```

::: warning
Always call the unsubscribe function when you no longer need updates (e.g., when a component unmounts). Failing to unsubscribe causes memory leaks. If you are using React, prefer the `useQuery` hook which handles unsubscription automatically.
:::

---

## Query builder chaining

Methods can be chained in any order before the terminal `.exec()`, `.count()`, or `.subscribe()`. All of the following are equivalent:

```typescript
// Order 1
await app.todos.where({ completed: false }).orderBy('createdAt').limit(5).exec()

// Order 2
await app.todos.where({ completed: false }).limit(5).orderBy('createdAt').exec()
```

A full chaining example:

```typescript
const recentActive = await app.todos
  .where({ completed: false })
  .orderBy('createdAt', 'desc')
  .limit(20)
  .offset(0)
  .include('project')
  .exec()
```

---

## Transactions

Transactions execute multiple mutations atomically. Either all operations succeed, or none do. Use transactions when you need to update multiple records or collections as a single unit.

### app.transaction(fn)

Executes a function within a transaction context. The transaction is committed when the function completes, or rolled back if it throws.

```typescript
transaction(fn: (tx: TransactionProxy) => Promise<void>): Promise<Operation[]>
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `fn` | `(tx: TransactionProxy) => Promise<void>` | Function that performs mutations using the transaction proxy. |

**Returns:** `Promise<Operation[]>` — The operations created by the transaction.

```typescript
const ops = await app.transaction(async (tx) => {
  const order = await tx.orders.insert({ total: 99.99 })
  await tx.lineItems.insert({ orderId: order.id, product: 'Widget', qty: 2 })
  await tx.lineItems.insert({ orderId: order.id, product: 'Gadget', qty: 1 })
})
// All three inserts succeed or fail together
```

The transaction proxy (`tx`) provides the same collection accessors as the app (`tx.orders`, `tx.todos`, etc.), but mutations are buffered and only applied when the function completes successfully.

### app.mutation(name, fn)

A named transaction — identical to `app.transaction()` but with a name that appears in DevTools for easier debugging.

```typescript
mutation(name: string, fn: (tx: TransactionProxy) => Promise<void>): Promise<Operation[]>
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | `string` | A descriptive name for this mutation (visible in DevTools). |
| `fn` | `(tx: TransactionProxy) => Promise<void>` | Function that performs mutations using the transaction proxy. |

```typescript
await app.mutation('create-order', async (tx) => {
  const order = await tx.orders.insert({ total: 150 })
  await tx.lineItems.insert({ orderId: order.id, product: 'Widget', qty: 3 })
})
```

### TransactionProxy

The transaction proxy exposes collection accessors with the same API as the app-level accessors:

| Method | Description |
|--------|-------------|
| `tx.<collection>.insert(data)` | Insert a record within the transaction. |
| `tx.<collection>.update(id, data)` | Update a record within the transaction. |
| `tx.<collection>.delete(id)` | Delete a record within the transaction. |
| `tx.<collection>.findById(id)` | Read a record (sees uncommitted writes from this transaction). |

::: tip
Queries (`.where()`, `.exec()`) are not available inside transactions. Use `findById()` to look up records you need during the transaction.
:::

---

## Sequences

Sequences generate ordered, formatted identifiers (invoice numbers, order codes, receipt IDs). They are offline-safe — each device maintains its own counter that increments monotonically.

### app.sequences.next(name, config?)

Generates the next value in a named sequence.

```typescript
next(name: string, config?: SequenceConfig): Promise<string>
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | `string` | Sequence name. Different names maintain independent counters. |
| `config` | `SequenceConfig` | Optional. Format and scope options. |

#### SequenceConfig

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `format` | `string` | `'{name}-{seq:4}'` | Format template. See format tokens below. |
| `scope` | `string` | `undefined` | Scope key. Different scopes maintain independent counters for the same sequence name. |

#### Format tokens

| Token | Description | Example output |
|-------|-------------|----------------|
| `{seq}` | Counter without padding | `1`, `42`, `100` |
| `{seq:N}` | Counter zero-padded to N digits | `{seq:4}` → `0001` |
| `{date}` | Current date as `YYYYMMDD` | `20260508` |
| `{node4}` | First 4 chars of node ID | `a1b2` |
| `{node8}` | First 8 chars of node ID | `a1b2c3d4` |

```typescript
// Default format: name + zero-padded counter
await app.sequences.next('order')        // 'order-0001'
await app.sequences.next('order')        // 'order-0002'

// Custom format
await app.sequences.next('receipt', {
  format: 'REC-{seq:6}',
})                                        // 'REC-000001'

// Scoped sequences (independent counters per scope)
await app.sequences.next('receipt', { scope: 'store-A' })  // 'receipt-0001'
await app.sequences.next('receipt', { scope: 'store-B' })  // 'receipt-0001'
await app.sequences.next('receipt', { scope: 'store-A' })  // 'receipt-0002'
```

### app.sequences.current(name, config?)

Returns the current counter value without incrementing it. Returns `0` for unused sequences.

```typescript
current(name: string, config?: { scope?: string }): Promise<number>
```

```typescript
const count = await app.sequences.current('order')  // 0 (never used)
await app.sequences.next('order')
await app.sequences.next('order')
const count2 = await app.sequences.current('order') // 2
```

### app.sequences.reset(name, config?)

Resets a sequence counter. The next call to `.next()` starts from 1 (or from the specified value).

```typescript
reset(name: string, config?: { scope?: string; to?: number }): Promise<void>
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `config.scope` | `string` | `undefined` | Only reset the counter for this scope. |
| `config.to` | `number` | `0` | Reset the counter to this value. |

```typescript
await app.sequences.reset('order')          // Next .next() returns 'order-0001'
await app.sequences.reset('order', { to: 100 })  // Next .next() returns 'order-0101'
```

---

## StorageAdapter

The `StorageAdapter` interface defines the contract for storage backends. Kora ships with three implementations. You do not typically implement this yourself unless building a custom storage backend.

```typescript
interface StorageAdapter {
  /** Open or create the database. */
  open(schema: SchemaDefinition): Promise<void>

  /** Close the database and release resources. */
  close(): Promise<void>

  /** Execute a write query (INSERT, UPDATE, DELETE) within a transaction. */
  execute(sql: string, params?: unknown[]): Promise<void>

  /** Execute a read query (SELECT). */
  query<T>(sql: string, params?: unknown[]): Promise<T[]>

  /** Execute multiple operations atomically. */
  transaction(fn: (tx: Transaction) => Promise<void>): Promise<void>

  /** Apply a schema migration. */
  migrate(from: number, to: number, migration: MigrationPlan): Promise<void>
}

interface Transaction {
  execute(sql: string, params?: unknown[]): Promise<void>
  query<T>(sql: string, params?: unknown[]): Promise<T[]>
}
```

### Built-in adapters

| Adapter | Identifier | Environment | Description |
|---------|------------|-------------|-------------|
| SQLite WASM + OPFS | `'sqlite-wasm'` | Browser | Primary adapter. Runs SQLite in a Web Worker with OPFS persistence. Best performance. |
| IndexedDB | `'indexeddb'` | Browser | Fallback adapter. Used automatically when WASM/OPFS is unavailable. |
| Native SQLite | `'better-sqlite3'` | Node.js, Electron | Uses `better-sqlite3` for server-side and desktop applications. |

### Selecting an adapter

```typescript
const app = createApp({
  schema,
  store: {
    adapter: 'sqlite-wasm',  // or 'indexeddb', 'better-sqlite3'
    name: 'my-app-db',       // Database name (used for OPFS directory / IndexedDB name)
  },
})
```

If no adapter is specified, Kora automatically selects the best available adapter for the current environment:

1. In browsers: `sqlite-wasm` if OPFS is available, otherwise `indexeddb`
2. In Node.js: `better-sqlite3`

---

## StoreConfig

Configuration options for the store, passed to `createApp()`.

```typescript
interface StoreConfig {
  /** Storage adapter to use. Auto-detected if omitted. */
  adapter?: 'sqlite-wasm' | 'indexeddb' | 'better-sqlite3'

  /** Database name. Defaults to 'kora-db'. */
  name?: string
}
```
