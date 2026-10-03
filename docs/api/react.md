---
title: React API
description: "@korajs/react API reference: KoraProvider, useQuery, useQueryState, useMutation, useSyncStatus, createKoraHooks, useRichText, usePresence, and useCollaborators."
---

# React API Reference

`@korajs/react` provides React hooks and components for building reactive offline-first UIs. All hooks are concurrent-mode safe (using `useSyncExternalStore` with stable `subscribe`/`getSnapshot`, so renders never tear), compatible with React.StrictMode, re-render only when their value changes, and render on the server (`renderToString`, Next.js App Router) with empty values. See [Server rendering and Next.js](/guide/nextjs-app-router).

```typescript
import {
  KoraProvider,
  createKoraHooks,
  useQuery,
  useQueryState,
  useMutation,
  useSyncStatus,
  useCollection,
  useRichText,
  usePresence,
  useCollaborators,
} from '@korajs/react'
```

---

## KoraProvider

Context provider that makes the Kora app instance available to all hooks in the component tree. Must wrap any component that uses Kora hooks.

### Props

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `app` | `KoraApp` | One of `app` / `store` | The app instance returned by `createApp()`. Children render once `app.ready` resolves. |
| `store` | `Store` | One of `app` / `store` | Advanced: an opened store (with optional `syncEngine`) instead of an app. Children render immediately. |
| `fallback` | `ReactNode` | No | Rendered until `app.ready` resolves, and during a server render (where the app is inert). |
| `children` | `ReactNode` | Yes | Child components. |

### Example

```tsx
import { createApp, defineSchema, t } from 'korajs'
import { KoraProvider } from '@korajs/react'

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

::: tip Server rendering
A module-scope `createApp` evaluated during a server render (no `window`) is inert: it opens no database and `<KoraProvider app={app}>` renders its `fallback`. The client then hydrates the same fallback and fills in local data. See [Server rendering and Next.js](/guide/nextjs-app-router).
:::

---

## useQuery()

Returns a reactive array of records matching a query. The component re-renders automatically whenever the result set changes due to local mutations or incoming sync operations.

### Signature

```typescript
function useQuery<T = CollectionRecord>(
  query: QueryBuilder<T>,
  options?: { enabled?: boolean; throwOnError?: boolean },
): readonly T[]
```

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `query` | `QueryBuilder<T>` | A query built using collection methods (`.where()`, `.orderBy()`, etc.). A new builder with the same descriptor on each render is fine: the hook keys on the descriptor. |
| `options.enabled` | `boolean` | When `false`, no subscription is made and the hook returns `[]`. Defaults to `true`. |
| `options.throwOnError` | `boolean` | When `true` (default), a failed query is thrown to the nearest error boundary. When `false`, the hook keeps returning the last good rows; read the error with [`useQueryState`](#usequerystate). |

### Returns

`readonly T[]` -- The records matching the query, the same array until the result changes. Returns an empty array if no records match, and during a server render or hydration.

Data is always returned synchronously from the local store. There is no loading state for local data.

### Errors

A query that fails (for example a `where` or `orderBy` on a field that does not exist) is not swallowed into an empty list. `useQuery` throws it to the nearest [error boundary](https://react.dev/reference/react/Component#catching-rendering-errors-with-an-error-boundary); the store also emits it as a `query:error` event for DevTools. To handle it inline, use `useQueryState` or pass `throwOnError: false`.

### Example

```tsx
import { useQuery } from '@korajs/react'

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
- `subscribe` and `getSnapshot` are stable: React subscribes once per query, not once per render, and the component re-renders only when the result set changes, not on every sync event.
- Identical queries in different components share one subscription.
- Works correctly with React.StrictMode (double-mount safe).
- On the server and during hydration it returns `[]`, so server HTML and the first client render agree; the rows arrive right after hydration.

---

## useQueryState()

Like `useQuery`, but returns the query's error instead of throwing it, and whether the first result has arrived.

```typescript
function useQueryState<T = CollectionRecord>(
  query: QueryBuilder<T>,
  options?: { enabled?: boolean },
): { data: readonly T[]; error: Error | null; ready: boolean }
```

The returned object keeps its identity until `data`, `error` or `ready` changes. `error` clears when results flow again; `data` keeps the last good rows meanwhile. `ready` is `false` until the first result of the current query (always `false` on the server).

```tsx
function TodoList() {
  const { data: todos, error } = useQueryState(app.todos.where({ completed: false }))
  if (error) return <p role="alert">Could not load todos: {error.message}</p>
  return <ul>{todos.map((t) => <li key={t.id}>{t.title}</li>)}</ul>
}
```

---

## useMutation()

Returns a mutation function for performing write operations. Mutations are optimistic by default -- the local store is updated immediately, and the operation is queued for sync.

### Signature

```typescript
function useMutation<TData, TArgs extends unknown[], TContext = void>(
  fn: (...args: TArgs) => Promise<TData>,
  options?: {
    onMutate?: (...args: TArgs) => TContext | Promise<TContext>
    onRollback?: (context: TContext, ...args: TArgs) => void | Promise<void>
    onSuccess?: (data: TData, ...args: TArgs) => void
    onError?: (error: Error, ...args: TArgs) => void
    onSettled?: (data: TData | undefined, error: Error | null, ...args: TArgs) => void
  },
): {
  mutate: (...args: TArgs) => void
  mutateAsync: (...args: TArgs) => Promise<TData>
  isLoading: boolean
  error: Error | null
  reset: () => void
}
```

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `fn` | `(input: TInput) => Promise<TOutput>` | A collection method such as `app.todos.insert` or a custom function that performs mutations. |

### Returns

| Property | Type | Description |
|----------|------|-------------|
| `mutate` | `(...args: TArgs) => void` | Fire-and-forget mutation. Does not return a promise. |
| `mutateAsync` | `(...args: TArgs) => Promise<TData>` | Awaitable mutation. Resolves when the operation is persisted locally. |
| `isLoading` | `boolean` | `true` while a mutation is running. |
| `error` | `Error \| null` | The last mutation's error, or `null`. |
| `reset` | `() => void` | Clears `error`. |

`mutate`, `mutateAsync` and `reset` keep their identity for the component's lifetime, so they are safe in effect dependency arrays and as props of memoized children. The result object only changes when `isLoading` or `error` changes. The latest `fn` and `options` are always used, even though the callbacks are stable.

### Example

```tsx
import { useMutation } from '@korajs/react'

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

## `AuthBoundKoraProvider`

Owns authenticated app creation and teardown on shared browsers. It removes the previous provider
tree and awaits `app.close()` before creating a different user's app. Same-user token refreshes do
not replace the app.

```tsx
<AuthBoundKoraProvider
  authClient={binding}
  createApp={createAppForSession}
  signedOut={<SignIn />}
  fallback={<OpeningWorkspace />}
  error={({ error, retry, session }) => (
    <WorkspaceOpenError code={error.code} userId={session.userId} onRetry={retry} />
  )}
>
  <AuthenticatedApp />
</AuthBoundKoraProvider>
```

The renderer receives a stable code, sanitized primitive metadata, and a token-free session with
only `userId`. `retry()` uses the provider's serialized transition queue and closes partial resources
before opening exactly one replacement. Omitting `error` retains the default framework view.

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
| `status` | `SyncStatus` | Compatible high-level connection state, including `auth-required`. |
| `phase` | `SyncPhase` | Detailed suspended/offline/connecting/handshaking/uploading/receiving/applying/streaming/blocked phase. |
| `pendingOperations` | `number` | Number of local operations waiting to be sent to the server. |
| `inFlightUploadOperations` | `number` | Operations sent but not yet acknowledged. |
| `activeViewComplete` | `boolean` | Whether the active downlink view is applied through the accepted frontier. |
| `blockedFailure` | `ActiveApplyFailure \| null` | Current delivery-blocking apply failure. |
| `lastSyncedAt` | `number \| null` | Timestamp (milliseconds) of the last successful sync. `null` if never synced. |
| `heldOperations` | `number` | Unsynced writes of another user who shared this local database. They wait (not counted in `pendingOperations`) until that user signs in again on this device. |
| `heldNodes` | `HeldNodeInfo[]` | The local nodes holding those writes, with `operationCount`, `reason` (`'other-user'` or `'unassigned'`) and `principal`. Resolve `unassigned` ones with `app.sync.assignHeld` or `app.sync.discardHeld`. |
| `localDurability` | `'durable' \| 'degraded'` | `'degraded'` when the local database could not be persisted several times in a row (storage quota, broken IndexedDB). Warn the user to free up storage and stay online. |
| `serverProtocolVersion` | `number \| null` | Sync protocol version of the server in the current or last session; `null` before any server answered. |
| `protocolDeprecated` | `boolean` | `true` when the server speaks an older sync protocol than this client (a pre-beta.13 server). Sync still works, but upgrade the server: a later release refuses that protocol. |

The returned object keeps its identity while the status is unchanged, and so do its nested `heldNodes`, `initialSync` and `blockedFailure` values when only other fields change, so all of them are safe as effect or memo dependencies. Before the component mounts, and on the server, the status is `'offline'`.

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
import { useSyncStatus } from '@korajs/react'

function StorageWarning() {
  const { localDurability, heldOperations } = useSyncStatus()
  if (localDurability === 'degraded') return <p role="alert">Storage is full: stay online until it syncs.</p>
  if (heldOperations > 0) return <p>{heldOperations} changes from another account wait on this device.</p>
  return null
}

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

## createKoraHooks()

Creates hooks typed for your app, so components get schema-checked collection names, inserts, updates and query rows without passing generics around. Call it once next to `createApp`; nothing runs at call time.

```typescript
function createKoraHooks<TApp>(): {
  useApp: () => TApp
  useCollection: <N extends AppCollectionName<TApp>>(name: N) => AppCollections<TApp>[N]
  useQuery: typeof useQuery
  useQueryState: typeof useQueryState
  useMutation: typeof useMutation
  useSyncStatus: typeof useSyncStatus
}
```

```tsx
// kora.ts
import { createApp } from 'korajs'
import { createKoraHooks } from 'korajs/react'

export const app = createApp({ schema })
export const { useCollection, useQuery, useMutation } = createKoraHooks<typeof app>()

// TodoList.tsx
function TodoList() {
  const todos = useCollection('todos')                    // 'todoz' is a type error
  const rows = useQuery(todos.where({ completed: false })) // rows: readonly Todo[]
  const { mutate: add } = useMutation(todos.insert)        // add({ title: 1 }) is a type error
  return <button onClick={() => add({ title: 'New' })}>Add ({rows.length})</button>
}
```

The typed `useCollection` returns the app's own accessor (`app.collections[name]`), the same object across renders. The types are read from `typeof app`, so they follow whatever `createApp` infers from your schema. The helper types `AppCollectionName<TApp>`, `AppCollections<TApp>` and `AppRecord<TApp, Name>` are exported too.

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
import { useCollection } from '@korajs/react'

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
  collection: string,
  recordId: string,
  field: string,
  options?: { user?: AwarenessUser; useDocChannel?: boolean },
): UseRichTextResult
```

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `collection` | `string` | Collection containing the record. |
| `recordId` | `string` | ID of the record containing the rich text field. |
| `field` | `string` | Name of the `t.richtext()` field on the record. |
| `options.user` | `AwarenessUser` | Identity shown with this user's cursor. |
| `options.useDocChannel` | `boolean` | Force the incremental document channel on or off. |

### Returns

#### UseRichTextResult

| Property | Type | Description |
|----------|------|-------------|
| `doc` | `Y.Doc` | The Yjs document. Pass it to your editor's Yjs binding. |
| `text` | `Y.Text` | The document's text (`doc.getText('content')`). |
| `ready` | `boolean` | `false` while the Yjs state is being loaded from storage. |
| `error` | `Error \| null` | Load failure, if any. |
| `undo` / `redo` | `() => void` | Local undo and redo. Stable identities. |
| `canUndo` / `canRedo` | `boolean` | Whether undo / redo is possible. |
| `cursors` | `CursorInfo[]` | Remote collaborators' cursors in this field. |
| `setCursor` / `clearCursor` | functions | Publish or clear the local cursor. Stable identities. |

The result object keeps its identity until one of its values changes.

### Example with TipTap

```tsx
import { useRichText } from '@korajs/react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Collaboration from '@tiptap/extension-collaboration'

function NoteEditor({ noteId }: { noteId: string }) {
  const { doc, ready } = useRichText('notes', noteId, 'content')

  const editor = useEditor({
    extensions: [
      StarterKit,
      Collaboration.configure({ document: doc, field: 'content' }),
    ],
  }, [doc])

  if (!ready) return <div>Loading editor...</div>

  return <EditorContent editor={editor} />
}
```

### Behavior

- The Yjs state is loaded from the local store on mount.
- Changes to the Yjs document are automatically persisted and synced.
- When multiple devices edit the same rich text field concurrently, Yjs handles character-level merging automatically.
- The hook cleans up the Yjs binding on unmount.

---

## usePresence()

Sets the local user's collaborative presence state. When this hook is active, other connected clients will see this user's presence information (name, color, and optional avatar). Presence is ephemeral -- it is not persisted, only shared with currently connected peers.

Automatically clears presence on unmount.

### Signature

```typescript
function usePresence(
  user: { name: string; color: string; avatar?: string } | null,
): void
```

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `user` | `{ name: string; color: string; avatar?: string } \| null` | User identity for presence display. Pass `null` to clear presence. |

| User Property | Type | Required | Description |
|---------------|------|----------|-------------|
| `name` | `string` | Yes | Display name shown to other collaborators. |
| `color` | `string` | Yes | Hex color for cursor/avatar rendering (e.g., `'#e91e63'`). |
| `avatar` | `string` | No | URL to an avatar image. |

### Example

```tsx
import { usePresence } from '@korajs/react'

function Editor({ currentUser }: { currentUser: { name: string; color: string } }) {
  // Set presence when this component mounts, clear on unmount
  usePresence({ name: currentUser.name, color: currentUser.color })

  return <div>Editing document...</div>
}
```

### Conditional presence

Pass `null` to disable presence broadcasting without unmounting the component:

```tsx
function CollaborativeEditor({ user, isActive }: { user: User; isActive: boolean }) {
  usePresence(isActive ? { name: user.name, color: user.color } : null)

  return <div>...</div>
}
```

### Behavior

- Requires a sync engine to be configured (via `sync.url` in `createApp`). If no sync engine is available, the hook is a no-op.
- Presence state is set on the sync engine's `AwarenessManager`, which broadcasts it to all connected peers.
- Presence is automatically cleared when the component unmounts.
- Changing the `user` properties causes the presence state to be updated.

---

## useCollaborators()

Returns all currently connected collaborators' awareness states. Excludes the local user -- only returns remote peers. Re-renders only when the set of collaborators or their states change.

### Signature

```typescript
function useCollaborators(): AwarenessState[]
```

### Returns

`AwarenessState[]` -- An array of awareness states for all connected remote users. Returns an empty array if no peers are connected or sync is not configured.

#### AwarenessState

```typescript
interface AwarenessState {
  /** User identity information */
  user: {
    /** Display name */
    name: string
    /** Hex color for cursor/selection rendering */
    color: string
    /** Optional avatar URL */
    avatar?: string
  }

  /** Current cursor position, if any */
  cursor?: {
    /** Collection containing the record being edited */
    collection: string
    /** ID of the record being edited */
    recordId: string
    /** Field name of the richtext field */
    field: string
    /** Cursor anchor position (start of selection) */
    anchor: number
    /** Cursor head position (end of selection) */
    head: number
  }
}
```

### Example

```tsx
import { useCollaborators } from '@korajs/react'

function CollaboratorList() {
  const collaborators = useCollaborators()

  if (collaborators.length === 0) {
    return <span>No one else is here</span>
  }

  return (
    <div className="collaborators">
      {collaborators.map((c) => (
        <span
          key={c.user.name}
          className="collaborator-badge"
          style={{ backgroundColor: c.user.color }}
          title={c.user.name}
        >
          {c.user.avatar ? (
            <img src={c.user.avatar} alt={c.user.name} />
          ) : (
            c.user.name[0]
          )}
        </span>
      ))}
    </div>
  )
}
```

### Combined presence and collaborators

A typical pattern uses both hooks together:

```tsx
import { usePresence, useCollaborators } from '@korajs/react'

function CollaborativeDocument({ currentUser }: { currentUser: User }) {
  // Announce our presence
  usePresence({ name: currentUser.name, color: currentUser.color })

  // See who else is here
  const collaborators = useCollaborators()

  return (
    <div>
      <header>
        <span>{collaborators.length} other editor{collaborators.length !== 1 ? 's' : ''} online</span>
        <div className="avatars">
          {collaborators.map((c) => (
            <span key={c.user.name} style={{ color: c.user.color }}>
              {c.user.name}
            </span>
          ))}
        </div>
      </header>
      <Editor />
    </div>
  )
}
```

### Behavior

- Uses `useSyncExternalStore` internally for concurrent-mode safety (no tearing).
- Only re-renders when the collaborator list actually changes (deep comparison via JSON serialization).
- Renders `[]` on the server and during hydration.
- Returns an empty array if the sync engine is not configured or not connected.
- Automatically subscribes to the sync engine's `AwarenessManager` on mount and unsubscribes on unmount.
- Works correctly with React.StrictMode (double-mount safe).

---

## Full application example

A complete example combining all hooks:

```tsx
import { createApp, defineSchema, t } from 'korajs'
import { KoraProvider, useQuery, useMutation, useSyncStatus } from '@korajs/react'

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
