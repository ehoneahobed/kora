---
title: Server Rendering and Next.js
description: "Use Kora with server rendering: the Next.js App Router 'use client' boundary, what createApp does on the server, hydration, and typed hooks."
---

# Server rendering and Next.js (App Router)

Kora's data lives on the device: in SQLite (OPFS) or IndexedDB in the browser. A server render has no local database, so Kora's rule for server rendering is simple:

- **The server renders the shell; the client renders the data.** On the server, Kora hooks return empty values (`[]` rows, `'offline'` status, no collaborators), and `<KoraProvider app={app}>` renders its `fallback`.
- **Hydration matches.** The client's first render uses the same empty values, so React hydrates without a mismatch, then local data appears in the next render, typically within a frame.
- **`createApp` is inert on the server.** A module-scope `createApp` that a server renderer evaluates opens no database and starts no sync.

This works with any React server renderer (`renderToString`, `renderToPipeableStream`, Remix, Next.js). This page uses the Next.js App Router.

## 1. Create the app in a client module

<!-- docs-check: file app/schema.ts -->
```typescript
// app/schema.ts
import { defineSchema, t } from 'korajs'

export default defineSchema({
  version: 1,
  collections: {
    todos: { fields: { title: t.string(), completed: t.boolean().default(false) } },
  },
})
```

<!-- docs-check: file app/kora.ts -->
```typescript
// app/kora.ts: import it only from 'use client' modules
import { createApp } from 'korajs'
import { createKoraHooks } from 'korajs/react'
import schema from './schema'

export const app = createApp({
  schema,
  store: { workerUrl: '/kora-worker.js' }, // see "The SQLite worker" below
  sync: { url: process.env.NEXT_PUBLIC_KORA_SYNC_URL ?? 'ws://localhost:3001' },
})

// Typed hooks: collection names, inserts and rows are checked against the schema.
export const { useCollection, useQuery, useQueryState, useMutation, useSyncStatus } =
  createKoraHooks<typeof app>()
```

Import this module only from client components (`'use client'` modules). Next.js still evaluates it on the server while it pre-renders client components. There is no `window` there, so `createApp` returns an **inert** app:

- no storage adapter is opened and no sync connection is made;
- `app.ready` rejects with `ServerRenderingAppError` (code `SSR_INERT_APP`). The rejection is already handled, so a module nobody awaits never crashes the server with an unhandled rejection;
- writes (`app.todos.insert(...)`) fail with `AppNotReadyError` instead of hanging.

In the browser the same module creates the real app.

::: tip Node.js programs
Inertness only applies where there is no `window`. A Node.js program that wants a real database (a script, a test, an Electron main process) passes `ssr: false`, or names the Node adapter explicitly with `store: { adapter: 'better-sqlite3' }`, which implies it. `ssr: true` keeps an app inert without a `window` even with that adapter.
:::

## 2. Put the provider behind the `'use client'` boundary

<!-- docs-check: file app/providers.tsx -->
```tsx
// app/providers.tsx
'use client'

import { KoraProvider } from 'korajs/react'
import type { ReactNode } from 'react'
import { app } from './kora'

export function Providers({ children }: { children: ReactNode }) {
  return (
    <KoraProvider app={app} fallback={<p>Opening your workspace...</p>}>
      {children}
    </KoraProvider>
  )
}
```

<!-- docs-check: file app/layout.tsx -->
```tsx
// app/layout.tsx (a Server Component)
import { Providers } from './providers'

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
```

On the server, `KoraProvider` renders the `fallback` (the app is never ready there). In the browser it hydrates that same fallback, waits for `app.ready`, then renders its children.

## 3. Use the hooks in client components

<!-- docs-check: file app/todos/todo-list.tsx -->
```tsx
// app/todos/todo-list.tsx
'use client'

import { useCollection, useMutation, useQueryState } from '../kora'

export function TodoList() {
  const todos = useCollection('todos')
  const { data, error, ready } = useQueryState(todos.where({ completed: false }))
  const { mutate: add } = useMutation(todos.insert)

  if (error) return <p role="alert">{error.message}</p>
  if (!ready) return null
  return (
    <>
      <button onClick={() => add({ title: 'New todo' })}>Add</button>
      <ul>{data.map((todo) => <li key={todo.id}>{todo.title}</li>)}</ul>
    </>
  )
}
```

Server Components cannot call Kora hooks or read the local database: the data is on the user's device, not on your server. If a server route needs the data, read it from your [sync server](/guide/production-server), which holds the synced copy.

## What each hook returns during a server render

| Hook | Server and hydration value |
|------|----------------------------|
| `useQuery` | `[]` |
| `useQueryState` | `{ data: [], error: null, ready: false }` |
| `useSyncStatus` | the offline status (`status: 'offline'`) |
| `useCollaborators` | `[]` |
| `useMutation` | `isLoading: false`, `error: null` |

All of them pass a `getServerSnapshot` to `useSyncExternalStore`, which is what lets React render them on the server and hydrate them without a mismatch.

## The SQLite worker

In the browser Kora runs SQLite in a Web Worker, so `store.workerUrl` must point at a worker script that imports `@korajs/store/sqlite-wasm/worker` (see [Storage Configuration](/guide/storage-configuration)). With Vite this is `import workerUrl from './kora-worker.ts?worker&url'`. With Next.js, build the worker as its own entry (or copy a prebuilt one) into `public/` and pass its public path, as above. The `create-kora-app` templates are Vite single-page apps; there is no Next.js template yet.

## Checklist

- `KoraProvider` and every component that uses a Kora hook are in `'use client'` modules, and only those import the module that calls `createApp`.
- Give `KoraProvider` a `fallback`: it is what the server renders.
- Do not `await app.ready` at the top level of a module that the server evaluates: it rejects there.
- Code that runs in Node.js outside a server render and needs a database passes `ssr: false`.
