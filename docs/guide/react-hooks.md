# React Hooks

Kora provides first-class React bindings through the `@kora/react` package. All hooks are designed for offline-first: data loads synchronously from the local store, mutations are optimistic, and reactive queries update in real time.

## Installation

```bash
pnpm add @kora/react
```

## KoraProvider

Wrap your app with `KoraProvider` to make the Kora app instance available to all hooks:

```tsx
import { KoraProvider } from '@kora/react'
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
import { useQuery } from '@kora/react'
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

`useMutation` returns a function that performs an optimistic mutation.

```tsx
import { useMutation } from '@kora/react'
import { app } from './app'

function AddTodo() {
  const addTodo = useMutation(app.todos.insert)

  return (
    <button onClick={() => addTodo({ title: 'New task' })}>
      Add Task
    </button>
  )
}
```

### Key Behaviors

- **Fire-and-forget.** The mutation function does not return a promise by default. The local store updates instantly and any reactive queries re-render.
- **Optimistic.** The data appears in the UI before it syncs to the server.
- **Offline safe.** Mutations work regardless of network state. Operations queue for sync.

### Mutation Types

```tsx
// Insert
const addTodo = useMutation(app.todos.insert)
addTodo({ title: 'New task', completed: false })

// Update
const updateTodo = useMutation(app.todos.update)
updateTodo('record-id', { completed: true })

// Delete
const deleteTodo = useMutation(app.todos.delete)
deleteTodo('record-id')
```

### Awaiting Mutations

If you need to wait for the local write to complete (e.g., to get the generated ID):

```tsx
const addTodo = useMutation(app.todos.insert)

async function handleAdd() {
  const todo = await addTodo({ title: 'New task' })
  console.log(todo.id) // the generated UUID
}
```

## useSyncStatus

`useSyncStatus` provides real-time sync state for building status indicators.

```tsx
import { useSyncStatus } from '@kora/react'

function SyncIndicator() {
  const status = useSyncStatus()

  switch (status.state) {
    case 'synced':
      return <span>All changes saved</span>
    case 'syncing':
      return <span>Syncing...</span>
    case 'offline':
      return <span>Working offline</span>
    case 'error':
      return <span>Sync error - retrying</span>
    case 'connected':
      return <span>Connected</span>
  }
}
```

### Status Properties

| Property | Type | Description |
|----------|------|-------------|
| `state` | `'connected' \| 'syncing' \| 'synced' \| 'offline' \| 'error'` | Current sync state |
| `pendingOperations` | `number` | Number of operations not yet sent to server |
| `lastSyncedAt` | `number \| null` | Timestamp of last successful sync |

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
import { useCollection } from '@kora/react'

function TodoManager() {
  const todos = useCollection(app.todos)

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

`useRichText` binds a `t.richtext()` field to a rich text editor. It returns the Yjs document and a binding helper.

```tsx
import { useRichText } from '@kora/react'

function NoteEditor({ todoId }: { todoId: string }) {
  const { doc, provider } = useRichText(app.todos, todoId, 'notes')

  // Pass `doc` to your editor (e.g., TipTap, Slate, ProseMirror)
  // The `provider` handles syncing the Yjs document

  return <YourEditor doc={doc} />
}
```

### With TipTap

```tsx
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Collaboration from '@tiptap/extension-collaboration'
import { useRichText } from '@kora/react'

function NoteEditor({ todoId }: { todoId: string }) {
  const { doc } = useRichText(app.todos, todoId, 'notes')

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
} from '@kora/react'
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

  if (status.state === 'offline') {
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
      addTodo({ title: title.trim() })
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
              updateTodo(todo.id, { completed: !todo.completed })
            }
          />
          <span>{todo.title}</span>
          <button onClick={() => deleteTodo(todo.id)}>Delete</button>
        </li>
      ))}
    </ul>
  )
}
```

Every piece of this example works offline. Data loads instantly, mutations are optimistic, and sync happens automatically in the background.
