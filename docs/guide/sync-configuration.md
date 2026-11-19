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

Kora does not connect on its own: set `autoConnect: true`, or call `app.sync?.connect()` (for
example once a user signed in). Neither waits for `app.ready`: the connection starts in parallel
with opening the local store. `app.sync` is `null` when `sync` is not configured.

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `url` | (required) | Sync server URL: `wss://` (or `ws://` locally) for WebSocket, `https://` for HTTP. |
| `transport` | `'websocket'` | `'http'` for HTTP long-polling where WebSockets are blocked. `createProductionServer` serves WebSocket sync only: map an HTTP endpoint to `KoraSyncServer.handleHttpRequest` (with the `authorization` and `x-kora-session` headers, as in [Upgrading to beta.13](/guide/upgrading-to-beta13#an-http-long-poll-endpoint)). |
| `autoConnect` | `false` | Connect at start, in parallel with opening the store. |
| `auth` | | `async (options?) => ({ token })`, called before every connection attempt; with `{ forceRefresh: true }` after the server ended a session as expired or revoked. |
| `authClient` | | A binding from `createKoraAuthSync({ authClient, schema })` (`@korajs/auth`); overrides `auth`. Wrap it in `lazyAuthSync(() => import('./auth-sync').then((m) => m.binding))` (from `korajs`) to load the sign-in client after the first paint, as the sync templates do. |
| `firstVisit` | | `{ readThrough: true }` answers queries made before the store opens from the sync server's read endpoint (`POST <sync url>/read`, enabled by the server's `readThrough`), so a first visit shows data before the database fills. It uses the credential of `authClient` (only while a user is signed in) or else `auth`, and does nothing when the server has no read endpoint. A device whose data is complete does not read through. |
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
| `bulkReplication` | on for browser OPFS | Apply a large first sync into a scratch in-memory database and merge it into yours once, instead of one journaled transaction per batch. Used only for a device's first sync of a view with at least 2000 server operations and more than one batch (`{ minOperations }` changes that; `0` stages every multi-batch first sync), and only where the database can stage. A scope above `maxOperations` (default 150000) is applied directly, and a replica that grows past `maxBytes` (default 256 MiB) is merged as it is and the rest of the stream applied directly. A browser OPFS database stages by default. Node's native SQLite (`better-sqlite3`) has no per-batch journaling cost to avoid, so it stages only when you ask (`true` or an object). IndexedDB and Tauri databases never stage. `false` applies the stream directly. Nothing of a staged stream is in your database, or counted in its sync watermark, until the merge: a reload mid-way starts the stream again. |
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
are deduplicated and sorted, an empty list denies, and more than the server's
`maxScopePredicateValues` (default 100) per predicate fails the handshake (`SCOPE_PREDICATE_LIMIT`).
A predicate object other than exactly `{ $in: [...] }` is refused the same way, and a `null` or
non-object collection grant denies the collection. A grant may also be a disjunction,
`{ $or: [conjunction, ...] }` with up to 8 branches ("my own records or records of my teams"); a
client from before 1.0.0-beta.15 cannot read `$or` and is refused with `CLIENT_TOO_OLD`. With a
disjunctive upload grant, a write must keep the record in every branch it matched before. The same
matcher filters downloads, relays, backfills and uploads. A schema with [access rules](/guide/access-rules)
gets its grants from the rules instead, and the download stream follows membership changes.

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

Assigned writes upload under their own node. If the server refuses that node for the user (it has
history with no recorded owner, as a node a beta.12 server accepted has, or another device uses
the id), the assigned writes that never reached the server are re-authored under a fresh node of
the user's and upload on a later session (`sync:node-id-rotated`). What the server already
stored under the old node is not repeated.

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
contained narrower ones). Registrations made in a burst (a list mounting one query per row) switch
the view once. Each view has its own delivery watermark, so returning to a view resumes
it; a new view back-fills once. The number of remembered views is bounded (least recently used
first, never the current one).

A handshake carries at most 500 query views: past that the client widens the collections with
the most views to the whole collection (a collection beyond the cap syncs whole), which syncs more,
never less. The server refuses more than its `maxSyncQueries` (default 1000) with
`SYNC_QUERIES_LIMIT`, and a malformed list with `INVALID_SYNC_QUERIES`.

## Delivery guarantees

Once the server stores an operation, every client whose scope includes it receives it, and nothing
is ever silently skipped, across dropped messages, reconnects and restarts:

- **Downloads** follow a durable, gap-free delivery watermark per view: the client advances it only
  after a batch is fully applied, in the same storage transaction as the batch's operations, so a
  dropped or failed batch is re-sent. A large first sync is staged (`bulkReplication`) and nothing
  of it counts until the merge.
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
  re-uploaded, and devices ahead of it resync, also after a database-level restore Kora never saw
  (each batch carries a delivery anchor the device reports back); a cloned database (copied app data) moves to a fresh node id (a store with a pinned node id,
  as with `createKoraAuthSync`, reports `NODE_ROTATION_FAILED` instead).
- The outbound queue lives in the local database: writes survive reloads, restarts and reboots.

See [Sync Protocol](/guide/sync-protocol#delivery-watermark) for the mechanics.

## Status

`app.sync.getStatus()`, `app.sync.subscribeStatus(listener)` and `useSyncStatus()` return the same
`SyncStatusInfo`: `status` (`connected`, `reconnecting`, `syncing`, `synced`, `offline`,
`clock-error`, `error`, `schema-mismatch`, `auth-required`, `encryption-locked`), `phase`, `pendingOperations`,
`heldOperations` and `heldNodes`, `localDurability`, `serverProtocolVersion` and
`protocolDeprecated`, `clockSkewMs`, `initialSync` progress (`initialSync.first` is true only for
the device's first download), `deliveryWatermark` and `serverFrontier`, and `blockedFailure`. See
[React Hooks](/guide/react-hooks#usesyncstatus) for the full table.

For an indicator, `useSyncSummary()` (React, Vue, Svelte) or `summarizeSyncStatus(status)` gives a
tone, a title and one line of detail, with `downloading` true only while the first download runs
(see [Sync API](/api/sync#status-controllers)).

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

Rejected operations are kept in a durable list (they survive reloads) until you clear them. In a
component, `useMutation(fn, { onRejected })` and its `rejected` state report a refusal to the
component that made the write (React, Vue and Svelte).
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
| `sync:operations-acknowledged`, `sync:operations-rewritten` | The server stored these operation ids; unsent operations were re-authored under new ids (`reason`: clock rebase, node rotation, sequence renumbering; `idMapping`). |
| `sync:scope-retracted` | Records left this device's view (access rules, `scopeExit: 'retract'`). |
| `sync:staging-started`, `sync:staging-merged`, `sync:staging-discarded` | A staged first sync (`bulkReplication`) began, was merged into the database, or was dropped. |
| `sync:durability-degraded`, `sync:durability-restored` | Local storage stopped (or resumed) persisting. |
| `sync:clock-skew`, `sync:clock-rebase` | This device's clock differs from the server's; unsynced writes were re-stamped. |
| `sync:schema-mismatch` | Version mismatches. |
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
