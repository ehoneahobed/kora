---
title: Test API
description: "@korajs/test API reference: in-process test networks with real stores, chaos transports and convergence assertions for multi-device sync tests."
---

# Test API Reference

`@korajs/test` builds in-process sync networks: one `KoraSyncServer` and several devices, each with
a real SQLite store (`better-sqlite3`) and sync engine, connected by in-memory transports. Use it to
test that your schema, resolvers, constraints and validators converge. The
[Testing guide](/guide/testing) shows patterns.

<!-- docs-check-prelude
import { checkConvergence, createTestNetwork, expectConverged } from '@korajs/test'
import { defineSchema, t } from 'korajs'
const schema = defineSchema({
  version: 1,
  collections: { todos: { fields: { title: t.string(), completed: t.boolean().default(false) } } },
})
-->

## createTestNetwork(schema, options?)

```typescript
const network = await createTestNetwork(schema, { devices: 3 })
try {
  const [a, b] = network.devices
  if (!a || !b) throw new Error('expected two devices')
  await a.sync()
  await b.sync()
  await a.collection('todos').insert({ title: 'from A' })
  await a.sync()
  await b.sync()
  await expectConverged(network.devices, schema)
} finally {
  await network.close()
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `devices` | `2` | Number of devices. |
| `deviceNames` | `device-0`, `device-1`, ... | Names (overrides `devices`). |
| `chaos` | none | `ChaosConfig` applied to every device link (`dropRate`, `duplicateRate`, `reorderRate`, `maxLatency`, `randomSource`, `dropPredicate`). |
| `wrapTransport` | none | Wraps each device's transport pair (`wrapTransportPairWithProtobufWire`, `wrapTransportPairWithServerClock(pair, now)`, `createTransportMetrics().wrapTransport`). |
| `serverStore` | a `MemoryServerStore` | Run against SQLite or Postgres; the network closes it. |
| `validateOperation` | none | The server's validator. |
| `blobStorage` | `false` | Central blob storage on the server. |
| `encryption` / `serverEncryption` | none | Device encryption key material (`{ config, salt, iterations? }`) and the server's encryption policy. |
| `deviceMaxOperationBytes` | 256 KiB | Each device store's `maxOperationBytes`. |
| `legacyMerge` | `false` | Devices use the 1.0.0-beta.12 merge (comparison only). |

`TestNetwork`: `server`, `devices`, `tmpDir` and `close()`.

`createMixedTestNetwork(serverSchema, serverOptions, deviceConfigs)` creates devices on different
schema versions (`{ name, schema, syncSchemaVersion?, operationTransforms? }`) to test migrations
and operation transforms.

## TestDevice

| Member | Description |
|--------|-------------|
| `name`, `store`, `emitter` | The device's name, `Store` and event emitter (`emitter.clear()` resets recorded events). |
| `collection(name)` | Collection accessor: `insert`, `update`, `delete`, `findById`, `where`. |
| `sync()` | Connects (first call) and flushes pending operations. |
| `disconnect()` / `reconnect()` / `isConnected()` | Connection control. |
| `getState(collection)` | Every record as a plain object, for assertions. |
| `getNodeId()`, `getVersionVector()`, `getSyncEngine()`, `getRejectedOperations()` | Introspection. |
| `authChanged()` | Tells the engine its auth binding changed. |
| `putBlob`, `stageBlob`, `pullBlob`, `pullBlobByRef`, `getBlobBytes` | Blob transfer. |
| `close()` | Closes the store and sync. |

Merge decisions are recorded in the device's audit trail as in an app.

## TestServer

`new TestServer(schema, options?)` with `store`, `schemaVersion`, `supportedSchemaVersions`,
`operationTransforms`, `encryption`, `blobStorage`, `validateOperation`. Members: `store`, `ready`,
`blobStore`, `getAllOperations()`, `getKoraContext()` (the route context), `authoritativeNodeIds`,
`getConnectionCount()`, `retransmitPendingRelays()`, `getLiveBlobRefs()`, `close()`.

## Convergence assertions

<!-- docs-check: signature @korajs/test @korajs/core -->
```typescript
function expectConverged(devices: TestDevice[], schema: SchemaDefinition): Promise<void>
function expectConvergedEventually(
  devices: TestDevice[],
  schema: SchemaDefinition,
  options?: { timeoutMs?: number; intervalMs?: number },
): Promise<void>
function checkConvergence(devices: TestDevice[], schema: SchemaDefinition): Promise<ConvergenceResult>

interface ConvergenceResult { converged: boolean; differences: CollectionDifference[] }
interface CollectionDifference {
  collection: string
  deviceA: string
  deviceB: string
  missingInB: string[]     // record ids
  missingInA: string[]
  fieldDifferences: FieldDifference[]  // { recordId, field, valueInA, valueInB }
}
```

`expectConverged` throws with the differences when any pair of devices disagrees.
`expectConvergedEventually` retries until the timeout, for networks with chaos.

```typescript
const result = await checkConvergence([], schema)
result.converged // true: fewer than two devices always agree
```

## Auth

`createTestAuthBinding({ initialUserId?, anonymous? })` is a deterministic `AuthSyncBinding` that can
move between loading, signed out and several users without an auth server, for testing per-user
databases, held writes and reconnects.
