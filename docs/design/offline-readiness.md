# Design: offline readiness (`app.offline`, `useOfflineReady`)

Status: revision 5, decisions taken (section 12). Not implemented. Date: 2026-10-20.
Workstream A of the beta.15 plan. Public API: review before code. Changes from revision 1:
the eight open questions are decided (section 12); writes on the IndexedDB fallback now wait
for a durable snapshot (section 8.1); the auth component is specified (section 8.2).
Changes from revision 2 (review): every delivery unit opens a durable marker before it applies,
so a partly applied ordinary stream is never `complete` after a reload (4.1); blob durability
counts only while a pin keeps files (3, 5); token stores declare their durability (8.2); the
localStorage eviction marker carries the backend (6.1); a clock moved backward re-evaluates
auth at once (8.2).
Changes from revision 3 (review): the unit-open marker is an ordinary `_kora_meta` write, with no
barrier (4.1); every completion-metadata change is broadcast to every tab (4.2); the worker
heals a precache entry only with bytes matching the build-time digest (7); component-owned pins
are held per component, so one unmount never releases another's pin (4.3); a snapshot lost to a
storage-leader change (#52, `SNAPSHOT_SUPERSEDED`) is reported, not recovered (8.1).
Changes from revision 4 (review, and main after #52, #54, #55, #57, #59 merged): each delivery
unit has its own open marker, so one engine's final batch never clears another's (4.1); the
single-tab fallback without `BroadcastChannel` is enforced, not assumed (4.2); holds of a tab
that exits are pruned by the tabs still open, through #61's per-tab locks (4.3); `forceFullResync`
(#54) is a watermark reset that clears marks; `insertMany` (#55) is a write with one barrier.

Related: version gate (`docs/design/version-gate.md`, PR #61): one build writes a database at a
time; an older tab retires and prompts a reload before its first refused write; it also defines
the per-tab locks and the fail-closed coordination fallback this design reuses (4.2, 4.3).
Merged since revision 4: IndexedDB snapshot ordering (#52), retraction order and delivery-order
visibility with `forceFullResync` (#54), `insertMany` (#55), `useMutation` rejected state (#57),
multi-tab transaction isolation (#59).

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
- The promise **"Works offline after the first open, never loses your work"** holds on every
  backend, with its scope defined precisely in section 8.

Non-goals (v1):
- Opening offline on a first visit (impossible; F15 fail-fast stays: a missing `sqlite3.wasm`
  fails the open in seconds with a clear error).
- Detecting a whole-origin wipe (section 6.3; a server-side signal is future work, section 13),
  background download while the app is closed (Background Sync), caching the app's own non-Kora
  API responses or cross-origin assets.
- `keep` across relations (`include`: one pin per collection), a blob cache size cap with
  eviction, a durable file blob store for Tauri (section 13), server-rendered pages.

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
    quarantined: number             // reported only, never gating (section 4.2)
  }
  files: { kept: number; missing: number; bytesMissing: number; failed: number }
  storage: {
    backend: 'opfs' | 'indexeddb' | 'native' | 'memory'
    durable: boolean                // the database survives a reload, and so does the blob
                                    // store while any pin keeps files (section 5)
    blobStoreDurable: boolean       // diagnostic: the blob store alone survives a reload
    persisted: boolean | null       // navigator.storage.persisted(); null: unknown/unsupported
                                    // informational: false shows "may be cleared if unused"
    writes: 'durable' | 'failing'   // section 8.1: 'failing' while snapshot saves fail, and
                                    // until reload after a SNAPSHOT_SUPERSEDED loss
    usage: number | null
    quota: number | null
    evicted: StorageEviction | null // section 6
  }
  auth: {
    state: 'n/a' | 'loading' | 'restorable' | 'not-restorable' | 'unknown'
    offlineUntil: number | null     // restorable offline until (ms); null: no limit known
  }
}

type OfflineReason =
  | 'shell-none' | 'shell-unsupported' | 'shell-not-installed' | 'shell-installing'
  | 'shell-other-build'
  | 'data-syncing' | 'data-incomplete' | 'data-blocked'
  | 'files-downloading' | 'files-missing' | 'files-failed'
  | 'storage-non-durable' | 'storage-writes-failing' | 'storage-uncoordinated'
  | 'storage-other-tab'
  | 'auth-loading' | 'auth-not-restorable' | 'auth-unknown' | 'server-rendering'

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
`useOfflineKeep(query, options)` holds a pin for a component's lifetime, only when asked; pins
are durable and normally released explicitly. Several components (in one tab or several) may
hold the same pin: each holds it separately, and the pin goes only when the last holder and any
explicit `keep` have released it (4.3).

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
| storage | `durable` (database durable; blob store durable only while a pin has `files: true`) and `writes === 'durable'` |
| auth | `n/a`, or `restorable` with `offlineUntil` null or in the future (section 8.2) |

Otherwise `preparing` when every failing component is making progress (shell installing, data
syncing on a live session, files downloading, auth loading), else `not-ready`. `persisted`,
`quota`, `quarantined`, `evicted` and `misses` never make `ready` true or false (decisions 1
and 3). A status with `persisted: false` still reads `ready`, and the badge adds "may be cleared
if unused". `ready` flips to `not-ready` on a timer at `auth.offlineUntil`, and is re-evaluated
at once when the wall clock jumps (section 8.2, "Re-evaluation").

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
- **Delivery unit open** (every batch, not only re-scope units). A unit is the batches one sync
  engine applies from one base up to its `isFinal` batch. Several engines can run units of the
  same view at once (every tab runs its own `SyncEngine` over the shared database, 4.2), so the
  marker is **per unit**, never per view: before the first operation of ANY delivery batch is
  applied, the engine writes `offline_unit_open:<signature>:<unitId>` =
  `{ base, upTo }` in its own committed `_kora_meta` transaction unless its own unit's key is
  already present. `unitId` is the engine's random session id plus the unit's base delivery
  sequence, so no two units, in one tab or across tabs, share a key. `upTo` is the highest
  delivery sequence the unit can apply: the handshake's `serverMaxDeliverySequence` for a
  handshake stream, the batch's `maxDeliverySequence` for a streaming unit; a later batch of the
  same unit that goes beyond it rewrites the key first (a second small write, only for units
  longer than their announced frontier).
  - **Cleared by its owner** in the transaction that sets the mark for the unit's final batch.
    One engine's final batch never deletes another live unit's key.
  - **Superseded** (the crash case): in that same transaction the engine also deletes every
    other key of the view with `base >= myBase` and `upTo <= W`, where `myBase` and `W` are its
    own unit's base and final watermark. Its unit applied every operation of the view in
    `(myBase, W]`, a superset of anything the other unit could have applied, and the fold
    depends only on the set of operations, so the database is exactly the state at `W` whatever
    that unit left. A unit still running in another tab is either covered this way (what it
    still applies is already applied, idempotently) or keeps its key. A crashed unit's key
    therefore stays until a later unit covers it; the next engine resumes from the durable
    watermark (at or below the crashed unit's base) to the server's frontier (at or above its
    `upTo`), so the first complete unit after the crash clears it.
  - **Marks never go backward.** A unit whose final watermark is below the stored mark's
    leaves the mark (it may still clear its own key). So a slower tab finishing an older unit
    cannot replace a newer tab's mark with an older one.

  The marker needs no durability barrier of its own: it commits before any operation of the
  unit, so whatever persists an operation of the unit persists the marker too (OPFS and native:
  each later commit; IndexedDB fallback: a snapshot is an export of the whole database at one
  commit, ordered by #52's commit counter, so a snapshot holding part of the unit holds the
  marker). A crash before any snapshot rolls back the marker and the partial unit together, to
  a state that was complete as of its mark. While any key of the view exists, no mark of that
  view is `complete` (rule 7 below). Operations of a batch are applied one transaction at a time
  and the watermark advances only after the whole batch, so without the marker a client that
  was complete, reconnected, applied part of an ordinary non-final batch and then crashed (or
  stalled on an operation and was reloaded offline) would still hold an old mark: the in-memory
  guards of rule 5 (`blockedFailure`, the in-flight batch) do not survive a reload and are per
  tab. The cost is one small `_kora_meta` row per unit, not per batch: a streaming unit (one
  final batch) writes it and clears it with the mark. On the IndexedDB fallback it adds no
  snapshot: remote applies never await the barrier (8.1), and the marker and mark ride the
  debounced snapshot that already persists the unit's operations.
- **Cleared** (every mark, in a transaction committed before anything is applied, so persisted
  by the same rule as the unit marker) when:
  - a batch carries `accessNarrowing` or `retractions` (a re-scope unit or records leaving);
  - the watermark is reset: `resetDeliveryForFullResync()` (history-behind, sequence conflict,
    deferred full resync) and the "watermark ahead of server frontier" reset (server restore,
    and `KoraSyncServer.forceFullResync()` (#54), which advertises a frontier below the device's
    watermark so the view restarts from 0). Unit keys are not cleared by a reset: the replay
    from 0 covers them (`base >= 0`) and clears them with its first mark.
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
   barrier resolved after the mark was written. Before that the mark lives only in memory. The
   status waits for the next debounced snapshot that holds the mark (it observes the stored
   commit counter); it never forces one, so live delivery adds no snapshot;
7. no `offline_unit_open:<signature>:*` key exists for the active view (whichever engine or tab
   opened it), and `M.watermark` equals the view's durable watermark (a later unit that applied
   completely sets a newer mark; one that did not leaves its key).

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
  may differ. The status snapshot is cached per tab, and these writes change no record, so the
  record invalidations of the local-operation bus would never reach it. The bus
  (`kora/src/local-operation-bus.ts`, channel `kora-local-ops-<db>`) gains a third message,
  `kora-offline-meta-changed` (`{ originId, kind, signature | pinId }`), posted after the commit
  of every change to readiness metadata: unit key opened, cleared or superseded, mark set, cleared,
  replaced or evicted, every watermark reset, pin added, held, released, completed, and (IndexedDB
  fallback) a barrier covering a mark resolved. Every receiving tab re-reads marks, markers and
  pins from the database and recomputes its status; the writing tab recomputes its own. A tab
  that missed messages (bfcache, freeze) recomputes on `pageshow` / `resume`.
- **No `BroadcastChannel`: one tab, enforced.** Today `acquireTabStorageSession()` treats every
  instance as a leader when a coordination API is missing, so two tabs could each cache `ready`
  with no message to invalidate it. The version gate (#61, section 4.1.1) makes the fallback
  fail closed, and this design relies on it rather than on an assumption: with Web Locks but no
  `BroadcastChannel`, a tab opens storage only while it holds the exclusive `kora-db:<db>` lock
  for its life, so a second tab does not open storage at all (it waits, `store:tab-exclusive`)
  and its status is not computed from the database: `not-ready` with reason
  `storage-other-tab` (badge: "Open in another tab"). Without
  Web Locks the open refuses (`TAB_COORDINATION_UNAVAILABLE`) unless the app opted into
  `store.allowUncoordinatedTabs`, which also makes `app.offline` report `not-ready` with reason
  `storage-uncoordinated`: an uncoordinated database is never claimed ready. The one tab that
  holds the database still recomputes on `pageshow` / `resume`; there is nobody else to
  notify.
- **No sync.** `data.state` is `local` (nothing to download). Pins only track files.
- **Quarantine** (`sync:apply-failed`) is reported only, never gating (decision 3): it waits
  for an app update or a key, which would hold `ready` false forever for unrelated routes. A
  record whose operation is quarantined may be missing or stale offline; the guarantee (8.3)
  names this exception. A transient failure stalls the watermark (`blockedFailure`) and is
  gating (`data-blocked`).
- **Progress**: `(watermark - start) / (serverFrontier - start)` during a handshake stream
  (delivery sequences include out-of-scope operations, so it is approximate and monotonic).

### 4.3 `keep(query, { files })`

Pins live in a local-only table `_kora_offline_pins(id, collection, where, files, explicit,
created_at, completed_at)`; they are not operations and never sync. Rules:
- The query must be a single-collection `where`; `limit`, `offset` and `include` are refused
  (`OFFLINE_KEEP_UNSUPPORTED_QUERY`; decision 5: one pin per collection, so an LMS keeps
  courses, lessons and quizzes as three pins); `orderBy` is ignored. Operator filters are
  widened to the collection subset exactly as `queryDescriptorToSyncSubset` does today (correct,
  may download more); files are still selected by the full local query.
- At most 64 pins per database (`OFFLINE_PIN_LIMIT`, decision 5): pins travel in the handshake
  and the server bounds predicates (`maxScopePredicateValues`). Each new pin is a new view that
  back-fills once (deduplicated); keeps within the existing subset-change debounce share one.
- A pin is complete when a mark containing it exists (section 4.1) and, with `files`, every
  blob it needs is present. `completed_at` is display only; completion is re-derived, never
  trusted from the row.
- **Holders.** `keep()` and `release()` set and clear the pin's `explicit` flag. A component
  holds a pin through `useOfflineKeep`, which adds a row to `_kora_offline_pin_holds(pin_id,
  holder)` on mount (`holder` = this tab's id plus a per-hook-instance id, so React StrictMode's
  double mount is two holds then one) and deletes its own row on unmount. A pin row is deleted,
  in the same transaction, only when `explicit` is false and no hold remains; two components
  on one query, in one tab or two, therefore keep the pin until both unmount.
- **Holds of a tab that exits** (crash, kill, close without unmount) are pruned by the tabs
  still open, not only at the next open. The holder's tab id is the `tabId` of its version-gate
  tab lock (`kora-tab:<db>:<identity>`, #61 section 4.1), held for the tab's life:
  - At open, a tab deletes every hold whose tab id has no held tab lock
    (`navigator.locks.query()`).
  - While open, a tab that sees holds of other tabs (at open, and on every
    `kora-offline-meta-changed` with `kind: 'hold'`) watches each such tab's lock: it queues a
    `navigator.locks.request(<that tab's lock name>, { mode: 'shared' })`, granted only once the
    owner released it. Its callback returns at once (the lock is not kept) and prunes that tab's
    holds in one transaction, after `query()` confirms the lock is still not held, then
    broadcasts the change. One watcher per holder tab per watching tab; it is dropped when that
    tab's holds are gone.
  - A tab releases its tab lock on `pagehide` / `freeze` (#61), so its holds can be pruned while
    it sits in bfcache or frozen. Its components are still mounted, so on `pageshow` / `resume`,
    after re-acquiring its tab lock, the tab re-inserts every hold its mounted hooks own (kept in
    memory) and re-creates a pin the prune deleted (the pin id is the same hash, `keep` is
    idempotent). The pin may be absent for that interval, which is correct: no live component
    held it.
  - Without `BroadcastChannel` one tab owns the database (4.2) and at open every hold is stale.
    With `allowUncoordinatedTabs` (no Web Locks) holds are not used: `useOfflineKeep` takes an
    explicit pin and releases it on unmount, and the docs say a crash leaves it pinned until
    released.
  `app.offline.list()` shows `explicit` and the holder count.

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
  filesystem stores true, `MemoryBlobStore` false), reported as `storage.blobStoreDurable`. The
  memory fallback in `resolveBlobStore` becomes visible, but it gates readiness only while some
  pin has `files: true`: then `storage.durable` is false (`storage-non-durable`). With no kept
  files, no blob is part of the readiness promise, so a durable database with a memory blob
  store is `durable` and can be `ready` (blobs viewed on demand are "not available offline", as
  above).
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
2. `localStorage['kora:db:<dbName>'] = JSON.stringify({ v: 1, epoch, backend })`. Independent of
   the manifest, which shares IndexedDB with the fallback backend and vanishes with it. It
   carries the backend itself, so the same-backend rule below holds when it is the only
   evidence left (the manifest cleared or unreadable). A marker without a `backend` (malformed,
   or written by a future format this build does not read) is ignored, never reported.

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
| IndexedDB to OPFS move, OPFS fallback | Marker for another backend (both markers record it): the existing migration path or `StorageBackendMismatchError` applies, not eviction. This holds with the localStorage marker alone. |
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
in the status so the app can warn ("install the app to keep it offline"). A server-side
signal is deferred to beta.16 (section 13). This is the one case where unsynced work can still
be lost; section 8 says so.

## 7. Shell (A4)

The page cannot know whether the precache is complete: `navigator.serviceWorker.controller` is
null after a hard reload although offline reloads work, and a cache can be partly deleted. So
the worker answers:

- `postMessage({ type: 'KORA_SW_STATUS' })` to `registration.active` (not the controller); the
  worker checks every `PRECACHE` URL in `kora-shell-<VERSION>` and replies
  `{ v: 1, version, complete, missing: n, misses }`. When online and incomplete it heals: it
  refetches each missing URL (`cache: 'reload'`) and stores it only when its SHA-256 equals the
  build-time digest of that file. The plugin already computes the digests to derive `VERSION`
  (`computePrecache`); the generated worker embeds them as `DIGESTS` and checks with
  `crypto.subtle.digest`. Hashed names would match anyway, but mutable URLs (`index.html`, other
  pages, the unhashed `sqlite3.wasm` copy, `manifest.webmanifest`) may already serve a newer
  deployment; their bytes do not match, are never written into this build's cache, and the entry
  stays missing: `not-installed` until the newer worker installs and the user accepts it. The
  worker never heals with bytes it cannot verify.
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
  `durable: true`, `persisted: true`, `usage`/`quota` null. In beta.15 the blob store is
  whatever `resolveBlobStore` chose in the WebView (OPFS where the WebView has it); where it is
  memory, a pin with `files` reports `storage-non-durable` and the app is not `ready`. The
  durable file blob store for Tauri comes after beta.15 (decision 8, section 13).
- **Templates** (decision 7): every template, `tauri-react` included, renders `<OfflineBadge />`
  from `useOfflineReady()`, on by default and not rendered in `vite dev`: "Available offline"
  (plus "may be cleared if unused" when `persisted` is false) / "Preparing offline copy... 40%"
  / "Not available offline yet", with the first reason as a tooltip. The update prompt is
  unchanged.

## 8. Wording and guarantees (A5)

Headline (decision 2): **"Works offline after the first open, never loses your work."**

"Your work" is defined precisely, and the docs page states it: a write whose promise resolved
(`insert`, `insertMany`, `update`, `delete`, `transaction`, `mutation`, `mutateAsync`) survives a tab crash,
a browser crash, a reload and a restart, offline, on every backend, until it reaches the server.
The one exception is a browser deleting the whole site's storage (section 6.3); the docs page
names it and how to prevent it (persistent storage, installing the app). On the IndexedDB
fallback a write can also be lost to a storage-leader change before any snapshot held it; its
promise then rejects (`SNAPSHOT_SUPERSEDED`, 8.1), so it was never a resolved write, and the
loss is reported. A follower's transaction cut by a leader change fails with a retriable
`BridgeTerminatedError` (#59) before it resolves, so it is not a resolved write either.

### 8.1 Durable writes on every backend

| Backend | When a write is durable | Change |
|---|---|---|
| OPFS (`opfs-sahpool`, rollback journal) | On commit | None |
| Native (`better-sqlite3`, Tauri plugin) | On commit (WAL) | `synchronous = FULL` set explicitly (below) |
| IndexedDB fallback (SQLite in memory + snapshot) | Today: up to 500 ms later (debounce) or on tab hide | Writes wait for the snapshot |

**Mechanism.** The store's local write path (the transaction that records an operation and
applies it, `packages/store/src/store/store.ts`), after its transaction commits and before the
promise resolves, awaits `adapter.ensureDurable()` when the adapter implements it. Only
`IndexedDbAdapter` implements it (`flushBarrier` in
`packages/store/src/adapters/indexeddb-persistence-scheduler.ts`), so OPFS and native writes pay
nothing. Three changes make the barrier strong enough to promise on:

1. **Group commit.** `flushBarrier` already resolves every write scheduled before it with one
   snapshot, and concurrent barriers share the snapshot in flight. Writes issued together
   (`Promise.all`, a `transaction`, `mutate` calls in one tick) pay one snapshot. A write path
   awaiting the barrier skips the 500 ms debounce: it starts the snapshot at once.
2. **Ordered snapshots across tabs.** Each tab has its own adapter and scheduler, and a follower's
   snapshot exports the leader's database over RPC (`writeSnapshot`, `exportDump` in
   `indexeddb-adapter.ts`). Two tabs can save out of order today, so an older export may
   overwrite a newer one, and a write whose barrier resolved in one tab is lost if the other
   tab's older save lands last. Fix (#52, merged): a commit counter `{ epoch, lineage, seq }`, bumped
   in the same SQLite transaction as every write (a connection-local TEMP table, never part of a
   dump), is read in the export's transaction and stored with the dump; the save becomes a
   compare-and-put in one IndexedDB `readwrite` transaction that keeps the stored snapshot when
   it is newer. Each worker database (open, reload, promotion) starts a new lineage. A barrier
   is satisfied when a stored snapshot of the write's lineage (or its ancestry) holds the
   write, whoever saved it. The binary
   snapshot (`saveToIndexedDB`, which `restoreIfFresh` prefers) and the JSON dump are written in
   that same IndexedDB transaction with the same counter, so a restore can never pick an older
   one of the two. A follower's
   barrier is also routed to the leader tab (one request on the storage channel, answered after
   the leader's strict snapshot, build notes below) instead of exporting the whole database over
   the broadcast channel; the follower exports itself only when the leader is gone, and
   compare-and-put keeps that safe.
3. **Strict IndexedDB durability.** Barrier snapshots open their transaction with
   `{ durability: 'strict' }` (Chrome's default is `relaxed`, whose `complete` can fire before
   the data reaches disk). Debounced background snapshots stay `relaxed`.

**Failure.** The write is already committed in memory and visible; rolling it back would lose
it. The promise rejects with `WriteNotDurableError` (`WRITE_NOT_DURABLE`, carrying the operation
id and the barrier's error as `cause`), and `storage.writes` is `failing`
(`storage-writes-failing`, never `ready`). Two causes, both reported on the existing
`store:persistence-error` (plus `store:write-durability`, and `store:quota-exceeded` for quota):
- **Save failed** (quota, broken IndexedDB). The write is kept: it stays in memory and in the
  outbound queue, the scheduler keeps retrying, and the error says the app must not retry it.
  `writes` returns to `durable` when a snapshot covering it succeeds.
- **Snapshot superseded** (`context.code: 'SNAPSHOT_SUPERSEDED'`, #52). The storage leader
  changed before any snapshot held the write, so the worker database it was made in is gone and
  the write may be lost (unless sync already uploaded it in degraded mode). Kora cannot recover
  it and offers no recovery API: the error and the event say so, every later barrier of that
  tab keeps rejecting, and `writes` stays `failing` for the rest of the tab's session. Later
  writes are still persisted. A reload opens a new lineage and starts clean (`durable`); the
  app tells the user that their last change may not have been saved.

Sync's degraded upload mode (`sync:durability-degraded`, `awaitUploadDurability` in
`sync-engine.ts`) is unchanged: it lets the server hold a copy when the device cannot, which
only helps, and is the only way a superseded write can survive.

**Scope of the wait.** The barrier runs once per resolved promise: at the end of the outermost
`app.transaction`, `mutation` or `insertMany` (#55, one transaction for all its rows), not per
statement or row inside it. `mutate` (fire-and-forget) does
not wait and gives no guarantee until its write resolves internally; the docs say to use
`mutateAsync` where the user is told "saved". `close()` waits for pending barriers.

**Behavior change.** Today a write on the fallback resolves even while snapshots fail (only
`store:persistence-error` reports it). From beta.15 it rejects with `WriteNotDurableError`.
Apps that treat any rejection as "not saved" must not retry a save-failed write (it exists):
the error says so, and the upgrade notes call it out.

**What still shows early.** Reactive queries update when the in-memory transaction commits, so
for the barrier's duration a write is visible but not yet durable. The guarantee is on the
resolved promise; `useMutation().isLoading` covers the window. Remote operations applied by sync
do not wait for the barrier: their watermark is in the same snapshot, so a crash rolls both back
together and the server re-sends them.

**Latency (fallback devices only).** One snapshot per group of writes, costing a full export plus
one IndexedDB put: linear in database size. Sequential awaited writes each pay it, so bulk
imports must use `insertMany` or one `app.transaction` (the docs page says so). A new benchmark
(`packages/store/src/benchmarks`) measures awaited-insert p50/p95 on the fallback at 1k and 10k
records, single and grouped; the target is p95 under 250 ms at 10k records. If it is missed, the
follow-up is an incremental snapshot (section 13), not weakening the promise.

**Measured 2026-10-29 (A0 implementation).** Headless Chromium 147 on the browser benchmark's
real SQLite WASM worker and IndexedDB backend measured resolved single-write latency at 10,000
records at 210.9 ms p50 and 222.1 ms p95 (20 sequential samples). The grouped 10,000-record
insert, including its one strict durability barrier, took 715.4 ms. The p95 gate therefore passes
without an incremental-snapshot exception; the benchmark now enforces the 250 ms limit. Its
crash scenario reloads the page immediately after the write resolves: the barrier-backed row
survives, while the same write with the barrier deliberately disabled is lost, proving that the
test distinguishes the new guarantee from the old fire-and-forget behavior.

**Build notes: follower barrier routed to the leader (A0).** A follower's `ensureDurable()` used to
run its own scheduler, which exported the whole database over the broadcast channel (compare-and-put
kept that safe, but two tabs with concurrent barriers took two snapshots). Now the follower sends one
`kora-snapshot-barrier-request` on the storage channel (`FollowerBroadcastBridge.requestSnapshotBarrier`),
answered by the leader TAB's main thread (`serveSnapshotBarriers`, started where the leader worker
starts serving), not by the worker relay: only the tab owns the snapshot scheduler and IndexedDB
saves. The leader runs `flushBarrierForPeer()`, which counts as one scheduled write, so the request
joins the same group commit as every barrier waiting there. A snapshot reports the moment it reads
the database (`readPoint`, inside the export transaction); writes and barriers up to that moment are
covered by it, later ones need the next, so a barrier that arrives before an in-flight snapshot reads
shares it. After the leader's reply the follower settles its writes against the stored snapshot
version, as for any save. Failures: the leader's error (code, message, quota) travels back and the
follower's barrier rejects with it (`WRITE_NOT_DURABLE` at the write). A leader that is closing or
retiring answers `LEADER_GOING_AWAY`. A leader that goes silent (watchdog), a follower bridge that is
terminated (this tab was promoted), a timeout, or a heartbeat from a relay of another epoch (a
successor leader never saw the request) all end the wait at once, and the follower then takes the
snapshot itself through whichever worker serves now. That is the barrier re-issued to the new
leader, with the outcome 8.1 already specifies: the write is durable only if a stored snapshot
(or the ancestry of the replaced database) held it, otherwise `SNAPSHOT_SUPERSEDED` and the promise
rejects. Nothing resolves on the leader's word alone after a leader change.

**Native.** Before A0, the Tauri plugin opened SQLite with `synchronous = NORMAL`, which in WAL
mode could lose the last commits on power loss or an OS crash (an app crash was safe). beta.15
sets `synchronous = FULL` there and in the `better-sqlite3` adapter (explicitly, not relying on
the compiled default), at a small write cost.

### 8.2 Auth: restorable offline

`ready` requires that the signed-in session can be restored on an offline reload (decision 4).
`AuthSyncBinding` (`packages/core/src/bindings/types.ts`) gains:

```typescript
resolveOfflineRestore?: () => Promise<
  | { restorable: true; until: number | null }   // until: ms; null: no limit known
  | { restorable: false; reason: 'signed-out' | 'locked' | 'non-durable-credentials' | 'expired'
                                | 'clock-rollback' }
  | { restorable: 'unknown'; reason: 'credential-durability-unknown' }
>
```

`createKoraAuthSync` (`packages/auth/src/client/auth-sync.ts`) implements it from the auth
client. Restorable when the stored access and refresh tokens (`initialize()` needs both to
restore a session) carry a user id, are in storage that survives a reload, and the session is
not `locked` (a clock set back already locks).

**Token storage durability.** `AuthTokenStorage` gains an optional
`readonly durability?: 'durable' | 'session' | 'memory'`; the interface itself says nothing about
it, so a custom store is never assumed durable:

| Token storage | `durability` | Offline restore |
|---|---|---|
| Default `localStorage` storage (`createTokenStorage`) | `durable` | judged as above |
| Its in-memory fallback, `createMemoryAuthTokenStorage()` | `memory` | `non-durable-credentials` |
| `createWebStorageAuthTokenStorage(localStorage)` | `durable` | judged as above |
| `createWebStorageAuthTokenStorage(sessionStorage)` | `session` | `non-durable-credentials` (closing the tab or reopening an installed app loses it) |
| `createAuthTokenStorage({ store, durability })` | as passed | as passed; absent: unknown |
| Custom object without `durability` | absent | `{ restorable: 'unknown' }`: `auth.state` `unknown` (`auth-unknown`), never `ready` |

An app with its own token store sets `durability: 'durable'` on it (a platform keychain, the
Tauri store) or declares `offline.auth`. `createWebStorageAuthTokenStorage` tells the two Web
Storage areas apart by identity (`storage === globalThis.localStorage`).

`until` is the earlier of `refreshIssuedAt + maxOfflineGraceMs` and the refresh token's `exp`,
null when neither is set. The grace is measured from what survives a reload, the stored refresh
token's issue time (`noteIssuedCredential`), not the in-memory `lastServerContactAt`: that one
also advances on a profile request without rotation (`markFresh`) and falls back to the issue
time after a reload, so using it would let `until` shrink across an offline reload and make an
earlier `ready` a lie. It is re-read on the binding's `subscribe`.

**Re-evaluation.** The auth component is computed on the binding's `subscribe` and on a timer at
`until`, but a wall clock moved backward fires neither: the page would keep reporting `ready`
while an offline reload compares the clock with the stored refresh token's issue time and locks
the session (`offlineStatus()` in `auth-client.ts`, `CLOCK_ROLLBACK_TOLERANCE_MS`). So:
- `resolveOfflineRestore` applies the same rollback test the reload applies, against the same
  stored issue time: `Date.now() + CLOCK_ROLLBACK_TOLERANCE_MS < refreshIssuedAt` reports
  `{ restorable: false, reason: 'clock-rollback' }` (`not-restorable`).
- `app.offline` re-runs it when the wall clock jumps. While the auth component is `restorable`,
  a 30 s watchdog compares the wall-clock delta with the `performance.now()` delta; a difference
  over 2 s in either direction re-evaluates at once (a forward jump also makes the `until` timer
  late, since timers follow the monotonic clock). It also re-evaluates on `visibilitychange`,
  `pageshow` and `online`/`offline`, which cover a device that slept. The watchdog stops while
  auth is not `restorable`, so it costs nothing on apps without auth.

| Configuration | `auth.state` |
|---|---|
| No `sync`, or sync with neither `authClient` nor `auth` | `n/a` |
| Binding reports `anonymous` (`mayConnectAnonymously`, e.g. koraforms respondents) | `n/a` |
| Binding `loading` | `loading` (`preparing`) |
| Binding without `resolveOfflineRestore` (custom or older), or a bare `sync.auth` function | `unknown` (`auth-unknown`, never `ready`) |
| Binding reports `restorable: 'unknown'` (token storage without `durability`) | `unknown` (`auth-unknown`, never `ready`) |
| Restorable, `until` null or in the future | `restorable` |
| Otherwise | `not-restorable` |

A bare `sync.auth` token function cannot know how the app signs in, so it never reports. Such an
app declares it with `createApp({ offline: { auth: () => ({ restorable, until }) } })`, which
takes precedence over the binding. Kora never assumes yes.

### 8.3 Docs page

New page `docs/guide/offline-readiness.md`:

Kora guarantees:
- When `useOfflineReady().state === 'ready'`, an offline reload opens this build, restores the
  signed-in user, shows the data of the current view and every pin as of `completedAt`, shows
  kept files, and accepts writes.
- A write whose promise resolved is never lost (8.1), on every backend, except when the browser
  deletes the whole site's storage (6.3). A write whose promise rejected with
  `SNAPSHOT_SUPERSEDED` may be lost, and the app was told (8.1).
- `ready` covers every record except those whose operations are quarantined
  (`data.quarantined`, decision 3).
- Nothing is dropped silently: refused writes (`sync:operation-rejected`, and the writing
  component's `useMutation` `rejected` state, #57), quarantined operations, failing durability
  and detected storage loss are events and status.

Your app's responsibilities:
- `keep` what must work offline beyond the routes the user opened online (one pin per
  collection, at most 64).
- Same-origin assets only, or cache your own (fonts, CDNs, your API).
- Sign the user in while online; offline restore lasts until `auth.offlineUntil`
  (`maxOfflineGraceMs`, else the refresh token's expiry). An app that gates its UI behind a
  sign-in Kora does not see (no `sync.authClient`) declares it with `offline.auth`.
- Bulk writes with `insertMany` or one `app.transaction`.
- Large pins within the device quota; ask for persistent storage, and tell Safari users to
  install the app.
- Show the badge, `storage.evicted` and `WriteNotDurableError` honestly.

## 9. Test plan

Unit (Vitest, no browser):
- Marks: set on a fully applied final batch; not set on a partial apply, a gap, a blocked
  failure or a legacy batch; cleared before a batch with `accessNarrowing`/`retractions` (throw
  inside `applyCollectionNarrowing`, restart: `incomplete`); cleared by every watermark reset;
  dropped with LRU eviction; rules key and scope key mismatches; containment across views.
- Unit-open marker: a complete device reconnects, applies some operations of an ordinary
  non-final batch, the engine is torn down (crash), a new engine starts with no connection:
  `incomplete`. The same after a stalled operation and an offline restart. The marker is written
  once per unit and removed with the final's mark; a streaming final leaves none.
- Concurrent units (two engines on one database, one view): A opens a newer unit and stalls
  mid-unit; B finishes an older unit: A's key survives, B's mark does not make the view
  `complete` (in either tab, and after both engines are torn down and a third starts offline).
  B's older final never replaces A's newer mark. A crashed unit's key is cleared by the first
  later unit that covers `[base, upTo]`, and not by one that does not. `forceFullResync` (server
  advertises a lower frontier): marks cleared, the replay from 0 clears every stale key.
- Re-scope end to end (server + engine, `@korajs/test`): membership gained and lost,
  disconnect inside the unit, reconnect.
- Pins: idempotent ids, survive restart, release, limit, refused queries, `static`/`reactive`/
  `disabled` effective subsets, no narrowing of an unrestricted collection.
- Files: missing/present, integrity on completion, quota failure (injected store throwing
  `QuotaExceededError`), `MemoryBlobStore` with a `files: true` pin gives `non-durable`, and with
  no such pin keeps `storage.durable` true (`blobStoreDurable` false), single fetcher under the
  lock.
- Eviction: marker plus fresh database reports; each row of 6.2 does not; a crash before the
  first durable open leaves no marker; the localStorage marker alone (manifest deleted) reports
  for the same backend and not for another; a marker without `backend` is ignored.
- Marks: principal and collection-set mismatches; IndexedDB backend not `ready` until the
  barrier resolves.
- Unit marker on the IndexedDB fallback: a live push applies with no extra snapshot (count
  exports: one debounced snapshot per idle period, none per unit); a snapshot taken mid-unit
  holds the marker; a crash before any snapshot restores the earlier complete state.
- Tabs: two tabs on one database, tab B `ready`; tab A opens a unit and stalls before its first
  operation: tab B's status becomes not `complete` on the `kora-offline-meta-changed` message,
  with no record change. Same for a mark cleared by narrowing, a watermark reset, and a pin
  released in the other tab.
- No `BroadcastChannel` (mock Web Locks only): a second tab does not open storage and never
  reports `ready`; it opens once the first closes. No Web Locks: open refused; with
  `allowUncoordinatedTabs`, `not-ready` with `storage-uncoordinated`.
- Pin holders: two components (same tab, and two tabs) hold one pin; unmounting one keeps it;
  unmounting both deletes it; StrictMode double mount leaves one hold; an explicit `keep` plus a
  hook survives the hook's unmount; a tab killed with a hold leaves a hold pruned at the next
  open (its tab lock is gone); with tab B still open and no tab opening, killing tab A (its
  tab lock released) prunes A's holds in B through the shared-lock watcher, the pin goes, and
  B's status no longer counts it; a tab sent to bfcache has its holds pruned and re-inserted on
  `pageshow`, with the same pin id.
- Service worker (`service-worker.test.ts` harness): status reply, incomplete cache, self-heal
  of a hashed entry; a missing `index.html` while the network serves a different build's
  `index.html` is not stored and the reply stays incomplete (`not-installed`); same for the
  unhashed `sqlite3.wasm` copy with changed bytes.
- State rule: a table test over every component combination; `persisted: false` and
  quarantined operations alone never change `ready`.
- Durable writes (8.1), with a fake IndexedDB whose saves can be delayed and failed: an awaited
  write resolves only after a snapshot covering it is stored; concurrent writes share one
  snapshot (count flushes); the awaiting path skips the debounce; two adapters on one database
  saving out of order keep the newer dump (compare-and-put); a failing save rejects with
  `WriteNotDurableError`, keeps the write in memory and the queue, sets `writes: 'failing'`, and
  the next success clears it; a barrier rejecting with `SNAPSHOT_SUPERSEDED` sets `writes:
  'failing'` for the rest of the session even after later successful snapshots, and a new app
  instance on the same database starts `durable`; OPFS and native adapters never call a barrier; barrier snapshots
  request `durability: 'strict'`; a transaction pays one barrier; the binary snapshot and dump
  are written in one IndexedDB transaction; `close()` waits for pending barriers.
- Auth (8.2): `resolveOfflineRestore` for stored credentials, in-memory token storage, locked,
  grace expired, refresh token expired, `until` as the minimum; every row of the 8.2 table,
  including `unknown` for a bare `sync.auth` and for a binding without the method, and the
  `offline.auth` override; `ready` flips at `offlineUntil` (fake timers). Token storage: every
  row of the durability table, including a custom store without `durability` (`unknown`) and
  `sessionStorage`. Clock: with `ready`, set the fake wall clock back past the tolerance without
  moving the monotonic clock: the watchdog reports `not-restorable` (`clock-rollback`) before
  any timer at `until`; a forward jump past `until` flips at once.

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
- Auth templates: sign in, clear the stored refresh token, go offline: `auth-not-restorable`;
  with `maxOfflineGraceMs` elapsed (page clock moved): `not-ready`.

Durable writes on the fallback (OPFS disabled by an init script, so `storage.backend` is
`indexeddb`): insert, await the promise, crash the renderer at once (CDP `Page.crash`), reopen
offline: the row is there and still queued. Repeat from a follower tab with two tabs open,
crashing both. A control run with the barrier disabled through a test hook loses the row, which
proves the test can fail. Kill the leader tab mid-barrier: the follower's promise rejects or
resolves only once the write is in a stored snapshot.

Eviction: delete the database's OPFS pool and IndexedDB copy from the page, keep the manifest,
reload: `store:storage-evicted` with `lostWrites.count` equal to the queued writes; clear all
origin storage: no event (documents 6.3). Tauri: unit test of the bundled/native status.

## 10. Rollout

1. beta.15, no protocol change (everything is client side; the server already sends the rules
   key, finals and `serverMaxDeliverySequence`). `AuthSyncBinding.resolveOfflineRestore` is
   optional; an older `@korajs/auth` reports `auth-unknown`, so `korajs` and `@korajs/auth` are
   updated together (changelog). Apps with a bare `sync.auth` function read `not-ready` until
   they declare `offline.auth`; the upgrade notes say so.
2. Order: durable fallback writes and the snapshot compare-and-put first (they fix today's
   promise, independent of the API), then eviction markers (the manifest exists since W8a, so
   detection works on existing databases at once), then marks, status and hooks, then the
   auth binding, then the service-worker protocol and template badge, then `keep`.
3. Version skew: an app on new `korajs` with an older `@korajs/cli` plugin reports `shell-none`;
   the changelog says to update both. `__KORA_SHELL__.v` versions the contract.
4. New events in `KoraEvent` (`packages/core/src/events/events.ts`), documented in
   `docs/api/devtools.md`: `offline:status` (state changes only, not progress ticks),
   `store:write-durability` (`state: 'failing' | 'restored'`),
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
| Crash or stall inside an ordinary delivery unit, then offline reload | `offline_unit_open` committed before the unit applies, so every snapshot holding part of the unit holds it; cleared only with the next mark (4.1). |
| Another tab opened a unit or cleared a mark; this tab's cached status says `ready` | `kora-offline-meta-changed` on the database channel; every tab recomputes (4.2). |
| Worker heals a lost `index.html` while a newer build is deployed | Healed bytes must match the build-time digest; a newer page is never stored, the shell stays `not-installed` (7). |
| One of two components using the same pin unmounts | Per-component holds; the pin goes with the last holder (4.3). |
| Two tabs run units of one view; the older unit finishes while the newer is partly applied | Per-unit keys: a final clears only its own key and keys it covers; marks never go backward (4.1). |
| Tab killed while holding a pin, other tabs stay open | Shared-lock watcher on its tab lock prunes its holds at once (4.3). |
| Browser without `BroadcastChannel`, two tabs | Exclusive `kora-db` lock: the second tab never opens storage; without Web Locks the open refuses (4.2, #61 4.1.1). |
| Server operator runs `forceFullResync` | A watermark reset: marks cleared before the replay (4.1). |
| Storage leader changed before a fallback snapshot held a write | `SNAPSHOT_SUPERSEDED`: the promise rejects, `writes: 'failing'` until reload (8.1). |
| Server restore resets watermarks | Every reset clears marks. |
| Grants changed while a mark exists | Rules key includes grants; mismatch is not complete. |
| Route never opened online | Not covered by containment: `incomplete` unless kept. |
| Blob store fell back to memory | With a `files: true` pin: `durable` false, `storage-non-durable`. Without: no blob is promised, `blobStoreDurable` false is shown. |
| Database in memory (`allowNonDurable`) | `backend: 'memory'`, `durable` false. |
| Corrupt kept blob | Hash verified before it counts; later corruption out of scope. |
| Identity cannot be restored offline (tokens in memory only, grace passed, refresh token expired) | `auth` component; unknown is never `ready` (8.2). |
| Custom or volatile token store (`createMemoryAuthTokenStorage`, `sessionStorage`) | Token stores declare `durability`; absent is `unknown`, memory and session are not restorable (8.2). |
| Wall clock set back after `ready` | Watchdog and resume events re-run the reload's own rollback test (8.2). |
| Manifest gone, only the localStorage marker left, backend changed | The marker carries the backend (6.1). |
| App's own login gate, unknown to Kora, local-only app | Not detectable; `offline.auth` is documented for it. |
| Binary and JSON snapshots disagree on the fallback | Written in one IndexedDB transaction with one counter (8.1). |
| `mutate` (fire-and-forget) before the snapshot | No promise to honor; docs point to `mutateAsync` (8.1). |
| Session restorable now, grace ends tomorrow | `ready` flips at `offlineUntil`; `until` is shown. |
| Custom auth the binding cannot judge | `auth-unknown` until the app declares `offline.auth`. |
| `offline.auth` declared wrongly by the app | App's claim; documented as its responsibility. |
| Write shown, crash before the snapshot | The promise had not resolved; `isLoading` covered it (8.1). |
| Two tabs save fallback snapshots out of order | Commit counter and compare-and-put (8.1). |
| Snapshot keeps failing (quota) | `writes: 'failing'`, never `ready`; the write promise rejects. |
| Tauri power loss after commit | `synchronous = FULL` (8.1). |
| `ready` with `persisted: false` | Allowed (decision 1); the badge says "may be cleared if unused"; a whole-site wipe is the documented exception. |
| Quarantined operation hides a record a kept route needs | Allowed (decision 3); counted in `data.quarantined` and documented. |
| Old build reopened on a newer database | One build per active worker; the store refuses (`store:schema-ahead`). |
| Old tab left open during a deployment keeps writing | Version gate (#61): it retires and prompts before the newer tab writes. |
| Whole-origin eviction after `ready` | Undetectable; `ready` is a claim about now; `persisted: false` is surfaced. |
| Another tab's view | Status is per tab, computed against this tab's view. |

## 12. Decisions (Obed, 2026-10-19)

1. `ready` does not require persistent storage. When `persisted` is false the badge and status
   say "may be cleared if unused" (3.1, 7).
2. The promise stays "works offline after first open, never loses your work". On the IndexedDB
   fallback writes wait for the durable snapshot (`ensureDurable`) before resolving (8.1).
3. Quarantined operations are reported only and never block `ready` (4.2).
4. Auth is in beta.15: `ready` requires an offline-restorable session; a binding that cannot
   report it is `not-ready`, never assumed yes (8.2).
5. `keep` refuses `include` (one pin per collection) and is capped at 64 pins (4.3).
6. A server-side signal for whole-site wipes is deferred to beta.16 (13).
7. The "Available offline" badge is on by default in every template and hidden in dev (7).
8. A durable file-based blob store for Tauri: yes, after beta.15 (13).

## 13. Future work

- **beta.16: whole-site wipe signal.** The device reports its unsynced count and commit counter
  at each handshake; the server flags a node that returns with an empty database after
  reporting writes outstanding, or never returns, so the app or an admin can contact the user.
  Detection only: the writes are gone.
- **After beta.15: Tauri file blob store.** A filesystem `ContentAddressedBlobStore` through the
  Tauri plugin (the server already has `packages/store/src/blob/filesystem-blob-store.ts`),
  the default in `tauri-react`, so desktop pins with files are durable without OPFS.
- **If the fallback latency target is missed:** incremental IndexedDB snapshots (changed tables
  only) to keep durable writes fast on large databases.

## 14. Deferred to the build

Questions this design cannot settle on paper; the build PR answers each with code and a test.

- **Unit `upTo` for multi-batch handshake streams** when the server's frontier moves during the
  stream: whether the rewrite of the key per batch beyond the announced frontier is measurable,
  or `upTo` should be widened once to the frontier announced in the final batch.
- **Watcher fan-out** (4.3): with many tabs and many holders the shared-lock watchers are
  O(tabs x holder tabs); measure, and cap or elect one pruning tab (as the file fetcher is
  elected) if it matters.
- **Status of a tab waiting for the exclusive lock** (4.2) in the badge copy, and how the
  version gate's prompt and this badge share one UI in the templates.
- **Resolved by A0 — IndexedDB-fallback latency target** (8.1): 222.1 ms p95 at 10k records in
  Chromium, below the enforced 250 ms gate. An incremental snapshot is not required for beta.15.

## 15. Integration with C1 (record-snapshot units)

A C1 record-snapshot unit installs records instead of replaying operations, but it is still a
delivery unit of a view, so the completion mark and the unit key follow the same rules:

- **Same transaction as the watermark.** A snapshot unit sets or clears `offline_complete:<signature>`
  and its `offline_unit_open:<signature>:<unitId>` key in the transaction that moves the view's
  watermark (`saveDeliveryWatermarkInTx(tx, signature, watermark, completion)` and the
  `completion` carried by `saveUnappliedOperationsInTx`). A final snapshot batch passes the same
  `OfflineCompletion` a final operation batch does; a snapshot that installs part of a view
  writes the unit key first (it is not applied in one transaction), exactly as a multi-transaction
  operation batch does. No path may move a watermark or install records of a view without going
  through those functions, or a mark could claim completeness the records do not have.
- **Installation clears marks before applying.** Installing a snapshot replaces records the
  marks described, so it calls `clearOfflineMarks()` (committed before the first record is
  installed), like an `accessNarrowing` batch or a watermark reset. A crash mid-installation then
  reads as `incomplete`; the replacement unit's final batch sets the new mark.
- **`upTo` is the snapshot's delivery sequence**, so a later unit covering it closes the key of
  a snapshot that crashed.

## 16. Build notes (A1/A2)

Where the design left a choice, the build took the safe one (a mark never claims completeness it
does not have; `unknown` is never ready):

- **The unit key is written only for batches that are not one transaction** (per-operation
  application, or more than `MAX_DELIVERY_TRANSACTION_OPERATIONS` operations). A batch committed
  in one transaction cannot be half applied, and a non-final one moves the durable watermark
  away from the mark's, which rule 7 already reads as not complete. Streaming finals and small
  handshake batches therefore pay no extra write.
- **A final batch closes every key of its view with `upTo` at or below its watermark**, without
  also requiring `base >= myBase`: the engine resumes from the durable watermark, which can lie
  above a crashed unit's base, and everything up to the final watermark is applied.
- **`data.state` offline uses the last accepted scope** (`lastAcceptedScope ?? activeScope`) to
  locate the view, because a reload has no handshake to refresh the active scope. The marks are
  loaded when the sync engine starts (`autoConnect`, or `app.sync.connect()`); an app that never
  starts sync reads `incomplete`.
- **`auth.state` is `unknown` for an app with only a bare `sync.auth` token function** and no
  `offline.auth` declaration. An app with `sync.authClient` is `loading` until the binding
  answers, then `restorable`, `not-restorable` or `unknown` (A3, section 16.1).
- **A mark on the IndexedDB fallback is volatile** until a persisted snapshot holds it
  (`StorageAdapter.whenPersisted`, which forces no snapshot); until then `data` reads `syncing`.
  A second tab that reads the leader's in-memory database in that window can see a mark that is
  not yet on disk; the window is one debounce interval.

## 16.1 Build notes (A3)

- `resolveOfflineRestore` judges from `AuthClient.getOfflineRestoreInfo()` (token presence,
  durability, refresh issue and expiry, grace, lock state) through the pure
  `judgeOfflineRestore(info, now)`, so every row of the 8.2 table is a unit test with no timers.
- The grace and expiry arrive as `until`; the controller arms one timer at `until` (re-armed in
  slices under the 2^31 ms timer cap) and, while `restorable`, the 30 s wall-clock watchdog
  (wall delta vs `performance.now()` delta, 2 s tolerance). Both re-run the binding rather than
  computing locally, so the binding stays the single judge.
- A binding whose `resolveSyncState` is `anonymous` reports `n/a` (nothing to restore).
- A throwing resolver reports `unknown` and warns once per evaluation; it never claims `ready`.

## 17. Build notes (A4)

Where the design left a choice, the build took the one that never claims a shell it cannot prove:

- **Reply channel.** The page sends `KORA_SW_STATUS` with a `MessageChannel` port and the worker
  answers on it (falling back to `event.source`), so a reply reaches the asking tab only. The
  message also carries `pages`: the same-origin `.js`/`.mjs`/`.css` paths from
  `performance.getEntriesByType('resource')`, `document.scripts` and the stylesheet and
  `modulepreload` links. The worker compares only the content-hashed ones (unhashed names cannot
  tell builds apart), capped at 500.
- **Presence, not re-hashing.** The status checks that each precached URL is in
  `kora-shell-<VERSION>`; it does not re-hash the entries already there (that would read the
  whole shell, megabytes, on every `visibilitychange`). Only bytes the worker is about to store
  are hashed. A corrupted entry that is still present is out of scope, like later blob
  corruption (section 11).
- **"Online" is not asked.** The worker does not consult `navigator.onLine`: it tries the
  refetch and an entry whose fetch fails simply stays missing. Concurrent checks (several tabs,
  `visibilitychange` bursts) share one verify-and-heal pass. A redirected or non-2xx response is
  never stored.
- **Without digests the worker never heals.** `serviceWorkerSource` takes `digests` optionally;
  absent, nothing is verifiable and a missing entry stays missing.
- **`misses`** are kept in the worker's memory (a terminated worker forgets them), deduplicated,
  at most 50 (the oldest dropped), as pathnames for same-origin and `origin + pathname` for
  cross-origin (query strings can carry tokens). Cross-origin GETs are observed only for requests
  from a page the worker controls: the worker answers them with a plain `fetch(request)` and
  records a rejection; it never caches them. Non-GET requests, navigations and
  `only-if-cached` requests are left alone.
- **States.** No registration yet reads `installing` (the page registers on `load`; a returning
  visit finds its registration at start and asks at once). A rejected `register()` reads
  `not-installed`. An active worker that does not answer within 15 s (one that predates the
  protocol, or is stuck) reads `not-installed`: its cache cannot be verified, and the state
  clears when the user accepts the update that brings a worker that answers; a late answer is
  still applied. The registration script also re-checks when the installing worker becomes
  `activated` or `redundant` (a first install or a failed one has no other event), and when a
  tab becomes visible; it never polls. An incomplete cache outranks `other-build`.
- **`bundled` is decided in `korajs`**, not by a page script: `storage.backend === 'native'`
  (Tauri and any native SQLite desktop host). It outranks a reported shell, and the contract
  cannot report `bundled` or `none` (those read as absent). `tauri-react` ships no worker; its
  `<OfflineBadge />` therefore reads `ready` as soon as the native data is complete.
- **Contract version skew.** Anything other than a `v: 1` object with a known state reads as
  `none` (`shell-none`), including a future `v: 2`. `kora:shell` is listened for from
  construction of the app, so a report that arrives before `app.ready` is not lost.
- **Badge.** One `OfflineBadge` file per template (React `.tsx`, Vue `.vue`, Svelte `.svelte`;
  Tailwind variants use utility classes, plain ones `.offline-badge` / `.offline-dot` in
  `index.css`, `tauri-react` inline styles like its other pills), rendered next to the existing
  status pills. It is an `<output>` element (implicit `role="status"`). The tooltip is the first
  reason code as is (`shell-not-installed`, ...), not prose: it is a developer-facing hint and
  the code is what the docs index. The hook is called unconditionally and the render is skipped
  when `import.meta.env.DEV`, so hook order never changes.
- **Verified in Chromium** by `packages/cli/tests/repro/A4-shell-status-browser.mjs` (skips
  cleanly when Chromium or the CLI build is missing): installed; a deleted entry reads
  `not-installed` offline and heals online; a lost `index.html` is not healed from a newer
  deployment's bytes; a script from another build reads `other-build`.

## 18. Build notes (A5)

Where the design left a choice, the build took the one that never claims `ready` without proof
and never drops a pin silently:

- **Storage.** Two local-only tables, never synced: `_kora_offline_pins(id, collection,
  where_json, files, explicit, created_at, completed_at)` and `_kora_offline_pin_holds(pin_id,
  holder, tab_id, tab_lock)`. The pin id is `pin_` plus the first 32 hex of the SHA-256 of the
  canonical `[collection, where, files]`; the 64-pin limit is enforced inside the writing
  transaction.
- **One pin is one `where` on one collection.** `limit`, `offset` and a non-empty `include` are
  refused with `OFFLINE_KEEP_UNSUPPORTED_QUERY`; `orderBy` is ignored. No `pins-incomplete`
  reason was added: an unfinished pin reads as the existing `data-incomplete`.
- **Pins widen, never narrow.** `SyncEngine.setPinQuerySubsets` adds the pins to
  `getActiveQuerySubsets()` only for collections that already have a restricted view, so a
  collection synced whole stays whole. Completeness over pins is the existing mark containment:
  a mark covering the pins is complete for them; adding a pin makes the view `incomplete`
  until the reconnect delivers it. Changing pins schedules a reconnect.
- **Holds and tabs.** Hold mode follows the version-gate mode: `full` records the holder's tab
  lock and other tabs prune it by a shared-lock watcher (a held shared request on the lock
  name resolves when the owner dies); `exclusive` and the explicit mode (no gate, no Web Locks)
  use counts. Pruning needs no BroadcastChannel. Holds are recorded again after a
  `suspended` to `open` gate transition and on `pageshow` with `persisted`. A serial queue makes
  hold/release/hold end with exactly one hold (StrictMode).
- **Fetcher.** One tab holds the exclusive Web Lock `kora-offline-files-<db>` for its life; a
  waiting tab takes over when it is released. Follower tabs do not report `downloading`; they
  see the fetcher's results through the database. A blob counts as kept only after
  `blobStore.get` re-hashed it: once per session for a blob already stored (a failing one is
  deleted and fetched again), and right after a fetch. Fetching waits for a connected sync
  status, because a pull without a connection waits out its transfer timeouts and would hold the
  pass. `quota` is detected from the error and from an
  `estimate()` pre-check; `integrity`, `unavailable`, `offline` and others are classified and
  retried on the next pass, never skipped.
- **Honest status.** Pins not yet loaded or whose scan failed cannot yield `ready`.
  `storage.durable` is also false when files are kept and the blob store is not durable
  (`ContentAddressedBlobStore.durable`: memory false, OPFS and filesystem true). Persistence is
  requested in the background with reason `offline-keep`; `ready` does not require it.
- **Review fixes.** The engine is created after the pins load, so `engineReady()` (called from
  `createApp` once the sync lifecycle is wired) puts the pins into its view and attaches the
  connection listener; a pin set is recorded as applied only when an engine took it. Each pin
  is scanned on its own: one that cannot be read (a removed collection) is `unprovenPins`, never
  `ready`, and does not block the others. In `explicit` mode a component hold no longer marks
  the pin kept (`ensureOfflinePin`); `release()` keeps a pin that components of the tab still
  hold. Errors of the completion write, hold release and bfcache re-assertion are logged, and a
  hold whose follow-up failed is removed before the error is rethrown. Progress events of the
  fetcher are announced every ten files.
- **Not done.** The Tauri file blob store is out of scope. No real-Chromium multi-tab run: the
  cross-tab behavior is covered with a fake lock manager (killed tab, bfcache, exclusive and
  explicit modes), not a browser. Quarantined operations are reported only.

