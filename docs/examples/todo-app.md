---
title: Todo App Example
description: "Build an offline-first todo app with Kora.js and React: schema, reactive queries, mutations, and optional multi-device sync."
---

# Todo App

An offline-capable todo app with optional sync: schema, CRUD, filtering and sync status, in about
150 lines. Every block below is a file of the app. To start from a working project instead, run
`npx create-kora-app@beta my-app` (see [Getting Started](/getting-started)).

## Schema

Kora infers every TypeScript type from this definition.

<!-- docs-check: file schema.ts -->
```typescript
// schema.ts
import { defineSchema, t } from 'korajs'

export const schema = defineSchema({
  version: 1,
  collections: {
    todos: {
      fields: {
        title: t.string(),
        completed: t.boolean().default(false),
        priority: t.enum(['low', 'medium', 'high']).default('medium'),
        createdAt: t.timestamp().auto(),
      },
      indexes: ['completed', 'priority', 'createdAt'],
    },
  },
})
```

`t.timestamp().auto()` sets `createdAt` on insert; the app never provides it. `indexes` creates
database indexes for filtering and sorting.

## App

<!-- docs-check: file app.ts -->
```typescript
// app.ts
import { type CollectionRecordOf, createApp } from 'korajs'
import { createKoraHooks } from 'korajs/react'
import { schema } from './schema'

export const app = createApp({
  schema,
  // Optional: remove `sync` for a local-only app.
  sync: {
    url: 'wss://my-server.example.com/kora-sync',
    autoConnect: true,
  },
})

export type Todo = CollectionRecordOf<typeof app, 'todos'>

// Hooks typed by the schema
export const { useMutation, useQuery, useSyncStatus } = createKoraHooks<typeof app>()
```

Without `sync` the app is local-only and fully functional. With it, every write is uploaded when a
connection exists and other devices' writes arrive in real time. `autoConnect: true` connects once
the local store is ready (otherwise call `app.sync?.connect()` yourself).

## Root

<!-- docs-check: file main.tsx -->
```tsx
// main.tsx
import { KoraProvider } from '@korajs/react'
import { createRoot } from 'react-dom/client'
import { app } from './app'
import { TodoApp } from './TodoApp'

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <KoraProvider app={app} fallback={<p>Loading...</p>}>
      <TodoApp />
    </KoraProvider>,
  )
}
```

`KoraProvider` renders `fallback` until the local database is open, so the components below can
query right away.

## TodoApp with filtering

<!-- docs-check: file TodoApp.tsx -->
```tsx
// TodoApp.tsx
import { useState } from 'react'
import { AddTodo } from './AddTodo'
import { SyncIndicator } from './SyncIndicator'
import { TodoItem } from './TodoItem'
import { app, useQuery } from './app'

type Filter = 'all' | 'active' | 'completed'

export function TodoApp() {
  const [filter, setFilter] = useState<Filter>('all')

  return (
    <div>
      <h1>Todos</h1>
      <SyncIndicator />
      <AddTodo />
      <FilterBar current={filter} onChange={setFilter} />
      <TodoList filter={filter} />
    </div>
  )
}

function FilterBar({ current, onChange }: { current: Filter; onChange: (f: Filter) => void }) {
  return (
    <div>
      {(['all', 'active', 'completed'] as const).map((f) => (
        <button key={f} type="button" onClick={() => onChange(f)} disabled={current === f}>
          {f}
        </button>
      ))}
    </div>
  )
}

function TodoList({ filter }: { filter: Filter }) {
  const query =
    filter === 'all'
      ? app.todos.where({}).orderBy('createdAt', 'desc')
      : app.todos.where({ completed: filter === 'completed' }).orderBy('createdAt', 'desc')
  const todos = useQuery(query)

  if (todos.length === 0) {
    return <p>No {filter === 'all' ? '' : filter} todos.</p>
  }

  return (
    <ul>
      {todos.map((todo) => (
        <TodoItem key={todo.id} todo={todo} />
      ))}
    </ul>
  )
}
```

Local queries need no network: `useQuery` renders `[]` first and the rows right after mount, then
re-renders whenever the result changes, from a local write or an incoming sync. Switching the
filter subscribes to the new query.

## AddTodo

<!-- docs-check: file AddTodo.tsx -->
```tsx
// AddTodo.tsx
import { useState } from 'react'
import { app, useMutation } from './app'

export function AddTodo() {
  const [title, setTitle] = useState('')
  const addTodo = useMutation(app.todos.insert)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim()) return
    addTodo.mutate({ title: title.trim(), priority: 'medium' })
    setTitle('')
  }

  return (
    <form onSubmit={handleSubmit}>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="What needs to be done?"
      />
      <button type="submit">Add</button>
      {addTodo.error && <p role="alert">{addTodo.error.message}</p>}
    </form>
  )
}
```

`useMutation` returns `mutate` (fire and forget), `mutateAsync` (awaitable), `reset`, `isLoading`
and `error`. The write lands in the local database at once and the list updates; uploading happens
in the background. Render `error`: a refused local write (an invalid value, for example) reports
there.

## TodoItem

<!-- docs-check: file TodoItem.tsx -->
```tsx
// TodoItem.tsx
import { app, type Todo, useMutation } from './app'

export function TodoItem({ todo }: { todo: Todo }) {
  const updateTodo = useMutation(app.todos.update)
  const deleteTodo = useMutation(app.todos.delete)
  const completed = todo.completed ?? false

  return (
    <li>
      <input
        type="checkbox"
        checked={completed}
        onChange={() => updateTodo.mutate(todo.id, { completed: !completed })}
      />
      <span style={{ textDecoration: completed ? 'line-through' : 'none' }}>{todo.title}</span>
      <span>{todo.priority}</span>
      <button type="button" onClick={() => deleteTodo.mutate(todo.id)}>
        Delete
      </button>
    </li>
  )
}
```

Defaulted fields read as `T | null` (an update can clear them), hence `todo.completed ?? false`.

## Sync status

<!-- docs-check: file SyncIndicator.tsx -->
```tsx
// SyncIndicator.tsx
import { useSyncStatus } from './app'

const labels: Record<string, string> = {
  connected: 'Connected',
  reconnecting: 'Reconnecting...',
  syncing: 'Syncing...',
  synced: 'All changes saved',
  offline: 'Offline: changes are kept on this device',
  'auth-required': 'Sign in to sync',
  error: 'Sync error',
}

export function SyncIndicator() {
  const status = useSyncStatus()

  return (
    <div>
      <span>{labels[status.status] ?? status.status}</span>
      {status.pendingOperations > 0 && <span> ({status.pendingOperations} pending)</span>}
    </div>
  )
}
```

`useSyncStatus` re-renders only when the status changes. `pendingOperations` counts local writes
the server has not acknowledged yet.

## How it works

When a user checks off a todo:

1. `updateTodo` records an **operation** with only the changed field (`{ completed: true }`) and
   its previous value, in the same local transaction as the row.
2. The UI updates from the local database.
3. When connected, the operation is uploaded; the server stores it and relays it to the user's
   other devices.
4. If two devices edit the same todo concurrently, every device merges the same operations the
   same way: per field, the later write wins by hybrid logical clock, not wall-clock time. See
   [Conflict Resolution](/guide/conflict-resolution).

None of this needs sync or conflict code in the app.
