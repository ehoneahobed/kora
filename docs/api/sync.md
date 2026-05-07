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

  // Type guards
  isSyncMessage,
  isHandshakeMessage,
  isHandshakeResponseMessage,
  isOperationBatchMessage,
  isAcknowledgmentMessage,
  isErrorMessage,

  // Constants
  SYNC_STATES,
  SYNC_STATUSES,
} from '@korajs/sync'
```

```typescript
import type {
  // Engine options
  SyncEngineOptions,
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

  // Store
  SyncStore,
  ApplyResult,

  // Types
  SyncConfig,
  SyncState,
  SyncStatus,
  SyncStatusInfo,
  SyncScopeContext,
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

### Methods

- **`start(): Promise<void>`** -- Connect, handshake, exchange deltas, then enter streaming mode. Throws if the engine is not in `disconnected` state.
- **`stop(): Promise<void>`** -- Disconnect the transport. Returns any in-flight batch to the outbound queue. No-op if already disconnected.
- **`pushOperation(op: Operation): Promise<void>`** -- Enqueue a local operation for sync. If currently streaming, flushes the queue immediately.
- **`getStatus(): SyncStatusInfo`** -- Returns the developer-facing sync status (see `SyncStatusInfo` below).
- **`getState(): SyncState`** -- Returns the internal state machine state. Primarily for testing.
- **`setReconnecting(value: boolean): void`** -- When `true`, `getStatus()` reports `'offline'` during intermediate states (connecting, handshaking, syncing) instead of `'syncing'`.
- **`getOutboundQueue(): OutboundQueue`** -- Access the outbound queue. Primarily for testing.

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
