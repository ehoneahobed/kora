# Sync Configuration

Kora sync is opt-in. Your app works fully offline without sync.

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

Kora then handles handshake, delta exchange, retries, and conflict resolution.

## Supported `sync` Options

Current `createApp` sync options:

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

## Transport Notes

- The sync engine package supports both WebSocket and HTTP long-polling transports.
- In the current `korajs` `createApp` runtime, sync uses WebSocket transport.
- If you need HTTP transport today, use `@korajs/sync` directly.

## Authentication

Provide an async `auth` function:

```typescript
sync: {
  url: 'wss://my-server.com/kora',
  auth: async () => ({
    token: await refreshAccessToken(),
  }),
}
```

The token is sent at connect time. If `auth` fails, reconnection will retry with backoff.

## Connection Lifecycle

### Startup

1. App opens local storage.
2. You call `app.sync?.connect()`.
3. Client authenticates (if configured).
4. Client/server exchange version vectors.
5. Missing operations are exchanged.
6. Streaming begins.

### Offline Handling

1. Network drops.
2. Kora emits `sync:disconnected`.
3. Local writes continue and queue.
4. Reconnect retries run with exponential backoff.
5. On reconnect, sync resumes and flushes queued operations.

## Sync Status in UI

Use `useSyncStatus()` from `@korajs/react` to show user-facing state:

- `'offline'`
- `'syncing'`
- `'synced'`
- `'error'`

## Scopes and Encryption

- Server-side data scoping is supported through authenticated context on the server.
- Client `sync.scopes` and client-side encryption options are not currently wired through `createApp`.

If your app needs those now, implement them at the lower-level package layer (`@korajs/sync` and `@korajs/server`).

## Disconnect and Reconnect

```typescript
await app.sync?.disconnect()
await app.sync?.connect()
```

Operations created while disconnected remain local and are sent on reconnect.
