---
title: React Hooks
description: "Kora.js React bindings: KoraProvider, typed hooks with createKoraHooks, useQuery and useQueryState, useMutation, useSyncStatus, useRichText and presence."
---

# React Hooks

`@korajs/react` connects a Kora app to React (18 or later). Every hook reads through
`useSyncExternalStore`, so renders never tear under concurrent rendering, and every hook works
under `React.StrictMode` and in server rendering.

```bash
pnpm add korajs@beta @korajs/react@beta
```

The hooks are also re-exported from `korajs/react`.


## KoraProvider

Create the app once, at module scope, and wrap the tree with `KoraProvider`:

```tsx
import { KoraProvider } from '@korajs/react'
import { app } from './kora'

function Root({ children }: { children: React.ReactNode }) {
  return (
    <KoraProvider app={app} fallback={<p>Opening local database...</p>}>
      {children}
    </KoraProvider>
  )
}
```

`KoraProvider` renders `fallback` (or nothing) until `app.ready` resolves, then provides the app
to every hook below it. If `app.ready` rejects (for example storage cannot open), it renders the
error message in place of the children and logs it. Hooks throw when used outside a provider.

## Typed hooks: createKoraHooks

The plain hooks accept any collection name and return untyped records. For hooks that know your
schema, create them once next to the app:

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

export const { useApp, useCollection, useQuery, useQueryState, useMutation, useSyncStatus } =
  createKoraHooks<typeof app>()
```

`useCollection('todos')` then returns the typed accessor: an unknown collection name, an unknown
field in `insert` or `where`, and a wrong value type are compile errors, and rows are typed. The
accessor keeps its identity across renders. Nothing runs when `createKoraHooks` is called; the
hooks read the app from the nearest `KoraProvider`.

<!-- docs-check-prelude
import { createApp, defineSchema, t } from 'korajs'
export const app = createApp({
  schema: defineSchema({
    version: 1,
    collections: {
      projects: { fields: { name: t.string() } },
      todos: {
        fields: {
          title: t.string(),
          completed: t.boolean().default(false),
          priority: t.enum(['low', 'medium', 'high']).default('medium'),
          assignee: t.string().optional(),
          projectId: t.string().optional(),
          notes: t.richtext().optional(),
          createdAt: t.timestamp().auto(),
        },
      },
    },
    relations: {
      todoProject: { from: 'todos', to: 'projects', type: 'many-to-one', field: 'projectId', onDelete: 'set-null' },
    },
  }),
})
-->

## useQuery

`useQuery(query, options?)` subscribes to a query and re-renders when its result changes.

```tsx
import { useQuery } from '@korajs/react'

function TodoList() {
  const todos = useQuery(app.todos.where({ completed: false }).orderBy('createdAt'))
  return (
    <ul>
      {todos.map((todo) => (
        <li key={todo.id}>{todo.title}</li>
      ))}
    </ul>
  )
}
```

How it behaves:

- **First render.** The local query runs right after the component mounts, so the very first
  render returns an empty array and the rows follow immediately. On the server (and during
  hydration) it returns `[]`. Use `useQueryState` to tell "not loaded yet" from "no rows".
- **Re-renders only on change.** Results are diffed per field (structurally for arrays, objects,
  JSON, blobs and rich text), so a write that does not change this result does not re-render, and
  the returned array keeps its identity while the result is unchanged.
- **Query identity does not matter.** Queries are keyed by what they ask for, so building a new
  query object on every render is fine: no `useMemo` needed. Components that ask for the same
  query share one subscription.
- **Errors reach an error boundary.** A failing query (for example an `orderBy` on a field the
  store does not have) is thrown to the nearest React error boundary. Pass
  `{ throwOnError: false }` to keep the last good rows instead, and read the error with
  `useQueryState`.
- **`enabled: false`** pauses the query and returns `[]`.

Queries are built with the collection API, and in a typed app they are checked against the
schema:

```tsx
import { useQuery } from '@korajs/react'

function Examples({ userId }: { userId: string }) {
  const everything = useQuery(app.todos.where({}))
  const mine = useQuery(app.todos.where({ assignee: userId }).orderBy('createdAt', 'desc'))
  const urgent = useQuery(
    app.todos.where({ completed: false, priority: { $in: ['high', 'medium'] } }).limit(10),
  )
  const recent = useQuery(app.todos.where({ createdAt: { $gt: Date.now() - 86_400_000 } }))
  const withProject = useQuery(app.todos.where({ completed: false }).include('project'))
  return <p>{withProject[0]?.project?.name ?? everything.length + mine.length + urgent.length + recent.length}</p>
}
```

`createdAt` and `updatedAt` can always be filtered and sorted on, even when the schema does not
declare them. `include('project')` follows the `todos` to `projects` relation and adds a
`project` property (the parent, or `null`) to each row; including a one-to-many relation from the
parent side adds an array of children.

## useQueryState

`useQueryState(query, options?)` returns `{ data, error, ready }` instead of throwing:

```tsx
import { useQueryState } from '@korajs/react'

function SafeTodoList() {
  const { data: todos, error, ready } = useQueryState(app.todos.where({ completed: false }))
  if (error) return <p role="alert">{error.message}</p>
  if (!ready) return <p>Loading...</p>
  return <p>{todos.length} open</p>
}
```

`ready` is false until the first result of the current query has arrived (always false on the
server). While `error` is set, `data` holds the last good rows; the error clears when results flow
again. The object keeps its identity until one of the three changes.

## useMutation

`useMutation(fn, options?)` wraps a write. It returns
`{ mutate, mutateAsync, isLoading, error, reset }`:

```tsx
import { useMutation } from '@korajs/react'

function AddTodo() {
  const addTodo = useMutation(app.todos.insert)
  return <button onClick={() => addTodo.mutate({ title: 'New task' })}>Add task</button>
}
```

| Property | Type | Description |
|----------|------|-------------|
| `mutate` | `(...args) => void` | Fire and forget. The local write lands at once and queries re-render. |
| `mutateAsync` | `(...args) => Promise<TData>` | Awaitable; resolves with the write's result (the record for an insert). |
| `isLoading` | `boolean` | True while a call is in flight. |
| `error` | `Error \| null` | The last error, or `null`. |
| `reset` | `() => void` | Clears `error` and `isLoading`. |

`mutate`, `mutateAsync` and `reset` keep their identity for the component's lifetime, so they are
safe in effect dependencies and as memoized props; the result object changes only when
`isLoading` or `error` changes. The latest `fn` and options are always used. Options are the
lifecycle callbacks `onMutate`, `onRollback` (called with the `onMutate` context when the write fails), `onSuccess`, `onError` and `onSettled`.

```tsx
import { useMutation } from '@korajs/react'

function TodoActions({ id }: { id: string }) {
  const update = useMutation(app.todos.update)
  const remove = useMutation(app.todos.delete)
  const add = useMutation(app.todos.insert)

  async function duplicate(title: string) {
    const copy = await add.mutateAsync({ title })
    console.log(copy.id)
  }

  return (
    <>
      <button onClick={() => update.mutate(id, { completed: true })}>Done</button>
      <button onClick={() => remove.mutate(id)}>Delete</button>
      <button onClick={() => duplicate('Copy')}>Duplicate</button>
    </>
  )
}
```

Writes are local first: they work offline and upload when sync is connected.

## useSyncStatus

`useSyncStatus()` returns the sync status (`SyncStatusInfo`) and re-renders only when it changes.
The object, and its nested `heldNodes`, `initialSync` and `blockedFailure` values, keep their
identity while unchanged. Without sync configured (and on the server) it reports `offline`.

```tsx
import { useSyncStatus } from '@korajs/react'

function SyncIndicator() {
  const { status, pendingOperations, localDurability } = useSyncStatus()
  if (localDurability === 'degraded') return <span>Storage problem: stay online</span>
  switch (status) {
    case 'synced':
      return <span>All changes saved</span>
    case 'syncing':
      return <span>Syncing {pendingOperations} changes</span>
    case 'offline':
      return <span>Working offline</span>
    case 'reconnecting':
      return <span>Reconnecting</span>
    case 'auth-required':
      return <span>Sign in to sync</span>
    case 'encryption-locked':
      return <span>Unlock to sync</span>
    default:
      return <span>{status}</span>
  }
}
```

| Field | Description |
|-------|-------------|
| `status` | `connected`, `reconnecting`, `syncing`, `synced`, `offline`, `clock-error`, `error`, `schema-mismatch`, `auth-required` or `encryption-locked` |
| `phase`, `reason` | Finer state (`uploading`, `receiving`, `blocked`, ...) and why |
| `reconnecting` | True while the engine is re-establishing a session |
| `pendingOperations` | Local writes the server has not acknowledged yet |
| `lastSyncedAt`, `lastSuccessfulPush`, `lastSuccessfulPull` | Timestamps, or `null` |
| `conflicts` | Merge conflicts seen this session |
| `heldOperations`, `heldNodes` | Writes waiting for another user, or unassigned writes the app must assign or discard (see [Authentication](/guide/authentication#held-writes)) |
| `localDurability` | `'degraded'` when the local database cannot persist; uploads continue so the server keeps a copy |
| `serverProtocolVersion`, `protocolDeprecated` | The server's sync protocol, and whether it is older than the client's |
| `clockSkewMs` | Server time minus local time at the last handshake |
| `initialSync` | First-sync progress: `complete`, `receivedBatches`, `totalBatches`, `progress` |
| `deliveryWatermark`, `serverFrontier` | How far delivery has been applied, and how far the server is |
| `blockedFailure` | An inbound operation that blocks delivery, with its code |

## useCollection

`useCollection(name)` returns a collection accessor. The plain hook is untyped; the one from
`createKoraHooks` is typed (see above).

```tsx
import { useCollection } from '@korajs/react'

function ClearCompleted() {
  const todos = useCollection('todos')
  async function clear(ids: string[]) {
    for (const id of ids) await todos.delete(id)
  }
  return <button onClick={() => clear([])}>Clear completed</button>
}
```

## useRichText

`useRichText(collectionName, recordId, fieldName, options?)` binds a `t.richtext()` field to a
shared Yjs document. Kora keeps the document synced; there is no separate provider to wire up.

```tsx
import { useRichText } from '@korajs/react'

function NotesEditor({ todoId }: { todoId: string }) {
  const { text, ready, undo, canUndo } = useRichText('todos', todoId, 'notes')
  if (!ready) return <span>Loading...</span>
  return (
    <div>
      <p>{text.toString()}</p>
      <button disabled={!canUndo} onClick={undo}>Undo</button>
    </div>
  )
}
```

| Property | Description |
|----------|-------------|
| `doc`, `text` | The shared `Y.Doc` and the field's `Y.Text`, for your editor binding |
| `undo`, `redo`, `canUndo`, `canRedo` | Undo history of this field's local edits |
| `ready`, `error` | Loaded from the store; a load or binding error |
| `cursors`, `setCursor`, `clearCursor` | Remote collaborators' cursors, and this client's |

Options: `user` (name and color shown with this client's cursor) and `useDocChannel`. With TipTap,
pass `doc` to `Collaboration.configure({ document: doc })`.

## Presence

`usePresence(user)` broadcasts the current user's presence (`{ name, color, avatar? }`, or `null`
to clear it) while the component is mounted. `useCollaborators()` returns the connected
collaborators, each with `user` and, while they edit a field, `cursor`.

```tsx
import { useCollaborators, usePresence } from '@korajs/react'

function ActiveUsers({ me }: { me: { name: string; color: string } }) {
  usePresence(me)
  const collaborators = useCollaborators()
  return (
    <div>
      {collaborators.map((c) => (
        <span key={c.user.name} title={c.user.name} style={{ color: c.user.color }}>
          {c.user.name[0]}
        </span>
      ))}
    </div>
  )
}
```

See the [Presence guide](/guide/presence).

## Server rendering

All hooks render on the server: `useQuery` returns `[]`, `useQueryState` returns
`{ data: [], error: null, ready: false }`, `useSyncStatus` reports `offline`, `useMutation` is idle
and `useCollaborators` is empty. An app created where there is no `window` stays inert (no
database, no sync) and `KoraProvider` renders its fallback; the client takes over after
hydration with no mismatch. See [Next.js App Router](/guide/nextjs-app-router).
