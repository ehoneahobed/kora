---
title: Offline Readiness
description: "What offline-first means in Kora: the guarantees (opens offline after the first visit, a resolved write is never lost), what your app is responsible for, and how to check and test both."
---

# Offline Readiness

Kora's promise is: **works offline after the first open, never loses your work.** This page says
exactly what that covers, what your app has to do for it to be true, and how to see and test it.
The API reference is [Offline readiness](/api/offline); the app shell itself is described in
[Opening the app offline](./offline-patterns.md#opening-the-app-offline-the-app-shell).

<!-- docs-check-prelude
import { WriteNotDurableError, createApp, defineSchema, t } from 'korajs'
import { createAuthTokenStorage } from '@korajs/auth'
const schema = defineSchema({
  version: 1,
  collections: {
    todos: { fields: { title: t.string() } },
    lessons: { fields: { courseId: t.string(), title: t.string() } },
  },
})
const app = createApp({ schema })
declare const courseId: string
declare function showBanner(text: string): void
declare function tellTheUser(text: string): void
-->

## What Kora guarantees

**When `app.offline.status().state` is `ready`, reloading with no network opens the app, signs the
user in again, shows the data of the screens they use and everything you told Kora to keep, and
accepts writes.** `ready` is only claimed when every part is proven; a part Kora cannot check reads
`unknown` and is never `ready`.

**A write whose promise resolved is never lost**, offline, on every storage backend, through a tab
crash, a browser crash, a reload and a restart, until it reaches the server. That covers `insert`,
`insertMany`, `update`, `delete`, `app.transaction`, `mutation` and `mutateAsync`. (`mutate` is
fire-and-forget: it promises nothing until its write has resolved internally, so use `mutateAsync`
where the user is told "saved".)

**Nothing is dropped silently.** A refused write, a quarantined operation, failing durability and a
detected storage loss each surface as an event and in the status.

## What it does not cover

- **A browser that deletes the whole site's storage.** Under storage pressure, or after Safari's
  seven days without a visit, the browser can delete everything for the origin: the database, the
  service worker and Cache Storage together. Nothing is left to compare with, so Kora cannot tell it
  from a first visit. Prevention is the defence: persistent storage (`app.storage.persistence`,
  requested for you after sign-in or the first write), installing the app, and syncing. The status
  reports `storage.persisted` so the app can say so.
- **Data the server received after the last sync.** `complete` means complete as of
  `data.completedAt`. No device can know what it has not been told.
- **A first visit with no network.** The app has to open once, online, to install its shell.

## The status

```typescript
const status = app.offline.status() // synchronous, never prompts, never throws

if (status.state === 'ready') {
  // Reload with no network would work.
} else if (status.state === 'preparing') {
  // Every missing piece is making progress (first visit, initial sync, files downloading).
} else {
  showBanner(`Not available offline yet: ${status.reasons.join(', ')}`)
}

const stop = app.offline.subscribe((next) => {
  if (next.state === 'ready') tellTheUser('You can go offline now.')
})
stop()
```

In React, Vue and Svelte the same snapshot comes from `useOfflineReady()`, which re-renders only
when it changes. `status.reasons` is empty exactly when the state is `ready`; each reason names the
part that is missing (`shell-installing`, `data-incomplete`, `auth-not-restorable`,
`files-missing`, `storage-writes-failing`, ...).

## The app shell and the badge

The interface itself (HTML, scripts, styles, the SQLite WASM) opens offline because `vite build`
runs the `koraServiceWorker()` plugin from `@korajs/cli/vite`, which precaches the built app in a
service worker. The worker verifies its own cache and reports it, so `status.shell` can say
`installed`, `installing`, `not-installed`, `other-build`, `unsupported` or `none`. Only `installed`
(and `bundled`, a desktop build) counts toward `ready`. The `tauri-react` template has no service
worker: its interface is embedded in the binary.

Every template renders an `<OfflineBadge />` built on `useOfflineReady()`: "Available offline"
(with "may be cleared if unused" until the browser grants persistent storage), "Preparing offline
copy... 40%", or "Not available offline yet" with the first reason as its tooltip. It is hidden in
`vite dev`. Keep it, restyle it, or build your own from `useOfflineReady()`.

Your app keeps the shell honest by serving everything it needs from the same origin, or by caching
the rest itself: a font from a CDN, an analytics script and your own API are not in the precache.
The status lists the URLs the worker could not serve in `shell.misses`; it never changes `state`.

## Keeping data that no screen is showing

By default `data.state` judges the queries your screens run. To promise data the user has not
opened (a course they saved for the flight), keep it:

```typescript
const handle = await app.offline.keep(app.lessons.where({ courseId }), { files: true })

handle.status() // { complete, records, files: { done, total, ... } }
await handle.whenComplete() // the records, and their files, are on this device

await app.offline.release(handle) // stop promising it
```

`keep` is explicit and persistent: the pin lives in the device's database until you release it, and
calling it again with the same query changes nothing, so call it on every start. A pin is a `where`
on one collection (no `limit`, `offset` or `include`; keep each related collection with its own
call), and a database holds at most 64. With `{ files: true }` the blobs the records reference are
downloaded in the background and verified against their SHA-256 before they count. In React,
`useOfflineKeep(query, { files: true })` holds a pin while a component is mounted. Limits and failure
reasons (`quota`, `unavailable`, `integrity`) are in the [API reference](/api/offline#keeping-data-keep-release-hold).

## Signing in

An app that signs users in is `ready` only when a reload with no network would restore the session.
With `createKoraAuthSync` from `@korajs/auth`, Kora answers that from the stored credentials:

| Stored credentials | `auth.state` |
|---|---|
| Both tokens in `localStorage` (the default), refresh token not expired, inside `maxOfflineGraceMs` | `restorable`, until `auth.offlineUntil` |
| In memory or `sessionStorage` | `not-restorable` |
| A custom token store that does not declare `durability` | `unknown`, never `ready` |
| Signed out, locked, expired, or a clock set back | `not-restorable` |

Sign the user in while online; the offline restore then lasts until `auth.offlineUntil`, and `ready`
turns off by itself when that time passes. Local data is never wiped when a session lapses. If you
bring your own token store, declare how it persists:

```typescript
import { createAuthTokenStorage } from '@korajs/auth'

declare const keychain: {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

// A platform keychain survives a restart, so say so. Without `durability` the store reads as
// `unknown`: Kora does not guess that a custom store is durable.
const tokenStorage = createAuthTokenStorage({ store: keychain, durability: 'durable' })
```

If your sign-in is something Kora cannot see (a bare `sync.auth` token function), declare it:

```typescript
const customApp = createApp({
  schema,
  offline: { auth: () => ({ restorable: true, until: Date.now() + 7 * 24 * 60 * 60 * 1000 }) },
})
```

The sync templates sign in with Google OAuth. Until someone has signed in, a sync template reads
`auth-not-restorable` and its badge says "Not available offline yet", although its local data
works. That is the status being cautious, not the app being broken; configure a sign-in method (or
`offline.auth`) for the app you ship.

## If the browser deleted the database

When a database that existed on this device is reopened empty, Kora does not mistake it for a new
device. It emits `store:storage-evicted` and keeps the loss in `app.storage.evicted`, with how many
unsynced writes only that copy held, until you acknowledge it:

```typescript
const lost = app.storage.evicted
if (lost !== null) {
  tellTheUser(
    lost.lostWrites.count > 0
      ? `This device lost ${lost.lostWrites.count} change(s) that had not synced yet.`
      : 'This device was cleared. Your synced data is restoring.',
  )
  await app.offline.acknowledgeEviction() // durable: it does not come back after a reload
}
```

The database is still opened and re-syncs; what only the vanished copy held is gone. Kora does not
report a loss after `app.storage.deleteDatabase()`, a move between OPFS and IndexedDB, a first
open, a changed `store.name`, or when the user clears all site data (nothing remains to compare).

## Durable writes on the IndexedDB fallback

OPFS and native SQLite commit durably. The IndexedDB fallback keeps SQLite in memory and saves
snapshots, so from `1.0.0-beta.15` a write there **waits for a snapshot that holds it** before its
promise resolves. Writes issued together share one snapshot. If the snapshot cannot be saved (quota,
broken IndexedDB), the write stays committed and visible, and its promise rejects with
`WriteNotDurableError` (`WRITE_NOT_DURABLE`):

```typescript
try {
  await app.todos.insert({ title: 'Pack the charger' })
} catch (error) {
  if (error instanceof WriteNotDurableError) {
    // The todo exists on this device. Do NOT insert it again: that creates a duplicate.
    showBanner('Saved on this device but not yet confirmed. Keep the app open.')
  } else {
    throw error
  }
}

app.storage.writes.status() // { state: 'durable' } or { state: 'failing', permanent, since, message }
```

`failing` returns to `durable` when a later snapshot succeeds. `permanent: true` means the storage
leader changed before any snapshot held the write, so it may be lost: tell the user to reload and
check. While writes are `failing` the status is not `ready` (`storage-writes-failing`).

Two things follow for your code. **Do not retry a `WriteNotDurableError`**: the write exists. And
**use `insertMany` or one `app.transaction` for bulk writes**: each awaited write on the fallback pays
a snapshot that grows with the database, so a loop of a thousand `insert` calls is a thousand
snapshots.

## What your app is responsible for

- `keep` what must work offline beyond the screens the user opened online.
- Serve assets from your own origin, or cache the rest (fonts, CDNs, your API).
- Sign the user in while online, and declare token durability or `offline.auth` if you use your own.
- Use `insertMany` or `app.transaction` for bulk writes.
- Keep persistent storage likely: Kora requests it for you; on Safari, tell users to install the app.
- Show the badge, `storage.evicted` and `WriteNotDurableError` honestly.

## Testing it

Run a production build, because the service worker only exists there. `@korajs/test/playwright` has
the helpers; `assertReadyMeansOffline` is the whole contract as one call: wait for `ready`, cut the
network, reload, check the shell and data, write, reload again, check the write survived.

<!-- docs-check: skip Playwright test file, runs under @playwright/test not in the app -->
```typescript
import { assertReadyMeansOffline, expectNeverReady } from '@korajs/test/playwright'
import { expect, test } from '@playwright/test'

test('the app works offline once it says it is ready', async ({ page }) => {
  await page.goto('http://localhost:4173')
  await assertReadyMeansOffline(page, {
    shellSelector: 'h1',
    dataSelector: 'text="First task"',
    write: async (p) => {
      await p.getByPlaceholder('What needs to be done?').fill('Offline task')
      await p.getByPlaceholder('What needs to be done?').press('Enter')
    },
    verifyWrite: async (p) => p.getByText('Offline task').isVisible(),
  })
})
```

The helpers read `window.app.offline`; expose your app there in the test build
(`Object.assign(globalThis, { app })`), or pass `accessor` for another path. Pair the positive test
with `expectNeverReady` for the cases where `ready` must not appear (service worker blocked,
signed out).

Kora runs this against all 13 bundled templates: `pnpm test:e2e:offline` in the repository scaffolds
each one from the packed packages, builds it, serves it the way its `package.json` says, and drives
it in Chromium with the network cut. `KORA_OFFLINE_TEMPLATES=react-basic,vue-sync` runs a subset.

## Upgrading to beta.15

- **Update `korajs`, `@korajs/auth` and `@korajs/cli` together.** An older `@korajs/auth` cannot
  report whether the session restores offline, so the app reads `auth-unknown` and is never `ready`.
  An older `@korajs/cli` plugin publishes no shell status, which reads `shell-none`.
- **Writes can now reject with `WriteNotDurableError`** on the IndexedDB fallback. Before, such a
  write resolved even when its snapshot failed. Treat it as "saved here, not yet confirmed", not as
  "failed", and do not retry it.
- **A custom token store without `durability` reads as `unknown`.** It is never `ready` until you
  pass `durability: 'durable'` to `createAuthTokenStorage` (or `'session'`, `'memory'` to say what it
  is), or declare `offline.auth`.
- **A custom blob store without `durable` counts as not durable.** A pin that keeps files then
  reports `storage-non-durable`. Declare `readonly durable = true` on a store whose bytes survive a
  restart.
- **An app with a bare `sync.auth` token function** reads `not-ready` until it declares
  `offline.auth`.
- **Reserved name:** `offline` is now a property of the app, so a collection or app extension named
  `offline` collides.
