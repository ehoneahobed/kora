# Sync Configuration

Kora sync is opt-in. Your app works fully offline without sync. When enabled, sync handles connection management, delta exchange, conflict resolution, and reconnection automatically.

## Enable Sync

Add `sync.url`, then connect after `app.ready`:

```typescript
import { createApp } from 'korajs'
import schema from './schema'

const app = createApp({
  schema,
  sync: {
    url: 'wss://my-server.com/kora',
  },
})

await app.ready
await app.sync?.connect()
```

Kora then handles the handshake, delta exchange, retries, and conflict resolution.

## Sync Options Reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `url` | `string` | -- | WebSocket URL of your sync server (required) |
| `auth` | `() => Promise<{ token: string }>` | -- | Async function that returns an auth token |
| `batchSize` | `number` | `100` | Max operations per sync batch |
| `schemaVersion` | `number` | `1` | Schema version sent in handshake |
| `autoReconnect` | `boolean` | `true` | Automatically reconnect on disconnect |
| `reconnectInterval` | `number` | `1000` | Initial reconnect delay in ms |
| `maxReconnectInterval` | `number` | `30000` | Maximum reconnect delay in ms |

### Full Configuration Example

```typescript
const app = createApp({
  schema,
  sync: {
    url: 'wss://my-server.com/kora',
    auth: async () => ({ token: await getAuthToken() }),
    batchSize: 100,
    schemaVersion: 1,
    autoReconnect: true,
    reconnectInterval: 1000,
    maxReconnectInterval: 30000,
  },
})
```

## Authentication

Provide an async `auth` function that returns a token. The token is sent during the WebSocket handshake:

```typescript
sync: {
  url: 'wss://my-server.com/kora',
  auth: async () => ({
    token: await refreshAccessToken(),
  }),
}
```

The `auth` function is called on every connection attempt, including reconnections. This allows you to refresh expired tokens automatically.

### With @korajs/auth

If you use `@korajs/auth`, pass the auth client's access token:

```typescript
import { AuthClient } from '@korajs/auth'

const authClient = new AuthClient({ serverUrl: 'http://localhost:3001' })

const app = createApp({
  schema,
  sync: {
    url: 'wss://my-server.com/kora',
    auth: async () => ({
      token: await authClient.getAccessToken(),
    }),
  },
})
```

On the server side, bridge auth to the sync server with `toSyncAuthProvider()`:

```typescript
import { BuiltInAuthRoutes, TokenManager, InMemoryUserStore } from '@korajs/auth/server'
import { createKoraServer } from '@korajs/server'

const authRoutes = new BuiltInAuthRoutes({ userStore, tokenManager })

const server = createKoraServer({
  store: serverStore,
  port: 3001,
  auth: authRoutes.toSyncAuthProvider(),
})
```

See the [Authentication Guide](/guide/authentication) for the full setup.

### Anonymous Sync (Mixed Auth)

For apps where some users are authenticated and others are anonymous (e.g., public form respondents), use `MixedAuthProvider`:

```typescript
import { MixedAuthProvider } from '@korajs/server'

const auth = new MixedAuthProvider({
  primary: authRoutes.toSyncAuthProvider(),
  anonymousScopes: {
    responses: {},  // anonymous users can only sync this collection
  },
})

const server = createKoraServer({ store, port: 3001, auth })
```

On the client, return an empty token for unauthenticated users:

```typescript
sync: {
  url: 'wss://my-server.com/kora',
  auth: async () => ({
    token: (await authClient.getAccessToken()) ?? '',
  }),
}
```

Anonymous connections get full offline-first capabilities — data saves locally and syncs when connected — but are restricted to the collections listed in `anonymousScopes`.

See the [Common Patterns guide](/guide/common-patterns#anonymous-public-data-access) for a complete walkthrough.

## Connection Lifecycle

### Initial Sync

When a client connects for the first time (or after being offline):

1. App opens local storage and loads the local version vector.
2. You call `app.sync?.connect()`.
3. Client authenticates (if configured).
4. **Handshake**: Client sends its version vector to the server.
5. **Server response**: Server sends its version vector back.
6. **Delta exchange**: Both sides compute which operations the other is missing and send them. Operations are sent in causal order (dependencies before dependents).
7. **Streaming**: After the initial exchange, the connection enters real-time bidirectional streaming mode. New operations are sent as they happen.

### How Delta Sync Works

Version vectors track the highest sequence number seen from each node. During sync:

```
Client version vector: { nodeA: 42, nodeB: 17 }
Server version vector: { nodeA: 42, nodeB: 20, nodeC: 5 }

Client needs: nodeB ops 18-20, all nodeC ops (1-5)
Server needs: nothing (client has nothing server doesn't)
```

Only the missing operations are transferred. This makes incremental sync very efficient -- typically under 200ms for a single new operation.

### Offline Handling

1. Network drops (or device goes offline).
2. Kora emits `sync:disconnected`.
3. Local writes continue normally and are added to a persistent outbound queue.
4. Reconnect retries run with exponential backoff (see below).
5. On reconnect, the full handshake runs and the queue is flushed.

The outbound queue is persisted to the local database. Operations survive page refreshes, browser restarts, and device reboots.

## Reconnection Behavior

When the connection drops, Kora retries with exponential backoff:

| Attempt | Delay |
|---------|-------|
| 1 | Immediate |
| 2 | `reconnectInterval` (default: 1s) |
| 3 | 2x previous (2s) |
| 4 | 2x previous (4s) |
| 5+ | Capped at `maxReconnectInterval` (default: 30s) |

The backoff resets after a successful connection. Set `autoReconnect: false` to disable automatic reconnection:

```typescript
sync: {
  url: 'wss://my-server.com/kora',
  autoReconnect: false,
}
```

## Transports

### WebSocket (Default)

The `createApp` runtime uses WebSocket transport. This provides:

- Low-latency bidirectional streaming
- Real-time operation delivery
- Efficient for frequent small updates

### HTTP Long-Polling

The `@korajs/sync` package also supports HTTP long-polling transport, useful when WebSocket connections are blocked by firewalls or proxies. To use it, work with the sync engine directly:

```typescript
import { SyncEngine, HttpLongPollingTransport } from '@korajs/sync'

const transport = new HttpLongPollingTransport({
  url: 'https://my-server.com/kora/sync',
  pollInterval: 5000,
})

const sync = new SyncEngine({ transport, mergeEngine, operationLog })
sync.start()
```

### Wire Format

Kora uses format negotiation. The client and server negotiate between:

- **JSON** -- human-readable, good for debugging
- **Protocol Buffers** -- compact binary encoding, 60-80% smaller payloads

The negotiation happens automatically during the handshake. In development, JSON is preferred for debuggability. In production, Protobuf is preferred for bandwidth efficiency.

## Sync Status in UI

Use `useSyncStatus()` from `@korajs/react` to show user-facing state:

```tsx
import { useSyncStatus } from '@korajs/react'

function SyncIndicator() {
  const status = useSyncStatus()

  switch (status.state) {
    case 'synced':
      return <span>All changes saved</span>
    case 'syncing':
      return <span>Syncing...</span>
    case 'offline':
      return <span>Working offline</span>
    case 'error':
      return <span>Sync error - retrying</span>
    case 'connected':
      return <span>Connected</span>
  }
}
```

### Status Properties

| Property | Type | Description |
|----------|------|-------------|
| `state` | `'connected' \| 'syncing' \| 'synced' \| 'offline' \| 'error'` | Current sync state |
| `pendingOperations` | `number` | Operations queued but not yet sent |
| `lastSyncedAt` | `number \| null` | Timestamp of last successful sync |

## Server-Side Scoping

Restrict which data each user can sync by returning scopes from your auth provider:

```typescript
const auth = new TokenAuthProvider({
  validate: async (token) => {
    const user = await verifyToken(token)
    return {
      userId: user.id,
      scopes: {
        // User only syncs their own todos
        todos: { userId: user.id },
        // User syncs all projects in their org
        projects: { orgId: user.orgId },
      },
    }
  },
})
```

The server filters operations based on scopes before sending them to the client. This ensures users only receive data they are authorized to see.

### With Organizations (RBAC)

If you use `@korajs/auth` organizations, the `OrgScopeResolver` generates scope filters automatically based on org membership:

```typescript
import { OrgScopeResolver, RbacEngine } from '@korajs/auth/server'

const rbac = new RbacEngine(orgStore)
const scopeResolver = new OrgScopeResolver(orgStore, rbac)

// In your auth provider:
const scopes = await scopeResolver.resolve(userId, orgId, ['todos', 'projects'])
```

See the [Authentication Guide](/guide/authentication) for the full RBAC setup.

## End-to-End Encryption

Kora supports encrypting operation data before it leaves the device. When enabled, the server only sees encrypted payloads -- it cannot read your users' data.

```typescript
const app = createApp({
  schema,
  sync: {
    url: 'wss://my-server.com/kora',
    encryption: {
      enabled: true,
      key: userPassphrase,  // or a key provider function
    },
  },
})
```

- Uses AES-256-GCM with PBKDF2 key derivation (600,000 iterations)
- Operation metadata (timestamps, IDs) remains unencrypted for sync protocol
- Operation data (field values) is encrypted end-to-end
- Supports key rotation with versioned keys

See the [Sync Encryption guide](/guide/sync-encryption) for setup details.

## Sync Diagnostics

The sync engine exposes real-time diagnostics for monitoring connection health:

```typescript
const diagnostics = app.sync?.exportDiagnostics()
// {
//   state: 'streaming',
//   status: { status: 'synced', pendingOperations: 0, ... },
//   pendingOperations: 0,
//   lastSyncedAt: 1715097600000,
//   lastSuccessfulPush: 1715097600000,
//   lastSuccessfulPull: 1715097600000,
//   conflicts: 0,
//   reconnecting: false,
// }
```

For lower-level observability, listen to diagnostics events:

```typescript
app.events.on('sync:diagnostics', (event) => {
  console.log(event.diagnostics.quality)
  console.log(event.diagnostics.rttP95Ms)
  console.log(event.diagnostics.effectiveBandwidth)
})
```

Diagnostics events are also visible in [DevTools](/guide/devtools).

## Manual Disconnect and Reconnect

```typescript
// Disconnect (e.g., when user logs out)
await app.sync?.disconnect()

// Reconnect (e.g., when user logs back in)
await app.sync?.connect()
```

Operations created while disconnected remain in the local queue and are sent on the next successful connection.

## Sync Events

Listen to sync events programmatically for logging or custom behavior:

```typescript
app.events.on('sync:connected', (event) => {
  console.log('Connected to sync server')
})

app.events.on('sync:disconnected', (event) => {
  console.log('Disconnected:', event.reason)
})

app.events.on('sync:sent', (event) => {
  console.log('Sent', event.operations.length, 'operations')
})

app.events.on('sync:received', (event) => {
  console.log('Received', event.operations.length, 'operations')
})

app.events.on('sync:auth-failed', () => {
  // Token rejected by the server (expired, revoked, or database reset).
  // Sign out the user so they can re-authenticate.
  console.warn('Auth token rejected — signing out')
  authClient.signOut()
})
```

These events are also visible in the [DevTools](/guide/devtools) sync timeline.

## Troubleshooting

### Sync not connecting

- Verify the `sync.url` uses `wss://` (not `ws://`) for HTTPS sites.
- Check that the sync server is running and the port is accessible.
- If using auth, verify the token is valid and not expired.
- Check browser console for WebSocket connection errors.

### Operations not syncing

- Check `useSyncStatus().pendingOperations` -- if greater than 0, operations are queued.
- Verify the connection state is `'connected'` or `'synced'`.
- Check the server logs for authentication or scope rejections.

### Slow initial sync

- Reduce the amount of data with server-side scoping.
- Check the total operation count -- large datasets take longer on first sync.
- Consider operation compaction on the server to reduce historical operations.

### Duplicate data appearing

- This should not happen. Kora operations are content-addressed (same content = same ID), and duplicates are automatically deduplicated.
- If you see duplicates, check that your schema's `id` field is not being generated client-side with non-deterministic IDs.
