---
title: Getting Started
description: "Scaffold an offline-first app with create-kora-app, add a field with a schema migration, and learn the collection API, React hooks and sync setup."
---

# Getting Started

This tutorial scaffolds a local-first React app, adds a field with a schema migration, and shows
the API you use from there. It takes about ten minutes. Every step on this page is checked in CI
against a freshly scaffolded app (`scripts/docs/check-getting-started.mjs`).

You need Node.js 20 or later and a package manager (pnpm, npm, yarn or bun).

## 1. Scaffold the app

Kora 1.0 is in beta, so ask for the `beta` tag (plain `npx create-kora-app` installs the older
0.x line):

```bash
npx create-kora-app@beta my-app --template react-basic --pm pnpm --yes
cd my-app
pnpm dev
```

Open http://localhost:5173. You have a todo app that stores its data in SQLite inside the
browser. Add a few todos, reload, and they are still there. Stop the dev server and the data is
still on the device: nothing here needs a network.

`--template react-basic` picks the smallest template (React, plain CSS, no sync server), and
`--yes` skips the prompts. Without flags, `create-kora-app` asks for:

```
? Project name
? Platform:                 Web (browser) | Desktop (Tauri, native SQLite)
? UI framework:             React | Vue 3 | Svelte 5
? Authentication:           None   (email and OAuth templates are coming soon)
? Use Tailwind CSS?
? Enable multi-device sync?
? Server-side database:     SQLite (zero-config) | PostgreSQL (production-scale)
? Package manager:          pnpm | npm | yarn | bun
```

`--yes` alone gives the recommended setup: React, Tailwind and a SQLite sync server
(`react-tailwind-sync`), with the package manager that ran the command. The CLI installs the
dependencies for you; pass `--skip-install` to do it yourself. Every web template also ships an
offline app shell: production builds register a service worker, so the deployed app opens with no
network (see [Offline Patterns](/guide/offline-patterns#the-app-shell)).

## 2. What you got

```
my-app/
  src/
    schema.ts                     # the schema: the single source of truth for your data
    modules/todos/
      todo.schema.ts              # the todos collection
      todo.queries.ts             # reads
      todo.mutations.ts           # writes
      useTodos.ts                 # React binding for the feature
    App.tsx                       # the UI
    main.tsx                      # createApp() and <KoraProvider>
    kora-worker.ts                # SQLite WASM worker entry
  kora.config.ts                  # `kora dev` settings
  vite.config.ts                  # Vite, cross-origin isolation, offline app shell
```

`src/main.tsx` creates the app once and hands it to React:

<!-- docs-check: skip excerpt of the scaffolded src/main.tsx (imports App and the worker URL) -->
```tsx
const app = createApp({
  schema,
  store: { workerUrl: koraWorkerUrl },
  devtools: import.meta.env.DEV,
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <KoraProvider app={app} fallback={<div>Loading...</div>}>
      <App />
    </KoraProvider>
  </StrictMode>,
)
```

SQLite runs in a Web Worker, persisted with OPFS, so storage never blocks the UI. `workerUrl` is
the worker that `src/kora-worker.ts` builds. When OPFS is not available Kora falls back to durable
IndexedDB, and when no durable storage exists at all it refuses writes instead of silently keeping
them in memory (see [Storage Configuration](/guide/storage-configuration)). `<KoraProvider>` shows
its `fallback` until the local database is open.

## 3. Add a field with a migration

Give todos a priority. A schema change that adds a column needs a new schema version and a
migration, because existing devices already have a database at version 1.

Replace `src/modules/todos/todo.schema.ts`:

<!-- docs-check: file src/modules/todos/todo.schema.ts -->
```ts
import { t } from 'korajs'

export const todos = {
  fields: {
    title: t.string(),
    completed: t.boolean().default(false),
    priority: t.enum(['low', 'medium', 'high']).default('medium'),
    createdAt: t.timestamp().auto(),
  },
  indexes: ['completed', 'createdAt'],
}
```

Replace `src/schema.ts`:

<!-- docs-check: file src/schema.ts -->
```ts
import { defineSchema, migrate, t } from 'korajs'
import { todos } from './modules/todos/todo.schema'

export default defineSchema({
  version: 2,
  collections: {
    todos,
  },
  migrations: {
    2: migrate().addField('todos', 'priority', t.enum(['low', 'medium', 'high']).default('medium')),
  },
})
```

Then show the priority in `src/App.tsx`, right after the line that renders the title
(`<span className={`title ...`}>{String(todo.title)}</span>`):

<!-- docs-tutorial: insert src/App.tsx after {String(todo.title)}</span> -->
```tsx
<span className="time">{String(todo.priority)}</span>
```

Save, and the dev server reloads. On the next open, the store sees that the database is at
version 1 and runs migration 2 in one transaction: the column is added, existing todos read
`'medium'`, and the schema version moves to 2. A migration either applies completely or not at
all. Read [Schema Design](/guide/schema-design#migrations) for renames, backfills that sync, and
schema transforms for devices that are still on an older version.

## 4. The collection API

Everything the template does goes through the app's collections. Every call works offline and
persists before it resolves.

<!-- docs-check-prelude
import { createApp, defineSchema, t } from 'korajs'
const app = createApp({
  schema: defineSchema({
    version: 1,
    collections: {
      todos: {
        fields: {
          title: t.string(),
          completed: t.boolean().default(false),
          priority: t.enum(['low', 'medium', 'high']).default('medium'),
          createdAt: t.timestamp().auto(),
        },
      },
    },
  }),
})
-->

```ts
await app.ready

const todo = await app.todos.insert({ title: 'Ship the beta' })
// { id: '0190…', title: 'Ship the beta', completed: false, priority: 'medium',
//   createdAt: 1712188800000 }

await app.todos.update(todo.id, { completed: true })
const found = await app.todos.findById(todo.id)

const open = await app.todos
  .where({ completed: false, priority: 'high' })
  .orderBy('createdAt', 'desc')
  .limit(10)
  .exec()

const count = await app.todos.where({ completed: false }).count()

const stop = app.todos.where({ completed: false }).subscribe((rows) => {
  console.log(`${rows.length} open`) // runs now, then after every change
})

await app.todos.delete(todo.id)
stop()
```

These calls are typed from the schema: `app.todos.insert({ titel: 'x' })` and
`where({ priority: 'urgent' })` are compile errors. Two names are worth knowing:

- `app.collections.todos` is the same accessor. Use it for a collection whose name is also an app
  property (`events`, `sync`, `storage`, `ready`, ...), which `app.<name>` cannot reach. In
  development, `createApp` warns about such names.
- `createdAt` and `updatedAt` are always queryable, even when the schema does not declare them:
  every record keeps its creation and last-update time.

<!-- docs-check-prelude -->

## 5. React hooks

The template's hooks (`useCollection`, `useQuery`, `useMutation` from `@korajs/react`) work with
any collection name. For schema-checked names, inserts and rows, create typed hooks once next to
your app:

<!-- docs-check: file kora.ts -->
```ts
import { createKoraHooks } from '@korajs/react'
import { createApp, defineSchema, t } from 'korajs'

export const app = createApp({
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

export const { useCollection, useQuery, useMutation } = createKoraHooks<typeof app>()
```

<!-- docs-check: file TodoList.tsx -->
```tsx
import { useCollection, useMutation, useQuery } from './kora'

export function TodoList() {
  const todos = useCollection('todos') // 'todoz' is a type error
  const open = useQuery(todos.where({ completed: false }).orderBy('createdAt'))
  const add = useMutation(todos.insert)
  const toggle = useMutation(todos.update)

  return (
    <div>
      <button onClick={() => add.mutate({ title: 'New todo' })}>Add</button>
      <ul>
        {open.map((todo) => (
          <li key={todo.id} onClick={() => toggle.mutate(todo.id, { completed: true })}>
            {todo.title}
          </li>
        ))}
      </ul>
    </div>
  )
}
```

`useMutation` returns `{ mutate, mutateAsync, isLoading, error, reset }`: call `mutate(...)`
(fire and forget) or `await mutateAsync(...)`. `useQuery` re-renders when the result changes. Its
very first render, before the local query has run, returns an empty array; use
`useQueryState` when you need to tell "still loading" from "no rows" (or a query error). See
[React Hooks](/guide/react-hooks).

## 6. Add sync

Sync is one more option on `createApp`. Kora does not connect on its own unless you ask it to:

<!-- docs-check: file sync-app.ts -->
```ts
import { createApp } from 'korajs'
import schema from './src/schema'

export const app = createApp({
  schema,
  sync: {
    url: 'wss://my-server.example.com/kora-sync',
    autoConnect: true, // or call `await app.sync?.connect()` after `app.ready`
  },
})
```

Writes still land locally first. They upload when a connection exists, survive reloads while
offline, and concurrent edits from other devices merge per field the same way on every device
([Conflict Resolution](/guide/conflict-resolution)). For a working client and server, scaffold a
sync template (`npx create-kora-app@beta my-app --yes` gives `react-tailwind-sync`): `pnpm dev`
then starts the app and a local sync server together. Running a server is covered in
[Sync Configuration](/guide/sync-configuration) and [Production Server](/guide/production-server).

## 7. Deploy

```bash
pnpm build          # tsc && vite build: dist/ with the offline app shell
npx kora deploy     # Fly.io, Railway or AWS for sync templates
```

See [Deployment](/guide/deployment).

## What's next

- [Schema Design](/guide/schema-design): field types, the value domain, relations, migrations
- [Conflict Resolution](/guide/conflict-resolution): exactly how concurrent edits merge
- [Offline Patterns](/guide/offline-patterns): sync status, pending writes, the app shell
- [React Hooks](/guide/react-hooks), [Vue](/api/vue), [Svelte](/api/svelte)
- [Sync Configuration](/guide/sync-configuration) and [Sync Protocol](/guide/sync-protocol)
- [Authentication](/guide/authentication) and [Sync Encryption](/guide/sync-encryption)
- [Production Server](/guide/production-server) and [Deployment](/guide/deployment)
- [Storage Configuration](/guide/storage-configuration) and [Backup and Restore](/guide/backup-restore)
- [Testing](/guide/testing) and [DevTools](/guide/devtools)
- [Error Codes](/api/errors): every Kora error code, its cause and its fix
- [API Reference](/api/)
