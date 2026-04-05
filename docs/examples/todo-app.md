# Todo App

Build a fully offline-capable todo app with real-time sync in under 100 lines of application code. This example covers schema definition, CRUD operations, filtering, and live sync status.

## Define Your Schema

Start by describing your data. Kora infers all TypeScript types from this definition, so your IDE autocompletes field names and type-checks values everywhere.

```typescript
// schema.ts
import { defineSchema, t } from 'kora'

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

`t.timestamp().auto()` means `createdAt` is set automatically on insert -- the developer never provides it. The `indexes` array tells Kora to create database indexes for fast filtering and sorting.

## Create the App

```typescript
// app.ts
import { createApp } from 'kora'
import { schema } from './schema'

export const app = createApp({
  schema,
  sync: {
    url: 'wss://my-server.com/kora',
  },
})
```

That single `sync` line is all it takes to enable real-time synchronization. Without it, the app works fully offline with local persistence. With it, every mutation syncs to the server and fans out to other connected clients.

## React Components

### App Root

Wrap your application in `KoraProvider` to make the app instance available to all hooks.

```tsx
// main.tsx
import { KoraProvider } from '@kora/react'
import { app } from './app'
import { TodoApp } from './TodoApp'

function Main() {
  return (
    <KoraProvider app={app}>
      <TodoApp />
    </KoraProvider>
  )
}
```

### TodoApp with Filtering

```tsx
// TodoApp.tsx
import { useState } from 'react'
import { useQuery, useSyncStatus } from '@kora/react'
import { app } from './app'
import { AddTodo } from './AddTodo'
import { TodoItem } from './TodoItem'

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
        <button key={f} onClick={() => onChange(f)} disabled={current === f}>
          {f}
        </button>
      ))}
    </div>
  )
}

function TodoList({ filter }: { filter: Filter }) {
  const query = filter === 'all'
    ? app.todos.orderBy('createdAt', 'desc')
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

`useQuery` returns data synchronously from the local store. There is no loading spinner for local data. The hook re-renders the component whenever the query result changes -- whether from a local mutation or an incoming sync.

### AddTodo

```tsx
// AddTodo.tsx
import { useState } from 'react'
import { useMutation } from '@kora/react'
import { app } from './app'

export function AddTodo() {
  const [title, setTitle] = useState('')
  const addTodo = useMutation(app.todos.insert)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim()) return
    addTodo({ title: title.trim(), priority: 'medium' })
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
    </form>
  )
}
```

`useMutation` is optimistic by default. The todo appears in the list instantly, before sync confirms it. If you need confirmation, you can `await` the result.

### TodoItem

```tsx
// TodoItem.tsx
import { useMutation } from '@kora/react'
import { app } from './app'

interface Todo {
  id: string
  title: string
  completed: boolean
  priority: 'low' | 'medium' | 'high'
  createdAt: number
}

export function TodoItem({ todo }: { todo: Todo }) {
  const updateTodo = useMutation(app.todos.update)
  const deleteTodo = useMutation(app.todos.delete)

  return (
    <li>
      <input
        type="checkbox"
        checked={todo.completed}
        onChange={() => updateTodo(todo.id, { completed: !todo.completed })}
      />
      <span style={{ textDecoration: todo.completed ? 'line-through' : 'none' }}>
        {todo.title}
      </span>
      <span>{todo.priority}</span>
      <button onClick={() => deleteTodo(todo.id)}>Delete</button>
    </li>
  )
}
```

### Sync Status Indicator

```tsx
// SyncIndicator.tsx
import { useSyncStatus } from '@kora/react'

function SyncIndicator() {
  const status = useSyncStatus()

  const labels: Record<string, string> = {
    connected: 'Connected',
    syncing: 'Syncing...',
    synced: 'All changes saved',
    offline: 'Offline',
    error: 'Sync error',
  }

  return (
    <div>
      <span>{labels[status.status]}</span>
      {status.pendingOperations > 0 && (
        <span> ({status.pendingOperations} pending)</span>
      )}
    </div>
  )
}
```

`useSyncStatus` only re-renders when the status actually changes, not on every sync event. The `pendingOperations` count tells users how many local changes are waiting to be synced.

## How It Works

When a user checks off a todo:

1. `updateTodo` creates an **Operation** with only the changed field (`{ completed: true }`).
2. The operation is written to the local SQLite store immediately. The UI updates.
3. The operation enters the outbound sync queue.
4. When connected, Kora sends the operation to the server, which fans it out to other clients.
5. If two users edit the same todo concurrently, the merge engine resolves the conflict automatically using last-write-wins (ordered by hybrid logical clock, not wall-clock time).

All of this happens with zero sync or conflict code from the developer.
