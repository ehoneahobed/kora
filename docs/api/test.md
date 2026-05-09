# Test API Reference

`@korajs/test` provides a testing harness for multi-device sync scenarios. It creates virtual networks with real SQLite stores and in-memory transports.

```typescript
import {
  createTestNetwork,
  expectConverged,
  checkConvergence,
} from '@korajs/test'

import type {
  TestNetwork,
  TestDevice,
  TestServer,
  TestNetworkOptions,
  ConvergenceResult,
  CollectionDifference,
  FieldDifference,
} from '@korajs/test'
```

---

## createTestNetwork()

Creates a virtual network with a server and multiple devices for testing sync behavior.

### Signature

```typescript
function createTestNetwork(
  schema: SchemaDefinition,
  options?: TestNetworkOptions
): Promise<TestNetwork>
```

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `schema` | `SchemaDefinition` | The schema for all devices and the server. |
| `options` | `TestNetworkOptions` | Optional configuration. |

#### TestNetworkOptions

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `devices` | `number` | `2` | Number of devices to create. |
| `deviceNames` | `string[]` | `['device-0', 'device-1', ...]` | Custom names for devices. Overrides `devices` count. |

### Returns

`Promise<TestNetwork>` -- A network object with server, devices, and cleanup.

### TestNetwork

| Property | Type | Description |
|----------|------|-------------|
| `server` | `TestServer` | The virtual sync server. |
| `devices` | `TestDevice[]` | Array of virtual devices. |
| `tmpDir` | `string` | Temporary directory for SQLite databases. |
| `close()` | `Promise<void>` | Close all devices and the server, clean up temp files. |

### Example

```typescript
const network = await createTestNetwork(schema, { devices: 3 })

try {
  // ... test logic
} finally {
  await network.close()
}
```

---

## TestDevice

A virtual device with a real SQLite store, sync engine, and merge engine.

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` | Device name (for identification in logs). |
| `store` | `Store` | The device's local store. |
| `emitter` | `KoraEventEmitter` | Event emitter for instrumentation events. |

### Methods

#### .collection(name)

Returns a collection accessor for performing CRUD operations.

```typescript
collection(name: string): CollectionAccessor
```

```typescript
await device.collection('todos').insert({ title: 'Test' })
```

#### .sync()

Connects to the server and performs a full sync cycle.

```typescript
sync(): Promise<void>
```

#### .disconnect()

Closes the current sync connection.

```typescript
disconnect(): Promise<void>
```

#### .reconnect()

Re-establishes a sync connection to the server (disconnects first if connected).

```typescript
reconnect(): Promise<void>
```

#### .getState(collectionName)

Returns all records in a collection as plain objects. Useful for assertions.

```typescript
getState(collectionName: string): Promise<Record<string, unknown>[]>
```

#### .getNodeId()

Returns the device's unique node ID.

```typescript
getNodeId(): string
```

#### .getVersionVector()

Returns the device's current version vector.

```typescript
getVersionVector(): VersionVector
```

#### .isConnected()

Returns whether the device is currently connected to the server.

```typescript
isConnected(): boolean
```

#### .close()

Releases all resources (closes store, disconnects sync).

```typescript
close(): Promise<void>
```

---

## TestServer

The virtual sync server that devices connect to.

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `store` | `MemoryServerStore` | The server's in-memory operation store. |

### Methods

#### .getAllOperations()

Returns all operations stored on the server.

```typescript
getAllOperations(): Operation[]
```

#### .getConnectionCount()

Returns the number of currently connected devices.

```typescript
getConnectionCount(): number
```

#### .close()

Closes the server and all connections.

```typescript
close(): Promise<void>
```

---

## expectConverged()

Asserts that all devices have identical state across all collections. Throws a descriptive error if devices have not converged.

### Signature

```typescript
function expectConverged(
  devices: TestDevice[],
  schema: SchemaDefinition
): Promise<void>
```

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `devices` | `TestDevice[]` | Devices to compare. |
| `schema` | `SchemaDefinition` | Schema defining the collections to check. |

### Throws

Throws an error with message `'Devices have not converged'` and detailed difference information if any device has different state.

---

## checkConvergence()

Checks convergence without throwing. Returns a detailed result describing any differences.

### Signature

```typescript
function checkConvergence(
  devices: TestDevice[],
  schema: SchemaDefinition
): Promise<ConvergenceResult>
```

### Returns

#### ConvergenceResult

| Field | Type | Description |
|-------|------|-------------|
| `converged` | `boolean` | `true` if all devices have identical state. |
| `differences` | `CollectionDifference[]` | Details of any differences found. |

#### CollectionDifference

| Field | Type | Description |
|-------|------|-------------|
| `collection` | `string` | Collection name where difference was found. |
| `deviceA` | `string` | Name of the first device. |
| `deviceB` | `string` | Name of the second device. |
| `missingInB` | `string[]` | Record IDs present in A but missing in B. |
| `missingInA` | `string[]` | Record IDs present in B but missing in A. |
| `fieldDifferences` | `FieldDifference[]` | Field-level differences for records present in both. |

#### FieldDifference

| Field | Type | Description |
|-------|------|-------------|
| `recordId` | `string` | The record with differing values. |
| `field` | `string` | The field name that differs. |
| `valueInA` | `unknown` | Value on device A. |
| `valueInB` | `unknown` | Value on device B. |

---

## ChaosTransport

Re-exported from `@korajs/sync`. A transport wrapper that simulates unreliable network conditions for stress testing.

```typescript
import { ChaosTransport } from '@korajs/test'
```

See the [Sync API reference](/api/sync) for `ChaosTransport` configuration options.
