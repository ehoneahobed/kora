# korajs

Offline-first application framework. Local-first storage, reactive queries, automatic conflict resolution, and real-time sync -- with zero distributed systems code.

## Install

```bash
pnpm add korajs
```

## Quick Start

```typescript
import { createApp, defineSchema, t } from 'korajs'

const app = createApp({
  schema: defineSchema({
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
  }),
})

const todo = await app.todos.insert({ title: 'Ship Kora v1' })
const active = await app.todos.where({ completed: false }).orderBy('createdAt').exec()
await app.todos.update(todo.id, { completed: true })
app.todos.where({ completed: false }).subscribe((todos) => console.log(todos))
```

## Enable Sync

Add one line to sync across devices:

```typescript
const app = createApp({
  schema,
  sync: { url: 'wss://my-server.com/kora' },
})
```

Conflicts are resolved automatically. No distributed systems code required.

## React Integration

Install `@korajs/react` or import from `korajs/react`:

```tsx
import { KoraProvider, useQuery, useMutation } from 'korajs/react'
```

## Vue 3 Integration

```typescript
import { KoraProvider, useQuery, useMutation } from 'korajs/vue'
```

Requires `vue` and `@korajs/vue` as peer dependencies.

## Svelte Integration

```typescript
import { createQueryStore, useQuery, useMutation } from 'korajs/svelte'
import KoraProvider from '@korajs/svelte/KoraProvider.svelte'
```

Requires `svelte` and `@korajs/svelte` as peer dependencies. Wrap your app with `<KoraProvider app={kora}>` (see `@korajs/svelte` README).

## Packages

`@korajs/core` | `@korajs/store` | `@korajs/merge` | `@korajs/sync` | `@korajs/server` | `@korajs/react` | `@korajs/vue` | `@korajs/svelte` | `@korajs/devtools` | `@korajs/cli`

## License

MIT

See the [full documentation](https://github.com/ehoneahobed/kora) for guides, API reference, and examples.
