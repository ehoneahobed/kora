# Design: offline readiness (`app.offline`, `useOfflineReady`)

Status: revision 1, for review. Not implemented. Date: 2026-10-19.
Workstream A of the beta.15 plan. Public API: review before code.

## 1. Problem

Kora has every piece of "works offline" and no single answer to "is this device ready?":

- koraforms respondents opened links offline and nothing worked: the shell was never installed,
  or the first sync never finished, and nothing said so.
- koradocs images are fetched only when viewed (`app.blobs.pull`), so a document opened offline
  shows broken images.
- An LMS learner who goes offline mid first sync has half a course and does not know it.

What exists today, and why it is not enough:

| Piece | Where | Gap |
|---|---|---|
| Offline shell (precache, one build per worker) | `packages/cli/src/vite/service-worker.ts` | The page never learns whether the precache is installed and complete. |
| Download progress | `SyncEngine.getStatus()`: `initialSync`, `activeViewComplete` (`packages/sync/src/engine/sync-engine.ts`) | Live only. `deltaReceiveComplete` is reset at every handshake and is not persisted, so after an offline reload nothing knows whether the data was ever complete. |
| Per-view watermark | `deliverySignature()` + `_kora_meta` watermarks (`docs/design/durable-delivery.md`) | Says how far a view got, not whether it reached the end. |
| Blobs | `kora/src/blob/create-blob-api.ts`, `packages/store/src/blob/*` | Pull on demand only. `resolveBlobStore` silently falls back to `MemoryBlobStore` (`kora/src/blob/resolve-blob-store.ts`). |
| Durable storage | `StoragePersistence` (`packages/store/src/persistence/storage-persistence.ts`), triggers in `kora/src/storage-accessor.ts` | Requested after the first write already. An evicted database reopens as a fresh, empty one: queued writes vanish silently. |

## 2. Goals and non-goals

Goals:
- One status, `app.offline.status()`, and `useOfflineReady()` (React, Vue, Svelte). `ready` means:
  reload with no network and this app opens, shows the data it was told to keep, and accepts
  writes. Every `ready` claim is backed by a test that does exactly that reload (section 9).
- `app.offline.keep(query, { files })`: declare what must be on the device, with progress.
- Storage loss is reported (`store:storage-evicted`), never mistaken for a fresh device.
- Templates show "Available offline" by default.

Non-goals (v1):
- Opening offline on a first visit (impossible; F15 fail-fast stays: a missing `sqlite3.wasm`
  fails the open in seconds with a clear error).
- Detecting a whole-origin wipe (section 6.3), background download while the app is closed
  (Background Sync), caching the app's own non-Kora API responses or cross-origin assets.
- `keep` across relations (`include`), a blob cache size cap with eviction, server-rendered pages.

## 3. API

```typescript
const status = app.offline.status()          // synchronous snapshot, never prompts, never throws
const off = app.offline.subscribe((s) => {}) // called on every change of the snapshot

interface OfflineStatus {
  state: 'ready' | 'preparing' | 'not-ready'
  reasons: OfflineReason[]          // empty exactly when state === 'ready'
  shell: {
    state: 'installed' | 'installing' | 'not-installed' | 'other-build' | 'unsupported'
         | 'bundled' | 'none'
    version: string | null          // the active worker's precache version
    misses: string[]                // URLs the worker failed to serve offline (diagnostic)
  }
  data: {
    state: 'complete' | 'syncing' | 'incomplete' | 'local'
    progress: number | null         // 0..1, approximate, while syncing
    completedAt: number | null      // wall time of the mark in use (display only)
    quarantined: number             // reported, not gating (section 4.2)
  }
  files: { kept: number; missing: number; bytesMissing: number; failed: number }
  storage: {
    backend: 'opfs' | 'indexeddb' | 'native' | 'memory'
    durable: boolean                // database AND blob store survive a reload
    persisted: boolean | null       // navigator.storage.persisted(); null: unknown/unsupported
    usage: number | null
    quota: number | null
    evicted: StorageEviction | null // section 6
  }
  auth: { state: 'n/a' | 'restorable' | 'not-restorable'; offlineUntil: number | null }
}

type OfflineReason =
  | 'shell-none' | 'shell-unsupported' | 'shell-not-installed' | 'shell-installing'
  | 'shell-other-build'
  | 'data-syncing' | 'data-incomplete' | 'data-blocked'
  | 'files-downloading' | 'files-missing' | 'files-failed'
  | 'storage-non-durable' | 'auth-not-restorable' | 'server-rendering'

const handle = await app.offline.keep(app.lessons.where({ courseId }), { files: true })
handle.id                           // stable: hash of collection, where, files (idempotent)
handle.status()                     // { complete, records, files: { done, total, bytesDone, bytesTotal, failed } }
handle.subscribe(listener)
await handle.whenComplete({ signal })
await app.offline.release(handle)   // or release(handle.id)
app.offline.list()                  // every pin on this database
```

`useOfflineReady()` returns `OfflineStatus` (React via `useSyncExternalStore`, Vue a readonly
ref, Svelte a readable store plus `createOfflineReadyStore(app)`, mirroring `useSyncStatus`).
`useOfflineKeep(query, options)` wraps keep/release in a component lifetime only when asked;
pins are durable and normally released explicitly.

`keep()` resolves once the pin is durably recorded, not when the download finishes. It awaits
`app.ready`, works offline (the download starts at the next session), and is idempotent: apps call
it on every start. `offline` joins `RESERVED_APP_PROPERTIES` (`kora/src/reserved-app-properties.ts`);
a collection named `offline` moves to `app.collections.offline` with the existing dev warning.

### 3.1 State rule

`ready` iff every component holds:

| Component | Holds when |
|---|---|
| shell | `installed` or `bundled` |
| data | `complete` or `local`, and every pin is complete |
| files | `missing === 0` and `failed === 0` over pins with `files: true` |
| storage | `durable` |
| auth | `n/a` or `restorable` |

Otherwise `preparing` when every failing component is making progress (shell installing, data
syncing on a live session, files downloading), else `not-ready`. `persisted`, `quota`,
`quarantined`, `evicted` and `misses` never make `ready` true or false (section 12, Q1).

## 4. Data: "complete" that survives a reload

### 4.1 Completion marks

The live signal (`activeViewComplete`) cannot be read offline. Add a durable **completion mark**
per delivery view, stored with the view's watermark:

`_kora_meta` key `offline_complete:<signature>` =
`{ watermark, scopeKey, subsets, rulesKey, principal, collectionsKey, at }`

- **Set** when a delivery batch with `isFinal` is fully applied (`handleOperationBatch` /
  `recordReceivedBatch`, the `msg.isFinal && fullyApplied` branch), in the same transaction as the
  watermark advance (`commitDeliveryProgress`), so a mark never exists without its watermark.
  Handshake and streaming finals both set it. Only chained delivery batches (protocol 2) set
  marks; a server that sends none leaves data `incomplete`.
- **Cleared** (every mark, durably, before anything is applied) when:
  - a batch carries `accessNarrowing` or `retractions` (a re-scope unit or records leaving);
  - the watermark is reset: `resetDeliveryForFullResync()` (history-behind, sequence conflict,
    deferred full resync) and the "watermark ahead of server frontier" reset (server restore).
  Clear-before-apply makes a crash mid-unit read as incomplete, never complete.
- **Evicted** with its view watermark (the `MAX_DELIVERY_VIEW_WATERMARKS` LRU,
  `deleteDeliveryWatermark`).

`data.state` is `complete` when some mark M satisfies all of:
1. `M.scopeKey === scopeViewKey(activeScope)` (same server-granted downlink scope);
2. `M.rulesKey === accessRulesKey` (the key `saveAccessRulesKey` persists; null === null without
   access rules);
3. `M.principal` is the session's user id (a shared database used by another user, without
   scopes or access rules, has equal scope and rules keys) and `M.collectionsKey` equals the
   current synced-collection set (an app update that syncs a new collection is not complete for
   it until it streamed);
4. `querySubsetContains(M.subsets, currentSubsets)`
   (`packages/sync/src/scopes/query-subset.ts`): a view complete at watermark w contains
   everything any narrower view needs up to w;
5. no `blockedFailure` and no in-flight delivery batch in this tab;
6. on a backend that persists asynchronously (the IndexedDB fallback, `ensureDurable()`), the
   barrier resolved after the mark was written. Before that the mark lives only in memory.

The last-known `activeScope`, subsets and rules key are loaded at start (as today), so the check
works with no connection. `syncing` while a session is live and no mark matches; `incomplete`
otherwise. "Complete" means complete as of `completedAt`: data the server got after the last
sync is not here, which no device can know offline. Apps show `completedAt`
("Offline copy from 3 days ago").

### 4.2 The hard cases

- **Membership gained.** The grants are part of the rules key
  (`accessSessionRulesKey(..., accessGrantsKey(...))`, `client-session.ts`); a session whose grants
  change ends, and the next handshake re-scopes in full with a new key (`accessNarrowing` +
  entries, `packages/server/src/access/access-delivery.ts`). The narrowing clears the marks, the
  new key is saved only after the unit applies, and the next final marks under the new key.
  Between the two: `syncing`/`incomplete`. A membership gained while the device is offline is
  invisible to it, and readiness says nothing about it (complete as of `completedAt`).
- **Membership lost.** Same path; the narrowing removes the group's records. A pin on that group
  completes with `records: 0`. That is correct (no access), and the handle reports it so the app
  can say "this course is no longer available" instead of an empty page.
- **Scope change** (`scopeExit: 'retract'`, `applyScopeNarrowing` at handshake): a different
  `scopeKey` never matches an old mark, and narrowing only removes rows outside the new scope,
  so it needs no clear.
- **Query views.** In `reactive` mode every mounted query's equality filter is a subset, so the
  view changes with navigation. Containment (rule 3) keeps an offline reload of a visited route
  `complete`; a route never opened online is not covered, and that is the honest answer: use
  `keep`. A pin adds its subset to the effective view only for collections that already have
  subsets (a collection with none is unrestricted and already contains the pin), so keep never
  narrows what a collection downloads. Pins are added to `static` subsets the same way
  (`setQuerySubsets` replaces the app's manifest, not the pins); `disabled` ignores them.
- **Tabs.** Every tab's `createApp` runs its own `SyncEngine` over the one shared database
  (`kora/src/initialize-app.ts`), with its own view. Marks and pins live in the database, so
  every tab sees every mark; status is computed per tab against that tab's view, and two tabs
  may differ. Pin changes are announced on the existing database-scoped channel
  (`kora/src/local-operation-bus.ts`) so every tab's engine includes every pin.
- **No sync.** `data.state` is `local` (nothing to download). Pins only track files.
- **Quarantine** (`sync:apply-failed`) is counted, not gating: it waits for an app update or a
  key, which would hold `ready` false forever for unrelated routes. A transient failure stalls
  the watermark (`blockedFailure`) and is gating (`data-blocked`).
- **Progress**: `(watermark - start) / (serverFrontier - start)` during a handshake stream
  (delivery sequences include out-of-scope operations, so it is approximate and monotonic).

### 4.3 `keep(query, { files })`

Pins live in a local-only table `_kora_offline_pins(id, collection, where, files, created_at,
completed_at)`; they are not operations and never sync. Rules:
- The query must be a single-collection `where`; `limit`, `offset` and `include` are refused
  (`OFFLINE_KEEP_UNSUPPORTED_QUERY`); `orderBy` is ignored. Operator filters are widened to the
  collection subset exactly as `queryDescriptorToSyncSubset` does today (correct, may download
  more); files are still selected by the full local query.
- At most 64 pins per database (`OFFLINE_PIN_LIMIT`): pins travel in the handshake and the
  server bounds predicates (`maxScopePredicateValues`). Each new pin is a new view that
  back-fills once (deduplicated); keeps within the existing subset-change debounce share one.
- A pin is complete when a mark containing it exists (section 4.1) and, with `files`, every
  blob it needs is present. `completed_at` is display only; completion is re-derived, never
  trusted from the row.

## 5. Files

- **Kept files.** For each pin with `files: true`, the blob refs of the records matching the pin's
  local query. **Missing** = `!blobStore.has(ref.hash)`. Each is fetched with the existing
  `app.blobs.pull(ref)` (manifest, then chunks; throttling and retries already handled by
  `createRemoteChunkProvider`) and read once with `get()`, which verifies the hash, before it
  counts as present. Later disk corruption is out of scope.
- **Referenced but never kept** blobs are not part of readiness and not counted in `missing`:
  the app did not ask for them offline. `useBlob`-style UI should show them as "not available
  offline" when `get` returns null; the docs page says so.
- **One fetcher per database.** A Web Lock `kora-offline-files-<db>` elects one tab to download;
  others see progress through the blob store and the channel.
- **Durability.** `ContentAddressedBlobStore` gains `readonly durable: boolean` (OPFS and
  filesystem stores true, `MemoryBlobStore` false). The memory fallback in `resolveBlobStore`
  becomes visible: `storage.durable` false and `storage-non-durable` while any pin wants files.
- **GC and caps.** `app.blobs.gc()` already keeps every blob a live record references
  (`collectBlobGarbage`), so a pinned blob is never collected while its record lives; a pin adds
  proactive download, not retention. A released pin's blobs become collectable once no live
  record references them. There is no client blob cap today; if one is added later, pinned blobs
  are exempt and unpinned ones are the evictable cache. The browser quota is the real cap: before
  a download, sum `ref.size` of missing refs against `navigator.storage.estimate()`; a
  `QuotaExceededError` (or the estimate) fails those files with `reason: 'quota'`
  (`files-failed`). Server limits (`blobLimits.maxRequestsPerMinute`) throttle pulls, they do not
  fail them; a peer-relay server with no peer online fails with `reason: 'unavailable'`, retried
  next session.
- `keep` with `files` requests persistent storage in the background (`requestInBackground`,
  new reason `'offline-keep'`): the user just asked for an offline copy.

## 6. Storage loss (A3)

### 6.1 Detection

A database that existed and vanished must not open as a fresh device. Evidence lives outside
the database, in two independent places:
1. the storage manifest (IndexedDB `kora-manifest`, `packages/store/src/adapters/storage-manifest.ts`),
   which already records every database with `backend`, `createdAt`, `lastOpenedAt` since W8a,
   extended with `epoch` (random, also written to `_kora_meta.db_epoch` at creation) and
   `unsynced`, `unsyncedAt`;
2. `localStorage['kora:db:<dbName>'] = epoch`. Independent of the manifest, which shares
   IndexedDB with the fallback backend and vanishes with it.

Both are written only after the first durable open (`afterLeaderOpen`, which already records
the manifest), so a crash during creation can never leave a marker for a database that never
existed.

At open, after the backend is resolved: if the database has no `_kora_meta` (it was just created)
and either marker names this database **for the same backend**, emit `store:storage-evicted` and
keep it in `storage.evicted` until `app.offline.acknowledgeEviction()`:

```typescript
interface StorageEviction {
  dbName: string
  detectedAt: number
  lastOpenedAt: number | null
  evidence: Array<'manifest' | 'localStorage'>
  lostWrites: { count: number; certain: boolean } // count at unsyncedAt; certain: no write after it
}
```

`unsynced` is written to the manifest when the outbound count crosses zero (both ways) and on
`pagehide`/hidden, so it is cheap and at worst stale: `certain: false` says so. A database with
lost writes is still opened (it re-syncs); the app must tell the user. This is reported, never
silent; Kora cannot recover what only that database held.

### 6.2 No false positives

| Case | Why it is not reported |
|---|---|
| `app.storage.deleteDatabase()` | Removes the manifest record and the localStorage marker first. |
| IndexedDB to OPFS move, OPFS fallback | Marker for another backend: the existing migration path or `StorageBackendMismatchError` applies, not eviction. |
| First open on this device, private window | No marker. |
| `store.name` change, `namespaceByAuthUser` | Markers are per database name. |
| User clears all site data | Markers are gone too: a fresh device (the user's intent). |

`navigator.storage.persisted()` is not evidence of anything here: it only says whether the
browser promised not to evict.

### 6.3 What cannot be detected

Eviction under storage pressure and Safari's 7-day script-storage cap delete the whole origin:
database, OPFS, Cache Storage, localStorage, the service worker. Nothing on the device remains to
compare with, so it is indistinguishable from a first visit. Defense is prevention (persistence
requested after the first write, sign-in, installed app, and now `keep`), plus `storage.persisted`
in the status so the app can warn ("install the app to keep it offline"). Server-assisted
detection is an open question (Q6).

## 7. Shell (A4)

The page cannot know whether the precache is complete: `navigator.serviceWorker.controller` is
null after a hard reload although offline reloads work, and a cache can be partly deleted. So
the worker answers:

- `postMessage({ type: 'KORA_SW_STATUS' })` to `registration.active` (not the controller); the
  worker checks every `PRECACHE` URL in `kora-shell-<VERSION>` and replies
  `{ v: 1, version, complete, missing: n, misses }`. When online and incomplete it re-adds the
  missing entries, then replies.
- The registration script (`registrationScript`) stores the result in
  `globalThis.__KORA_SHELL__ = { v: 1, state, version, misses }` and dispatches `kora:shell`.
  `app.offline` reads that contract (korajs cannot import `@korajs/cli`). Absent: `none`
  (no plugin, `vite dev`, or an older plugin: reason `shell-none`).
- **Same build.** The page also sends the URLs of its own same-origin hashed scripts and
  styles (`performance.getEntriesByType('resource')` plus `document.scripts`); the worker
  replies `sameBuild: false` when any is missing from its `PRECACHE`. That happens after a
  shift-reload online while an older worker is active: an offline reload would run the
  worker's older build against a database this page may have migrated (`store:schema-ahead`).
  State `other-build`, reason `shell-other-build`, until the user accepts the update.
- States: `installing` (registration pending or worker installing), `installed` (active worker,
  complete cache), `not-installed` (install failed or cache incomplete offline), `unsupported`
  (no service worker or insecure context, matching the script's guard). Checked at start, on
  `updatefound`, `controllerchange` and `visibilitychange`, never polled.
- `misses`: the worker records same-origin GETs it could not serve while the network failed, and
  cross-origin requests that failed from a controlled page. Diagnostic only (known after the
  failure); it is how a font CDN shows up.
- **Tauri / desktop**: `shell.state = 'bundled'` (interface embedded in the binary,
  `packages/cli/templates/tauri-react` has no service worker), `storage.backend = 'native'`,
  `durable: true`, `persisted: true`, `usage`/`quota` null. The blob store is whatever
  `resolveBlobStore` chose in the WebView; if it is memory, files are `non-durable` (Q8).
- **Templates**: every template renders `<OfflineBadge />` from `useOfflineReady()`: "Available
  offline" / "Preparing offline copy... 40%" / "Not available offline yet" with the first reason
  as a tooltip; hidden in `vite dev`. The update prompt is unchanged.

## 8. Wording and guarantees (A5)

Proposed headline: **"Works offline after the first open. Your work is saved on this device
first, and Kora never loses it silently."** The plan's "never loses your work" is not provable:
a whole-origin wipe (6.3) loses unsynced writes, and the IndexedDB fallback persists a snapshot
debounced by 500 ms (`indexeddb-adapter.ts`, flushed on tab hide), so a browser crash in that
window loses the last write (Q2).

New docs page `docs/guide/offline-readiness.md`:

Kora guarantees:
- When `useOfflineReady().state === 'ready'`, an offline reload opens this build, shows the data
  of the current view and every pin as of `completedAt`, shows kept files, and accepts writes.
- Writes are on the device before they upload, and survive reloads (OPFS: on commit; IndexedDB
  fallback: within 500 ms or on tab hide).
- Nothing is dropped silently: refused writes, quarantined operations and detected storage loss
  are events and status.

Your app's responsibilities:
- `keep` what must work offline beyond the routes the user opened online.
- Same-origin assets only, or cache your own (fonts, CDNs, your API).
- Sign the user in while online; offline sessions last `maxOfflineDuration` (30 days).
- Large pins within the device quota; tell users on Safari to install the app (persistence).
- Show the badge and `storage.evicted` honestly.

## 9. Test plan

Unit (Vitest, no browser):
- Marks: set on a fully applied final batch; not set on a partial apply, a gap, a blocked
  failure or a legacy batch; cleared before a batch with `accessNarrowing`/`retractions` (throw
  inside `applyCollectionNarrowing`, restart: `incomplete`); cleared by every watermark reset;
  dropped with LRU eviction; rules key and scope key mismatches; containment across views.
- Re-scope end to end (server + engine, `@korajs/test`): membership gained and lost,
  disconnect inside the unit, reconnect.
- Pins: idempotent ids, survive restart, release, limit, refused queries, `static`/`reactive`/
  `disabled` effective subsets, no narrowing of an unrestricted collection.
- Files: missing/present, integrity on completion, quota failure (injected store throwing
  `QuotaExceededError`), `MemoryBlobStore` gives `non-durable`, single fetcher under the lock.
- Eviction: marker plus fresh database reports; each row of 6.2 does not; a crash before the
  first durable open leaves no marker.
- Marks: principal and collection-set mismatches; IndexedDB backend not `ready` until the
  barrier resolves.
- Service worker (`service-worker.test.ts` harness): status reply, incomplete cache, self-heal.
- State rule: a table test over every component combination.

Playwright, every web template (12) built and served by the production server, through one
helper `assertReadyMeansOffline(page)`: wait for `ready`, set the context offline, reload, visit
every template route, check rows render, insert, check `pendingOperations` grew, reload offline
again, check the write is still there, go online, check it uploads. Negative tests, each asserting
`ready` is never observed:
- `sw.js` aborted: `shell-none`/`shell-not-installed`.
- The sync fixture holds the handshake stream's final batch: `data-syncing`, then offline
  `data-incomplete`, still after an offline reload.
- Blob chunk requests aborted for a kept record: `files-missing`.
- One precache entry deleted from Cache Storage while offline: `shell-not-installed`.
- Deploy a second build, shift-reload online: `shell-other-build`.
Eviction: delete the database's OPFS pool and IndexedDB copy from the page, keep the manifest,
reload: `store:storage-evicted` with `lostWrites.count` equal to the queued writes; clear all
origin storage: no event (documents 6.3). Tauri: unit test of the bundled/native status.

## 10. Rollout

1. beta.15, no protocol change (everything is client side; the server already sends the rules
   key, finals and `serverMaxDeliverySequence`).
2. Order: eviction markers first (the manifest exists since W8a, so detection works on existing
   databases at once), then marks, status and hooks, then the service-worker protocol and
   template badge, then `keep`.
3. Version skew: an app on new `korajs` with an older `@korajs/cli` plugin reports `shell-none`;
   the changelog says to update both. `__KORA_SHELL__.v` versions the contract.
4. New events in `KoraEvent` (`packages/core/src/events/events.ts`), documented in
   `docs/api/devtools.md`: `offline:status` (state changes only, not progress ticks),
   `offline:keep-progress`, `offline:keep-complete`, `offline:keep-failed`
   (`reason: 'quota' | 'unavailable' | 'integrity' | 'non-durable'`), `store:storage-evicted`.

## 11. Red-team: where could `ready` be true and the app fail offline?

| Attack | Resolution |
|---|---|
| Hard reload: page uncontrolled | Status asks `registration.active`, not `controller`. |
| Shift-reload online runs a newer build than the active worker | `sameBuild` check: `other-build`. |
| Another user on the same database, no scopes | `principal` in the mark. |
| App update syncs a new collection | `collectionsKey` in the mark. |
| IndexedDB fallback: mark not yet in the snapshot | `ready` waits for `ensureDurable()`. |
| Cache entry deleted or evicted after install | Worker verifies every precache URL per check. |
| CDN font, analytics script, own API | Not provable; `misses` surfaces it; template tests; app responsibility. |
| Crash inside a re-scope unit | Marks cleared before narrowing/retractions apply. |
| Server restore resets watermarks | Every reset clears marks. |
| Grants changed while a mark exists | Rules key includes grants; mismatch is not complete. |
| Route never opened online | Not covered by containment: `incomplete` unless kept. |
| Blob store fell back to memory | `durable` false, `storage-non-durable`. |
| Database in memory (`allowNonDurable`) | `backend: 'memory'`, `durable` false. |
| Corrupt kept blob | Hash verified before it counts; later corruption out of scope. |
| Identity cannot be restored offline (tokens gone, `maxOfflineDuration` passed, per-user database) | `auth` component (Q4). |
| Old build reopened on a newer database | One build per active worker; the store refuses (`store:schema-ahead`). |
| Whole-origin eviction after `ready` | Undetectable; `ready` is a claim about now; `persisted: false` is surfaced. |
| Another tab's view | Status is per tab, computed against this tab's view. |

## 12. Open questions for Obed

1. Should `ready` require `persisted === true`? Recommendation: no (most Chrome tabs and all
   non-installed Safari pages would never be ready); show "Available offline (may be cleared if
   unused)" when not persisted.
2. Approve the wording in section 8, or make writes on the IndexedDB fallback await the snapshot
   (`ensureDurable`) so "never loses your work" holds there, at a latency cost.
3. Quarantined operations: reported but not gating (recommended), or gating?
4. Is the `auth` component in beta.15? It needs `AuthSyncBinding` to expose whether the session
   is restorable offline and until when.
5. `keep` refuses `include`: an LMS keeps courses, lessons and quizzes as three pins. Acceptable
   for v1? And the 64-pin cap?
6. Whole-origin wipe: worth a server-assisted signal later (the device reports its unsynced count
   at handshake; the server flags a node that never returns with writes outstanding)?
7. Template badge: on by default in every template and hidden in dev, as proposed?
8. Tauri: ship a filesystem blob store for the WebView so desktop files are durable by default?
