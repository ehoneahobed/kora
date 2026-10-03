---
title: Presence and Awareness
description: "Show who is online and where they are working: presence, awareness, and live cursors for collaborative offline-first apps built with Kora.js."
---

# Presence & Awareness

Kora includes a presence system for sharing ephemeral collaborative state between connected clients. Unlike operations, presence data is never persisted: it exists only while clients are connected and is used for features like showing who is online, displaying cursor positions, and indicating which records are being edited.

## How Presence Works

Presence flows through the sync layer but operates independently from the operation sync protocol:

1. A client sets its local awareness state (user info, cursor position, custom data).
2. The state is sent to the sync server through the existing transport.
3. The server's `AwarenessRelay` forwards the state to the other connected clients that share the
   sender's download scope (its presence partition). Users who cannot sync the same data never see
   each other's presence.
4. When a client disconnects, the server broadcasts a removal notification.
5. As a safety net, clients run a timeout-based cleanup that removes stale remote states after 30 seconds of inactivity.

Presence data is lightweight and designed for frequent updates (e.g., cursor movements). It does not use the operation log, version vectors, or merge engine.

## Setting Presence with `usePresence`

<!-- docs-check-prelude
import { usePresence, useCollaborators } from '@korajs/react'
-->

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

- **Client joins**: A session takes part after its handshake is accepted. Its first update binds its awareness client id (later updates must use it, so a client cannot impersonate another) and its partition; the relay sends it every existing state in that partition.
- **State update**: The relay stores the state and forwards it to the other clients in the same partition.
- **Client leaves**: When a client disconnects, the relay sends a removal (`null` state) to the remaining clients in its partition.

The relay is built into `KoraSyncServer` and requires no additional configuration. It is active whenever sync is enabled.

```
Client A                    Server (AwarenessRelay)              Client B
   |                               |                                |
   |-- awareness update ---------->|                                |
   |   {user: {name: "Alice"}}     |-- relay within partition ---->|
   |                               |                                |
   |                               |<-- awareness update ----------|
   |<-- relay within partition ----|   {user: {name: "Bob"}}       |
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

For `t.richtext()` fields, `useRichText` publishes this user's cursor and returns the cursors of
everyone else editing the same field:

<!-- docs-check: standalone -->
```tsx
import { useRichText } from '@korajs/react'

function NoteEditor({ noteId, me }: { noteId: string; me: { name: string; color: string } }) {
  const { text, ready, cursors, setCursor, clearCursor } = useRichText('notes', noteId, 'content', {
    user: me,
  })
  if (!ready) return null

  return (
    <div>
      <textarea
        defaultValue={text.toString()}
        onSelect={(event) => {
          const { selectionStart, selectionEnd } = event.currentTarget
          setCursor(selectionStart, selectionEnd)
        }}
        onBlur={clearCursor}
      />
      {cursors.map((cursor) => (
        <span key={cursor.clientId} style={{ color: cursor.color }}>
          {cursor.userName} at {cursor.anchor}
        </span>
      ))}
    </div>
  )
}
```

Positions are Yjs anchor/head offsets, so editors with Yjs bindings (TipTap, ProseMirror with
y-prosemirror) can render them directly. A plain textarea like this one does not apply remote
edits; bind `text` to a Yjs-aware editor for real collaborative editing.

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
