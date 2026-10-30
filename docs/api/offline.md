---
title: Offline readiness
description: "app.offline.status(), useOfflineReady, completion marks and storage-loss reporting."
---

# Offline readiness

`app.offline` answers one question: if this device reloaded with no network right now, would the
app open, show the data it was told to keep, and accept writes? What Kora guarantees and what
your app is responsible for: the [Offline Readiness guide](/guide/offline-readiness). Design:
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
| `shell` | The offline app shell: `{ state, version, misses }`, see [The app shell](#the-app-shell) |
| `data` | `complete`, `syncing`, `incomplete` or `local`; `completedAt`; `quarantined` |
| `files` | Kept-file counts (zeros until files are kept) |
| `storage` | `backend`, `durable`, `persisted`, `writes`, `evicted` |
| `auth` | `n/a`, `loading`, `restorable` (with `offlineUntil`), `not-restorable` or `unknown` |

`unknown` is never ready. `persisted: false`, quarantined operations and an unacknowledged
eviction are reported but never change `state`.

## The app shell

`shell.state` says whether the interface itself (HTML, scripts, styles, the SQLite WASM) opens
with no network. Only `installed` and `bundled` count toward `ready`.

| State | Meaning | Reason when it is not `ready` |
|---|---|---|
| `installed` | The active service worker holds every precached file | none |
| `bundled` | A desktop build (native storage backend) embeds its interface in the binary | none |
| `installing` | The worker is registering or installing (first visit) | `shell-installing` (progress, so `preparing`) |
| `not-installed` | Install failed, or the cache is incomplete and could not be healed | `shell-not-installed` |
| `other-build` | The page runs a build the active worker does not hold | `shell-other-build` (resolved by accepting the update) |
| `unsupported` | No service workers, or an insecure context | `shell-unsupported` |
| `none` | Nothing reports a shell: no `koraServiceWorker()`, `vite dev`, or an older `@korajs/cli` | `shell-none` |

`shell.version` is the active worker's precache version and `shell.misses` the URLs it could
not serve offline (a font CDN shows up here); `misses` is diagnostic and never changes `state`.

The status comes from the worker that `koraServiceWorker()` (`@korajs/cli/vite`) generates, not
from `navigator.serviceWorker.controller`, which is `null` after a hard reload. The worker
verifies its cache and, when online, refetches a missing file and stores it only if its SHA-256
equals the digest recorded at build time; bytes of a newer deployment are never stored. The
registration script publishes the result as a versioned contract that `app.offline` reads:

<!-- docs-check: skip the browser-side contract written by the registration script, not app code -->
```typescript
globalThis.__KORA_SHELL__ = {
  v: 1,                                    // contract version; another value reads as absent
  state: 'installed',                      // 'installing' | 'installed' | 'not-installed' | 'other-build' | 'unsupported'
  version: '3f9c1a7b2d4e5f60',             // the active worker's precache version, or null
  misses: ['https://fonts.example/css'],   // diagnostic, bounded
}
// and a `kora:shell` event on window each time it changes
```

See [Opening the App Offline](/guide/offline-patterns#knowing-the-shell-is-really-there) for the
protocol. Every template renders an `<OfflineBadge />` built on `useOfflineReady()`.

## Keeping data: `keep`, `release`, `hold`

By default `data.state` judges the queries the app is showing. `app.offline.keep()` adds data
the app promises to have offline even when no screen is showing it (a course the user saved):

<!-- docs-check: skip partial snippet, app.lessons is the app's own collection -->
```typescript
const handle = await app.offline.keep(app.lessons.where({ courseId }), { files: true })

handle.status()                        // { complete, records, files: { done, total, bytesDone, bytesTotal, failed, failedReason } }
const stop = handle.subscribe((status) => {})
await handle.whenComplete()            // resolves when the records (and files) are here
await app.offline.release(handle)      // or release(handle.id)

app.offline.list()                     // [{ id, collection, where, files, explicit, holders, createdAt, completedAt }]
```

- `keep()` is explicit and persistent: the pin lives in the device's database until `release()`.
  Calling it again with the same query records nothing new and returns a handle with the same
  `id`. `handle.whenComplete()` rejects with `OFFLINE_PIN_RELEASED` if the pin is released first,
  and with an `AbortError` if its `signal` aborts.
- `hold()` is the reference-counted form for UI: `const release = await app.offline.hold(query)`.
  A pin lives while it is kept explicitly or at least one hold exists. Holds are per tab: a tab
  that is closed or killed has its holds removed by the other tabs (a shared Web Lock on the
  tab's version-gate lock), and a tab restored from the back-forward cache records its holds
  again. Without Web Locks, holds are counted in memory and a lost tab's holds are not pruned.
- Without Web Locks (`explicit` mode) holds are counted in memory per tab. A pin made by
  `keep()` stays kept (its flag is stored with the pin) however components hold and release it;
  only `release()` removes it, and a pin that components created is removed with its last hold.
- A pin is a `where` on one collection. `limit`, `offset` and `include` are refused
  (`OFFLINE_KEEP_UNSUPPORTED_QUERY`); keep each related collection with its own call.
- At most 64 pins (`OFFLINE_PIN_LIMIT`, an `OfflineKeepError` with code `OFFLINE_PIN_LIMIT`).
- Pins widen the sync query view of a collection the app already restricts to live queries
  (they never narrow it), so `data.state` is `complete` only when every pin and every live query
  was delivered. A pin added offline keeps `data.state` `incomplete` until the next session
  delivers it.
- `{ files: true }` also keeps the blobs the pinned records reference. One tab, elected by the
  Web Lock `kora-offline-files-<db>`, fetches them in the background; each is verified against its
  SHA-256 before it counts, and a file already stored is read back and checked once per session
  before it counts as kept. Files are fetched only while the sync connection is up; a quota
  failure is retried on the next connection change. `status().files` and `OfflineStatus.files` report progress; a failure
  is reported with `failedReason`: `quota`, `unavailable` (the server does not have it), `integrity`
  (the bytes did not match) or `error`. Files missing or failed give the reasons `files-missing`,
  `files-downloading` and `files-failed`; a non-durable blob store (the in-memory one) gives
  `storage-non-durable`.
- Keeping files asks the browser for persistent storage in the background (never on the
  `app.ready` path). Whether it is granted is reported as `storage.persisted` and never changes
  `state`.

React: `const { held, error } = useOfflineKeep(app.lessons.where({ courseId }), { files: true })`
holds while the component is mounted (StrictMode safe: a double mount leaves one hold). Vue:
`useOfflineKeep(queryOrGetter, options)` returns readonly refs `{ held, error }` and follows a
getter. Svelte: `createOfflineKeepStore(query, options)` (also exported as `useOfflineKeep`) is a
store of `{ held, error }` with `release()`. On the server they hold nothing.

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


## Sign-in

An app that signs users in is `ready` only when a reload with no network would restore the
session. `createKoraAuthSync` (`@korajs/auth`) answers from the stored credentials:

| Stored credentials | `auth.state` |
|---|---|
| Both tokens in `localStorage` (the default), refresh token not expired, inside `maxOfflineGraceMs` | `restorable`, `offlineUntil` is the earlier of the grace end and the refresh expiry |
| In memory or `sessionStorage` | `not-restorable` (`non-durable-credentials`) |
| A custom store that does not declare `durability` | `unknown`, never `ready` |
| Signed out, locked, expired, or a clock set back | `not-restorable` |

An app with its own token store sets `durability: 'durable'` on it (a platform keychain, the
Tauri store). An app whose sign-in Kora cannot see (a bare `sync.auth` token function) declares
it:

<!-- docs-check: skip partial snippet, shows only the option -->
```typescript
createApp({
  schema,
  sync: { url, auth: getToken },
  offline: { auth: () => ({ restorable: hasStoredSession(), until: sessionLimit() }) },
})
```

`ready` flips off by itself when `offlineUntil` passes, and when the device clock moves
backwards (checked every 30 seconds while the session is restorable, and on page resume and
`online`/`offline` events). Local data is never wiped when a session lapses.
