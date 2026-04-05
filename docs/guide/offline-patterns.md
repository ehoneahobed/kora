# Offline Patterns

Kora treats offline as the default state. Every code path works without a network connection. Connectivity is a bonus that enables sync, not a prerequisite for functionality.

This guide covers how Kora's offline-first architecture works and how to build UIs that embrace it.

## How It Works

When your app performs a mutation (insert, update, delete), Kora does three things:

1. **Writes to the local store immediately.** The data is persisted to SQLite WASM (via OPFS) on the device. This happens synchronously from the developer's perspective.

2. **Creates an operation.** Every mutation produces an immutable, content-addressed Operation that captures exactly what changed.

3. **Queues the operation for sync.** If a sync connection is active, the operation is sent immediately. If offline, it is added to a persistent outbound queue.

There is no "offline mode" to enable. The app is always offline-capable.

## Optimistic Mutations

All mutations in Kora are optimistic. When you call `app.todos.insert(...)`, the record appears in the local store and in any reactive queries immediately, before the operation syncs to the server.

```typescript
// This returns instantly — no network round-trip
const todo = await app.todos.insert({
  title: 'Buy groceries',
})

// The record is immediately available
const found = await app.todos.findById(todo.id)
// found.title === 'Buy groceries'
```

Reactive queries update immediately too:

```typescript
const todos = useQuery(app.todos.where({ completed: false }))
// The new todo appears in `todos` within a single frame (< 16ms)
```

This means your UI never waits for the network. Data is always local-first.

## The Operation Queue

When the device is offline, operations accumulate in a persistent outbound queue stored in the local database. The queue survives page refreshes, browser restarts, and device reboots.

When connectivity returns:

1. Kora reconnects to the sync server.
2. The client and server exchange version vectors to determine what each side is missing.
3. Queued operations are sent to the server in causal order (dependencies before dependents).
4. The server sends any operations from other clients that this device has not seen.
5. Incoming operations are merged into the local store using the [three-tier merge engine](/guide/conflict-resolution).

The entire process is automatic. No developer intervention required.

## Reconnection Behavior

Kora manages reconnection automatically with exponential backoff:

| Attempt | Delay |
|---------|-------|
| 1 | Immediate |
| 2 | 1 second |
| 3 | 2 seconds |
| 4 | 4 seconds |
| 5+ | 8 seconds (max) |

On each successful reconnection, the full sync handshake runs to bring both sides up to date. The protocol is resumable -- if the connection drops during sync, it picks up from the last acknowledged operation, not from the beginning.

## Monitoring Sync Status

Use `useSyncStatus` in React to track the current sync state:

```tsx
import { useSyncStatus } from '@korajs/react'

function SyncIndicator() {
  const status = useSyncStatus()

  return (
    <div>
      <span>{status.state}</span>
      {status.pendingOperations > 0 && (
        <span>{status.pendingOperations} changes pending</span>
      )}
    </div>
  )
}
```

### Sync States

| State | Meaning |
|-------|---------|
| `'connected'` | WebSocket is open, idle |
| `'syncing'` | Actively exchanging operations |
| `'synced'` | All local operations acknowledged by server |
| `'offline'` | No connection to sync server |
| `'error'` | Connection failed (will retry automatically) |

### Status Properties

| Property | Type | Description |
|----------|------|-------------|
| `state` | `string` | Current sync state |
| `pendingOperations` | `number` | Operations queued but not yet sent |
| `lastSyncedAt` | `number \| null` | Timestamp of last successful sync |

## Designing UIs for Offline-First

Building offline-first UIs requires a shift in thinking. Here are the key patterns.

### No Loading Spinners for Local Data

Since all data comes from the local store, queries always return results immediately. Do not show loading spinners for initial data loads:

```tsx
// GOOD: Data is always available
function TodoList() {
  const todos = useQuery(app.todos.where({ completed: false }))
  return (
    <ul>
      {todos.map((todo) => (
        <li key={todo.id}>{todo.title}</li>
      ))}
    </ul>
  )
}

// AVOID: Unnecessary loading states for local data
function TodoList() {
  const [loading, setLoading] = useState(true)
  // This pattern is not needed with Kora
}
```

The only time you might show a loading indicator is during the initial app startup while the local store is being opened for the first time.

### Show Sync Status, Not Connection Status

Users care about whether their data is saved, not whether a WebSocket is connected. Frame sync indicators in terms of data state:

```tsx
function StatusBar() {
  const status = useSyncStatus()

  if (status.state === 'synced') {
    return <span>All changes saved</span>
  }

  if (status.pendingOperations > 0) {
    return <span>Saving {status.pendingOperations} changes...</span>
  }

  if (status.state === 'offline') {
    return <span>Working offline - changes will sync when connected</span>
  }

  return null
}
```

### Let Users Keep Working

Never block user actions because the device is offline. Mutations always succeed locally:

```tsx
// GOOD: Works offline, operations queue automatically
function AddTodo() {
  const addTodo = useMutation(app.todos.insert)

  return (
    <button onClick={() => addTodo({ title: 'New task' })}>
      Add Task
    </button>
  )
}
```

If a particular action requires server confirmation (such as a payment), you can await the mutation and check sync status, but this should be the exception, not the rule.

### Handle Conflicts Gracefully

Most conflicts resolve automatically through Kora's merge engine. For cases where you want to inform the user that a conflict was resolved, listen for merge events:

```typescript
app.on('merge:conflict', (trace) => {
  // Show a non-blocking notification
  showToast(`"${trace.field}" was updated by another device`)
})
```

This is optional. By default, conflicts resolve silently and the UI updates to reflect the merged state.

## Offline-First Checklist

When building features, verify these offline behaviors:

- [ ] All CRUD operations work with no network connection
- [ ] Reactive queries update immediately on local mutations
- [ ] No loading spinners for data that comes from the local store
- [ ] The app starts and is usable before the sync connection is established
- [ ] Pending changes survive a page refresh
- [ ] When connectivity returns, changes sync without user intervention
- [ ] Conflicting edits from multiple devices merge cleanly
- [ ] The UI communicates sync state without alarming the user

## How Operations Survive Offline

Operations are durable by design:

1. **Content-addressed.** Each operation's ID is a hash of its content. Duplicate operations are automatically deduplicated.

2. **Causally ordered.** Each operation records which operations it depends on, forming a directed acyclic graph (DAG). This ensures operations are applied in the correct order even when they arrive out of sequence.

3. **Persisted locally.** The operation log is stored in the same local database as your data. It persists across page refreshes, app restarts, and device reboots.

4. **Idempotent sync.** Receiving the same operation twice is harmless. Content-addressing catches duplicates automatically. This means the sync protocol does not need exactly-once delivery -- at-least-once is sufficient.

These properties mean that data loss requires the local database itself to be destroyed. As long as the browser's storage is intact, no operation is ever lost.
