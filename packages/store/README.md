# @korajs/store

Local storage engine for Kora.js. Supports SQLite WASM with OPFS persistence, IndexedDB fallback, and native SQLite for server-side use. Provides CRUD operations, reactive queries, and subscriptions.

> Most developers don't install this directly. Use [`korajs`](https://www.npmjs.com/package/korajs) instead.

## Install

```bash
pnpm add @korajs/store
```

## Usage

### Create a Store

```typescript
import { createStore } from '@korajs/store'
import { defineSchema, t } from '@korajs/core'

const schema = defineSchema({
  version: 1,
  collections: {
    todos: {
      fields: {
        title: t.string(),
        completed: t.boolean().default(false),
        createdAt: t.timestamp().auto(),
      },
    },
  },
})

const store = await createStore({ schema, adapter: 'sqlite-wasm' })
```

### Insert and Query

```typescript
await store.insert('todos', { title: 'Ship Kora v1' })

const active = await store.query('todos', {
  where: { completed: false },
  orderBy: { createdAt: 'desc' },
  limit: 10,
})
```

### Reactive Subscriptions

```typescript
const unsubscribe = store.subscribe(
  { collection: 'todos', where: { completed: false }, orderBy: { createdAt: 'asc' } },
  (todos) => {
    // Called immediately with current data, then on every change
    console.log(todos)
  }
)
```

## Storage Adapters

| Adapter | Environment | Persistence |
|---------|-------------|-------------|
| `sqlite-wasm` | Browser (default) | OPFS |
| `indexeddb` | Browser (fallback) | IndexedDB |
| `sqlite-native` | Node.js / Electron | Filesystem |

The adapter is selected automatically based on environment. SQLite WASM runs in a Web Worker to avoid blocking the main thread.

## License

MIT

See the [full documentation](https://github.com/ehoneahobed/kora) for guides, API reference, and examples.
