---
title: Offline readiness
description: "app.offline.status(), useOfflineReady, completion marks and storage-loss reporting."
---

# Offline readiness

`app.offline` answers one question: if this device reloaded with no network right now, would the
app open, show the data it was told to keep, and accept writes? Design:
`docs/design/offline-readiness.md` in the repository.

<!-- docs-check-prelude
import { createApp, defineSchema, t } from 'korajs'
const schema = defineSchema({ version: 1, collections: { todos: { fields: { title: t.string() } } } })
const app = createApp({ schema })
-->

```typescript
const status = app.offline.status()            // synchronous snapshot, never prompts, never throws
const stop = app.offline.subscribe((s) => {})  // called on every change of the snapshot

await app.offline.acknowledgeEviction()        // after telling the user a database vanished
app.storage.evicted                            // the unacknowledged storage loss, or null
```

React: `const offline = useOfflineReady()` (`@korajs/react`). Vue: `const offline = useOfflineReady()`
returns a readonly ref (`@korajs/vue`). Svelte: `const offline = createOfflineReadyStore()`, also
exported as `useOfflineReady` (`@korajs/svelte`). Each returns the same `OfflineStatus` and
re-renders only when it changes. On the server it reports `not-ready` with `server-rendering`.

## `OfflineStatus`

| Field | Meaning |
|---|---|
| `state` | `ready`, `preparing` (every missing piece is making progress) or `not-ready` |
| `reasons` | Why not: empty exactly when `state` is `ready` |
| `shell` | The offline app shell (`none` until the shell reports) |
| `data` | `complete`, `syncing`, `incomplete` or `local`; `completedAt`; `quarantined` |
| `files` | Kept-file counts (zeros until files are kept) |
| `storage` | `backend`, `durable`, `persisted`, `writes`, `evicted` |
| `auth` | `n/a`, or `unknown` while an authenticated app's offline sign-in is unproven |

`unknown` is never ready. `persisted: false`, quarantined operations and an unacknowledged
eviction are reported but never change `state`.

## What "complete" means

`data.state` is `complete` only when a durable **completion mark** proves the current view was
fully delivered: the mark is written in the same transaction as the delivery watermark of the
final batch, cleared before a batch that narrows the view or removes records, and cleared by every
watermark reset. A delivery that crashed or stalled part-way leaves the view `incomplete` after a
reload, never `complete`. "Complete" means complete as of `data.completedAt`; data the server
received after the last sync is not here, which no device can know offline.

The marks are read when the sync engine starts (`sync.autoConnect`, or `await app.sync.connect()`).

## Storage loss

When a database that existed on this device is reopened empty, Kora emits `store:storage-evicted`
and keeps `app.storage.evicted` (`{ dbName, detectedAt, lastOpenedAt, evidence, lostWrites }`)
until `app.offline.acknowledgeEviction()`. See the changeset notes for when it is not reported.
