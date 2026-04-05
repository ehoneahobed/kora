# Sync Configuration

Kora sync is opt-in. Your app works fully offline without any sync configuration. When you are ready to sync data across devices, add a `sync` property to your `createApp` call.

## Enabling Sync

The minimal sync configuration is a single URL:

```typescript
import { createApp } from 'kora'
import schema from './schema'

const app = createApp({
  schema,
  sync: {
    url: 'wss://my-server.com/kora',
  },
})
```

This connects to a Kora sync server over WebSocket and handles everything automatically: connection management, reconnection, operation exchange, and conflict resolution.

## Full Configuration

Here is every sync option available:

```typescript
const app = createApp({
  schema,
  sync: {
    // Required: sync server URL
    url: 'wss://my-server.com/kora',

    // Transport protocol (default: 'websocket')
    transport: 'websocket',  // or 'http'

    // Authentication
    auth: async () => ({
      token: await getAuthToken(),
    }),

    // Sync scopes: filter which data syncs per collection
    scopes: {
      todos: (ctx) => ({ where: { userId: ctx.userId } }),
      projects: (ctx) => ({ where: { teamId: ctx.teamId } }),
    },

    // End-to-end encryption
    encryption: {
      enabled: true,
      key: 'user-passphrase',  // or a keyProvider function
    },
  },
})
```

## Transport Options

### WebSocket (Default)

WebSocket provides real-time bidirectional sync. This is the recommended transport for most applications.

```typescript
sync: {
  url: 'wss://my-server.com/kora',
  transport: 'websocket',
}
```

The sync flow over WebSocket:

1. **Handshake**: Client sends its version vector and schema version. Server responds with its version vector.
2. **Delta exchange**: Both sides compute and send operations the other is missing.
3. **Real-time streaming**: After the initial exchange, new operations are pushed bidirectionally as they occur.

### HTTP Polling Fallback

For environments where WebSocket is not available (restrictive firewalls, some serverless platforms), use HTTP polling:

```typescript
sync: {
  url: 'https://my-server.com/kora',
  transport: 'http',
}
```

HTTP transport polls the server at regular intervals. It uses the same version vector-based delta sync, just over request/response cycles instead of a persistent connection. Latency is higher than WebSocket, but correctness is identical.

## Authentication

Provide an async `auth` function that returns credentials. Kora calls this function before each connection attempt, so tokens are always fresh.

```typescript
sync: {
  url: 'wss://my-server.com/kora',
  auth: async () => {
    const token = await refreshAccessToken()
    return { token }
  },
}
```

The token is sent in the handshake message. On the server side, configure a `TokenAuthProvider` to validate tokens and extract user context. See [Deployment](/guide/deployment) for server-side auth setup.

If `auth` throws or returns a rejected promise, Kora will retry the connection with exponential backoff.

## Sync Scopes

By default, a client syncs all data from all collections. Sync scopes let you filter which records sync to each client.

```typescript
sync: {
  url: 'wss://my-server.com/kora',
  auth: async () => ({ token: await getToken() }),
  scopes: {
    todos: (ctx) => ({ where: { userId: ctx.userId } }),
    projects: (ctx) => ({ where: { teamId: ctx.teamId } }),
  },
}
```

The `ctx` parameter contains the user context extracted from the auth token by the server's `TokenAuthProvider`. Scopes are evaluated on the server to determine which operations to send to each client.

### Use Cases

- **Multi-tenant apps**: Sync only the current tenant's data
- **User-specific data**: Sync only records belonging to the authenticated user
- **Role-based access**: Sync different subsets based on user roles
- **Bandwidth optimization**: Reduce sync payload for mobile clients

### Scope Behavior

- Scopes filter the initial sync (which operations to send to a new client).
- Scopes filter real-time streaming (only forward operations matching the scope).
- If a record moves out of scope (e.g., reassigned to another user), the client retains its local copy but stops receiving updates.
- Collections without a scope entry sync all data.

## Encryption

Enable end-to-end encryption so that the sync server cannot read your data:

```typescript
sync: {
  url: 'wss://my-server.com/kora',
  encryption: {
    enabled: true,
    key: 'user-passphrase',
  },
}
```

With encryption enabled:

- Operation payloads (the `data` and `previousData` fields) are encrypted before leaving the client.
- The server stores and relays encrypted blobs without access to the plaintext.
- Other clients decrypt operations using the same key.
- Metadata (collection name, record ID, timestamps) remains unencrypted so the server can route and order operations.

### Key Provider

For dynamic keys (e.g., derived from user credentials):

```typescript
encryption: {
  enabled: true,
  keyProvider: async () => {
    return await deriveKeyFromUserPassword()
  },
},
```

## Connection Lifecycle

Understanding the connection lifecycle helps when building sync status UI.

### Startup

1. App calls `createApp` with sync config.
2. Kora opens the local store and loads any queued operations.
3. A connection attempt begins (WebSocket or HTTP).
4. If `auth` is configured, the auth function is called.
5. The handshake exchanges version vectors.
6. Delta operations are exchanged.
7. Real-time streaming begins.

### Offline Handling

1. Connection drops (network failure, server restart, etc.).
2. Kora emits a `sync:disconnected` event.
3. Local mutations continue to work and queue operations.
4. Reconnection attempts begin with exponential backoff (immediate, 1s, 2s, 4s, 8s max).
5. On reconnection, the full handshake and delta exchange run.
6. Queued operations sync to the server.

### Resumability

The sync protocol is resumable. If the connection drops during a large delta exchange:

- The client tracks the last acknowledged sequence number.
- On reconnection, sync resumes from the last acknowledged point.
- No operations are re-sent unnecessarily.

## Multiple Tabs

Kora handles multiple browser tabs connected to the same local store:

- Only one tab maintains the active WebSocket connection (the "leader" tab).
- Other tabs sync with the local store and receive updates via the leader.
- If the leader tab closes, another tab promotes itself to leader.
- This avoids redundant connections and bandwidth usage.

## Disabling Sync

To disable sync at runtime (e.g., for a "work offline" toggle):

```typescript
// Disconnect from the sync server
app.sync.disconnect()

// Reconnect later
app.sync.connect()
```

Operations created while disconnected queue normally and sync when `connect()` is called.
