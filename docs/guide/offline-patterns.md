---
title: Offline Patterns
description: "Designing for offline as the default state: durable write queues, sync status UX, connectivity changes, and convergence in Kora.js apps."
---

# Offline Patterns

Kora treats offline as the default state. Every code path works without a network connection. Connectivity is a bonus that enables sync, not a prerequisite for functionality.

This guide covers how Kora's offline-first architecture works and how to build UIs that embrace it.

## How It Works

When your app performs a mutation (insert, update, delete), Kora does three things:

1. **Writes to the local store.** The record and its operation are committed to the local database (SQLite WASM on OPFS, or IndexedDB) in one transaction before the call resolves.

2. **Creates an operation.** Every mutation produces an immutable, content-addressed Operation that captures exactly what changed, with a sequence number reserved in the same commit.

3. **Queues the operation for sync.** The operation joins a persistent outbound queue. When a connection exists it is uploaded once it is durable on the device; it counts as synced only when the server acknowledged it.

There is no "offline mode" to enable. The app is always offline-capable.

## Opening the App Offline: the App Shell

Kora keeps your **data** on the device, but the browser also needs the app's **interface**
(HTML, JavaScript, CSS, the SQLite WASM) to open with no network. Every web template
created by `create-kora-app` ships a service worker for that, generated at build time by
the `koraServiceWorker()` Vite plugin:

<!-- docs-check: skip excerpt of the scaffolded vite.config.ts (its other plugins are defined there) -->
```typescript
// vite.config.ts
import { koraServiceWorker } from '@korajs/cli/vite'

export default defineConfig({
  plugins: [react(), crossOriginIsolation(), sqliteWasmHotfix(), koraServiceWorker()],
})
```

- **Production builds only.** `vite build` writes `dist/sw.js` and registers it from
  `index.html`. In `vite dev` nothing is registered, and any stale Kora worker on the dev
  origin is removed.
- **Precache:** the built shell and every hashed asset, the sqlite WASM, the OPFS proxy and
  your `public/` files, in a cache versioned by their content (`kora-shell-<version>`).
  Old versions are deleted when a new one activates.
- **Navigations** are network first (4 s timeout, `navigationTimeoutMs`) with the cached shell as the fallback, so
  online users always get the latest deploy and offline users still get the app.
- **Hashed assets** are cache first; everything else is network first with a cache
  fallback (an unhashed `sqlite3.wasm` is never served stale next to new JavaScript).
- **Never cached:** the sync endpoint (`/kora-sync`), auth routes (`/auth`), and
  `/__kora`, `/health`. Change the list with `koraServiceWorker({ bypass: [...] })`.
- **Updates:** a new deploy installs in the background and waits. The page shows "A new
  version is available. Reload"; only when the user accepts does it activate and reload, so
  one page never mixes old and new assets. To use your own UI, pass
  `koraServiceWorker({ updatePrompt: false })` and handle the event:

<!-- docs-check-prelude
declare function showMyToast(options: { onReload: () => void }): void
-->

```typescript
window.addEventListener('kora:update-available', (event) => {
  event.preventDefault() // also suppresses the built-in prompt when updatePrompt is true
  showMyToast({ onReload: () => (event as CustomEvent<{ update: () => void }>).detail.update() })
})
```

The production server's static headers are designed to work with it (see
[Production server](./production-server.md#static-files-and-the-offline-app-shell)).
The `tauri-react` template has no service worker: its interface is embedded in the
desktop binary and always opens offline.

<!-- docs-check-prelude
import { createApp, defineSchema, t } from 'korajs'
import { useMutation, useQuery, useQueryState, useSyncStatus } from '@korajs/react'
const app = createApp({
  schema: defineSchema({
    version: 1,
    collections: { todos: { fields: { title: t.string(), completed: t.boolean().default(false) } } },
  }),
})
declare function showToast(message: string): void
-->

## Optimistic Mutations

All mutations in Kora are optimistic. When you call `app.todos.insert(...)`, the record appears in the local store and in any reactive queries immediately, before the operation syncs to the server.

```typescript
// No network round-trip: resolves once the local write committed
const todo = await app.todos.insert({
  title: 'Buy groceries',
})

// The record is immediately available
const found = await app.todos.findById(todo.id)
// found?.title === 'Buy groceries'
```

Reactive queries pick up the write right after it commits: subscribers are notified after the
commit, batched per microtask, and only when their result changed. Check the measured latency on
your target devices with the store benchmarks; see `docs/benchmarks/baseline.md` in the repository.

This means your UI never waits for the network. Data is always local-first.

## The Operation Queue

When the device is offline, operations accumulate in a persistent outbound queue stored in the local database. The queue survives page refreshes, browser restarts, and device reboots.

When connectivity returns:

1. Kora reconnects to the sync server.
2. The client sends its version vector and its delivery watermark.
3. Queued operations of this device are sent to the server in causal order (dependencies before dependents).
4. The server resumes its delivery stream after the device's watermark, so the device receives exactly what it has not applied.
5. Incoming operations are folded into the local store per field (see [Conflict Resolution](/guide/conflict-resolution)); one the device cannot apply yet is quarantined and retried, never dropped.

The entire process is automatic. No developer intervention required.

## Reconnection Behavior

Kora manages reconnection automatically with exponential backoff:

| Attempt | Delay (before jitter) |
|---------|-----------------------|
| 1 | 1 second |
| 2 | 2 seconds |
| 3 | 4 seconds |
| 4 | 8 seconds |
| 5 | 16 seconds |
| 6+ | 30 seconds (max) |

The base delay is `min(initialDelay * 2^attempt, maxDelay)`, capped at a maximum of 30 seconds. A jitter of plus or minus 25% is applied to each delay so that many clients do not reconnect in lockstep. The backoff resets only after a connection stayed up for 10 seconds, and a reconnect counts only once the session reaches streaming. Dead connections are detected by heartbeats (about a minute of silence).

On each reconnection the handshake runs again. The protocol is resumable: if the connection drops during sync, delivery resumes from the device's watermark, not from the beginning.

## Monitoring Sync Status

Use `useSyncStatus` in React to track the current sync state:

```tsx
function SyncIndicator() {
  const status = useSyncStatus()

  return (
    <div>
      <span>{status.status}</span>
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
| `'connected'` | Session open; the initial exchange has not finished |
| `'reconnecting'` | Connection lost; reconnecting with backoff |
| `'syncing'` | Actively exchanging operations |
| `'synced'` | All local operations acknowledged by the server |
| `'offline'` | No connection to the sync server |
| `'auth-required'` | Sync waits for a sign-in or a fresh credential |
| `'clock-error'` | Device clock is too far ahead of the server to sync safely |
| `'error'` | Connection failed (will retry automatically) |
| `'schema-mismatch'` | Client and server schema versions are incompatible |

Besides `status` and `pendingOperations`, the status reports `heldOperations` (writes waiting for
another user, or unassigned writes), `localDurability` (`'degraded'` when local storage cannot
persist) and more; see [React Hooks](/guide/react-hooks#usesyncstatus).

## Designing UIs for Offline-First

Building offline-first UIs requires a shift in thinking. Here are the key patterns.

### No Network Spinners for Local Data

All data comes from the local store, so queries never wait for the network. The local query runs
right after a component mounts: the first render returns `[]` and the rows follow immediately. For
most lists that is invisible. Where an empty state would flash ("No todos yet"), wait for `ready`:

```tsx
function TodoList() {
  const { data: todos, ready } = useQueryState(app.todos.where({ completed: false }))
  if (!ready) return null
  if (todos.length === 0) return <p>No todos yet</p>
  return (
    <ul>
      {todos.map((todo) => (
        <li key={todo.id}>{todo.title}</li>
      ))}
    </ul>
  )
}
```

The other loading state is app startup: `<KoraProvider fallback={...}>` covers the time the local
database takes to open.

### Show Sync Status, Not Connection Status

Users care about whether their data is saved, not whether a WebSocket is connected. Frame sync indicators in terms of data state:

```tsx
function StatusBar() {
  const status = useSyncStatus()

  if (status.status === 'synced') {
    return <span>All changes saved</span>
  }

  if (status.pendingOperations > 0) {
    return <span>Saving {status.pendingOperations} changes...</span>
  }

  if (status.status === 'offline') {
    return <span>Working offline: changes will sync when connected</span>
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
    <button onClick={() => addTodo.mutate({ title: 'New task' })}>
      Add Task
    </button>
  )
}
```

If a particular action requires server confirmation (such as a payment), you can await the mutation and check sync status, but this should be the exception, not the rule.

### Handle Conflicts Gracefully

Concurrent edits merge automatically. For cases where you want to inform the user that a conflict was resolved, listen for merge events:

```typescript
app.on('merge:conflict', (event) => {
  // Show a non-blocking notification
  showToast(`"${event.trace.field}" was updated by another device`)
})
```

This is optional. By default, conflicts resolve silently and the UI updates to reflect the merged state. Separately, a write the server **refuses** (a constraint, a validator) is reported with `sync:operation-rejected` and undone on its author; surface that one to the user.

## Offline-First Checklist

When building features, verify these offline behaviors:

- [ ] All CRUD operations work with no network connection
- [ ] Reactive queries update immediately on local mutations
- [ ] No loading spinners for data that comes from the local store
- [ ] The app starts and is usable before the sync connection is established
- [ ] The deployed build reopens with the network off (the app shell)
- [ ] Pending changes survive a page refresh
- [ ] When connectivity returns, changes sync without user intervention
- [ ] Conflicting edits from multiple devices merge cleanly
- [ ] The UI communicates sync state without alarming the user

## How Operations Survive Offline

Operations are durable by design:

1. **Content-addressed.** Each operation's ID is a hash of its content. Duplicate operations are automatically deduplicated.

2. **Causally ordered.** Each operation records which operations it depends on, forming a directed acyclic graph (DAG). This ensures operations are applied in the correct order even when they arrive out of sequence.

3. **Persisted locally.** The operation log is stored in the same local database as your data. It persists across page refreshes, app restarts, and device reboots.

4. **Idempotent sync.** Receiving the same operation twice is harmless. Content-addressing catches duplicates automatically. This means the sync protocol does not need exactly-once delivery: at-least-once is sufficient.

5. **Never dropped.** An operation the device cannot apply yet is quarantined durably and retried; one the server refuses is kept in the rejected list with its reason; and the device recovers its own writes from the server if its local log lost them.

As long as the browser's storage is intact, no operation is lost. Ask for persistent storage
(`store.persistence`, see [Storage Configuration](/guide/storage-configuration#durable-storage-persist))
so the browser does not evict it under storage pressure.
