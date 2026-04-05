# React API Reference

`@kora/react` provides React hooks and components for building reactive offline-first UIs. All hooks are concurrent-mode safe (using `useSyncExternalStore` internally) and compatible with React.StrictMode.

```typescript
import {
  KoraProvider,
  useQuery,
  useMutation,
  useSyncStatus,
  useCollection,
  useRichText,
} from '@kora/react'
```

---

## KoraProvider

Context provider that makes the Kora app instance available to all hooks in the component tree. Must wrap any component that uses Kora hooks.

### Props

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `app` | `KoraApp` | Yes | The app instance returned by `createApp()`. |
| `children` | `ReactNode` | Yes | Child components. |

### Example

```tsx
import { createApp, defineSchema, t } from 'kora'
import { KoraProvider } from '@kora/react'

const schema = defineSchema({
  version: 1,
  collections: {
    todos: {
      fields: {
        title: t.string(),
        completed: t.boolean().default(false),
      },
    },
  },
})

const app = createApp({ schema })

function App() {
  return (
    <KoraProvider app={app}>
      <TodoList />
    </KoraProvider>
  )
}
```

::: warning
Create the app instance outside of your component tree (e.g., in a module-level variable). Creating it inside a component would reinitialize the database on every render.
:::

---

## useQuery()

Returns a reactive array of records matching a query. The component re-renders automatically whenever the result set changes due to local mutations or incoming sync operations.

### Signature

```typescript
function useQuery<T extends CollectionRecord>(query: QueryBuilder<T>): T[]
```

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `query` | `QueryBuilder<T>` | A query built using collection methods (`.where()`, `.orderBy()`, etc.). |

### Returns

`T[]` -- An array of records matching the query. Returns an empty array if no records match.

Data is always returned synchronously from the local store. There is no loading state for local data.

### Example

```tsx
import { useQuery } from '@kora/react'

function TodoList() {
  const todos = useQuery(
    app.todos.where({ completed: false }).orderBy('createdAt', 'desc')
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

### With filtering

```tsx
function AssignedTodos({ userId }: { userId: string }) {
  const todos = useQuery(
    app.todos.where({ assignee: userId, completed: false }).orderBy('dueDate')
  )

  return <TodoTable todos={todos} />
}
```

### With relations

```tsx
function TodosWithProjects() {
  const todos = useQuery(
    app.todos.where({ completed: false }).include('project')
  )

  return todos.map((todo) => (
    <div key={todo.id}>
      {todo.title} - {todo.project?.name}
    </div>
  ))
}
```

### Behavior

- The callback is subscribed on mount and unsubscribed on unmount. No manual cleanup is needed.
- Uses `useSyncExternalStore` internally, so it is safe in React 18+ concurrent mode (no tearing).
- The component only re-renders when the result set actually changes (deep comparison), not on every sync event.
- Works correctly with React.StrictMode (double-mount safe).

---

## useMutation()

Returns a mutation function for performing write operations. Mutations are optimistic by default -- the local store is updated immediately, and the operation is queued for sync.

### Signature

```typescript
function useMutation<TInput, TOutput>(
  fn: (input: TInput) => Promise<TOutput>
): {
  mutate: (input: TInput) => void
  mutateAsync: (input: TInput) => Promise<TOutput>
}
```

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `fn` | `(input: TInput) => Promise<TOutput>` | A collection method such as `app.todos.insert` or a custom function that performs mutations. |

### Returns

| Property | Type | Description |
|----------|------|-------------|
| `mutate` | `(input: TInput) => void` | Fire-and-forget mutation. Does not return a promise. |
| `mutateAsync` | `(input: TInput) => Promise<TOutput>` | Awaitable mutation. Resolves when the operation is persisted locally. |

### Example

```tsx
import { useMutation } from '@kora/react'

function AddTodo() {
  const { mutate: addTodo } = useMutation(app.todos.insert)

  return (
    <button onClick={() => addTodo({ title: 'New todo' })}>
      Add Todo
    </button>
  )
}
```

### Update and delete

```tsx
function TodoItem({ todo }: { todo: Todo }) {
  const { mutate: updateTodo } = useMutation(
    (data: Partial<Todo>) => app.todos.update(todo.id, data)
  )
  const { mutate: deleteTodo } = useMutation(
    () => app.todos.delete(todo.id)
  )

  return (
    <div>
      <input
        type="checkbox"
        checked={todo.completed}
        onChange={() => updateTodo({ completed: !todo.completed })}
      />
      <span>{todo.title}</span>
      <button onClick={() => deleteTodo()}>Delete</button>
    </div>
  )
}
```

### Awaiting confirmation

When you need to confirm the operation was persisted before proceeding:

```tsx
function AddTodoForm() {
  const { mutateAsync: addTodo } = useMutation(app.todos.insert)
  const [title, setTitle] = useState('')

  const handleSubmit = async () => {
    const todo = await addTodo({ title })
    setTitle('')
    console.log('Created todo:', todo.id)
  }

  return (
    <form onSubmit={handleSubmit}>
      <input value={title} onChange={(e) => setTitle(e.target.value)} />
      <button type="submit">Add</button>
    </form>
  )
}
```

---

## useSyncStatus()

Returns the current sync connection status and metadata. Re-renders only when the status changes, not on every sync event.

### Signature

```typescript
function useSyncStatus(): SyncStatus
```

### Returns

#### SyncStatus

| Property | Type | Description |
|----------|------|-------------|
| `status` | `'connected' \| 'syncing' \| 'synced' \| 'offline' \| 'error'` | Current connection state. |
| `pendingOperations` | `number` | Number of local operations waiting to be sent to the server. |
| `lastSyncedAt` | `number \| null` | Timestamp (milliseconds) of the last successful sync. `null` if never synced. |

#### Status values

| Status | Description |
|--------|-------------|
| `'connected'` | WebSocket connection is open but initial sync has not completed. |
| `'syncing'` | Actively exchanging operations with the server. |
| `'synced'` | All local operations have been sent and acknowledged. Up to date. |
| `'offline'` | No connection to the server. The app continues to work locally. |
| `'error'` | A sync error occurred. Operations are queued and will retry. |

### Example

```tsx
import { useSyncStatus } from '@kora/react'

function SyncIndicator() {
  const { status, pendingOperations, lastSyncedAt } = useSyncStatus()

  return (
    <div>
      <span className={`status-${status}`}>
        {status === 'synced' && 'All changes saved'}
        {status === 'syncing' && 'Syncing...'}
        {status === 'offline' && 'Working offline'}
        {status === 'error' && 'Sync error'}
        {status === 'connected' && 'Connecting...'}
      </span>
      {pendingOperations > 0 && (
        <span>{pendingOperations} pending</span>
      )}
    </div>
  )
}
```

---

## useCollection()

Returns a typed collection accessor for performing operations on a specific collection. This is a convenience hook when you need the collection reference inside a component without importing the app instance directly.

### Signature

```typescript
function useCollection<T extends CollectionRecord>(name: string): CollectionAccessor<T>
```

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | `string` | Collection name as defined in the schema. |

### Returns

`CollectionAccessor<T>` -- A typed accessor with `insert`, `update`, `delete`, `findById`, `where`, and other query methods.

### Example

```tsx
import { useCollection } from '@kora/react'

function TodoActions() {
  const todos = useCollection('todos')

  const addTodo = async () => {
    await todos.insert({ title: 'New todo' })
  }

  const clearCompleted = async () => {
    const completed = await todos.where({ completed: true }).exec()
    for (const todo of completed) {
      await todos.delete(todo.id)
    }
  }

  return (
    <div>
      <button onClick={addTodo}>Add</button>
      <button onClick={clearCompleted}>Clear completed</button>
    </div>
  )
}
```

---

## useRichText()

Provides binding helpers for rich text fields backed by Yjs CRDTs. Returns the Yjs document and utility functions for integrating with rich text editors (e.g., TipTap, ProseMirror, Quill).

### Signature

```typescript
function useRichText(
  recordId: string,
  field: string
): RichTextBinding
```

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `recordId` | `string` | ID of the record containing the rich text field. |
| `field` | `string` | Name of the `t.richtext()` field on the record. |

### Returns

#### RichTextBinding

| Property | Type | Description |
|----------|------|-------------|
| `yText` | `Y.Text` | The Yjs `Y.Text` instance for this field. Pass this to your editor's Yjs binding. |
| `yDoc` | `Y.Doc` | The parent Yjs document. Needed by some editor bindings. |
| `isLoading` | `boolean` | `true` while the Yjs state is being loaded from storage. |
| `isEmpty` | `boolean` | `true` if the rich text field has no content. |

### Example with TipTap

```tsx
import { useRichText } from '@kora/react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Collaboration from '@tiptap/extension-collaboration'

function NoteEditor({ noteId }: { noteId: string }) {
  const { yText, yDoc, isLoading } = useRichText(noteId, 'content')

  const editor = useEditor({
    extensions: [
      StarterKit,
      Collaboration.configure({ document: yDoc, field: 'content' }),
    ],
  }, [yDoc])

  if (isLoading) return <div>Loading editor...</div>

  return <EditorContent editor={editor} />
}
```

### Behavior

- The Yjs state is loaded from the local store on mount.
- Changes to the Yjs document are automatically persisted and synced.
- When multiple devices edit the same rich text field concurrently, Yjs handles character-level merging automatically.
- The hook cleans up the Yjs binding on unmount.

---

## Full application example

A complete example combining all hooks:

```tsx
import { createApp, defineSchema, t } from 'kora'
import { KoraProvider, useQuery, useMutation, useSyncStatus } from '@kora/react'

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

const app = createApp({
  schema,
  sync: { url: 'wss://my-server.com/kora' },
})

function App() {
  return (
    <KoraProvider app={app}>
      <SyncIndicator />
      <AddTodo />
      <TodoList />
    </KoraProvider>
  )
}

function SyncIndicator() {
  const { status, pendingOperations } = useSyncStatus()
  return (
    <header>
      {status === 'offline' ? 'Working offline' : 'Connected'}
      {pendingOperations > 0 && ` (${pendingOperations} pending)`}
    </header>
  )
}

function AddTodo() {
  const { mutate: addTodo } = useMutation(app.todos.insert)
  const [title, setTitle] = useState('')

  return (
    <form onSubmit={(e) => { e.preventDefault(); addTodo({ title }); setTitle('') }}>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs to be done?" />
      <button type="submit">Add</button>
    </form>
  )
}

function TodoList() {
  const todos = useQuery(
    app.todos.where({ completed: false }).orderBy('createdAt', 'desc')
  )
  const { mutate: updateTodo } = useMutation(
    (args: { id: string; data: Partial<Todo> }) => app.todos.update(args.id, args.data)
  )

  return (
    <ul>
      {todos.map((todo) => (
        <li key={todo.id}>
          <input
            type="checkbox"
            checked={todo.completed}
            onChange={() => updateTodo({ id: todo.id, data: { completed: true } })}
          />
          {todo.title}
        </li>
      ))}
    </ul>
  )
}
```
