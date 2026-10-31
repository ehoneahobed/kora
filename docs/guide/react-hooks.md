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
    <KoraProvider app={app}>
      {children}
    </KoraProvider>
  )
}
```

`KoraProvider` renders its children at once, before the local database is open, so the first
paint is your real interface instead of a spinner. Hooks below it return empty values until the
store opens (`useQuery` returns `[]`; `useQueryState` reports `ready: false`), then fill in. If
`app.ready` rejects (for example storage cannot open), it renders the error message in place of
the children and logs it. Hooks throw when used outside a provider.

### Rendering before the store opens

The SQLite WASM and the rest of the store runtime load after the first paint. Until they are
open:

- `useQuery(app.todos.where(...))` works: the query is recorded and runs when the store opens.
  Render an empty state only when `useQueryState(...).ready` is true, so a first visit does not
  flash "No todos yet".
- Writes made through `useMutation` are accepted. They wait in memory, are saved to a small
  IndexedDB journal first, and are applied in order as soon as the store opens. Closing the tab
  in between does not lose them: the next visit applies what is left. The journal is per database
  and per signed-in user, and it is cleared as each write is applied.
- A write called directly (`await app.todos.insert(...)` outside a hook) still throws
  `AppNotReadyError` before `app.ready`: await `app.ready` first, or use `useMutation`.
- `app.todos.findById(...)` also throws before ready, because `null` would read as "no such
  record".

What is and is not saved to the journal:

- A write that uses atomic helpers (`op.increment`, `op.append`) waits in memory only: the
  helpers cannot be saved and would be wrong to apply twice.
- A write to a collection with a `t.secret()` field, and every write when `sync.encryption` is
  enabled, also waits in memory only. The journal holds the arguments as you gave them, before
  the store's at-rest transform (secret fields, end-to-end encryption) can run, and it must never
  hold plaintext the database would not. These writes are lost if the tab closes before the store
  opens.
- Each journaled write gets an identity (and an insert its record id and time) when the user acts.
  The store records that identity in the same transaction as the write, so a replay knows exactly
  whether the write already landed: a process that dies between applying a write and removing its
  entry, a removal that fails, or a late save never creates a second record or applies an update
  twice (which would revert a later edit). A write that did not land is applied as last-write-wins
  would have it at the time you acted: fields another tab or device wrote since are left alone,
  and a delete yields to a later write. An edit made on another device that has not synced here
  yet is not visible to the replay and loses to it.
- Writes held in memory only (atomic helpers, a `File` or binary value, a secret collection,
  encryption, or a journal that does not answer within 2 s) raise `journal:memory-only` and a
  one-time console warning, so the loss window is never silent.
- An entry written by another user waits for that user (it is never applied for someone else).
  One written before the app knew who was signed in is applied when the app has one database for
  the device (the sync layer holds such writes by their node: `sync.assignHeld` / `discardHeld`),
  and waits, reported on every start with `journal:write-failed`, when each user has a database of
  their own. Entries that wait show up in `useSyncStatus()` as `heldOperations` / `heldNodes`
  (`source: 'journal'`, with each write's collection, kind and time) so you can ask the user;
  `app.sync.assignHeld(nodeId, 'current-user')` applies an unassigned node and
  `app.sync.discardHeld(nodeId)` removes it (raising `journal:discarded` with the count). Writes
  still waiting in memory before the store opens count in `pendingOperations`. Writes a closed
  tab left without an owner are listed as soon as the journal has been read, while the store is
  still opening; the rest are judged when the signed-in user is known. Each node carries
  `oldestWrittenAt` (the age is `Date.now() - oldestWrittenAt`). When the signed-in user changes
  while the app is open, the unsent writes of the account that left are listed as writes of
  another account (`reason: 'other-user'`, `principal` is that account) and can be discarded with
  `app.sync.discardHeld(nodeId)`; they are applied the next time that account's database opens.
  Discarding removes the writes for good: they were never operations, so nothing else holds them.
  When the journal of a deleted database cannot be removed because another tab keeps it open, the
  delete is retried twice and then `journal:delete-blocked` is raised (the writes stay listed).
  Waiting writes never expire; only failed entries kept for inspection are removed after 30 days,
  announced with `journal:write-expired` (naming each) first. `deleteDatabase` raises
  `journal:discarded` with the number of unsent writes it throws away.
- If the store cannot open, waiting and later `useMutation` writes reject with
  `WRITE_NOT_APPLIED` (`mutate` shows the error instead of loading forever). The error says
  whether the write was saved for the next start (do not repeat it) or lost. Closing the app
  before the browser started it rejects them the same way.
- A recovered write that fails for a transient reason (storage busy or not durable) is tried again
  at the next start (five attempts at most, decided by the error code, never its message); any
  other failure marks the entry failed, raises the `journal:write-failed` event and keeps it for
  inspection (announced with `journal:write-expired` before it is removed after 30 days).
- A recovered write takes a fresh clock timestamp when it is applied, not the time you made it
  (the clock must stay monotonic, so it cannot be backdated). It is checked against the edits this
  device already holds (an update leaves out fields a later edit rewrote; a delete yields to a later
  write), but it beats an edit made on another device earlier that has not reached this one yet.
  Concretely: you rename a task offline in a tab that closes before the store opens, and a second
  device renames the same task a minute later. When the first device recovers the write it is
  stamped "now", so after both sync the first device's name wins, although the second device's edit
  happened later by the clock. Different fields of the same record never conflict this way.
  Only `t.timestamp().auto()` fields (like `createdAt`) keep the time you made the write.
- Order: what an earlier tab left is applied first, then this session's writes in call order.
  `app.transaction(...)`, `app.mutation(...)`, `app.sequences` and `app.blobs` wait for the store
  and run after the hook writes already queued, even when called first.
- Web Locks: where `navigator.locks` is missing (insecure HTTP), a tab cannot tell a slow live tab
  from a closed one and treats entries older than two minutes as abandoned; the idempotent replay
  above keeps that from creating duplicates. The per-session lock may keep a page out of the
  back/forward cache.
- `waitForStorage` restores the gate, but the store opens when the provider mounts rather than
  when the module is evaluated.

If a screen needs the real store before it renders anything (for example it reads
`app.getStore()`), pass `waitForStorage`: the provider then renders `fallback` until the store is
open, as it did before.

<!-- docs-check: skip fragment: the provider with the waitForStorage opt-out -->
```tsx
<KoraProvider app={app} waitForStorage fallback={<p>Opening local database...</p>}>
  {children}
</KoraProvider>
```

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
`{ mutate, mutateAsync, isLoading, error, rejected, reset }`:

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
| `rejected` | `MutationRejection \| null` | The latest server refusal of a write made by this hook, or `null`. |
| `reset` | `() => void` | Clears `error`, `rejected` and `isLoading`. |

`mutate`, `mutateAsync` and `reset` keep their identity for the component's lifetime, so they are
safe in effect dependencies and as memoized props; the result object changes only when
`isLoading` or `error` changes. The latest `fn` and options are always used. Options are the
lifecycle callbacks `onMutate`, `onRollback` (called with the `onMutate` context when the write fails), `onSuccess`, `onError`, `onSettled` and `onRejected` (below).

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

### When the server refuses a write

A write the sync server refuses later (a validator, an access rule, a constraint), even hours
later after an offline period, is reported to the hook that made it: `rejected` holds the reason
and `onRejected` is called, while the component is mounted. The device has already undone the
write (`rejected.reverted`).

```tsx
import { useMutation } from '@korajs/react'

function AddTodo() {
  const add = useMutation(app.todos.insert, {
    onRejected: (r) => console.warn(`Not saved: ${r.message}`),
  })
  // add.rejected: { code, message, collection, recordId, operationIds, reverted, args } | null
  return (
    <>
      <button onClick={() => add.mutate({ title: 'New task' })}>Add task</button>
      {add.rejected && <p role="alert">Undone: {add.rejected.message}</p>}
    </>
  )
}
```

A transaction is one write. Refusals that arrive after the component unmounted are still reported
by `app.on('sync:operation-rejected', ...)` and `app.sync.getRejectedOperations()`. Details:
[Rejected writes](/api/react#rejected-writes).

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
database, no sync) and `KoraProvider` renders its children with empty values (its `fallback`
with `waitForStorage`); the client takes over after hydration with no mismatch. See [Next.js App Router](/guide/nextjs-app-router).
