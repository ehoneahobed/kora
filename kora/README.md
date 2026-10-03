# korajs

Offline-first application framework: local storage, reactive queries, automatic conflict resolution and real-time sync, with zero distributed-systems code.

## Install

```bash
pnpm add korajs@beta
```

## Quick Start

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

const todo = await app.todos.insert({ title: 'Ship Kora v1' })
const active = await app.todos.where({ completed: false }).orderBy('createdAt').exec()
await app.todos.update(todo.id, { completed: true })
app.todos.where({ completed: false }).subscribe((todos) => console.log(todos))
```

## Enable Sync

Point the app at a [Kora sync server](https://korajs.dev/guide/production-server):

<!-- docs-check: continue -->
```typescript
const syncedApp = createApp({
  schema,
  sync: { url: 'wss://sync.example.com/kora-sync', autoConnect: true },
})
```

Writes still land locally first and upload when a connection exists; concurrent edits merge per
field the same way on every device.

## React Integration

Install `@korajs/react@beta`, then import from it or from `korajs/react`:

```tsx
import { KoraProvider, useQuery, useMutation } from 'korajs/react'
```

## Vue 3 Integration

```typescript
import { KoraProvider, useQuery, useMutation } from 'korajs/vue'
```

Requires `vue` and `@korajs/vue` (peer dependencies).

## Svelte Integration

```typescript
import { createQueryStore, useQuery, useMutation } from 'korajs/svelte'
import KoraProvider from '@korajs/svelte/KoraProvider.svelte'
```

Requires `svelte` and `@korajs/svelte` (peer dependencies). Wrap your app with `<KoraProvider app={kora}>` (see the `@korajs/svelte` README).

## Packages

`@korajs/core` | `@korajs/store` | `@korajs/merge` | `@korajs/sync` | `@korajs/server` | `@korajs/auth` | `@korajs/react` | `@korajs/vue` | `@korajs/svelte` | `@korajs/tauri` | `@korajs/devtools` | `@korajs/cli` | `@korajs/test` | `create-kora-app`

## License

MIT

Documentation: [korajs.dev](https://korajs.dev).
