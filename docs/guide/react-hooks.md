---
title: React Hooks
description: "Kora.js React bindings: useQuery for reactive data, useMutation, useSyncStatus, useRichText, and KoraProvider, all concurrent-mode safe."
---

# React Hooks

Kora provides first-class React bindings through the `@korajs/react` package. All hooks are designed for offline-first: data loads synchronously from the local store, mutations are optimistic, and reactive queries update in real time.

## Installation

```bash
pnpm add @korajs/react
```

## KoraProvider

Wrap your app with `KoraProvider` to make the Kora app instance available to all hooks:

```tsx
import { KoraProvider } from '@korajs/react'
import { app } from './app'

function App() {
  return (
    <KoraProvider app={app}>
      <YourApp />
    </KoraProvider>
  )
}
```

`KoraProvider` must be placed above any component that uses Kora hooks. It accepts a single `app` prop -- the instance returned by `createApp`.

## useQuery

`useQuery` subscribes to a reactive query and re-renders the component when the results change.

```tsx
import { useQuery } from '@korajs/react'
import { app } from './app'

function TodoList() {
  const todos = useQuery(
    app.todos.where({ completed: false }).orderBy('createdAt')
  )

  return (
    <ul>
      {todos.map((todo) => (
        <li key={todo.id}>{todo.title}</li>
      ))}
    </ul>
  )
}
```

### Key Behaviors

- **Synchronous return.** `useQuery` returns data immediately from the local store. There is no loading state for local data.
- **Reactive.** When the underlying data changes (local mutation or incoming sync), the component re-renders with the updated results.
- **Efficient.** The subscription only triggers a re-render when the query results actually change, not on every mutation. Results are diffed internally.
- **Concurrent mode safe.** Uses `useSyncExternalStore` under the hood for React 18+ compatibility. No tearing in concurrent rendering.
- **Cleanup on unmount.** The subscription is automatically removed when the component unmounts. No memory leaks.
- **StrictMode safe.** Works correctly with `React.StrictMode` double-mount behavior.

### Query Variations

```tsx
// All records in a collection
const allTodos = useQuery(app.todos)

// Filtered
const active = useQuery(app.todos.where({ completed: false }))

// Sorted
const sorted = useQuery(app.todos.orderBy('createdAt', 'desc'))

// Limited
const recent = useQuery(
  app.todos.orderBy('createdAt', 'desc').limit(5)
)

// Combined
const topActive = useQuery(
  app.todos
    .where({ completed: false })
    .orderBy('priority', 'desc')
    .limit(10)
)

// With relations
const todosWithProject = useQuery(
  app.todos.where({ completed: false }).include('project')
)
```

### Avoiding Unnecessary Re-renders

The query object passed to `useQuery` should be stable across renders. If you construct a new query object on every render, wrap it in `useMemo`:

```tsx
function TodoList({ userId }: { userId: string }) {
  const query = useMemo(
    () => app.todos.where({ assignee: userId }),
    [userId]
  )
  const todos = useQuery(query)

  return /* ... */
}
```

## useMutation

`useMutation` returns a mutation object with `mutate` (fire-and-forget), `mutateAsync` (awaitable), `reset`, and the `isLoading` and `error` state fields.

```tsx
import { useMutation } from '@korajs/react'
import { app } from './app'

function AddTodo() {
  const addTodo = useMutation(app.todos.insert)

  return (
    <button onClick={() => addTodo.mutate({ title: 'New task' })}>
      Add Task
    </button>
  )
}
```

### Key Behaviors

- **Fire-and-forget.** `mutate(...)` returns nothing. The local store updates instantly and any reactive queries re-render.
- **Optimistic.** The data appears in the UI before it syncs to the server.
- **Offline safe.** Mutations work regardless of network state. Operations queue for sync.

### Result Properties

| Property | Type | Description |
|----------|------|-------------|
| `mutate` | `(...args) => void` | Fire-and-forget trigger. Does not return a promise. |
| `mutateAsync` | `(...args) => Promise<TData>` | Awaitable trigger. Resolves with the write result. |
| `reset` | `() => void` | Clears `error` and `isLoading` back to their initial state. |
| `isLoading` | `boolean` | `true` while an async mutation is in flight. |
| `error` | `Error \| null` | The last error thrown by `mutateAsync`, or `null`. |

### Mutation Types

```tsx
// Insert
const addTodo = useMutation(app.todos.insert)
addTodo.mutate({ title: 'New task', completed: false })

// Update
const updateTodo = useMutation(app.todos.update)
updateTodo.mutate('record-id', { completed: true })

// Delete
const deleteTodo = useMutation(app.todos.delete)
deleteTodo.mutate('record-id')
```

### Awaiting Mutations

If you need to wait for the local write to complete (e.g., to get the generated ID), use `mutateAsync`:

```tsx
const addTodo = useMutation(app.todos.insert)

async function handleAdd() {
  const todo = await addTodo.mutateAsync({ title: 'New task' })
  console.log(todo.id) // the generated UUID
}
```

## useSyncStatus

`useSyncStatus` provides real-time sync state for building status indicators.

```tsx
import { useSyncStatus } from '@korajs/react'

function SyncIndicator() {
  const status = useSyncStatus()

  switch (status.status) {
    case 'synced':
      return <span>All changes saved</span>
    case 'syncing':
      return <span>Syncing...</span>
    case 'offline':
      return <span>Working offline</span>
    case 'error':
      return <span>Sync error - retrying</span>
    case 'clock-error':
      return <span>Clock integrity blocked</span>
    case 'schema-mismatch':
      return <span>Server schema mismatch</span>
    case 'connected':
      return <span>Connected</span>
  }
}
```

### Status Properties

| Property | Type | Description |
|----------|------|-------------|
| `status` | `'connected' \| 'syncing' \| 'synced' \| 'offline' \| 'error' \| 'clock-error' \| 'schema-mismatch'` | Current sync state |
| `pendingOperations` | `number` | Number of operations not yet sent to server |
| `lastSyncedAt` | `number \| null` | Timestamp of last successful sync (`null` if never synced) |
| `lastSuccessfulPush` | `number \| null` | Timestamp of last successful push to the server |
| `lastSuccessfulPull` | `number \| null` | Timestamp of last successful pull from the server |
| `conflicts` | `number` | Merge conflicts encountered this session |
| `clockSkewMs` | `number \| null` | `serverTime - localTime` in ms at the last handshake. Negative means this device's clock is fast. |

`useSyncStatus` only re-renders when the status object changes, not on every sync event. This keeps the component efficient.

### Pending Operations Counter

Show users how many changes are waiting to sync:

```tsx
function PendingBadge() {
  const { pendingOperations } = useSyncStatus()

  if (pendingOperations === 0) return null

  return (
    <span className="badge">
      {pendingOperations} pending
    </span>
  )
}
```

## useCollection

`useCollection` provides direct access to a collection's API within a component. This is useful when you need multiple operations on the same collection:

```tsx
import { useCollection } from '@korajs/react'

function TodoManager() {
  const todos = useCollection('todos')

  async function handleAdd() {
    await todos.insert({ title: 'New task' })
  }

  async function handleComplete(id: string) {
    await todos.update(id, { completed: true })
  }

  async function handleDelete(id: string) {
    await todos.delete(id)
  }

  return /* ... */
}
```

## useRichText

`useRichText` binds a `t.richtext()` field to a rich text editor. Its first argument is the collection **name** (a string), followed by the record ID and field name. It returns the shared Yjs document plus undo/redo controls, readiness state, and collaborative cursor helpers.

```tsx
import { useRichText } from '@korajs/react'

function NoteEditor({ todoId }: { todoId: string }) {
  const { doc, text, ready } = useRichText('todos', todoId, 'notes')

  // Pass `doc` to your editor (e.g., TipTap, Slate, ProseMirror).
  // Kora keeps the document synced; there is no separate provider to wire up.
  if (!ready) return <span>Loading...</span>

  return <YourEditor doc={doc} />
}
```

### Result Properties

| Property | Type | Description |
|----------|------|-------------|
| `doc` | `Y.Doc` | The shared Yjs document to hand to your editor binding. |
| `text` | `Y.Text` | The bound `Y.Text` for the field. |
| `undo` / `redo` | `() => void` | Undo/redo scoped to this field's edits. |
| `canUndo` / `canRedo` | `boolean` | Whether an undo/redo step is available. |
| `ready` | `boolean` | `true` once the document has loaded from the store. |
| `error` | `Error \| null` | Load or binding error, if any. |
| `cursors` | `CursorInfo[]` | Remote collaborators' cursor positions. |
| `setCursor` / `clearCursor` | `(anchor, head) => void` / `() => void` | Publish or clear this client's cursor. |

### With TipTap

```tsx
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Collaboration from '@tiptap/extension-collaboration'
import { useRichText } from '@korajs/react'

function NoteEditor({ todoId }: { todoId: string }) {
  const { doc } = useRichText('todos', todoId, 'notes')

  const editor = useEditor({
    extensions: [
      StarterKit,
      Collaboration.configure({ document: doc }),
    ],
  })

  return <EditorContent editor={editor} />
}
```

## Complete Example

Here is a full todo app using all the hooks together:

```tsx
import {
  KoraProvider,
  useQuery,
  useMutation,
  useSyncStatus,
} from '@korajs/react'
import { app } from './app'

function App() {
  return (
    <KoraProvider app={app}>
      <header>
        <h1>Todos</h1>
        <SyncIndicator />
      </header>
      <AddTodo />
      <TodoList />
    </KoraProvider>
  )
}

function SyncIndicator() {
  const status = useSyncStatus()

  if (status.status === 'offline') {
    return <span>Offline - changes will sync later</span>
  }
  if (status.pendingOperations > 0) {
    return <span>Syncing {status.pendingOperations} changes...</span>
  }
  return <span>Synced</span>
}

function AddTodo() {
  const addTodo = useMutation(app.todos.insert)

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = e.currentTarget
    const title = new FormData(form).get('title') as string
    if (title.trim()) {
      addTodo.mutate({ title: title.trim() })
      form.reset()
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <input name="title" placeholder="What needs to be done?" />
      <button type="submit">Add</button>
    </form>
  )
}

function TodoList() {
  const todos = useQuery(
    app.todos.where({ completed: false }).orderBy('createdAt')
  )
  const updateTodo = useMutation(app.todos.update)
  const deleteTodo = useMutation(app.todos.delete)

  return (
    <ul>
      {todos.map((todo) => (
        <li key={todo.id}>
          <input
            type="checkbox"
            checked={todo.completed}
            onChange={() =>
              updateTodo.mutate(todo.id, { completed: !todo.completed })
            }
          />
          <span>{todo.title}</span>
          <button onClick={() => deleteTodo.mutate(todo.id)}>Delete</button>
        </li>
      ))}
    </ul>
  )
}
```

Every piece of this example works offline. Data loads instantly, mutations are optimistic, and sync happens automatically in the background.

## Presence Hooks

For collaborative features, Kora provides hooks that share ephemeral user state (presence) across connected clients.

### `usePresence(user)`

Broadcasts the current user's presence to all connected clients. Cleans up automatically on unmount.

```tsx
import { usePresence } from '@korajs/react'

function Editor() {
  usePresence({
    name: 'Alice',
    color: '#e91e63',
    avatar: 'https://example.com/alice.png',  // optional
  })

  return <div>...</div>
}
```

Pass `null` to clear presence (e.g., when the user is idle).

### `useCollaborators()`

Returns a reactive list of all connected collaborators and their presence state:

```tsx
import { useCollaborators } from '@korajs/react'

function ActiveUsers() {
  const collaborators = useCollaborators()

  return (
    <div className="avatars">
      {collaborators.map((c) => (
        <span
          key={c.user.name}
          style={{ borderColor: c.user.color }}
          title={c.user.name}
        >
          {c.user.name[0]}
        </span>
      ))}
    </div>
  )
}
```

Each collaborator is an `AwarenessState` with two fields:

| Property | Type | Description |
|----------|------|-------------|
| `user` | `AwarenessUser` | Name, color, and optional avatar |
| `cursor` | `AwarenessCursor \| undefined` | Cursor position, present only while the collaborator is editing a field |

See the [Presence guide](/guide/presence) for a full walkthrough.
