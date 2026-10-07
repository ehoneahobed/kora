---
title: Sync API
description: "@korajs/sync API reference: app.sync, status types, the SyncEngine for custom runtimes, transports, protocol messages and constants, serializers, encryption, scope filtering and awareness."
---

# Sync API Reference

`createApp({ sync: { url } })` creates and runs the sync engine; apps use it through `app.sync`.
How to configure it is in [Sync Configuration](/guide/sync-configuration); what travels on the
wire is in [Sync Protocol](/guide/sync-protocol). This page lists the API.

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
| `connect()` / `disconnect()` / `reconnect()` | Lifecycle. With `autoConnect: true`, `createApp` connects once the store is ready. |
| `status` / `getStatus()` | The current `SyncStatusInfo`. |
| `subscribeStatus(listener)` | Status changes (event driven); returns an unsubscribe function. |
| `waitForSettled({ upload?, download?: 'active-view' \| false, timeoutMs?, signal? })` | Resolves to `{ outcome: 'settled' \| 'offline' \| 'suspended' \| 'blocked' \| 'timeout' \| 'aborted', status }` (plus `reason` or `failure`). |
| `setQuerySubsets(subsets)` | Replaces the static query-view manifest (`sync.querySubsets.mode: 'static'`). |
| `retryNow()` | Skips the current reconnect backoff. |
| `clearSchemaBlock()` | Clears a schema-mismatch block after the app upgraded; then `connect()`. |
| `exportDiagnostics()` | A `SyncDiagnostics` snapshot for support. |
| `getRejectedOperations()` / `clearRejectedOperations(ids)` | Operations the server refused (`RejectedOperation`: `operationId`, `collection`, `recordId`, `code`, `message`, `retriable`, `rejectedAt`). |
| `getHeldOperations()` / `assignHeld(nodeId, 'current-user')` / `discardHeld(nodeId)` | Writes held because they belong to another user or to nobody yet. See [Held writes](/guide/sync-configuration#held-writes). |

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
| `initialSync?` | `{ complete, receivedBatches, totalBatches, progress }`. |
| `activeViewId?`, `activeViewComplete?` | Query-view download state. |
| `blockedFailure?` | The `ActiveApplyFailure` blocking delivery (`operationId`, `collection`, `recordId`, `code`, `message`, `retriable`, `firstSeenAt`, `retryCount`), if any. |
| `heldOperations?`, `heldNodes?` | Held writes. |
| `localDurability?` | `'degraded'` when the local database could not be made durable repeatedly. |
| `serverProtocolVersion?`, `protocolDeprecated?` | Protocol of the current session. |

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

`SyncStore` is the store's sync surface (`@korajs/store`'s `Store` implements it): applying remote
operations returns an `ApplyResult` (`'applied'`, `'duplicate'`, `'skipped'`, `'rejected'` or
`'deferred'`; the last three carry an `ApplyFailureReason` `{ code, message, retriable }`). A failed operation stalls the delivery
watermark and is retried or quarantined, never skipped.

---

## Transports

<!-- docs-check: signature @korajs/sync @korajs/core -->
```typescript
interface SyncTransport {
  connect(url: string, options?: { authToken?: string; headers?: Record<string, string> }): Promise<void>
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
| `HttpLongPollingTransport` (`transport: 'http'` or `http(s)://` URLs) | `serializer`, `fetchImpl`, `retryDelayMs`, `preferWebSocket`, `webSocketFactory`. Sessions are identified by the `HTTP_SYNC_SESSION_HEADER` header and authenticated on every request. |
| `ChaosTransport(inner, config)` | Test wrapper: `dropRate`, `duplicateRate`, `reorderRate`, `maxLatency`, `randomSource`, `dropPredicate`. |

`ConnectionMonitor` (connection quality from RTT and errors) and `ReconnectionManager` (exponential
backoff from 1 s to 30 s with 25% jitter, reset after 10 s of stable connection) are exported for
custom engines.

---

## Protocol

`SYNC_PROTOCOL_VERSION` is `2`; `LEGACY_SYNC_PROTOCOL_VERSION` is `1` (Kora 1.0.0-beta.12 and
earlier, accepted with a deprecation in 1.0.0-beta.13 only). Message types (`SyncMessage` union):
`HandshakeMessage`, `HandshakeResponseMessage`, `OperationBatchMessage`, `AcknowledgmentMessage`,
`OperationRejectedMessage`, `ErrorMessage`, `HeartbeatMessage`, `AwarenessUpdateMessage`,
`YjsDocUpdateMessage`, the blob chunk messages and the encryption key messages, each with an `is*`
type guard (`isSyncMessage`, `isHandshakeMessage`, ...). Their fields are listed in
[Sync Protocol](/guide/sync-protocol#handshake-fields).

| Constant | Meaning |
|----------|---------|
| `INVALID_OPERATION_ID` | An operation's id does not match its content hash. |
| `PLAINTEXT_REJECTED` | A plaintext operation where the session requires encryption. |
| `PROTOCOL_V1_DEPRECATED` | Warning code for protocol-1 peers. |
| `SCHEMA_MISMATCH_PREFIX`, `isSchemaMismatchReject`, `isClientSchemaVersionSupported` | Schema-version negotiation. |

### Serializers

`MessageSerializer` has `encode`, `decode`, `encodeOperation`, `decodeOperation` and optional
`setWireFormat`/`getWireFormat`. `JsonMessageSerializer` is what Kora uses: protocol v2 is JSON
(`WireFormat` `'json'`). `ProtobufMessageSerializer` and `NegotiatedMessageSerializer` encode the
protobuf envelope, but no Kora server or client negotiates protobuf today (the server advertises
`supportedWireFormats: ['json']`). `versionVectorToWire` and `wireToVersionVector` convert vectors.

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
matches everything. `InvalidScopeError` and `ScopeViolationError` are thrown for malformed scopes
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
(`app.blobs.pull`). Both are wired by `createApp`.

## Status controllers

`createSyncStatusController({ ... })` and `OFFLINE_SYNC_STATUS` back the framework bindings'
`useSyncStatus`; use them to build a binding for another UI framework.
