---
title: Testing
description: "Test offline-first Kora.js apps: unit testing collections and merges, simulating offline states, and @korajs/test convergence utilities."
---

# Testing

`@korajs/test` provides a testing harness for verifying sync, conflict resolution, and multi-device behavior. It creates virtual device networks with real SQLite stores and in-memory transports. No actual network required.

## Installation

```bash
pnpm add -D @korajs/test@beta vitest
```

The package runs each device on a real SQLite store (`better-sqlite3`) and a real sync engine,
and the server on a real `KoraSyncServer`, so tests exercise the same fold, constraints and
validators as production. It works with any test runner; the examples use Vitest.

<!-- docs-check-prelude
import { afterEach, describe, expect, test } from 'vitest'
import { createTestNetwork, expectConverged, checkConvergence, type TestNetwork } from '@korajs/test'
import { defineSchema, t } from '@korajs/core'
const schema = defineSchema({
  version: 1,
  collections: { todos: { fields: { title: t.string(), completed: t.boolean().default(false) } } },
})
let network: TestNetwork
-->

## Creating a test network

`createTestNetwork()` sets up a server and devices connected by in-memory transports:

```typescript
import { defineSchema, t } from '@korajs/core'
import { createTestNetwork, type TestNetwork } from '@korajs/test'
import { afterEach, describe, expect, test } from 'vitest'

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

describe('sync', () => {
  let network: TestNetwork | null = null

  afterEach(async () => {
    await network?.close()
    network = null
  })

  test('data syncs between devices', async () => {
    network = await createTestNetwork(schema)
    const [deviceA, deviceB] = network.devices
    if (!deviceA || !deviceB) throw new Error('expected two devices')

    await deviceA.collection('todos').insert({ title: 'Buy milk' })
    await deviceA.sync()
    await deviceB.sync()

    const todos = await deviceB.getState('todos')
    expect(todos).toHaveLength(1)
    expect(todos[0]?.title).toBe('Buy milk')
  })
})
```

`sync()` connects on the first call and afterwards flushes pending uploads; a connected device
receives other devices' operations as the server relays them. Call `sync()` on each device after
writes, as above.

## Devices and options

```typescript
network = await createTestNetwork(schema, { devices: 3 })
network = await createTestNetwork(schema, { deviceNames: ['alice', 'bob', 'charlie'] })
```

Other options configure the server and the links: `validateOperation`, `serverStore` (SQLite or
Postgres instead of memory), `chaos` (drop, duplicate, reorder, latency), `blobStorage`,
`encryption`. See the [Test API](/api/test#createtestnetwork-schema-options).

```typescript
import type { OperationValidator } from '@korajs/server'

const validateOperation: OperationValidator = (op) => {
  if (op.collection === 'todos' && op.type === 'insert') {
    return { action: 'reject', code: 'FORBIDDEN', message: 'Inserts are blocked' }
  }
  return { action: 'accept' }
}

test('the server refuses inserts', async () => {
  network = await createTestNetwork(schema, { validateOperation })
  const [device] = network.devices
  if (!device) throw new Error('expected a device')

  await device.sync()
  await device.collection('todos').insert({ title: 'Refused' })
  await device.sync()

  const rejected = await device.getRejectedOperations()
  expect(rejected[0]?.code).toBe('FORBIDDEN')
})
```

## Offline behavior

```typescript
test('offline writes sync after reconnecting', async () => {
  network = await createTestNetwork(schema)
  const [deviceA, deviceB] = network.devices
  if (!deviceA || !deviceB) throw new Error('expected two devices')

  await deviceA.sync()
  await deviceA.disconnect()
  await deviceA.collection('todos').insert({ title: 'Offline todo' })

  await deviceA.reconnect()
  await deviceA.sync()
  await deviceB.sync()

  const todos = await deviceB.getState('todos')
  expect(todos.map((todo) => todo.title)).toEqual(['Offline todo'])
})
```

## Asserting convergence

`expectConverged()` throws with the differences unless every device holds the same records;
`checkConvergence()` returns them instead:

```typescript
test('concurrent edits converge', async () => {
  network = await createTestNetwork(schema, { devices: 3 })
  const [a, b, c] = network.devices
  if (!a || !b || !c) throw new Error('expected three devices')

  const todo = await a.collection('todos').insert({ title: 'Shared' })
  for (const device of [a, b, c]) await device.sync()

  // Concurrent offline edits of the same field
  await b.disconnect()
  await c.disconnect()
  await b.collection('todos').update(todo.id, { title: 'From B' })
  await c.collection('todos').update(todo.id, { title: 'From C' })
  await b.reconnect()
  await c.reconnect()
  for (const device of [b, c, a, b, c]) await device.sync()

  await expectConverged(network.devices, schema)
  const result = await checkConvergence(network.devices, schema)
  expect(result.converged).toBe(true)
})
```

With `chaos`, use `expectConvergedEventually(devices, schema, { timeoutMs })`, which retries until
the network settles.

## Inspecting merge decisions

Each device records merge decisions in its audit trail, as an app does:

```typescript
test('the concurrent edit produced a merge trace', async () => {
  network = await createTestNetwork(schema)
  const [deviceA] = network.devices
  if (!deviceA) throw new Error('expected a device')
  const traces = await deviceA.store.getAuditTraces({ collections: ['todos'] })
  expect(Array.isArray(traces)).toBe(true)
})
```

Device events are on `device.emitter` (for example `merge:conflict` or
`sync:operation-rejected`).

## Testing schema migrations

`createMixedTestNetwork(serverSchema, serverOptions, devices)` runs devices on different schema
versions against one server, to test `supportedSchemaVersions` and operation transforms. See the
[Test API](/api/test).
