# @korajs/react

React bindings for Kora.js: a provider, reactive queries, mutations, sync status, rich text and
presence. Hooks use `useSyncExternalStore`, so they are safe in concurrent rendering, StrictMode and
server rendering.

## Install

```bash
pnpm add korajs@beta @korajs/react@beta
```

## Usage

<!-- docs-check-prelude
import { createApp, defineSchema, t } from 'korajs'
const schema = defineSchema({
  version: 1,
  collections: { todos: { fields: { title: t.string(), completed: t.boolean().default(false), createdAt: t.timestamp().auto() } } },
})
const app = createApp({ schema })
-->

```tsx
import { createKoraHooks, KoraProvider } from '@korajs/react'

// Hooks typed by your schema
const { useCollection, useMutation, useQuery, useSyncStatus } = createKoraHooks<typeof app>()

export function Root() {
  return (
    <KoraProvider app={app} fallback={<p>Loading...</p>}>
      <TodoList />
    </KoraProvider>
  )
}

function TodoList() {
  const todos = useCollection('todos')
  const open = useQuery(todos.where({ completed: false }).orderBy('createdAt'))
  const addTodo = useMutation(todos.insert)
  const status = useSyncStatus()

  return (
    <>
      <button onClick={() => addTodo.mutate({ title: 'New todo' })}>Add</button>
      {addTodo.error && <p role="alert">{addTodo.error.message}</p>}
      <ul>
        {open.map((todo) => (
          <li key={todo.id}>{todo.title}</li>
        ))}
      </ul>
      <small>
        {status.status}, {status.pendingOperations} pending
      </small>
    </>
  )
}
```

- `KoraProvider` renders `fallback` until the local database is open.
- `useQuery` renders `[]` first and the rows right after mount, then re-renders only when the
  result changes. `useQueryState` returns `{ data, error, ready }`.
- `useMutation` returns `{ mutate, mutateAsync, isLoading, error, reset }`; writes land locally at
  once and upload in the background.
- `useSyncStatus()` returns the full status (`status`, `pendingOperations`, `lastSyncedAt`, ...)
  and re-renders only when it changes.
- `useRichText`, `usePresence`, `useCollaborators` and `AuthBoundKoraProvider` cover collaborative
  editing and per-user databases.

## Documentation

[React Hooks guide](https://korajs.dev/guide/react-hooks) and the
[React API reference](https://korajs.dev/api/react).

## License

MIT
