---
title: Sync Configuration
description: "Configure Kora.js sync: options, authentication, server-granted scopes, query views, delivery guarantees, held writes, durability, status, settlement and diagnostics."
---

# Sync Configuration

Sync is opt-in: an app works fully offline without it. With it, Kora uploads local writes,
downloads everyone else's, merges concurrent edits and reconnects on its own. This page covers
the client side; the server is in [Production Server](/guide/production-server) and the wire
format in [Sync Protocol](/guide/sync-protocol).

## Enable sync

<!-- docs-check-prelude
import { createApp, defineSchema, t } from 'korajs'
const schema = defineSchema({
  version: 1,
  collections: {
    todos: { fields: { title: t.string(), completed: t.boolean().default(false), userId: t.string().optional() } },
    courses: { fields: { orgId: t.string(), title: t.string() } },
  },
})
declare function getAccessToken(options?: { forceRefresh?: boolean }): Promise<string>
declare const orgId: string
declare const signal: AbortSignal
-->

```ts
const app = createApp({
  schema,
  sync: {
    url: 'wss://sync.example.com/kora-sync',
    autoConnect: true,
  },
})
```

Kora does not connect on its own: set `autoConnect: true`, or call `await app.sync?.connect()`
after `app.ready` (for example once a user signed in). `app.sync` is `null` when `sync` is not
configured.

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `url` | (required) | Sync server URL: `wss://` (or `ws://` locally) for WebSocket, `https://` for HTTP. |
| `transport` | `'websocket'` | `'http'` for HTTP long-polling where WebSockets are blocked. |
| `autoConnect` | `false` | Connect after `app.ready`. |
| `auth` | | `async (options?) => ({ token })`, called before every connection attempt; with `{ forceRefresh: true }` after the server ended a session as expired or revoked. |
| `authClient` | | A binding from `createKoraAuthSync({ authClient, schema })` (`@korajs/auth`); overrides `auth`. |
| `unassignedWrites` | `'hold'` | Writes made before the app knew who was signed in, on a database that never synced: `'hold'` them for the app to assign, or `'assign-to-first-user'` (single-user apps). See [held writes](#held-writes). |
| `scope` | | Flat scope values (`{ orgId }`) the client asks for, combined with the schema's scope declarations. They can only narrow the server's grant. |
| `scopes` | | Per-collection scope functions, for the same purpose. |
| `querySubsets` | `{ mode: 'reactive' }` | Which records a device downloads within its scope: `'reactive'`, `'static'` or `'disabled'` (see [query views](#query-views)). |
| `scopeExit` | `'retain'` | `'retract'` removes records from the local view when the server's grant no longer covers them. |
| `encryption` | | End-to-end encryption; see [Sync Encryption](/guide/sync-encryption). |
| `operationTransforms` | | Transforms for operations of other schema versions, the same list as the server's (see [Schema Design](/guide/schema-design#devices-on-older-versions-transforms-at-fold-time)). |
| `schemaVersion` | `schema.version` | The schema version sent in the handshake. |
| `batchSize` | `100` | Operations per upload batch. |
| `strictHandshake` | `false` | Wait for the server's acknowledgment of each handshake delta batch before streaming. |
| `autoReconnect` | `true` | Reconnect after an unexpected disconnect. |
| `reconnectInterval` | `1000` | First reconnect delay (ms). |
| `maxReconnectInterval` | `30000` | Longest reconnect delay (ms). |

Reconnects back off exponentially from `reconnectInterval` to `maxReconnectInterval` with 25%
jitter. The backoff resets only after a connection stayed up for 10 seconds, so a server that
accepts sessions and drops them at once keeps being backed off. A reconnect counts as successful
only when the new session reaches streaming.

## Authentication

The server decides who you are and what you may sync; the client supplies a credential.

### With `@korajs/auth`

<!-- docs-check: continue -->
```ts
import { createKoraAuth, createKoraAuthSync } from '@korajs/auth'

const authClient = createKoraAuth({ serverUrl: 'https://api.example.com' })

const authedApp = createApp({
  schema,
  sync: {
    url: 'wss://sync.example.com/kora-sync',
    authClient: createKoraAuthSync({ authClient, schema }),
    autoConnect: true,
  },
})
```

The binding supplies and refreshes tokens, binds the device's writes to the signed-in user,
suspends sync while signed out (`status: 'auth-required'`), and keeps a user who is offline signed
in (an explicit `authenticated-offline` state: network errors, timeouts and 5xx responses never
sign anyone out). On the server, `createKoraAuthServer({ userStore, jwtSecret }).auth` is the
matching provider. See [Authentication](/guide/authentication).

### With your own tokens

<!-- docs-check: continue -->
```ts
const tokenApp = createApp({
  schema,
  sync: {
    url: 'wss://sync.example.com/kora-sync',
    auth: async (options) => ({ token: await getAccessToken(options) }),
    autoConnect: true,
  },
})
```

Return a freshly refreshed token when `options.forceRefresh` is true: the server just refused the
cached one. Tokens are sent in the handshake, never in the WebSocket URL (a `WebSocketTransport`
used directly with `@korajs/sync` accepts `tokenInUrl: true` for a proxy that needs it).

### Scopes are granted by the server

What a session may read and write is decided on the server from the verified identity: the auth
provider returns the grant (for example `todos: { userId }`, `projects: { orgId }`). The client's
`scope`, `scopes` and query views can only **narrow** it; a handshake that asks for more gets only
the grant, and a collection the grant does not name is not synced. With `@korajs/auth`,
schema-scoped collections bind to the verified `userId` automatically, and other bindings come
from `scopeValues` or `resolveScopes` on the server. A grant value that cannot be resolved fails
closed (`SCOPE_REQUIRED`, `INVALID_SCOPE_PREDICATE`).

Grants may use bounded `$in` lists (`{ courses: { offeringId: { $in: ['a', 'b'] } } }`): values
are deduplicated and sorted, an empty list denies, and more than 100 values per predicate fails
the handshake (`SCOPE_PREDICATE_LIMIT`). The same matcher filters downloads, relays, backfills and
uploads.

A local write outside the session's upload scope is not silently kept local: it is reported with
`sync:operation-rejected` (`OUT_OF_UPLINK_SCOPE`) and kept in the rejected list.

### Anonymous devices

With a `MixedAuthProvider` on the server, devices without a token sync only the collections in
its `anonymousScopes`. An anonymous device receives a secret node token at its first handshake and
must present it to reconnect with its node id, so no other anonymous client can take its node
over. `createKoraAuthSync({ authClient, schema, anonymous: 'allow' })` syncs anonymously while
signed out (the default, `'suspend'`, pauses sync until sign-in). See
[Common Patterns](/guide/common-patterns#anonymous-public-data-access).

## Held writes

Writes belong to the user who made them. On a shared device every user writes under their own
node, and a node's writes upload only on that user's sessions:

- Writes of another user who used this local database wait for that user to sign in again
  (`status.heldOperations`, `heldNodes` with reason `other-user`). Use
  `store.namespaceByAuthUser` to give each user their own database instead.
- Writes made on a never-synced database before the app knew who was signed in cannot be
  attributed (reason `unassigned`). The app decides:

<!-- docs-check: continue -->
```ts
const held = (await app.sync?.getHeldOperations()) ?? []
for (const node of held) {
  if (node.reason === 'unassigned') {
    await app.sync?.assignHeld(node.nodeId, 'current-user') // or: await app.sync?.discardHeld(node.nodeId)
  }
}
```

`assignHeld` needs a signed-in user (`HELD_ASSIGN_NO_USER`); `discardHeld` stops the writes from
uploading but does not roll them back. `sync.unassignedWrites: 'assign-to-first-user'` assigns
them automatically to the first user the server accepts on this device.

## Query views

Within its scope, a device downloads what its views need:

- **`'reactive'`** (default): each reactive query's equality filters register a sync subset, sent
  in the handshake. Operator filters (`$gt`, `$in`) are not subsets; use scopes for those.
  Changing subscriptions reconnects (debounced) with the new subsets.
- **`'static'`**: a manifest you set, replaced atomically:

<!-- docs-check: continue -->
```ts
const staticApp = createApp({
  schema,
  sync: { url: 'wss://sync.example.com/kora-sync', querySubsets: { mode: 'static' } },
})
await staticApp.sync?.setQuerySubsets([{ collection: 'courses', where: { orgId } }])
```

- **`'disabled'`**: no subsets; the device downloads its whole scope.

Subsets are canonicalized (key order and duplicates do not matter; a broader predicate removes
contained narrower ones). Each view has its own delivery watermark, so returning to a view resumes
it; a new view back-fills once. The number of remembered views is bounded (least recently used
first, never the current one).

## Delivery guarantees

Once the server stores an operation, every client whose scope includes it receives it, and nothing
is ever silently skipped, across dropped messages, reconnects and restarts:

- **Downloads** follow a durable, gap-free delivery watermark per view: the client advances it only
  after a batch is fully applied, in the same transaction, so a dropped or failed batch is re-sent.
- **Operations a device cannot apply yet** (unknown collection after a server upgrade, missing
  encryption key, a far-future timestamp, a transform it lacks) are quarantined durably and
  replayed on every start and when keys arrive (`sync:apply-failed`, `sync:apply-recovered`). A
  possibly transient failure stalls delivery instead (`sync:apply-blocked`, `blockedFailure`) and
  is retried.
- **Uploads** are tracked per batch: an operation counts as synced only when the server has it,
  and the device keeps a contiguous "stored on the server" prefix, so `pendingOperations` is
  exact. A permanently refused write (`sync:operation-rejected`, `retriable: false`) is never
  uploaded again and is undone on its author.
- **Nothing is uploaded before it is durable on the device.** If local storage keeps failing
  (quota, a broken IndexedDB), uploads continue so the server keeps a copy, and the status reports
  `localDurability: 'degraded'` (`sync:durability-degraded`, then `sync:durability-restored`).
- **Devices and the server recover from each other.** A device that lost its newest writes gets
  them back from the server; a server restored from an older backup gets the missing writes
  re-uploaded; a cloned database (copied app data) moves to a fresh node id.
- The outbound queue lives in the local database: writes survive reloads, restarts and reboots.

See [Sync Protocol](/guide/sync-protocol#delivery-watermark) for the mechanics.

## Status

`app.sync.getStatus()`, `app.sync.subscribeStatus(listener)` and `useSyncStatus()` return the same
`SyncStatusInfo`: `status` (`connected`, `reconnecting`, `syncing`, `synced`, `offline`,
`clock-error`, `error`, `schema-mismatch`, `auth-required`, `encryption-locked`), `phase`, `pendingOperations`,
`heldOperations` and `heldNodes`, `localDurability`, `serverProtocolVersion` and
`protocolDeprecated`, `clockSkewMs`, `initialSync` progress, `deliveryWatermark` and
`serverFrontier`, and `blockedFailure`. See [React Hooks](/guide/react-hooks#usesyncstatus) for
the full table.

### Waiting for sync

<!-- docs-check: continue -->
```ts
const result = await app.sync?.waitForSettled({
  upload: true,
  download: 'active-view',
  timeoutMs: 30_000,
  signal,
})
if (result?.outcome !== 'settled') console.warn('not settled:', result?.outcome)
```

The outcome is `settled`, `offline`, `suspended`, `blocked`, `timeout` or `aborted`. Waiting
never discards local operations or changes sync state.

## Rejections

<!-- docs-check: continue -->
```ts
app.on('sync:operation-rejected', (event) => {
  console.warn(`${event.collection}/${event.recordId}: ${event.code} ${event.message}`)
})

const rejected = (await app.sync?.getRejectedOperations()) ?? []
await app.sync?.clearRejectedOperations(rejected.map((r) => r.operationId))
```

Rejected operations are kept in a durable list (they survive reloads) until you clear them.
Common codes: `CONSTRAINT_VIOLATION`, `SCHEMA_VALIDATION_ERROR`, `OPERATION_TOO_LARGE`,
`OUT_OF_UPLINK_SCOPE`, `RESTRICTED`, `RATE_LIMIT` (retriable), and your validator's own codes.
See [Error Codes](/api/errors).

## Events

| Event | When |
|-------|------|
| `sync:connected`, `sync:disconnected` | A session started or ended (`reason`). |
| `sync:sent`, `sync:received`, `sync:acknowledged` | Batches moved. |
| `sync:operation-rejected` | The server refused one of this device's operations. |
| `sync:apply-failed`, `sync:apply-blocked`, `sync:apply-retrying`, `sync:apply-recovered`, `sync:apply-abandoned` | An inbound operation could not be applied, and what happened next. |
| `sync:auth-failed`, `sync:suspended` | The credential was refused; sync paused (`auth-required`, `device-revoked`, `encryption-locked`, ...). |
| `sync:node-id-rotated`, `sync:local-node` | The device's node identity changed (claimed node, clone, principal switch, adoption of a closed tab's writes, held writes). |
| `sync:durability-degraded`, `sync:durability-restored` | Local storage stopped (or resumed) persisting. |
| `sync:clock-skew`, `sync:clock-rebase` | This device's clock differs from the server's; unsynced writes were re-stamped. |
| `sync:schema-mismatch`, `sync:protocol-deprecated` | Version mismatches. |
| `sync:delivery-gap`, `sync:delivery-stalled` | Delivery diagnostics. |
| `sync:diagnostics`, `sync:bandwidth`, `sync:initial-sync-progress`, `connection:quality` | Health and progress. |

Subscribe with `app.on(type, listener)` (or `app.events.on`), or pass `onSyncEvent` to
`createApp` for every `sync:*` event. The full list is in [DevTools](/api/devtools#events).

## Diagnostics

`app.sync?.exportDiagnostics()` returns a snapshot for support tickets: `state`, `status`,
`nodeId`, `url`, `schemaVersion`, the last sync, push and pull times, `conflicts`,
`pendingOperations`, `hasInFlightBatch`, `reconnecting`, `deliveryWatermark`,
`deliveryGapRepeatCount` and `timestamp`. The `sync:diagnostics` event carries live connection
metrics: RTT percentiles, throughput, queue size, error counts, `quality` and
`effectiveBandwidth`.

## Disconnecting

<!-- docs-check: continue -->
```ts
await app.sync?.disconnect() // writes keep queuing locally
await app.sync?.connect()
await app.sync?.reconnect() // one serialized disconnect and connect
await app.sync?.retryNow() // skip the current backoff
```

`app.sync.clearSchemaBlock()` clears a schema-mismatch block after the app upgraded; then
`connect()` again.

## Troubleshooting

- **Nothing connects.** Check `autoConnect` or the `connect()` call, use `wss://` on HTTPS pages,
  and look at `status.status` (`auth-required` means no credential; `schema-mismatch` means the
  server does not accept this schema version).
- **Writes stay pending.** `pendingOperations` counts writes the server has not acknowledged.
  Check `heldOperations` (another user's or unassigned writes), `sync:operation-rejected` events
  and `blockedFailure`.
- **A record never arrives.** Check the server's grant for the collection: the client cannot widen
  it. A child whose parent is outside the view is quarantined until the parent is present.
- **`clock-error`.** This device's clock is too far ahead of the server; fix the device clock.
