---
title: Testing
description: "Test offline-first Kora.js apps: unit testing collections and merges, simulating offline states, and @korajs/test convergence utilities."
---

# Testing

`@korajs/test` provides a testing harness for verifying sync, conflict resolution, and multi-device behavior. It creates virtual device networks with real SQLite stores and in-memory transports — no actual network required.

## Installation

```bash
pnpm add -D @korajs/test
```

The package depends on `better-sqlite3` for local stores. It is designed for use with Vitest.

## Creating a Test Network

`createTestNetwork()` sets up a virtual server and multiple devices, all connected via in-memory transports:

```typescript
import { defineSchema, t } from '@korajs/core'
import { createTestNetwork } from '@korajs/test'
import { afterEach, describe, test, expect } from 'vitest'

const schema = defineSchema({
  version: 1,
  collections: {
    todos: {
      fields: {
        title: t.string(),
        completed: t.boolean().default(false),
      },
    },
  },
})

describe('sync tests', () => {
  let network

  afterEach(async () => {
    if (network) {
      await network.close()
      network = null
    }
  })

  test('data syncs between devices', async () => {
    network = await createTestNetwork(schema)
    const [deviceA, deviceB] = network.devices

    // Insert on device A
    await deviceA.collection('todos').insert({ title: 'Buy milk' })

    // Sync both devices through the server
    await deviceA.sync()
    await deviceB.sync()

    // Device B has the record
    const todos = await deviceB.getState('todos')
    expect(todos).toHaveLength(1)
    expect(todos[0].title).toBe('Buy milk')
  })
})
```

## Custom Device Count

By default, `createTestNetwork` creates 2 devices. You can specify more:

```typescript
network = await createTestNetwork(schema, { devices: 3 })

const [alice, bob, charlie] = network.devices
```

Or use custom names:

```typescript
network = await createTestNetwork(schema, {
  deviceNames: ['alice', 'bob', 'charlie'],
})
```

## Testing Offline Behavior

Each device can disconnect and reconnect independently:

```typescript
test('offline mutations sync after reconnect', async () => {
  network = await createTestNetwork(schema)
  const [deviceA, deviceB] = network.devices

  // Sync, then disconnect device A
  await deviceA.sync()
  await deviceA.disconnect()

  // Insert while offline
  await deviceA.collection('todos').insert({ title: 'Offline todo' })

  // Reconnect and sync
  await deviceA.reconnect()
  await deviceB.sync()

  const todos = await deviceB.getState('todos')
  expect(todos).toHaveLength(1)
  expect(todos[0].title).toBe('Offline todo')
})
```

## Asserting Convergence

Use `expectConverged()` to verify all devices have identical state:

```typescript
import { createTestNetwork, expectConverged } from '@korajs/test'

test('all devices converge', async () => {
  network = await createTestNetwork(schema, { devices: 3 })
  const [a, b, c] = network.devices

  // Each device inserts a record
  await a.collection('todos').insert({ title: 'From A' })
  await b.collection('todos').insert({ title: 'From B' })
  await c.collection('todos').insert({ title: 'From C' })

  // Sync all devices (multiple rounds for relay)
  await a.sync()
  await b.sync()
  await c.sync()
  await a.disconnect()
  await b.disconnect()
  await a.sync()
  await b.sync()

  // All devices should have identical state
  await expectConverged(network.devices, schema)
})
```

For more details without throwing, use `checkConvergence()`:

```typescript
import { checkConvergence } from '@korajs/test'

const result = await checkConvergence(network.devices, schema)
if (!result.converged) {
  console.log(result.differences)
  // Shows which collections differ, missing records, and field-level differences
}
```

## Testing Updates and Deletes

```typescript
test('updates sync between devices', async () => {
  network = await createTestNetwork(schema)
  const [deviceA, deviceB] = network.devices

  const record = await deviceA.collection('todos').insert({ title: 'Original' })
  await deviceA.sync()
  await deviceB.sync()

  // Update on A
  await deviceA.collection('todos').update(record.id, { title: 'Updated' })
  await deviceA.disconnect()
  await deviceA.sync()
  await deviceB.disconnect()
  await deviceB.sync()

  const todos = await deviceB.getState('todos')
  expect(todos[0].title).toBe('Updated')
})

test('deletes sync between devices', async () => {
  network = await createTestNetwork(schema)
  const [deviceA, deviceB] = network.devices

  const record = await deviceA.collection('todos').insert({ title: 'To delete' })
  await deviceA.sync()
  await deviceB.sync()

  await deviceA.collection('todos').delete(record.id)
  await deviceA.disconnect()
  await deviceA.sync()
  await deviceB.disconnect()
  await deviceB.sync()

  const todos = await deviceB.getState('todos')
  expect(todos).toHaveLength(0)
})
```

## TestDevice API

Each device in the network exposes:

| Method | Description |
|--------|-------------|
| `.collection(name)` | Access a collection for insert/update/delete/query |
| `.sync()` | Connect to the server and sync |
| `.disconnect()` | Close the sync connection |
| `.reconnect()` | Re-establish the sync connection |
| `.getState(collection)` | Get all records in a collection (for assertions) |
| `.getNodeId()` | Get the device's unique node ID |
| `.getVersionVector()` | Get the device's version vector |
| `.isConnected()` | Check if currently connected |
| `.close()` | Release all resources |
