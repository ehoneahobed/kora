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

## Playwright helpers

`@korajs/test/playwright` is a separate entry with the browser-side helpers for end-to-end offline
tests: cutting the network, crashing a tab, restarting a browser profile, skewing the clock and
asserting that an app that says it is offline-ready really is. The main `@korajs/test` entry never
loads it. Install `playwright-core` (or `@playwright/test`, which includes it) next to it; it is an
optional peer dependency used for types, and nothing is imported from it at runtime. The crash and
throttle helpers use the Chrome DevTools protocol, so they need Chromium.

<!-- docs-check-prelude
import {
  assertReadyMeansOffline,
  blockServiceWorker,
  expectNeverReady,
  killTab,
  openProfile,
  restartProfile,
  skewClock,
  throttleNetwork,
  waitForOfflineStatus,
} from '@korajs/test/playwright'
// The checker has no playwright-core of its own, so these come from the helpers' signatures.
declare const page: Parameters<typeof killTab>[0]
declare const context: Parameters<typeof blockServiceWorker>[0]
declare const chromium: Parameters<typeof openProfile>[0]
declare const appUrl: string
declare const userDataDir: string
-->

| Helper | What it does |
|---|---|
| `goOffline(pageOrContext)` / `goOnline(...)` | Switch the whole browser context off or on. A service worker still serves its cache |
| `throttleNetwork(page, preset)` | CDP network emulation: `slow-4g`, `fast-3g`, `slow-3g`, `2g`, `offline`, `none`, or explicit conditions. Returns `{ reset() }`. Per page, Chromium only, not applied to requests a service worker makes |
| `killTab(page)` | `Page.crash` over CDP: the renderer dies without running `unload` or `pagehide`. Chromium only (`CRASH_UNSUPPORTED` elsewhere) |
| `openProfile(chromium, dir, options)` / `restartProfile(profile)` | Quit and relaunch the browser on the same user data directory, so OPFS, IndexedDB, Cache Storage and workers must survive a real restart |
| `skewClock(pageOrContext, ms)` | Offsets `Date.now()`, `new Date()` and `Date()` by `ms`, now and after every reload. It does not move `performance.now()`, timers, workers, service workers or the server clock. `skewClock(page, 0)` restores real time |
| `blockServiceWorker(context)` | Makes `navigator.serviceWorker.register()` reject for the context's pages |
| `waitForOfflineStatus(page, matcher, options?)` | Polls `app.offline.status()` until a state name or a predicate holds; survives reloads; times out with the last status. `hasReason('shell-none')` builds a predicate |
| `readOfflineStatus(page, options?)` | One read of the status, `null` while the app does not exist yet |
| `firstVisitOffline(context, url, options?)` | Installs the app online, closes that tab, goes offline and opens a fresh tab. Returns `{ page, loaded, error }` and does not throw, so one flow serves positive and negative tests. `warmUp: false` makes it a cold first visit |
| `assertReadyMeansOffline(page, options)` | When the status reads `ready`: go offline, reload, assert the shell and data render, run your `write`, reload again, assert `verifyWrite`, restore the network. Failures carry a code naming the broken promise |
| `expectNeverReady(page, during, options?)` | Runs a scenario while sampling the status in Node and in an in-page probe that also catches a `ready` flashing by during a reload. Returns a report; `report.assertNeverReady()` throws if `ready` was seen |

The helpers read the offline handle from `window.app.offline`. If your app exposes it elsewhere,
pass `accessor: 'myGlobal.app.offline'` (a dotted path from `window`) to any helper that reads the
status. Every wait is on a condition (`pollMs` only sets how often it is checked), never on a fixed
sleep.

### Ready means offline

```typescript
await page.goto(appUrl)
await assertReadyMeansOffline(page, {
  shellSelector: '#app',
  dataSelector: '.todo-row',
  write: async (p) => {
    await p.getByRole('button', { name: 'Add' }).click()
  },
  verifyWrite: async (p) => (await p.locator('.todo-row').count()) > 1,
})
```

The negative side is the same promise from the other direction: while something is wrong, the app
must never say `ready`.

```typescript
await blockServiceWorker(context)
await page.goto(appUrl)
const report = await expectNeverReady(page, async () => {
  await waitForOfflineStatus(page, (status) => status.reasons.includes('shell-none'))
  await page.reload()
})
report.assertNeverReady()
```

Keep a positive control next to every negative test (the same observer on a healthy app must
report `everReady: true`), or a broken observer passes silently.

### Crashes, restarts and slow networks

```typescript
// An awaited write must survive a renderer crash.
await killTab(page)
const reopened = await context.newPage()
await reopened.goto(appUrl)

// The same profile after the browser quits and starts again.
const profile = await openProfile(chromium, userDataDir)
await restartProfile(profile)

// A device with a fast clock, on a slow connection.
await skewClock(page, 10 * 60_000)
const throttle = await throttleNetwork(page, 'slow-4g')
await throttle.reset()
```

Failures are `OfflineAssertionError` (a `KoraError`) with these codes: `READY_TIMEOUT`,
`OFFLINE_RELOAD_FAILED`, `SHELL_MISSING`, `DATA_MISSING`, `NOT_READY_AFTER_RELOAD`,
`OFFLINE_WRITE_FAILED`, `OFFLINE_WRITE_LOST`, `READY_OBSERVED`, `OFFLINE_STATUS_TIMEOUT`,
`UNKNOWN_NETWORK_PRESET` and `CRASH_UNSUPPORTED`.

`assertReadyMeansOffline` also takes `requireReadyAfterReload` (also require `ready` after the
offline reload, default false), `onOnline` (for example wait for the queued write to upload),
`keepOffline`, `stepTimeoutMs` (default 15000), `timeoutMs` (wait for ready, default 30000) and
`accessor`. `expectNeverReady` returns `everReady`, `readyObservations`, `samples`, `statesSeen`,
`reasonsSeen`, `lastStatus` and `probeRead` (false when the page crashed before the probe could be
read). Where a sandbox keeps Chromium at a fixed path, pass it as `executablePath` when launching,
as the repo's own browser tests do with `PW_CHROMIUM_PATH`.
