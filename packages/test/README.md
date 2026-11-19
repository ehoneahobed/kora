# @korajs/test

A test harness for Kora.js sync. It runs a network of virtual devices against a real sync server in one process: each device has a real SQLite store (`better-sqlite3`) and a real sync engine, and the server is a real `KoraSyncServer`. Tests therefore exercise the same fold, constraints and validators as production, with in-memory transports and no network.

It works with any test runner; the examples use Vitest.

## Install

```bash
pnpm add -D @korajs/test@beta vitest
```

## Two devices, one server

```typescript
import { defineSchema, t } from '@korajs/core'
import { createTestNetwork, expectConverged, type TestNetwork } from '@korajs/test'
import { afterEach, expect, test } from 'vitest'

const schema = defineSchema({
  version: 1,
  collections: {
    todos: { fields: { title: t.string(), completed: t.boolean().default(false) } },
  },
})

let network: TestNetwork | null = null
afterEach(async () => {
  await network?.close()
  network = null
})

test('offline edits converge', async () => {
  network = await createTestNetwork(schema)
  const [a, b] = network.devices
  if (!a || !b) throw new Error('expected two devices')

  const todo = await a.collection('todos').insert({ title: 'Shared' })
  await a.sync()
  await b.sync()

  await b.disconnect()
  await b.collection('todos').update(todo.id, { title: 'Edited offline' })
  await b.reconnect()
  for (const device of [b, a]) await device.sync()

  expect((await a.getState('todos'))[0]?.title).toBe('Edited offline')
  await expectConverged(network.devices, schema)
})
```

`sync()` connects on the first call and afterwards flushes pending uploads. Call it on each device after its writes.

## What's in it

- `createTestNetwork(schema, options?)` sets up the server and the devices. Its options:
  - `devices` or `deviceNames`;
  - `validateOperation`;
  - `serverStore` (SQLite or Postgres instead of memory);
  - `chaos` (drop, duplicate, reorder, latency);
  - `blobStorage` and `encryption`.
- `createMixedTestNetwork` runs devices on different schema versions against one server, to test `supportedSchemaVersions` and operation transforms.
- `expectConverged(devices, schema)` throws with the differences unless every device holds the same records. `checkConvergence` returns them instead. `expectConvergedEventually` retries until a chaotic network settles.
- `TestDevice`, `TestServer`, `ChaosTransport` and `createTestAuthBinding`. The auth binding moves a device between loading, signed out and several users with no auth server.
- Access rules across users: `new TestServer(schema, { auth: true })` and `new TestDevice({ user: 'alice', ... })` sign devices in, so the schema's access rules apply as in production, and `server.access` (`grant`, `revoke`, `transfer`) changes memberships during a test.

## Playwright helpers

`@korajs/test/playwright` is a separate entry for end-to-end offline tests in a real browser:

- cut the network (`goOffline`, `throttleNetwork`);
- crash a tab (`killTab`);
- restart a browser profile (`openProfile`, `restartProfile`);
- skew the clock (`skewClock`);
- assert that an app that says it is offline-ready really is (`assertReadyMeansOffline`, `firstVisitOffline`).

It needs `playwright-core` (or `@playwright/test`) next to it. The crash and throttle helpers need Chromium. The main entry never loads this one.

## Docs

- [Testing guide](https://korajs.dev/guide/testing)
- [Test API reference](https://korajs.dev/api/test)

## License

MIT
