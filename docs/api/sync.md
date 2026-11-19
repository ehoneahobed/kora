---
title: Sync API
description: "@korajs/sync API reference: app.sync, status types, the SyncEngine for custom runtimes, transports, protocol messages and constants, serializers, encryption, scope filtering and awareness."
---

# Sync API Reference

`createApp({ sync: { url } })` creates and runs the sync engine; apps use it through `app.sync`.
How to configure it is in [Sync Configuration](/guide/sync-configuration); what travels on the
wire is in [Sync Protocol](/guide/sync-protocol). This page lists the API.

| Entry point | Contents |
|-------------|----------|
| `@korajs/sync` | Everything below. |
| `@korajs/sync/lite` | What the first paint needs before the engine loads: `createSyncStatusController`, `OFFLINE_SYNC_STATUS`, `summarizeSyncStatus`, the read-through client and config checks. |
| `@korajs/sync/read` | The read-through client (`ReadThroughClient`, `ReadThroughError`) and its types (`ReadQuery`, `ReadRequest`, `ReadResult`, ...). |
| `@korajs/sync/protobuf` | `ProtobufMessageSerializer`, `NegotiatedMessageSerializer` (see [Serializers](#serializers)). |

<!-- docs-check-prelude
import { createApp, defineSchema, t } from 'korajs'
const schema = defineSchema({ version: 1, collections: { todos: { fields: { title: t.string() } } } })
const app = createApp({ schema, sync: { url: 'wss://sync.example.com/kora-sync' } })
-->

---

## app.sync

`app.sync` is `null` when sync is not configured.

| Member | Description |
|--------|-------------|
| `connect()` / `disconnect()` / `reconnect()` | Lifecycle. `connect()` may be called before `app.ready`: the connection starts in parallel with opening the store (with `autoConnect: true`, at once). |
| `status` / `getStatus()` | The current `SyncStatusInfo`. |
| `subscribeStatus(listener)` | Status changes (event driven); returns an unsubscribe function. |
| `waitForSettled({ upload?, download?: 'active-view' \| false, timeoutMs?, signal? })` | Resolves to `{ outcome: 'settled' \| 'offline' \| 'suspended' \| 'blocked' \| 'timeout' \| 'aborted', status }` (plus `reason` or `failure`). |
| `setQuerySubsets(subsets)` | Replaces the static query-view manifest (`sync.querySubsets.mode: 'static'`). |
| `retryNow()` | Skips the current reconnect backoff. |
| `clearSchemaBlock()` | Clears a schema-mismatch block after the app upgraded; then `connect()`. |
| `exportDiagnostics()` | A `SyncDiagnostics` snapshot for support. |
| `getRejectedOperations()` / `clearRejectedOperations(ids)` | Operations the server refused (`RejectedOperation`: `operationId`, `collection`, `recordId`, `code`, `message`, `retriable`, `rejectedAt`). |
| `getHeldOperations()` / `assignHeld(nodeId, 'current-user')` / `discardHeld(nodeId)` | Writes held because they belong to another user or to nobody yet. `discardHeld` removes them for good; a journal node carries `oldestWrittenAt` for showing how long it has waited. See [Held writes](/guide/sync-configuration#held-writes). |

Once a newer build of the app has retired this tab (see [App updates](/guide/app-updates)), every
member that connects or changes persisted sync state (`connect`, `reconnect`, `retryNow`,
`setQuerySubsets`, `clearRejectedOperations`, `assignHeld`, `discardHeld`) rejects with
`BuildSupersededError`, and no automatic reconnect starts. Queued writes stay in the outbound
queue for the new build to upload.

```typescript
const unsubscribe = app.sync?.subscribeStatus((status) => {
  console.log(status.status, status.pendingOperations)
})

const result = await app.sync?.waitForSettled({ upload: true, timeoutMs: 10_000 })
if (result?.outcome === 'blocked') console.warn(result.failure.code)
```

### Status types

`SyncStatus` (developer view): `'connected'`, `'reconnecting'`, `'syncing'`, `'synced'`,
`'offline'`, `'clock-error'`, `'error'`, `'schema-mismatch'`, `'auth-required'`,
`'encryption-locked'` (`SYNC_STATUSES`).
`SyncState` (engine state): `'disconnected'`, `'connecting'`, `'handshaking'`, `'syncing'`,
`'streaming'`, `'error'` (`SYNC_STATES`).

`SyncStatusInfo`:

| Field | Description |
|-------|-------------|
| `status`, `phase?`, `reason?` | `phase` is one of `suspended`, `offline`, `connecting`, `authenticating`, `handshaking`, `uploading`, `receiving`, `applying`, `streaming`, `blocked`. |
| `reconnecting` | A reconnect is scheduled. |
| `pendingOperations`, `inFlightUploadOperations?` | Local writes not yet acknowledged. |
| `lastSyncedAt`, `lastSuccessfulPush`, `lastSuccessfulPull` | Timestamps (ms) or `null`. |
| `conflicts` | Merge conflicts seen this session. |
| `clockSkewMs` | Server minus local clock, measured at the handshake. |
| `deliveryWatermark?`, `serverFrontier?`, `hasInFlightDeliveryBatch?` | Download progress (see [Delivery watermark](/guide/sync-protocol#delivery-watermark)). |
| `initialSync?` | `{ complete, receivedBatches, totalBatches, progress, first? }`. The counters restart every session; `first` is true only when this session's catch-up started from nothing (delivery watermark 0), the device's first download. |
| `activeViewId?`, `activeViewComplete?` | Query-view download state. |
| `blockedFailure?` | The `ActiveApplyFailure` blocking delivery (`operationId`, `collection`, `recordId`, `code`, `message`, `retriable`, `firstSeenAt`, `retryCount`), if any. |
| `heldOperations?`, `heldNodes?` | Held writes. |
| `localDurability?` | `'degraded'` when the local database could not be made durable repeatedly. |
| `serverProtocolVersion?`, `protocolDeprecated?` | Protocol the server answered with; `protocolDeprecated` is true against a server older than this client's protocol (a pre-beta.13 server): upgrade the server. |

---

## SyncEngine

The engine behind `app.sync`, for runtimes that do not use `createApp` (custom stores, tests).

<!-- docs-check: signature @korajs/sync @korajs/core -->
```typescript
class SyncEngine {
  constructor(options: {
    transport: SyncTransport
    store: SyncStore                 // the local store's sync surface
    config: SyncConfig               // the same object as createApp's `sync`
    serializer?: MessageSerializer   // default: JSON
    emitter?: KoraEventEmitter
    queueStorage?: QueueStorage      // persists the outbound queue
    rejectedStorage?: RejectedOperationStorage
    syncState?: SyncStatePersistence // persists the delivery watermark
    keyring?: EncryptionKeyring      // end-to-end encryption
    encryptor?: SyncEncryptor        // low-level alternative to keyring
    keyServiceTimeoutMs?: number     // how long a key-record request may take
    metricsConfig?: { rttWindowSize?: number; bandwidthWindowSize?: number; diagnosticsInterval?: number }
  })
}
```

Main methods: `start()`, `stop()`, `destroy()`, `reconnect()`, `retryNow()`, `pushOperation(op)`,
`getStatus()`, `onStatusChange(listener)`, `getState()`, `onStateChange(listener)`,
`exportDiagnostics()`, `updateScope(scopeMap)`, `registerQuerySubset(subset)`,
`setQuerySubsets(subsets)`, `getRejectedOperations()`, `clearRejectedOperations(ids)`,
`getQuarantinedOperations()`, `retryQuarantinedOperations()`, `getHeldNodes()`, `assignHeld(nodeId)`,
`discardHeld(nodeId)`, `getAwarenessManager()`, `getRichtextDocChannel()`, `getBlobChunkChannel()`.
A `start()` cancelled by `stop()` or `destroy()` settles without an error; a stopped engine keeps
no timer running, so a Node process can exit.

`SyncStore` is the store's sync surface (`@korajs/store`'s `Store` implements it): applying remote
operations returns an `ApplyResult` (`'applied'`, `'duplicate'`, `'skipped'`, `'rejected'` or
`'deferred'`; the last three carry an `ApplyFailureReason` `{ code, message, retriable }`). A failed operation stalls the delivery
watermark and is retried or quarantined, never skipped.

Optional `SyncStore` members make delivery faster or enable features; a store written for an
earlier release keeps the per-operation path without them: `applyDeliveryBatch` (a whole delivery
batch in one storage transaction, in chunks of at most 500 operations), `beginBulkReplication`
(staged first sync, see `sync.bulkReplication`) and `applyCollectionNarrowing` (access rules: a
store without it reports `ACCESS_NARROWING_UNSUPPORTED` and delivery stops at that batch, visibly,
through `blockedFailure` and `sync:apply-blocked`). `SyncStatePersistence` gains the optional
`loadDeliveryAnchors` and `saveDeliveryAnchor` (see
[Delivery watermark](/guide/sync-protocol#delivery-watermark)).

---

## Transports

<!-- docs-check: signature @korajs/sync @korajs/core -->
```typescript
interface SyncTransport {
  connect(url: string, options?: { authToken?: string; headers?: Record<string, string> }): Promise<void>
  warmUp?(url: string): void       // optional: open the connection early while the store opens
  disconnect(): Promise<void>
  send(message: SyncMessage): void
  onMessage(handler: (message: SyncMessage) => void): void
  onClose(handler: (reason: string) => void): void
  onError(handler: (error: Error) => void): void
  isConnected(): boolean
}
```

| Class | Options |
|-------|---------|
| `WebSocketTransport` (the default for `ws://`/`wss://`) | `serializer`, `WebSocketImpl` (Node: pass `ws`), `connectTimeout`, `tokenInUrl` (default `false`: the token travels in the handshake), `heartbeat` (default on, every 25 s), `heartbeatTimeoutFactor` |
| `HttpLongPollingTransport` (`transport: 'http'`, with an `http(s)://` URL) | `serializer`, `fetchImpl`, `retryDelayMs`, `preferWebSocket`, `webSocketFactory`. Sessions are identified by the `HTTP_SYNC_SESSION_HEADER` header and authenticated on every request. |
| `ChaosTransport(inner, config)` | Test wrapper: `dropRate`, `duplicateRate`, `reorderRate`, `maxLatency`, `randomSource`, `dropPredicate`. |

`ConnectionMonitor` (connection quality from RTT and errors) and `ReconnectionManager` (exponential
backoff from 1 s to 30 s with 25% jitter, reset after 10 s of stable connection) are exported for
custom engines.

---

## Protocol

`SYNC_PROTOCOL_VERSION` is `2`; `LEGACY_SYNC_PROTOCOL_VERSION` is `1`, the version assumed for a
handshake that declares none (Kora 1.0.0-beta.12 and earlier, accepted with a deprecation in
1.0.0-beta.13 and beta.14, refused since 1.0.0-beta.15). Message types (`SyncMessage` union):
`HandshakeMessage`, `HandshakeResponseMessage`, `OperationBatchMessage`, `AcknowledgmentMessage`,
`OperationRejectedMessage`, `ErrorMessage`, `HeartbeatMessage`, `DeviceStatusMessage`, `AwarenessUpdateMessage`,
`YjsDocUpdateMessage`, the blob chunk messages and the encryption key messages, each with an `is*`
type guard (`isSyncMessage`, `isHandshakeMessage`, ...). Their fields are listed in
[Sync Protocol](/guide/sync-protocol#handshake-fields).

| Constant | Meaning |
|----------|---------|
| `INVALID_OPERATION_ID` | An operation's id does not match its content hash. |
| `PLAINTEXT_REJECTED` | A plaintext operation where the session requires encryption. |
| `PROTOCOL_VERSION_UNSUPPORTED` | Handshake refusal for a client below the server's protocol. |
| `SCHEMA_MISMATCH_PREFIX`, `isSchemaMismatchReject`, `isClientSchemaVersionSupported` | Schema-version negotiation. |
| `MAX_PROBE_OPERATION_IDS` | `500`: most operation ids one handshake asks the server about (`probeOperationIds`). |

### Serializers

`MessageSerializer` has `encode`, `decode`, `encodeOperation`, `decodeOperation` and optional
`setWireFormat`/`getWireFormat`. `JsonMessageSerializer` is what Kora uses and the sync engine's
default: protocol v2 is JSON (`WireFormat` `'json'`). `ProtobufMessageSerializer` and
`NegotiatedMessageSerializer` encode the protobuf envelope, but no Kora server or client negotiates
protobuf today (the client offers `supportedWireFormats: ['json']` in its handshake and the server
answers with `selectedWireFormat`). protobufjs is opt-in: both classes are also exported from
`@korajs/sync/protobuf`, and `@korajs/sync` declares `sideEffects: false`, so a bundle that does not
import them does not contain protobufjs. `HttpLongPollingTransport` still defaults to the
negotiated serializer (JSON unless told otherwise), loaded when it connects.
`versionVectorToWire` and `wireToVersionVector` convert vectors.

### Delta cursors

`encodeDeltaCursor`, `decodeDeltaCursor`, `createDeltaCursorFromBatch` and
`sliceOperationsAfterCursor` handle the resumable cursor of paginated delta batches.

---

## Scope filtering

<!-- docs-check: signature @korajs/sync @korajs/core -->
```typescript
type SyncScopeMap = Record<string, Record<string, unknown>>   // collection -> field filters

function operationMatchesScope(op: Operation, scopeMap: SyncScopeMap | undefined, fullRecord?: Record<string, unknown> | null): boolean
function filterOperationsByScope(operations: Operation[], scopeMap: SyncScopeMap | undefined): Operation[]

interface SyncQuerySubset { collection: string; where: Record<string, unknown> }
function querySubsetContains(broad: SyncQuerySubset[], narrow: SyncQuerySubset[]): boolean
function dedupeQuerySubsets(subsets: SyncQuerySubset[]): SyncQuerySubset[]
```

The server applies scopes; these helpers exist for custom servers and tests. A missing scope map
matches everything. A collection's scope is a conjunction of field predicates (a value, or exactly
`{ $in: [...] }`), or `{ $or: [conjunction, ...] }` with up to 8 branches; every decision goes
through one matcher in `@korajs/core`, which fails closed on a malformed scope. A client declares
`supportsScopeDisjunction` at the handshake; a server refuses a client that does not (Kora
1.0.0-beta.14 and earlier) with `CLIENT_TOO_OLD` when its grant contains `$or`. `InvalidScopeError` and `ScopeViolationError` are thrown for malformed scopes
and out-of-scope writes.

---

## Encryption

End-to-end encryption is configured with `sync.encryption` and controlled through `app.encryption`;
see [Sync Encryption](/guide/sync-encryption). Exports for custom setups:

| Export | Description |
|--------|-------------|
| `EncryptionKeyring` | The per-user keyring behind `app.encryption` (`getStatus`, `onStatusChange`, `unlock`, `lock`, `rotate`, `changePassphrase`, `enableRecovery`, `recover`). Pass it as `new SyncEngine({ keyring })`. |
| `createKeyCache('auto' \| 'indexeddb' \| 'memory' \| 'none')`, `IndexedDbKeyCache`, `MemoryKeyCache`, `NoKeyCache` | Where unlocked keys are kept. |
| `SyncEncryptor.fromKeys([{ version, key, keyId }])` / `SyncEncryptor.create(config, salt)` | Low-level encryptor from your own keys, or from a passphrase and a salt every device shares. |
| `deriveKey(passphrase, salt?)`, `deriveVersionedKey(...)`, `generateSalt()` | PBKDF2-SHA-256 key derivation (600 000 iterations); store the salt to derive the same key again. |
| `validateEncryptedRelations(schema, encryptionConfig)` | Refuses configurations that encrypt foreign keys of enforced relations (`SealedRelationFieldError`). |
| `isEncryptedPayload(value)` | Detects the 1.0.0-beta.12 payload format. |
| Errors | `EncryptionError`, `DecryptionError`, `KeyDerivationError`, `EncryptionKeyError` (status codes such as `WRONG_PASSPHRASE`, `PASSPHRASE_REQUIRED`, `KEY_ID_MISMATCH`, `KEY_SERVICE_UNSUPPORTED`), `KeyUnwrapError`. |

---

## Awareness (presence)

`AwarenessManager({ clientId?, emitter?, timeoutMs? })` (default timeout 30 s) holds ephemeral
presence: `setLocalState(state | null)`, `getLocalState()`, `getStates()`,
`on('change', listener)`, `off`, `destroy()`. A state is
`{ user: { name, color, avatar? }, cursor?: { collection, recordId, field, anchor, head } }`.
Presence is not persisted. A state whose `cursor` names a record is relayed to the sessions whose
download scope contains that record; a state without a cursor only to sessions with the same
download scope (see [Presence](/guide/presence#who-sees-a-presence-state)). With an emitter, changes
emit `awareness:updated`.

```typescript
app.getSyncEngine()?.getAwarenessManager().setLocalState({
  user: { name: 'Bob', color: '#4ecdc4' },
})
```

In React use `usePresence` and `useCollaborators` (see [Presence](/guide/presence)).
`getRemoteAwarenessStates` and `subscribeRemoteAwarenessStates` back those hooks.

## Rich text and blobs on the connection

`RichtextDocChannel` streams Yjs updates of large rich-text fields over the connection
(`YjsDocUpdateMessage`, authorized per record) instead of whole operations;
`DEFAULT_RICHTEXT_DOC_CHANNEL_THRESHOLD` sets when it is used. `BlobChunkChannel` moves blob chunks
(`app.blobs.pull`). Both are wired by `createApp`. Blob messages go out once the handshake is
accepted (`syncing` or `streaming`); `BlobChunkChannel.send` returns `false` when it could not
send, and `onReady(handler)` is called after each accepted handshake, where the chunk provider
re-sends its pending requests.

## Status controllers

`createSyncStatusController({ ... })` and `OFFLINE_SYNC_STATUS` back the framework bindings'
`useSyncStatus`; use them to build a binding for another UI framework.

`summarizeSyncStatus(status, { syncConfigured? })` turns a `SyncStatusInfo` into what an indicator
shows: `{ state, tone, title, detail, pending, lastSyncedAt, downloading, progress }`. `tone` is
`ok`, `working` (offline counts as working: the data is safe on the device) or `attention`
(someone has to act). `downloading` is true only during the device's first download
(`initialSync.first`), never for the catch-up after a reconnect. It backs `useSyncSummary()` in
React, Vue and Svelte, and is also exported from `@korajs/sync/lite` and `korajs`.

```typescript
import { summarizeSyncStatus } from '@korajs/sync'

const summary = app.sync ? summarizeSyncStatus(app.sync.status) : null
console.log(summary?.title, summary?.detail)
```

## Read-through

`ReadThroughClient({ url, schemaVersion, auth?, cookies?, fetch?, maxAttempts?, maxRetryDelayMs? })`
answers queries from the sync server's read endpoint (`POST <syncPath>/read`) before the local
store holds the data. `createApp` uses it for `sync.firstVisit.readThrough`; apps rarely construct
it. `read(query, { signal? })` resolves to `{ frontier, grantKey, result }`; queries made in the same
turn travel in one request (at most `MAX_READ_QUERIES`, 8). Retriable failures are retried
(3 attempts by default, waits up to 5 s); failures reject with `ReadThroughError` (`retriable`
says whether asking later can succeed). The server side is `readThrough` on `KoraSyncServer`
(see [Server API](/api/server)).
