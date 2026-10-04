---
title: DevTools API
description: "@korajs/devtools API reference and the complete Kora event catalog: every event, its payload, who emits it and whether DevTools records it."
---

# DevTools API Reference

`@korajs/devtools` records Kora's instrumentation events and shows them in a browser DevTools panel
or an in-page overlay. `createApp({ devtools: true })` sets it up; see the
[DevTools guide](/guide/devtools) for using the panels.

<!-- docs-check-prelude
import { createApp, defineSchema, t } from 'korajs'
const schema = defineSchema({ version: 1, collections: { todos: { fields: { title: t.string() } } } })
const app = createApp({ schema })
-->

## Events {#events}

Kora reports what happens to your data as typed events (`KoraEvent` in `@korajs/core`).
Subscribe on the app:

```typescript
const off = app.events.on('sync:operation-rejected', (event) => {
  console.warn(`${event.collection}/${event.recordId} was refused: ${event.code}`)
})
app.on('merge:conflict', (event) => console.log(event.trace.strategy))
off()
```

`app.on` is the same as `app.events.on`. A sync server emits its events on the emitter passed to
`KoraSyncServer` / `createProductionServer`. The **DevTools** column says whether the
`Instrumenter` records the event for the panel.

### Operations and merges

| Event | Payload | Emitted | DevTools |
|-------|---------|---------|----------|
| `operation:created` | `operation` | after every local write | yes |
| `operation:applied` | `operation`, `duration` | after the store applies a remote operation (not for local writes) | yes |
| `merge:started` | `operationA`, `operationB` | before the conflict traces of an applied remote operation | yes |
| `merge:conflict` | `trace` (`MergeTrace`) | once per fold decision that was a conflict | yes |
| `merge:completed` | `trace` | after the traces of one merge | yes |
| `constraint:violated` | `constraint`, `trace` | a device's optimistic constraint check failed after applying a remote operation (the server is the authority) | yes |
| `replay:completed` | `targetOperationId`, `operationsApplied`, `duration` | `app.replayTo()` finished | yes |

### Sync connection

| Event | Payload | Emitted | DevTools |
|-------|---------|---------|----------|
| `sync:connected` | `nodeId` | handshake accepted | yes |
| `sync:disconnected` | `reason` | connection closed | yes |
| `sync:suspended` | `reason` (`auth-loading`, `auth-required`, `auth-rejected`, `device-revoked`, `encryption-locked`, ...) | sync is paused on purpose | yes |
| `sync:auth-failed` | `reason` | the server refused the credentials | yes |
| `sync:schema-mismatch` | `clientSchemaVersion`, `serverSchemaVersion`, `supportedMin`, `supportedMax`, `reason` | the server does not accept this schema version | yes |
| `sync:clock-skew` | `skewMs`, `severity` (`info`, `slow-warning`, `fast-blocked`), `source` | clock skew measured at the handshake or reported by the server | no |
| `sync:clock-rebase` | `rebasedCount`, `maxSkewMs` | unsynced future-dated operations were re-stamped | no |
| `sync:node-id-rotated` | `previousNodeId`, `nodeId`, `reenqueuedCount`, `heldCount?` | the server refused this device's node id; writes moved to a new node | no |
| `sync:local-node` | `nodeId`, `action`, `localSequence?`, `serverSequence?`, `operationCount?` | bookkeeping of this database's nodes: `history-behind`, `server-behind`, `adoption-*`, `held`, `clone-detected`, `principal-switched`, `held-assigned`, `held-discarded` | no |
| `connection:quality` | `quality` | the measured quality changed | yes |
| `sync:diagnostics` | `diagnostics` | periodic metrics snapshot | yes |
| `sync:bandwidth` | `bytesPerSecond`, `direction` | bandwidth sample | yes |
| `encryption:status` | `status` (`state`, `keyring`, `keyVersion`, `code?`, `message?`) | the encryption keyring locked, unlocked or failed | no |

### Sync data flow

| Event | Payload | Emitted | DevTools |
|-------|---------|---------|----------|
| `sync:sent` | `operations`, `batchSize` | a batch was uploaded | yes |
| `sync:received` | `operations`, `batchSize` (server: also `uniqueOperations`, `duplicateOperations`, `rejectedOperations`) | a batch arrived | yes |
| `sync:acknowledged` | `sequenceNumber` | the server acknowledged an upload | yes |
| `sync:initial-sync-progress` | `progress`, `totalBatches`, `receivedBatches` | during the first sync | yes |
| `sync:operation-rejected` | `operationId`, `collection`, `recordId`, `code`, `message`, `retriable` | the server refused one of this device's operations; it is kept in `app.sync.getRejectedOperations()`, not retried | no |
| `sync:apply-failed` | `operationId`, `collection`, `recordId`, `code`, `message`, `retriable` | a received operation could not be applied (it is retried or quarantined, never skipped) | yes |
| `sync:apply-blocked` / `sync:apply-retrying` / `sync:apply-recovered` | `failure` | a failed apply blocks delivery, is retried, or succeeded | yes |
| `sync:delivery-gap` | `expectedBase`, `receivedBase`, `currentWatermark`, `messageId`, `repeatCount` | a batch did not continue the delivery watermark; it is re-requested | no |
| `sync:scope-retracted` | `collection`, `recordId`, `quarantinedOperationIds` | a record left this device's sync scope | no |
| `sync:durability-degraded` / `sync:durability-restored` | `message`, `failedAttempts` / none | the local database could not be made durable before uploads (the server holds the durable copy), and recovery | yes |

### Server only

| Event | Payload | Emitted |
|-------|---------|---------|
| `sync:protocol-deprecated` | `nodeId`, `clientProtocolVersion`, `serverProtocolVersion`, `message` | a protocol-1 client (Kora 1.0.0-beta.12 or earlier) connected |
| `sync:unverified-legacy-operation` | `nodeId`, `operationId`, `collection`, `message` | a protocol-1 operation whose id could not be verified was stored |
| `sync:forged-duplicate` | `nodeId`, `operationId`, `collection`, `message` | an upload reused a stored operation id with different content (refused) |
| `sync:delivery-stalled` | `sessionId`, `watermark`, `outstandingMaxDeliverySequence`, `repeatCount`, `reason` | a client stopped acknowledging deliveries |

### Storage

| Event | Payload | Emitted | DevTools |
|-------|---------|---------|----------|
| `store:durability-lost` | `dbName`, `phase` (`open`, `promotion`), `reason`, `message` | **blocking**: no durable storage; writes are refused with `StorageDurabilityError` unless `allowNonDurable` | yes |
| `store:storage-blocked` | `dbName`, `resource`, `state` (`waiting`, `resolved`), `waitedMs?`, `message` | **blocking while waiting**: another holder has the database's OPFS storage | yes |
| `store:opfs-unavailable` | `dbName`, `reason`, `message` | OPFS could not be used and the store is not durable (emitted with `store:durability-lost`) | yes |
| `store:storage-fallback` | `dbName`, `from`, `to`, `reason`, `message` | OPFS was unavailable and the app opened on durable IndexedDB instead | yes |
| `store:storage-migrated` | `dbName`, `from`, `to`, `message` | data moved between storage locations (one copy remains) | yes |
| `store:db-name-collision` | `dbName`, `message` | another runtime on this origin uses this database name (shared on purpose for tabs of one app; a bug for separate apps) | yes |
| `store:persistence-error` | `dbName`, `message`, `code` | persisting failed | yes |
| `store:quota-exceeded` | `dbName`, `message` | a write exceeded the storage quota | yes |
| `store:log-integrity` | `dbName`, `repaired`, `quarantined`, `gaps`, `clean`, `message` | the open-time log scan repaired or quarantined rows | yes |
| `store:rematerialized` | `dbName`, `mode`, `records`, `changedRows`, `message` | records were rebuilt with the fold (first open after upgrading, or after a restore) | yes |
| `storage:persistence` | `state`, `persisted`, `message?` | the `navigator.storage` persistence check or request | yes |

### Queries and presence

| Event | Payload | Emitted | DevTools |
|-------|---------|---------|----------|
| `query:error` | `queryId`, `collection`, `phase`, `code`, `message` | a subscription failed (it keeps its last results) | yes |
| `awareness:updated` | `states` | presence states changed | no |

### Declared but not emitted

`query:subscribed`, `query:invalidated`, `query:executed`, `state-machine:transition`,
`state-machine:rejected` and `sync:apply-abandoned` are part of the `KoraEvent` type but no Kora
package emits them in 1.0.0-beta.13. Do not build on them. State-machine refusals surface as
`InvalidStateTransitionError` from the write.

---

## createApp integration

With `devtools: true`, `createApp` creates an `Instrumenter` on the app's emitter, forwards events to
the browser extension through `window.postMessage` and mounts the in-page overlay (toggle with
Ctrl+Shift+K, Cmd+Shift+K on macOS). In Node and server renders only the instrumenter runs.

## Instrumenter

<!-- docs-check: signature @korajs/devtools @korajs/core -->
```typescript
class Instrumenter {
  constructor(emitter: KoraEventEmitter, config?: {
    bufferSize?: number      // default 10000
    bridgeEnabled?: boolean  // default true: post events through a MessageBridge
    channelName?: string     // default 'kora-devtools'
  })
}
```

Methods: `getBuffer()`, `getBridge()`, `pause()`, `resume()`, `isPaused()`, `destroy()`. Events
received while paused are dropped. The recorded types are listed in the tables above.

```typescript
import { Instrumenter } from '@korajs/devtools'

const instrumenter = new Instrumenter(app.events, { bufferSize: 5000, bridgeEnabled: false })
const recent = instrumenter.getBuffer().getAll()
instrumenter.destroy()
```

## Building blocks

| Export | Description |
|--------|-------------|
| `EventBuffer(capacity = 10000)` | Ring buffer of `TimestampedEvent` (`{ id, event, receivedAt }`): `push`, `getAll`, `getRange(startId, endId)`, `getByType`, `clear`, `size`, `capacity`. |
| `MessageBridge(channelName = 'kora-devtools')` | `window.postMessage` transport: `send`, `onReceive`, `destroy`; a no-op without `window`. |
| `filterEvents(events, { categories?, types?, timeRange?, collection? })` | AND-combined filter. |
| `getEventCategory(type)` | `'operation' \| 'merge' \| 'sync' \| 'query' \| 'connection'`. |
| `computeStatistics(events)` | Counts by category and type, merge conflicts, constraint violations, average merge and query durations, sync totals. |
| `buildPanelModel(events)` | `{ timeline, conflicts, operations, network }`, the data behind the panels. |
| `renderDevtoolsPanel(target, events)` | Renders the panel with Preact. |
| `mountKoraDevtoolsOverlay(instrumenter)` (`@korajs/devtools/overlay`) | Mounts the overlay; returns a teardown function. |
| `PortRouter` | Routes `kora-content` ports to the `kora-panel` port of the same tab in the extension's background script. |
