# @korajs/store

The local data layer of Kora.js: SQLite WASM on OPFS (in a worker), an IndexedDB fallback, native
SQLite for Node.js, the operation log, the per-field fold that materializes records, reactive
queries, transactions, sequences and blob storage.

> Most apps do not install this directly: `createApp()` from
> [`korajs`](https://www.npmjs.com/package/korajs) creates and opens the store, and you use it
> through `app.<collection>`.

## Install

```bash
pnpm add @korajs/store@beta
```

## Usage through createApp

<!-- docs-check: standalone -->
```typescript
import { createApp, defineSchema, t } from 'korajs'

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

const app = createApp({ schema })
await app.ready

await app.todos.insert({ title: 'Ship Kora v1' })
const active = await app.todos.where({ completed: false }).orderBy('createdAt', 'desc').limit(10).exec()

const unsubscribe = app.todos.where({ completed: false }).subscribe((todos) => {
  // Called with the current results, then whenever they change
  console.log(todos.length)
})
```

## Storage adapters

| Adapter | Entry point | Environment |
|---------|-------------|-------------|
| `sqlite-wasm` | `@korajs/store/sqlite-wasm` | Browsers with OPFS (default) |
| `indexeddb` | `@korajs/store/indexeddb` | Browsers without usable OPFS |
| `better-sqlite3` | `@korajs/store/better-sqlite3` | Node.js, Electron |

`createApp` picks one automatically. Kora never runs on non-durable storage silently: when nothing
durable can open it emits `store:durability-lost` and refuses writes with `StorageDurabilityError`.
`FilesystemBlobStore` lives in `@korajs/store/blob-fs` so browser bundles never include `node:fs`.

## Documentation

[Storage Configuration](https://korajs.dev/guide/storage-configuration) and the
[Store API reference](https://korajs.dev/api/store).

## License

MIT
