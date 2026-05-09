# Presence & Awareness

Kora includes a presence system for sharing ephemeral collaborative state between connected clients. Unlike operations, presence data is never persisted -- it exists only while clients are connected and is used for features like showing who is online, displaying cursor positions, and indicating which records are being edited.

## How Presence Works

Presence flows through the sync layer but operates independently from the operation sync protocol:

1. A client sets its local awareness state (user info, cursor position, custom data).
2. The state is sent to the sync server through the existing transport.
3. The server's `AwarenessRelay` broadcasts the state to all other connected clients.
4. When a client disconnects, the server broadcasts a removal notification.
5. As a safety net, clients run a timeout-based cleanup that removes stale remote states after 30 seconds of inactivity.

Presence data is lightweight and designed for frequent updates (e.g., cursor movements). It does not use the operation log, version vectors, or merge engine.

## Setting Presence with `usePresence`

The `usePresence` hook sets the local user's presence state and broadcasts it to peers. It automatically cleans up on unmount.

```tsx
import { usePresence } from '@korajs/react'

function DocumentEditor() {
  usePresence({
    name: 'Alice',
    color: '#e91e63',
  })

  return <div>Editing...</div>
}
```

When this component mounts, other connected clients will see Alice as an active collaborator. When it unmounts, her presence is removed.

### With an Avatar

```tsx
usePresence({
  name: 'Alice',
  color: '#e91e63',
  avatar: 'https://example.com/alice.jpg',
})
```

### Clearing Presence

Pass `null` to clear the local presence state:

```tsx
usePresence(null)
```

This is useful when the user navigates away from a collaborative view but remains connected.

## Displaying Collaborators with `useCollaborators`

The `useCollaborators` hook returns all currently connected remote users' awareness states. It excludes the local user and re-renders only when the set of collaborators or their states change.

```tsx
import { useCollaborators } from '@korajs/react'

function CollaboratorList() {
  const collaborators = useCollaborators()

  if (collaborators.length === 0) {
    return <span>No one else is online</span>
  }

  return (
    <ul>
      {collaborators.map((c) => (
        <li key={c.user.name} style={{ color: c.user.color }}>
          {c.user.name}
        </li>
      ))}
    </ul>
  )
}
```

The hook uses `useSyncExternalStore` internally, making it safe for React 18+ concurrent mode.

## Awareness State Structure

Each client's awareness state contains user identity information and an optional cursor position:

```typescript
interface AwarenessState {
  user: {
    name: string       // Display name
    color: string      // Hex color for cursor/avatar rendering
    avatar?: string    // Optional avatar URL
  }
  cursor?: {
    collection: string // Collection containing the record
    recordId: string   // ID of the record being edited
    field: string      // Richtext field name
    anchor: number     // Start of selection (Y.Text position)
    head: number       // End of selection (same as anchor if no selection)
  }
}
```

The `cursor` field is optional. When present, it indicates the user's cursor position within a specific richtext field, using Yjs-compatible anchor/head positions for editor interoperability.

## Server-Side Awareness Relay

On the server, the `AwarenessRelay` handles presence broadcasting:

- **Client joins**: When a new client registers, the relay sends it all existing awareness states so it immediately sees who is online.
- **State update**: When a client updates its awareness state, the relay stores it and forwards it to all other connected clients.
- **Client leaves**: When a client disconnects, the relay broadcasts a removal notification (`null` state) to all remaining clients.

The relay is built into `KoraSyncServer` and requires no additional configuration. It is active whenever sync is enabled.

```
Client A                    Server (AwarenessRelay)              Client B
   |                               |                                |
   |-- awareness update ---------->|                                |
   |   {user: {name: "Alice"}}     |-- relay to all others ------->|
   |                               |                                |
   |                               |<-- awareness update ----------|
   |<-- relay to all others -------|   {user: {name: "Bob"}}       |
   |                               |                                |
   |   (Alice disconnects)         |                                |
   |                               |-- removal broadcast --------->|
   |                               |   {clientId: null}            |
```

## Timeout-Based Cleanup

In addition to explicit removal on disconnect, the `AwarenessManager` runs a periodic cleanup timer. If a remote client's state has not been updated within 30 seconds, it is considered stale and removed automatically.

This handles edge cases where the server does not send an explicit removal (e.g., abrupt network failure, server crash). The timeout ensures that stale presence indicators are cleaned up even in degraded network conditions.

The timeout is configurable when creating an `AwarenessManager` directly:

```typescript
import { AwarenessManager } from '@korajs/sync'

const awareness = new AwarenessManager({
  timeoutMs: 60_000,  // 60 seconds instead of default 30
})
```

When using `createApp`, the default 30-second timeout is used automatically.

## Example: Active Users with Colored Avatars

A common pattern is showing a row of colored circles or avatars for all active users:

```tsx
import { usePresence, useCollaborators } from '@korajs/react'

function ActiveUsers({ currentUser }: { currentUser: { name: string; avatar: string } }) {
  // Set our own presence
  usePresence({
    name: currentUser.name,
    color: generateColor(currentUser.name),
    avatar: currentUser.avatar,
  })

  // Get everyone else
  const collaborators = useCollaborators()

  return (
    <div style={{ display: 'flex', gap: 4 }}>
      {collaborators.map((c) => (
        <div
          key={c.user.name}
          title={c.user.name}
          style={{
            width: 32,
            height: 32,
            borderRadius: '50%',
            border: `2px solid ${c.user.color}`,
            overflow: 'hidden',
          }}
        >
          {c.user.avatar ? (
            <img
              src={c.user.avatar}
              alt={c.user.name}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          ) : (
            <div
              style={{
                width: '100%',
                height: '100%',
                backgroundColor: c.user.color,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'white',
                fontSize: 14,
              }}
            >
              {c.user.name.charAt(0).toUpperCase()}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function generateColor(name: string): string {
  // Simple hash-based color generation
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash)
  }
  const hue = Math.abs(hash) % 360
  return `hsl(${hue}, 70%, 50%)`
}
```

## Example: Cursor Positions in a Collaborative Editor

For richtext fields using `t.richtext()`, you can share cursor positions so users see where others are typing:

```tsx
import { usePresence, useCollaborators } from '@korajs/react'
import { useCallback } from 'react'

function CollaborativeEditor({
  recordId,
  currentUser,
}: {
  recordId: string
  currentUser: { name: string }
}) {
  const color = generateColor(currentUser.name)

  // Set presence with cursor position
  usePresence({
    name: currentUser.name,
    color,
  })

  // Get collaborators for rendering their cursors
  const collaborators = useCollaborators()

  // Filter to collaborators editing the same record
  const editingHere = collaborators.filter(
    (c) => c.cursor?.recordId === recordId && c.cursor?.field === 'content'
  )

  // Update cursor position as the user types/selects
  const handleSelectionChange = useCallback(
    (anchor: number, head: number) => {
      // Update the awareness state with cursor info
      // (This would integrate with your editor's selection API)
    },
    [recordId]
  )

  return (
    <div>
      {/* Render remote cursors */}
      {editingHere.map((c) => (
        <div key={c.user.name}>
          <span
            style={{
              backgroundColor: c.user.color,
              color: 'white',
              padding: '0 4px',
              borderRadius: 2,
              fontSize: 12,
            }}
          >
            {c.user.name}
          </span>
        </div>
      ))}

      {/* Your editor component */}
      <div>{/* TipTap, ProseMirror, Quill, etc. */}</div>
    </div>
  )
}
```

The cursor positions use Yjs-compatible anchor/head values, making them compatible with editors built on Yjs bindings (TipTap, ProseMirror with y-prosemirror, etc.).

## Differences from Sync Operations

| | Operations | Presence |
|---|---|---|
| Persisted | Yes (local store + server) | No (in-memory only) |
| Survives refresh | Yes | No |
| Conflict resolution | Three-tier merge engine | No conflicts (each client owns its state) |
| Offline support | Full (queued and synced later) | None (requires active connection) |
| Use case | Application data | UI state (who is online, cursors) |

Presence is purely a connected-time feature. When a client is offline, it cannot send or receive presence updates. When it reconnects, it receives the current awareness states of all connected peers.

## Lifecycle Summary

1. Component mounts and calls `usePresence({ name, color })`.
2. The `AwarenessManager` sets the local state and sends it through the sync transport.
3. The server's `AwarenessRelay` stores the state and broadcasts it to all other clients.
4. Other clients' `useCollaborators` hooks update and re-render.
5. When the component unmounts, `usePresence` clears the local state.
6. The `AwarenessManager` broadcasts a removal (`null` state) through the transport.
7. The server relays the removal to other clients.
8. If the removal is not received (network failure), the 30-second timeout removes the stale state on each client.
