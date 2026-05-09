# Sync API Reference

`@korajs/sync` implements the Kora sync protocol: delta exchange, real-time streaming, and transport abstraction. It connects a local `SyncStore` to a remote sync server over any pluggable transport.

## Imports

```typescript
import {
  // Engine
  SyncEngine,
  OutboundQueue,
  ConnectionMonitor,
  ReconnectionManager,

  // Transports
  WebSocketTransport,
  HttpLongPollingTransport,
  ChaosTransport,

  // Serializers
  JsonMessageSerializer,
  ProtobufMessageSerializer,
  NegotiatedMessageSerializer,

  // Utilities
  versionVectorToWire,
  wireToVersionVector,

  // Scope Filtering
  operationMatchesScope,
  filterOperationsByScope,

  // Encryption
  SyncEncryptor,
  EncryptionError,
  DecryptionError,
  KeyDerivationError,
  isEncryptedPayload,
  deriveKey,
  deriveVersionedKey,
  generateSalt,

  // Awareness / Presence
  AwarenessManager,

  // Type guards
  isSyncMessage,
  isHandshakeMessage,
  isHandshakeResponseMessage,
  isOperationBatchMessage,
  isAcknowledgmentMessage,
  isErrorMessage,
  isAwarenessUpdateMessage,

  // Constants
  SYNC_STATES,
  SYNC_STATUSES,
} from '@korajs/sync'
```

```typescript
import type {
  // Engine options
  SyncEngineOptions,
  SyncDiagnostics,
  OutboundBatch,
  ConnectionMonitorConfig,
  ReconnectionConfig,

  // Transport
  SyncTransport,
  TransportOptions,
  TransportMessageHandler,
  TransportCloseHandler,
  TransportErrorHandler,
  WebSocketTransportOptions,
  WebSocketLike,
  WebSocketConstructor,
  HttpLongPollingTransportOptions,
  ChaosConfig,

  // Protocol
  SyncMessage,
  HandshakeMessage,
  HandshakeResponseMessage,
  OperationBatchMessage,
  AcknowledgmentMessage,
  ErrorMessage,
  SerializedOperation,
  WireFormat,
  MessageSerializer,

  // Encryption
  SyncEncryptionConfig,
  SyncEncryptionAlgorithm,
  EncryptedPayload,
  VersionedKey,

  // Awareness
  AwarenessState,
  AwarenessUser,
  AwarenessCursor,
  AwarenessChange,
  AwarenessMessage,
  CursorInfo,
  AwarenessStateWire,
  AwarenessUpdateMessage,

  // Store
  SyncStore,
  ApplyResult,

  // Types
  SyncConfig,
  SyncState,
  SyncStatus,
  SyncStatusInfo,
  SyncScopeContext,
  SyncScopeMap,
  QueueStorage,
} from '@korajs/sync'
```

---

## `SyncEngine`

Core sync orchestrator. Manages the full sync lifecycle as a state machine:

```
disconnected -> connecting -> handshaking -> syncing -> streaming
```

Coordinates handshake, version-vector delta exchange, and real-time bidirectional streaming between a local store and a remote sync server.

### Constructor

```typescript
const engine = new SyncEngine(options: SyncEngineOptions)
```

### `SyncEngineOptions`

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `transport` | `SyncTransport` | Yes | -- |
| `store` | `SyncStore` | Yes | -- |
| `config` | `SyncConfig` | Yes | -- |
| `serializer` | `MessageSerializer` | No | `NegotiatedMessageSerializer('json')` |
| `emitter` | `KoraEventEmitter` | No | `null` |
| `queueStorage` | `QueueStorage` | No | In-memory |
| `encryptor` | `SyncEncryptor` | No | `null` |
| `metricsConfig` | `MetricsCollectorConfig` | No | See Diagnostics section |

When an `encryptor` is provided, operation `data` and `previousData` fields are encrypted before sending and decrypted after receiving. The server never sees plaintext data. See the [E2E Sync Encryption](#e2e-sync-encryption) section.

### Methods

- **`start(): Promise<void>`** -- Connect, handshake, exchange deltas, then enter streaming mode. Throws if the engine is not in `disconnected` state.
- **`stop(): Promise<void>`** -- Disconnect the transport. Returns any in-flight batch to the outbound queue. No-op if already disconnected.
- **`pushOperation(op: Operation): Promise<void>`** -- Enqueue a local operation for sync. If currently streaming, flushes the queue immediately.
- **`getStatus(): SyncStatusInfo`** -- Returns the developer-facing sync status (see `SyncStatusInfo` below).
- **`getState(): SyncState`** -- Returns the internal state machine state. Primarily for testing.
- **`setReconnecting(value: boolean): void`** -- When `true`, `getStatus()` reports `'offline'` during intermediate states (connecting, handshaking, syncing) instead of `'syncing'`.
- **`getOutboundQueue(): OutboundQueue`** -- Access the outbound queue. Primarily for testing.
- **`exportDiagnostics(): SyncDiagnostics`** -- Export a diagnostics snapshot for debugging and support. Contains connection state, timing info, and queue metrics. See the [Sync Diagnostics](#sync-diagnostics--metrics) section.
- **`getAwarenessManager(): AwarenessManager`** -- Access the awareness manager for presence and cursor sharing. See the [Awareness / Presence](#awareness--presence-protocol) section.

### Example

```typescript
import { SyncEngine, WebSocketTransport } from '@korajs/sync'

const engine = new SyncEngine({
  transport: new WebSocketTransport(),
  store: myLocalStore,   // implements SyncStore
  config: {
    url: 'wss://my-server.com/kora',
    auth: async () => ({ token: await getAuthToken() }),
    batchSize: 50,
    schemaVersion: 1,
  },
})

await engine.start()

// Push local mutations
await engine.pushOperation(operation)

// Check status
const info = engine.getStatus()
// { status: 'synced', pendingOperations: 0, lastSyncedAt: 1715097600000 }

await engine.stop()
```

---

## Transports

All transports implement the `SyncTransport` interface.

### `SyncTransport` (interface)

```typescript
interface SyncTransport {
  connect(url: string, options?: TransportOptions): Promise<void>
  disconnect(): Promise<void>
  send(message: SyncMessage): void
  onMessage(handler: TransportMessageHandler): void
  onClose(handler: TransportCloseHandler): void
  onError(handler: TransportErrorHandler): void
  isConnected(): boolean
}
```

### `TransportOptions`

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `authToken` | `string` | No | -- |
| `headers` | `Record<string, string>` | No | -- |

### `WebSocketTransport`

WebSocket-based transport. Primary transport for real-time sync.

```typescript
const transport = new WebSocketTransport(options?: WebSocketTransportOptions)
```

#### `WebSocketTransportOptions`

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `serializer` | `MessageSerializer` | No | `JsonMessageSerializer` |
| `WebSocketImpl` | `WebSocketConstructor` | No | `globalThis.WebSocket` |
| `connectTimeout` | `number` (ms) | No | `10000` |

Auth tokens are appended as a `?token=` query parameter on the connection URL.

```typescript
import { WebSocketTransport } from '@korajs/sync'

const transport = new WebSocketTransport({
  connectTimeout: 5000,
})

await transport.connect('wss://my-server.com/kora', {
  authToken: 'my-jwt-token',
})
```

### `HttpLongPollingTransport`

HTTP long-polling fallback with automatic WebSocket upgrade. If `preferWebSocket` is `true` (the default), the transport attempts a WebSocket connection first and falls back to long-polling on failure.

```typescript
const transport = new HttpLongPollingTransport(options?: HttpLongPollingTransportOptions)
```

#### `HttpLongPollingTransportOptions`

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `serializer` | `MessageSerializer` | No | `NegotiatedMessageSerializer('json')` |
| `fetchImpl` | `typeof fetch` | No | `globalThis.fetch` |
| `retryDelayMs` | `number` | No | `250` |
| `preferWebSocket` | `boolean` | No | `true` |
| `webSocketFactory` | `() => SyncTransport` | No | Creates `WebSocketTransport` |

URL schemes are normalized automatically: `ws://` / `wss://` become `http://` / `https://` for polling, and vice versa for the WebSocket upgrade.

### `ChaosTransport`

Wraps another transport and injects faults for testing sync convergence under unreliable conditions. Supports message dropping, duplication, reordering, and latency injection.

```typescript
const chaos = new ChaosTransport(inner: SyncTransport, config?: ChaosConfig)
```

#### `ChaosConfig`

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `dropRate` | `number` (0-1) | No | `0` |
| `duplicateRate` | `number` (0-1) | No | `0` |
| `reorderRate` | `number` (0-1) | No | `0` |
| `maxLatency` | `number` (ms) | No | `0` |
| `randomSource` | `() => number` | No | `Math.random` |

All random behavior is injectable via `randomSource` for deterministic, reproducible tests.

```typescript
import { ChaosTransport, WebSocketTransport } from '@korajs/sync'

const chaos = new ChaosTransport(new WebSocketTransport(), {
  dropRate: 0.1,
  duplicateRate: 0.05,
  reorderRate: 0.05,
  maxLatency: 500,
})
```

---

## Protocol Messages

All messages are discriminated by the `type` field.

### `SyncMessage` (union)

```typescript
type SyncMessage =
  | HandshakeMessage
  | HandshakeResponseMessage
  | OperationBatchMessage
  | AcknowledgmentMessage
  | ErrorMessage
```

### `HandshakeMessage`

Sent by the client to initiate sync.

| Field | Type | Description |
|-------|------|-------------|
| `type` | `'handshake'` | |
| `messageId` | `string` | Unique message identifier |
| `nodeId` | `string` | Client node ID |
| `versionVector` | `Record<string, number>` | Client's current version vector |
| `schemaVersion` | `number` | Client schema version |
| `authToken` | `string?` | Optional auth token |
| `supportedWireFormats` | `WireFormat[]?` | `['json', 'protobuf']` |

### `HandshakeResponseMessage`

Server response to a handshake.

| Field | Type | Description |
|-------|------|-------------|
| `type` | `'handshake-response'` | |
| `messageId` | `string` | Unique message identifier |
| `nodeId` | `string` | Server node ID |
| `versionVector` | `Record<string, number>` | Server's current version vector |
| `schemaVersion` | `number` | Server schema version |
| `accepted` | `boolean` | Whether the handshake was accepted |
| `rejectReason` | `string?` | Reason if rejected |
| `selectedWireFormat` | `WireFormat?` | Negotiated wire format |

### `OperationBatchMessage`

Batch of operations sent during delta exchange or streaming.

| Field | Type | Description |
|-------|------|-------------|
| `type` | `'operation-batch'` | |
| `messageId` | `string` | Unique message identifier |
| `operations` | `SerializedOperation[]` | Operations in this batch |
| `isFinal` | `boolean` | `true` if last batch in delta exchange |
| `batchIndex` | `number` | 0-based batch index |

### `AcknowledgmentMessage`

Confirms receipt of a message.

| Field | Type | Description |
|-------|------|-------------|
| `type` | `'acknowledgment'` | |
| `messageId` | `string` | Unique message identifier |
| `acknowledgedMessageId` | `string` | ID of the message being acknowledged |
| `lastSequenceNumber` | `number` | Last sequence number in the acknowledged batch |

### `ErrorMessage`

| Field | Type | Description |
|-------|------|-------------|
| `type` | `'error'` | |
| `messageId` | `string` | Unique message identifier |
| `code` | `string` | Error code |
| `message` | `string` | Human-readable error description |
| `retriable` | `boolean` | Whether the client should retry |

### `SerializedOperation`

Wire-format operation. Identical to `Operation` but uses `Record` instead of `Map` for JSON compatibility.

| Field | Type |
|-------|------|
| `id` | `string` |
| `nodeId` | `string` |
| `type` | `'insert' \| 'update' \| 'delete'` |
| `collection` | `string` |
| `recordId` | `string` |
| `data` | `Record<string, unknown> \| null` |
| `previousData` | `Record<string, unknown> \| null` |
| `timestamp` | `HLCTimestamp` |
| `sequenceNumber` | `number` |
| `causalDeps` | `string[]` |
| `schemaVersion` | `number` |

### `WireFormat`

```typescript
type WireFormat = 'json' | 'protobuf'
```

### Type Guards

All type guards accept `unknown` and return a type predicate:

- `isSyncMessage(value): value is SyncMessage`
- `isHandshakeMessage(value): value is HandshakeMessage`
- `isHandshakeResponseMessage(value): value is HandshakeResponseMessage`
- `isOperationBatchMessage(value): value is OperationBatchMessage`
- `isAcknowledgmentMessage(value): value is AcknowledgmentMessage`
- `isErrorMessage(value): value is ErrorMessage`

---

## `OutboundQueue`

Manages operations waiting to be sent to the sync server. Deduplicates by operation ID (content-addressed) and maintains causal order via topological sort. Persistence is pluggable via `QueueStorage`.

```typescript
const queue = new OutboundQueue(storage: QueueStorage)
```

### Methods

- **`initialize(): Promise<void>`** -- Load persisted operations from storage. Must be called before any other method.
- **`enqueue(op: Operation): Promise<void>`** -- Add an operation. Deduplicates by ID. Persists to storage.
- **`takeBatch(batchSize: number): OutboundBatch | null`** -- Take up to `batchSize` operations from the front of the queue. Moves them to in-flight status. Returns `null` if empty.
- **`acknowledge(batchId: string): Promise<void>`** -- Confirm a batch was successfully sent. Removes operations from persistent storage.
- **`returnBatch(batchId: string): void`** -- Return a failed in-flight batch to the front of the queue for retry.
- **`peek(count: number): Operation[]`** -- View the first `count` operations without removing them.

### Properties

- **`size: number`** -- Operations waiting in the queue (excludes in-flight).
- **`totalPending: number`** -- All operations including in-flight.
- **`hasOperations: boolean`** -- Whether the queue has any operations to send.
- **`isInitialized: boolean`** -- Whether `initialize()` has been called.

### `OutboundBatch`

```typescript
interface OutboundBatch {
  batchId: string
  operations: Operation[]
}
```

### `QueueStorage` (interface)

Implement this to persist the outbound queue (e.g., to IndexedDB).

```typescript
interface QueueStorage {
  load(): Promise<Operation[]>
  enqueue(op: Operation): Promise<void>
  dequeue(ids: string[]): Promise<void>
  count(): Promise<number>
}
```

---

## `ConnectionMonitor`

Tracks connection quality based on RTT latency samples, missed acknowledgments, and activity timestamps.

```typescript
const monitor = new ConnectionMonitor(config?: ConnectionMonitorConfig)
```

### `ConnectionMonitorConfig`

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `windowSize` | `number` | No | `20` |
| `staleThreshold` | `number` (ms) | No | `30000` |
| `timeSource` | `TimeSource` | No | `Date.now` |

### Methods

- **`recordLatency(ms: number): void`** -- Record a round-trip time sample. Resets missed ack counter.
- **`recordMissedAck(): void`** -- Record a missed acknowledgment.
- **`recordActivity(): void`** -- Record any send/receive activity.
- **`getQuality(): ConnectionQuality`** -- Assess current quality (see thresholds below).
- **`getAverageLatency(): number | null`** -- Average RTT in ms, or `null` if no samples.
- **`getMissedAcks(): number`** -- Current missed ack count.
- **`reset(): void`** -- Clear all metrics. Call on disconnect.

### Quality Thresholds

| Quality | Avg RTT | Missed Acks |
|---------|---------|-------------|
| `'excellent'` | < 100ms | 0 |
| `'good'` | < 300ms | <= 1 |
| `'fair'` | < 1000ms | <= 3 |
| `'poor'` | >= 1000ms | > 3 |
| `'offline'` | No activity for `staleThreshold` ms | -- |

---

## `ReconnectionManager`

Manages reconnection attempts with exponential backoff and jitter.

**Delay formula:** `min(initialDelay * multiplier^attempt, maxDelay) * (1 + jitter * (random - 0.5) * 2)`

```typescript
const manager = new ReconnectionManager(config?: ReconnectionConfig)
```

### `ReconnectionConfig`

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `initialDelay` | `number` (ms) | No | `1000` |
| `maxDelay` | `number` (ms) | No | `30000` |
| `multiplier` | `number` | No | `2` |
| `maxAttempts` | `number` | No | `0` (unlimited) |
| `jitter` | `number` (0-1) | No | `0.25` |
| `timeSource` | `TimeSource` | No | `Date.now` |
| `randomSource` | `() => number` | No | `Math.random` |

### Methods

- **`start(onReconnect: () => Promise<boolean>): Promise<boolean>`** -- Begin reconnection loop. Calls `onReconnect` on each attempt. Returns `true` if reconnection succeeds, `false` if `maxAttempts` exhausted or stopped.
- **`stop(): void`** -- Cancel any pending reconnection attempt.
- **`reset(): void`** -- Reset the attempt counter. Call after a successful manual reconnection.
- **`getNextDelay(): number`** -- Compute the delay for the current attempt.
- **`isRunning(): boolean`** -- Whether the reconnection loop is active.
- **`getAttemptCount(): number`** -- Current attempt number.

### Example

```typescript
import { ReconnectionManager } from '@korajs/sync'

const manager = new ReconnectionManager({
  initialDelay: 1000,
  maxDelay: 30000,
  maxAttempts: 10,
})

const success = await manager.start(async () => {
  try {
    await engine.start()
    return true
  } catch {
    return false
  }
})
```

---

## Serializers

All serializers implement the `MessageSerializer` interface.

### `MessageSerializer` (interface)

```typescript
interface MessageSerializer {
  encode(message: SyncMessage): string | Uint8Array
  decode(data: string | Uint8Array | ArrayBuffer): SyncMessage
  encodeOperation(op: Operation): SerializedOperation
  decodeOperation(serialized: SerializedOperation): Operation
  setWireFormat?(format: WireFormat): void
  getWireFormat?(): WireFormat
}
```

### `JsonMessageSerializer`

Encodes messages as JSON strings. Decodes JSON strings back to typed messages with validation via `isSyncMessage()`.

```typescript
const serializer = new JsonMessageSerializer()
```

### `ProtobufMessageSerializer`

Encodes messages as compact binary protobuf using `protobufjs/minimal`. Decodes `Uint8Array` / `ArrayBuffer` payloads.

```typescript
const serializer = new ProtobufMessageSerializer()
```

### `NegotiatedMessageSerializer`

Supports runtime wire-format switching. Starts with an initial format and can switch after handshake negotiation.

```typescript
const serializer = new NegotiatedMessageSerializer(initialFormat?: WireFormat)
// Default initialFormat: 'json'
```

Additional methods:

- **`setWireFormat(format: WireFormat): void`** -- Switch encoding format at runtime.
- **`getWireFormat(): WireFormat`** -- Current encoding format.

Decoding is format-agnostic: string payloads are decoded as JSON, binary payloads attempt protobuf first then fall back to JSON.

### Utility Functions

- **`versionVectorToWire(vector: VersionVector): Record<string, number>`** -- Convert a `Map<string, number>` version vector to a plain object for wire transmission.
- **`wireToVersionVector(wire: Record<string, number>): VersionVector`** -- Convert a wire-format version vector back to a `Map`.

---

## `SyncStore` (interface)

Interface that the local store must implement for sync. Decouples `@korajs/sync` from `@korajs/store`.

```typescript
interface SyncStore {
  getVersionVector(): VersionVector
  getNodeId(): string
  applyRemoteOperation(op: Operation): Promise<ApplyResult>
  getOperationRange(nodeId: string, fromSeq: number, toSeq: number): Promise<Operation[]>
}
```

### `ApplyResult`

```typescript
type ApplyResult = 'applied' | 'duplicate' | 'skipped'
```

---

## Types

### `SyncConfig`

Developer-facing sync configuration.

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `url` | `string` | Yes | -- |
| `transport` | `'websocket' \| 'http'` | No | `'websocket'` |
| `auth` | `() => Promise<{ token: string }>` | No | -- |
| `scopes` | `Record<string, (ctx: SyncScopeContext) => Record<string, unknown>>` | No | -- |
| `batchSize` | `number` | No | `100` |
| `reconnectInterval` | `number` (ms) | No | `1000` |
| `maxReconnectInterval` | `number` (ms) | No | `30000` |
| `schemaVersion` | `number` | No | `1` |

### `SyncScopeContext`

```typescript
interface SyncScopeContext {
  userId?: string
  [key: string]: unknown
}
```

### `SyncState`

Internal engine states:

```typescript
type SyncState = 'disconnected' | 'connecting' | 'handshaking' | 'syncing' | 'streaming' | 'error'
```

Available as a const array: `SYNC_STATES`.

### `SyncStatus`

Developer-facing status (simplified view of internal state):

```typescript
type SyncStatus = 'connected' | 'syncing' | 'synced' | 'offline' | 'error'
```

Available as a const array: `SYNC_STATUSES`.

### `SyncStatusInfo`

```typescript
interface SyncStatusInfo {
  status: SyncStatus
  pendingOperations: number
  lastSyncedAt: number | null
}
```

### `SyncScopeMap`

```typescript
type SyncScopeMap = Record<string, Record<string, unknown>>
```

A map of collection names to field-value filters. An empty filter `{}` means no restriction (all records visible). A missing collection means hidden (no records visible for that collection).

---

## E2E Sync Encryption

End-to-end encryption for the sync layer. When enabled, the sync engine encrypts the `data` and `previousData` fields of every operation before sending over the wire. The server never sees plaintext user data. Metadata (id, nodeId, collection, timestamps, causalDeps, etc.) stays in cleartext so the server can route, deduplicate, and order operations.

### Configuration

Enable encryption via `createApp()`:

```typescript
import { createApp, defineSchema, t } from 'korajs'

const app = createApp({
  schema: defineSchema({
    version: 1,
    collections: {
      secrets: {
        fields: {
          title: t.string(),
          content: t.string(),
        }
      }
    }
  }),
  sync: {
    url: 'wss://my-server.com/kora',
    encryption: {
      enabled: true,
      key: 'my-secure-passphrase'
    }
  }
})
```

### `SyncEncryptionConfig`

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `enabled` | `boolean` | Yes | -- |
| `key` | `string \| () => Promise<string>` | Yes (when enabled) | -- |
| `algorithm` | `SyncEncryptionAlgorithm` | No | `'aes-256-gcm'` |

The `key` field accepts either a passphrase string or an async function that returns a passphrase (useful for fetching from a vault or user prompt).

### `SyncEncryptionAlgorithm`

```typescript
type SyncEncryptionAlgorithm = 'aes-256-gcm'
```

Currently only AES-256-GCM is supported. The type is extensible for future algorithms.

### `SyncEncryptor`

Encrypts and decrypts operation `data` and `previousData` fields using AES-256-GCM. Each field encryption uses a unique random IV (12 bytes, NIST-recommended for AES-GCM), ensuring that encrypting the same data twice produces different ciphertext.

Key rotation is supported via versioned keys. The key version is embedded in the encrypted payload so the decryptor can select the correct key.

#### Static Factory Methods

- **`SyncEncryptor.create(config: SyncEncryptionConfig, salt?: Uint8Array): Promise<SyncEncryptor>`** -- Create a `SyncEncryptor` from a `SyncEncryptionConfig`. Derives the encryption key from the passphrase using PBKDF2 (600,000 iterations, SHA-256). The optional `salt` parameter allows deterministic key derivation (primarily for testing). Throws `EncryptionError` if `enabled` is `false` or the key is empty.

- **`SyncEncryptor.fromKeys(versionedKeys: VersionedKey[]): SyncEncryptor`** -- Create a `SyncEncryptor` from pre-derived versioned keys. Use this when you need multiple key versions for key rotation, or when you have already derived the keys externally. The highest version number is used for encryption. Throws `EncryptionError` if no keys are provided.

#### Instance Methods

- **`encryptOperation(operation: Operation): Promise<Operation>`** -- Encrypt an operation's `data` and `previousData` fields. Returns a new operation (the original is not mutated). Fields that are `null` (e.g., delete operations) remain `null`.

- **`decryptOperation(operation: Operation): Promise<Operation>`** -- Decrypt an operation's `data` and `previousData` fields. Returns a new operation. If a field is not encrypted (no marker), it passes through unchanged, enabling mixed plaintext/encrypted operations during migration.

- **`encryptSerializedOperation(serialized: SerializedOperation): Promise<SerializedOperation>`** -- Same as `encryptOperation` but for the wire-format `SerializedOperation` type.

- **`decryptSerializedOperation(serialized: SerializedOperation): Promise<SerializedOperation>`** -- Same as `decryptOperation` but for the wire-format `SerializedOperation` type.

- **`encryptBatch(operations: Operation[]): Promise<Operation[]>`** -- Encrypt a batch of operations in parallel.

- **`decryptBatch(operations: Operation[]): Promise<Operation[]>`** -- Decrypt a batch of operations in parallel.

- **`addKey(key: VersionedKey): void`** -- Add a new versioned key for key rotation. If its version number is higher than the current version, it becomes the active encryption key. Previously-versioned keys remain available for decrypting older operations. Throws `EncryptionError` if the key version already exists.

- **`getCurrentKeyVersion(): number`** -- Get the current encryption key version number.

#### Static Methods

- **`SyncEncryptor.isEncryptedPayload(field: Record<string, unknown> | null): boolean`** -- Check whether a field value contains an encrypted payload.

#### Example: Key Rotation

```typescript
import { SyncEncryptor, deriveVersionedKey } from '@korajs/sync'

// Create with initial key
const encryptor = await SyncEncryptor.create({
  enabled: true,
  key: 'initial-passphrase'
})

// Later, rotate to a new key
const newKey = await deriveVersionedKey('new-passphrase', 2)
encryptor.addKey(newKey)

// New operations are encrypted with version 2
// Old operations encrypted with version 1 can still be decrypted
```

### `EncryptedPayload`

Structure embedded in operation `data` and `previousData` fields when encryption is enabled. The server stores and relays these opaque payloads without being able to read the plaintext contents.

```typescript
interface EncryptedPayload {
  /** Encryption key version. Supports key rotation. */
  v: number
  /** Base64-encoded initialization vector (12 bytes for AES-GCM). Unique per field. */
  iv: string
  /** Base64-encoded ciphertext (AES-256-GCM output including authentication tag). */
  ct: string
  /** Encryption algorithm identifier. */
  alg: SyncEncryptionAlgorithm
}
```

### `VersionedKey`

A versioned encryption key with its associated salt for key derivation.

```typescript
interface VersionedKey {
  /** Key version number (monotonically increasing, starting at 1). */
  version: number
  /** The derived CryptoKey for AES-256-GCM operations. */
  key: CryptoKey
  /** The salt used during PBKDF2 key derivation. Required to re-derive the same key. */
  salt: Uint8Array
}
```

### Key Derivation Functions

#### `deriveKey(passphrase, salt?)`

Derives an AES-256-GCM encryption key from a passphrase using PBKDF2 with SHA-256 and 600,000 iterations (OWASP-recommended minimum). The derived key is deterministic: the same passphrase and salt always produce the same key.

```typescript
function deriveKey(
  passphrase: string,
  salt?: Uint8Array
): Promise<{ key: CryptoKey; salt: Uint8Array }>
```

If `salt` is omitted, a random 32-byte salt is generated. Store the salt to re-derive the same key later.

```typescript
import { deriveKey } from '@korajs/sync'

// First time: derive key with a new random salt
const { key, salt } = await deriveKey('my-secure-passphrase')

// Later: re-derive the same key using the stored salt
const { key: sameKey } = await deriveKey('my-secure-passphrase', salt)
```

#### `deriveVersionedKey(passphrase, version, salt?)`

Wraps `deriveKey` with a version number for key rotation support.

```typescript
function deriveVersionedKey(
  passphrase: string,
  version: number,
  salt?: Uint8Array
): Promise<VersionedKey>
```

The `version` must be a positive integer. Throws `KeyDerivationError` if the version is invalid.

#### `generateSalt()`

Generates a cryptographically random 32-byte salt for PBKDF2 key derivation.

```typescript
function generateSalt(): Uint8Array
```

#### `isEncryptedPayload(field)`

Standalone function (also available as a static method on `SyncEncryptor`) to check whether a field value contains an encrypted payload.

```typescript
function isEncryptedPayload(field: Record<string, unknown> | null): boolean
```

### Error Classes

#### `EncryptionError`

Thrown when encryption of operation data fails. Extends `SyncError`.

```typescript
class EncryptionError extends SyncError {
  constructor(message: string, context?: Record<string, unknown>)
}
```

#### `DecryptionError`

Thrown when decryption of operation data fails. Typically indicates a wrong key, tampered ciphertext, or corrupted data. Extends `SyncError`.

```typescript
class DecryptionError extends SyncError {
  constructor(message: string, context?: Record<string, unknown>)
}
```

#### `KeyDerivationError`

Thrown when key derivation fails (e.g., empty passphrase, crypto.subtle unavailable). Extends `SyncError`.

```typescript
class KeyDerivationError extends SyncError {
  constructor(message: string, context?: Record<string, unknown>)
}
```

---

## Sync Diagnostics & Metrics

The sync engine collects connection, latency, throughput, queue, and error metrics internally via a `SyncMetricsCollector`. These metrics are accessible through the `SyncEngine` and emitted as events for DevTools integration.

### Accessing Diagnostics

Use `SyncEngine.exportDiagnostics()` to get a full snapshot:

```typescript
const engine = new SyncEngine({ /* ... */ })
await engine.start()

const diag = engine.exportDiagnostics()
console.log(diag.state)              // 'streaming'
console.log(diag.pendingOperations)  // 0
console.log(diag.lastSyncedAt)      // 1715097600000
```

### `SyncDiagnostics`

High-level diagnostics snapshot returned by `SyncEngine.exportDiagnostics()`.

```typescript
interface SyncDiagnostics {
  state: SyncState
  status: SyncStatusInfo
  nodeId: string
  url: string
  schemaVersion: number
  lastSyncedAt: number | null
  lastSuccessfulPush: number | null
  lastSuccessfulPull: number | null
  conflicts: number
  pendingOperations: number
  hasInFlightBatch: boolean
  reconnecting: boolean
  timestamp: number
}
```

### `SyncDiagnosticsSnapshot`

Comprehensive metrics snapshot (defined in `@korajs/core`). Emitted periodically via the `sync:diagnostics` event when a `KoraEventEmitter` is attached.

| Field | Type | Description |
|-------|------|-------------|
| `status` | `SyncStatus` | Current developer-facing sync status |
| `connectedAt` | `number \| null` | Timestamp when the current connection was established |
| `disconnectedAt` | `number \| null` | Timestamp of the last disconnection |
| `reconnectAttempts` | `number` | Reconnection attempts since last successful connection |
| `rttMs` | `number` | Current round-trip time in milliseconds |
| `rttP50Ms` | `number` | Median (50th percentile) RTT over the sliding window |
| `rttP95Ms` | `number` | 95th percentile RTT |
| `rttP99Ms` | `number` | 99th percentile RTT |
| `operationsSent` | `number` | Total operations sent during this session |
| `operationsReceived` | `number` | Total operations received during this session |
| `bytesSent` | `number` | Total bytes sent during this session |
| `bytesReceived` | `number` | Total bytes received during this session |
| `pendingOperations` | `number` | Operations waiting to be sent |
| `outboundQueueSize` | `number` | Estimated bytes in the outbound queue |
| `lastSyncedAt` | `number \| null` | Timestamp of the last successful sync |
| `syncDuration` | `number \| null` | Duration of the last complete sync cycle in ms |
| `initialSyncComplete` | `boolean` | Whether the initial full delta exchange has completed |
| `initialSyncProgress` | `number` | Progress of the initial sync as a 0-1 ratio |
| `lastError` | `string \| null` | Description of the last error |
| `errorCount` | `number` | Total errors during this session |
| `quality` | `ConnectionQuality` | Assessed connection quality level |
| `effectiveBandwidth` | `number \| null` | Estimated effective bandwidth in bytes per second |

### `MetricsCollectorConfig`

Passed via `SyncEngineOptions.metricsConfig` to configure the internal metrics collector.

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `rttWindowSize` | `number` | No | `100` |
| `bandwidthWindowSize` | `number` | No | `20` |
| `diagnosticsInterval` | `number` (ms) | No | `5000` |
| `timeSource` | `TimeSource` | No | `Date.now` |

### Bandwidth Estimation

The metrics collector uses a `BandwidthEstimator` internally to estimate effective bandwidth. The estimator maintains a sliding window of transfer samples and computes a weighted average, giving exponentially more weight to recent samples (decay factor of 0.9). The effective bandwidth reported in `SyncDiagnosticsSnapshot` is the lower of inbound and outbound estimates, since the bottleneck determines the effective rate.

Bandwidth estimation requires at least 2 samples before returning a value. Samples with zero or negative duration or byte count are ignored.

### Latency Percentile Tracking

RTT measurements are tracked using a `SlidingWindowPercentile` calculator with a configurable window size (default 100 samples). The calculator uses the nearest-rank method: the percentile value is the smallest value in the dataset such that at least p% of the data is less than or equal to that value. Older samples are overwritten in a circular buffer when the window is full.

### Diagnostics Events

When a `KoraEventEmitter` is provided to `SyncEngine`, the metrics collector emits the following events:

- **`sync:diagnostics`** -- Emitted periodically (default every 5 seconds) while connected. Contains the full `SyncDiagnosticsSnapshot`.
- **`sync:bandwidth`** -- Emitted after each transfer measurement. Contains `{ bytesPerSecond: number, direction: 'in' | 'out' }`.
- **`sync:initial-sync-progress`** -- Emitted during initial sync. Contains `{ progress: number, totalBatches: number, receivedBatches: number }`.

### Quality Assessment

The metrics collector assesses connection quality from RTT percentiles and error rate:

| Quality | P95 RTT | Error Count |
|---------|---------|-------------|
| `'excellent'` | < 100ms | 0 |
| `'good'` | < 300ms | <= 1 |
| `'fair'` | < 1000ms | <= 3 |
| `'poor'` | >= 1000ms | > 3 |
| `'offline'` | No connection | -- |

If no RTT data has been collected yet, quality falls back to error-based assessment only.

---

## Sync Scope Filtering

Scope filtering determines which operations are relevant to a particular client based on per-collection field filters. This is used by both the client and server to restrict the set of operations exchanged during sync.

### `SyncScopeMap`

```typescript
type SyncScopeMap = Record<string, Record<string, unknown>>
```

A map from collection names to field-value filters:
- An **empty filter** `{}` for a collection means no field restrictions -- all records in that collection are in scope.
- A **missing collection** means the collection is entirely out of scope -- no records are visible.
- A filter with **field-value pairs** (e.g., `{ userId: 'abc' }`) means only operations whose data matches all specified fields are in scope.

### `operationMatchesScope(op, scopeMap)`

Check whether a single operation matches the given scope map.

```typescript
function operationMatchesScope(
  op: Operation,
  scopeMap: SyncScopeMap | undefined
): boolean
```

**Rules:**
- If `scopeMap` is `undefined`: the operation is always in scope (no filtering).
- If the operation's collection is not present in the scope map: the operation is out of scope.
- If the collection has an empty scope `{}`: the operation is in scope (no field restrictions).
- If the collection has field-value pairs: all specified field-value pairs must match in the operation's data snapshot. The snapshot is built by merging `previousData` and `data` (with `data` taking precedence), representing the record's state after the operation is applied.
- If the operation has no data or previousData (both `null`): the operation is out of scope when field filters are present.

```typescript
import { operationMatchesScope } from '@korajs/sync'

const scopeMap = {
  todos: { userId: 'user-123' },
  settings: {},  // all settings records are in scope
}

// Returns true if op.collection is 'todos' and the
// merged data snapshot has userId === 'user-123'
const inScope = operationMatchesScope(myOperation, scopeMap)
```

### `filterOperationsByScope(ops, scopeMap)`

Filter an array of operations to only those matching the given scope map.

```typescript
function filterOperationsByScope(
  operations: Operation[],
  scopeMap: SyncScopeMap | undefined
): Operation[]
```

Returns the full array unchanged if `scopeMap` is `undefined`. Otherwise, returns a new array containing only the operations that match the scope.

```typescript
import { filterOperationsByScope } from '@korajs/sync'

const scopeMap = {
  todos: { userId: 'user-123' },
}

const filtered = filterOperationsByScope(allOperations, scopeMap)
// filtered contains only operations for the 'todos' collection
// where userId matches 'user-123'
```

---

## Awareness / Presence Protocol

The awareness system provides real-time collaborative presence -- cursor positions, user identity, and online status. Awareness states are ephemeral: they are never persisted, only shared with currently connected peers via the sync transport. The protocol is compatible with Yjs awareness semantics for interoperability with existing collaborative editors.

### `AwarenessManager`

Manages collaborative awareness state for a single client. Tracks both the local user's state and all remote clients' states. Each `AwarenessManager` has a unique client ID.

```typescript
const awareness = new AwarenessManager(options?: {
  clientId?: number
  emitter?: KoraEventEmitter
  timeoutMs?: number
})
```

#### Constructor Options

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `clientId` | `number` | No | Auto-incremented |
| `emitter` | `KoraEventEmitter` | No | `null` |
| `timeoutMs` | `number` (ms) | No | `30000` |

The `timeoutMs` controls how long to wait before cleaning up a stale remote client's presence (safety net in case the server does not send an explicit removal on disconnect).

#### Properties

- **`clientId: number`** (readonly) -- Unique client ID for this instance.

#### Methods

- **`setLocalState(state: AwarenessState | null): void`** -- Set the local user's awareness state and broadcast to peers. Pass `null` to clear presence.

- **`getLocalState(): AwarenessState | null`** -- Get the local awareness state.

- **`getStates(): Map<number, AwarenessState>`** -- Get all known awareness states (local and remote). Returns a new Map on each call.

- **`handleRemoteMessage(message: AwarenessMessage): void`** -- Process an incoming awareness message from the transport. Updates remote states and notifies listeners. Ignores the local client's own state if echoed back.

- **`removeClient(clientId: number): void`** -- Remove a specific remote client's awareness state. Called when the server notifies that a client has disconnected.

- **`onSend(handler: (message: AwarenessMessage) => void): void`** -- Register a handler for sending awareness messages through the transport. The sync engine calls this to wire outgoing awareness messages to the transport.

- **`on('change', listener: (change: AwarenessChange) => void): () => void`** -- Register a listener for awareness state changes. Returns an unsubscribe function.

- **`off('change', listener): void`** -- Remove a specific change listener.

- **`startCleanupTimer(): void`** -- Start the timer that removes stale remote states. Called when the sync engine transitions to streaming state.

- **`stopCleanupTimer(): void`** -- Stop the cleanup timer.

- **`destroy(): void`** -- Clean up all resources. Broadcasts removal of local state before shutting down. After calling `destroy()`, the manager will no longer send or receive awareness updates.

#### Example

```typescript
import { AwarenessManager } from '@korajs/sync'

const awareness = new AwarenessManager({
  timeoutMs: 30_000,
})

// Set local presence
awareness.setLocalState({
  user: { name: 'Alice', color: '#ff6b6b' },
  cursor: {
    collection: 'documents',
    recordId: 'doc-1',
    field: 'content',
    anchor: 42,
    head: 42,
  },
})

// Listen for changes from other users
const unsubscribe = awareness.on('change', (change) => {
  console.log('Added:', change.added)
  console.log('Updated:', change.updated)
  console.log('Removed:', change.removed)

  // Get all current states
  const states = awareness.getStates()
  for (const [clientId, state] of states) {
    console.log(`${state.user.name} is at position ${state.cursor?.anchor}`)
  }
})

// Clean up on disconnect
awareness.destroy()
```

### Types

#### `AwarenessState`

Per-client awareness state shared with connected peers.

```typescript
interface AwarenessState {
  /** User identity information */
  user: AwarenessUser
  /** Current cursor position, if any */
  cursor?: AwarenessCursor
}
```

#### `AwarenessUser`

User identity information for presence display.

```typescript
interface AwarenessUser {
  /** Display name of the user */
  name: string
  /** Hex color for cursor/selection rendering (e.g. '#ff0000') */
  color: string
  /** Optional avatar URL */
  avatar?: string
}
```

#### `AwarenessCursor`

Cursor position within a richtext field. Uses Yjs-compatible anchor/head positions for editor interop.

```typescript
interface AwarenessCursor {
  /** Collection containing the record being edited */
  collection: string
  /** ID of the record being edited */
  recordId: string
  /** Field name of the richtext field */
  field: string
  /** Cursor anchor position in Y.Text (start of selection) */
  anchor: number
  /** Cursor head position in Y.Text (end of selection, same as anchor if no selection) */
  head: number
}
```

#### `AwarenessChange`

Describes a change in awareness states. Emitted when remote clients update or remove their presence.

```typescript
interface AwarenessChange {
  /** Client IDs whose states were added */
  added: number[]
  /** Client IDs whose states were updated */
  updated: number[]
  /** Client IDs whose states were removed */
  removed: number[]
}
```

#### `AwarenessMessage`

Internal awareness message format used between `AwarenessManager` and the transport layer.

```typescript
interface AwarenessMessage {
  type: 'awareness'
  /** Client ID of the sender */
  clientId: number
  /** All known awareness states. null value means removal. */
  states: Record<number, AwarenessState | null>
}
```

#### `CursorInfo`

Developer-facing cursor information for rendering in editors. Editor-agnostic: provides data that can be rendered by TipTap, ProseMirror, Quill, or other editors.

```typescript
interface CursorInfo {
  /** Unique client ID */
  clientId: number
  /** User display name */
  userName: string
  /** Hex color for cursor rendering */
  color: string
  /** Cursor anchor position (start of selection) */
  anchor: number
  /** Cursor head position (end of selection) */
  head: number
}
```

### Timeout-Based Cleanup

The `AwarenessManager` includes a safety net for cleaning up stale presence data. When the cleanup timer is running (started via `startCleanupTimer()`), it periodically checks all remote client states and removes any that have not been updated within the configured `timeoutMs` (default 30 seconds). This handles edge cases where the server does not send an explicit removal on disconnect.

The cleanup timer is automatically started when the sync engine enters the `streaming` state and stopped on disconnect or `destroy()`.

### Integration with SyncEngine

The `SyncEngine` creates and manages an `AwarenessManager` internally. Access it via `engine.getAwarenessManager()`:

```typescript
const engine = new SyncEngine({ /* ... */ })
await engine.start()

const awareness = engine.getAwarenessManager()
awareness.setLocalState({
  user: { name: 'Bob', color: '#4ecdc4' },
})
```

When a `KoraEventEmitter` is attached to the engine, awareness changes emit `awareness:updated` events containing the full states map.
