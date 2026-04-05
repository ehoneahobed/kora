# @korajs/react

React hooks and bindings for Kora.js. Reactive queries that update automatically, optimistic mutations, sync status tracking, and rich text editing support.

## Install

```bash
pnpm add korajs @korajs/react
```

## Usage

### Provider

```tsx
import { KoraProvider } from '@korajs/react'

function App() {
  return (
    <KoraProvider app={app}>
      <TodoList />
    </KoraProvider>
  )
}
```

### Reactive Queries

```tsx
import { useQuery } from '@korajs/react'

function TodoList() {
  const todos = useQuery(app.todos.where({ completed: false }).orderBy('createdAt'))
  // Always up to date. No loading state needed for local data.

  return todos.map((todo) => <TodoItem key={todo.id} todo={todo} />)
}
```

### Mutations

```tsx
import { useMutation } from '@korajs/react'

function AddTodo() {
  const addTodo = useMutation(app.todos.insert)

  return <button onClick={() => addTodo({ title: 'New todo' })}>Add</button>
}
```

### Sync Status

```tsx
import { useSyncStatus } from '@korajs/react'

function SyncIndicator() {
  const status = useSyncStatus()
  // 'connected' | 'syncing' | 'synced' | 'offline' | 'error'
  return <span>{status}</span>
}
```

All hooks use `useSyncExternalStore` for React 18+ concurrent mode safety.

## License

MIT

See the [full documentation](https://github.com/ehoneahobed/kora) for guides, API reference, and examples.
