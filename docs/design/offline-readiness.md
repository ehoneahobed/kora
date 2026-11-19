# Design: offline readiness (`app.offline`, `useOfflineReady`)

Guide: [Offline Readiness](../guide/offline-readiness.md). API: [`app.offline`](../api/offline.md).
Related: [durable delivery](durable-delivery.md) (watermarks), [version gate](version-gate.md)
(per-tab locks and the fail-closed tab coordination reused here). Section numbers are stable:
source comments cite them ("design 4.1").

## 1. Problem

Kora had every ingredient of "works offline" and no answer to "is this device ready to go
offline?". A link opened offline could fail because the shell was never installed or the first
sync never finished; files were fetched only when viewed; a user offline mid first sync held half
the data and could not tell. Each existing signal failed a reload: the service worker never told
the page whether its precache was complete, download progress was live-only, a watermark says how
far a view got but not whether it reached the end, the blob store could silently fall back to
memory, and an evicted database reopened as a fresh one, silently losing queued writes.

## 2. Goals and non-goals

- One status, `app.offline.status()`, and `useOfflineReady()` (React, Vue, Svelte). `ready` means:
  reload with no network and the app opens, shows the data it was told to keep, and accepts
  writes. Every `ready` claim is backed by a test performing that reload (section 9).
- `app.offline.keep(query, { files })` declares what must be on the device.
- Storage loss is reported (`store:storage-evicted`), never mistaken for a fresh device.
- The promise **"Works offline after the first open, never loses your work"** holds on every
  backend, scoped precisely in section 8.

Not goals: opening offline on a first visit; detecting a whole-origin wipe (6.3); background
download while the app is closed; caching non-Kora API responses or cross-origin assets; `keep`
across relations; a client blob cache cap.

## 3. API

```typescript
app.offline.status()            // synchronous snapshot; never prompts, never throws
app.offline.subscribe(listener) // on every change of the snapshot

interface OfflineStatus {
  state: 'ready' | 'preparing' | 'not-ready'
  reasons: OfflineReason[]      // empty exactly when ready
  shell: { state: 'installed' | 'installing' | 'not-installed' | 'other-build' | 'unsupported'
                | 'bundled' | 'none'; version: string | null; misses: string[] }
  data: { state: 'complete' | 'syncing' | 'incomplete' | 'local'; progress: number | null
          completedAt: number | null; quarantined: number }
  files: { kept: number; missing: number; bytesMissing: number; failed: number }
  storage: { backend: 'opfs' | 'indexeddb' | 'native' | 'memory'; durable: boolean
             blobStoreDurable: boolean; persisted: boolean | null; writes: 'durable' | 'failing'
             usage: number | null; quota: number | null; evicted: StorageEviction | null }
  auth: { state: 'n/a' | 'loading' | 'restorable' | 'not-restorable' | 'unknown'
          offlineUntil: number | null }
}

const handle = await app.offline.keep(app.lessons.where({ courseId }), { files: true })
handle.status(); handle.subscribe(listener); await handle.whenComplete({ signal })
await app.offline.release(handle)
app.offline.list()
```

Reason codes name the failing component (`shell-*`, `data-*`, `files-*`, `storage-*`, `auth-*`,
`server-rendering`); the list is in `packages/core/src/offline/offline-status.ts`.
`useOfflineKeep(query, options)` holds a pin for a component's lifetime (4.3). `keep()` resolves
once the pin is durably recorded, not when the download finishes; it works offline and is
idempotent, so apps call it on every start. `offline` is a reserved app property.

### 3.1 State rule

`ready` iff every component holds:

| Component | Holds when |
|---|---|
| shell | `installed` or `bundled` |
| data | `complete` or `local`, and every pin complete |
| files | no `missing` and no `failed` over pins with `files: true` |
| storage | `durable` and `writes === 'durable'` |
| auth | `n/a`, or `restorable` with `offlineUntil` null or in the future |

Otherwise `preparing` when every failing component is progressing (shell installing, data syncing
on a live session, files downloading, auth loading), else `not-ready`.

`persisted`, `quota`, `quarantined`, `evicted` and `misses` never change `ready`. Persistent
storage is granted inconsistently by browsers, so requiring it would make `ready` unreachable; the
badge adds "may be cleared if unused" instead. Quarantined operations wait for an app update or a
key, so gating on them would block unrelated data indefinitely; they are counted and documented.
`ready` also flips at `auth.offlineUntil` and on wall-clock jumps (8.2).

## 4. Data: "complete" that survives a reload

### 4.1 Completion marks

Each delivery view has a durable **completion mark** next to its watermark: `_kora_meta` key
`offline_complete:<signature>` = `{ watermark, scopeKey, subsets, rulesKey, principal,
collectionsKey, at }`.

**Set** when a final (`isFinal`) delivery batch is fully applied, in the same transaction as the
watermark advance, so a mark never exists without its watermark. Only protocol-2 chained batches
set marks.

**Delivery unit marker.** A delivery unit is the batches one sync engine applies from one base to
its final batch. Every tab runs its own engine over the shared database, so several units of one
view can run at once and the marker is per unit: before a unit's first operation the engine
commits `offline_unit_open:<signature>:<unitId>` = `{ base, upTo }`, where `unitId` is the
engine's random session id plus the base, and `upTo` is the highest delivery sequence the unit can
apply (rewritten first if a later batch goes beyond it).

- Only batches not applied in one transaction write it (per-operation application, or more than
  `MAX_DELIVERY_TRANSACTION_OPERATIONS` operations). A one-transaction batch cannot be half
  applied, and a non-final one moves the watermark away from the mark's (rule 7).
- The transaction that sets a final batch's mark deletes its own key and every other key of the
  view with `upTo` at or below its watermark: it applied every operation of the view up to there,
  and the fold depends only on the set of operations, so a crashed unit's leftovers are covered.
- Marks never go backward: a unit finishing below the stored mark leaves it.

The marker needs no barrier: it commits before any operation of its unit, so whatever persists an
operation persists the marker (on the IndexedDB fallback, a snapshot is a whole-database export at
one commit). It exists because operations apply one transaction at a time while the watermark
moves only after the batch; without it, a complete device that crashed mid-batch would still hold
its old mark after an offline reload, since the in-memory guards are per tab and do not survive.

**Clear every mark of the view** in a transaction committed before anything is applied when a
batch carries `accessNarrowing` or `retractions`, and on every watermark reset
(`resetDeliveryForFullResync()`, the "watermark ahead of server frontier" reset after a server
restore or `KoraSyncServer.forceFullResync()`). A crash mid-unit then reads as incomplete. Marks
are also evicted with their view watermark (LRU).

**Rules.** `data.state` is `complete` when some mark M satisfies all of:

1. `M.scopeKey` equals the key of the server-granted downlink scope;
2. `M.rulesKey` equals the persisted access-rules key (grants are part of it);
3. `M.principal` is the session's user and `M.collectionsKey` the current synced-collection set;
4. `M.subsets` contains the current query subsets (`querySubsetContains`);
5. no blocked failure and no in-flight delivery batch in this tab;
6. on the IndexedDB fallback, a persisted snapshot holds the mark (`StorageAdapter.whenPersisted`,
   which never forces one); until then `data` reads `syncing`;
7. no `offline_unit_open:<signature>:*` key exists for the view, and `M.watermark` equals the
   durable watermark.

Offline, the view is found with the last accepted scope, subsets and rules key, loaded when the
sync engine starts (an app that never starts sync reads `incomplete`). Otherwise `syncing` while a
session is live, `incomplete` when not. Complete means complete as of `completedAt`; apps show it.

### 4.2 The hard cases

- **Membership or grant changes** end the session; the next handshake re-scopes in full with an
  `accessNarrowing`, which clears the marks. A pin on a group the user lost completes with
  `records: 0`. A change made while offline is invisible to the device.
- **Scope change.** A different `scopeKey` never matches an old mark.
- **Query views.** In `reactive` mode the view follows navigation; containment keeps a visited
  route complete, and a route never opened online is honestly not covered (use `keep`).
- **Tabs.** Marks and pins live in the database; each tab computes status against its own view.
  Readiness metadata changes no record, so after every such commit (unit key, mark, watermark
  reset, pin, IndexedDB barrier) the local-operation bus (`kora-local-ops-<db>`) carries
  `kora-offline-meta-changed` (event `offline:meta-changed`) and every tab recomputes; a tab
  returning from bfcache or freeze recomputes on `pageshow` / `resume`.
- **No `BroadcastChannel`.** A tab opens storage only while holding the exclusive `kora-db:<db>`
  Web Lock; a second tab reports `storage-other-tab`. Without Web Locks the open is refused unless
  `store.allowUncoordinatedTabs` is set, which reports `storage-uncoordinated`: an uncoordinated
  database is never `ready`.
- **No sync.** `data.state` is `local`.
- **Quarantine** is reported only; a transient apply failure stalls the watermark and gates
  (`data-blocked`).
- **Progress** is `(watermark - start) / (serverFrontier - start)`: approximate and monotonic.

### 4.3 `keep(query, { files })`

Pins live in local-only tables that never sync: `_kora_offline_pins(id, collection, where_json,
files, explicit, created_at, completed_at)` and `_kora_offline_pin_holds(pin_id, holder, tab_id,
tab_lock)`. The id is `pin_` plus 32 hex digits of the SHA-256 of `[collection, where, files]`.

- One pin is one `where` on one collection: `limit`, `offset` and `include` are refused
  (`OFFLINE_KEEP_UNSUPPORTED_QUERY`), `orderBy` is ignored, operator filters widen to the sync
  subset (files still follow the exact local query).
- At most 64 pins (`OFFLINE_PIN_LIMIT`), because pins travel in the handshake and the server bounds
  scope predicates.
- **Pins widen, never narrow:** a pin joins the subsets only of collections that already have a
  restricted view (`reactive` and `static`; `disabled` ignores pins). Changing pins reconnects.
- Completion is re-derived, never read from the row: a mark containing the pin and, with `files`,
  every needed blob present. A pin that cannot be scanned blocks `ready` but not other pins.
- **Holders.** `keep()` / `release()` set the `explicit` flag; `useOfflineKeep` adds a hold per
  hook instance on mount and removes it on unmount (a serial queue keeps StrictMode at one hold).
  A pin goes only when it is not explicit and no hold remains.
- **Pruning.** A hold records its tab's version-gate lock (`kora-tab:<db>:<identity>`). At open a
  tab deletes holds whose lock is free; while open it queues a shared request on each other
  holder tab's lock, granted only when that tab is gone, and then prunes its holds. A tab frees its
  lock on `pagehide` / `freeze` and re-inserts its mounted hooks' holds (and any pruned pin) on
  `pageshow` / `resume`. Without per-tab locks holds are counted.

## 5. Files

- For each pin with `files: true`, the blob refs of records matching the pin's local query. A blob
  counts as kept only after `blobStore.get` re-hashed it (once per session for stored blobs, and
  after each fetch). Referenced but unkept blobs are not part of readiness.
- One tab fetches, holding the Web Lock `kora-offline-files-<db>`; it waits for a connected sync
  status. Failures are classified (`quota` from the error or an `estimate()` pre-check,
  `integrity`, `unavailable`, `offline`) and retried next pass, never skipped.
- `ContentAddressedBlobStore.durable` (OPFS and filesystem true, memory false) gates readiness only
  while a pin keeps files; with none, nothing about blobs is promised.
- `app.blobs.gc()` keeps every blob a live record references, so a pin adds download, not
  retention. `keep` with `files` requests persistent storage in the background.

## 6. Storage loss

### 6.1 Detection

Evidence of a database lives outside it, in two independent places written only after its first
durable open:

1. the storage manifest (IndexedDB `kora-manifest`): backend, timestamps, a random `epoch` (also
   in `_kora_meta.db_epoch`) and the unsynced write count;
2. `localStorage['kora:db:<dbName>'] = { v: 1, epoch, backend }`, which survives the loss of
   IndexedDB on the fallback backend. A marker without `backend` is ignored.

If a just-created database (no `_kora_meta`) has evidence **for the same backend**, Kora emits
`store:storage-evicted` and keeps `storage.evicted` (`dbName`, `detectedAt`, `lastOpenedAt`,
`evidence`, `lostWrites: { count, certain }`) until `app.offline.acknowledgeEviction()`. The unsynced
count is updated when the outbound count crosses zero and on `pagehide`, so it is cheap and at worst
stale (`certain: false`). The database still opens and re-syncs; the loss is never hidden.

### 6.2 No false positives

`app.storage.deleteDatabase()` removes both pieces of evidence first. A backend move or fallback
leaves evidence for another backend (migration or `StorageBackendMismatchError` applies). A first
open or private window has no evidence. Evidence is per database name, so `store.name` changes and
`namespaceByAuthUser` do not trigger it. Clearing all site data removes the evidence too.

### 6.3 What cannot be detected

Eviction under storage pressure and Safari's script-storage cap delete the whole origin, evidence
included, which is indistinguishable from a first visit. The defense is prevention (persistent
storage, sign-in, installing the app, `keep`) and showing `storage.persisted`. This is the one case
where unsynced work can still be lost.

## 7. Shell

The page cannot tell whether the precache is complete (`controller` is null after a hard reload,
and caches can be partly deleted), so the worker answers.

- The page sends `KORA_SW_STATUS` to `registration.active` with a `MessageChannel` port. The worker
  checks that every precached URL is present in `kora-shell-<VERSION>` (presence, not re-hashing,
  which would read megabytes per check) and replies `{ v: 1, version, complete, missing, misses,
  sameBuild }`.
- **Healing.** A missing entry is refetched and stored only if its SHA-256 equals the build-time
  digest embedded in the worker. Mutable URLs (`index.html`, the unhashed `sqlite3.wasm`,
  `manifest.webmanifest`) may already serve a newer deployment; their bytes do not match and are
  never stored. Redirects and non-2xx responses are never stored.
- **Same build.** The page sends the hashed script and style paths it loaded; if any is missing from
  the worker's precache (a shift-reload online under an older worker), the state is `other-build`
  until the update is accepted, because an offline reload would run an older build against a
  database this page may have migrated.
- **Contract.** The registration script publishes `globalThis.__KORA_SHELL__ = { v: 1, state,
  version, misses }` and dispatches `kora:shell`; `korajs` reads it (it cannot import
  `@korajs/cli`). Anything else reads as `none` (no plugin, `vite dev`, older or newer plugin).
- **States.** `installing`, `installed`, `not-installed` (install rejected, cache incomplete, or no
  answer within 15 s), `unsupported`. Checked on lifecycle and visibility events, never polled.
  `misses` (at most 50, no query strings) lists requests the worker could not serve offline.
- **Desktop.** `bundled` is decided in `korajs` when `storage.backend === 'native'`.
- **Badge.** Every template renders `<OfflineBadge />` (hidden in dev): "Available offline",
  "Preparing offline copy... 40%" or "Not available offline yet", with the first reason code as
  tooltip.

## 8. Guarantees

A write whose promise resolved (`insert`, `insertMany`, `update`, `delete`, `transaction`,
`mutation`, `mutateAsync`) survives tab and browser crashes, reloads and restarts, offline, on
every backend, until it reaches the server. The exception is a whole-site wipe (6.3). On the
IndexedDB fallback a write lost to a storage-leader change before any snapshot held it rejects
(`SNAPSHOT_SUPERSEDED`), so it was never a resolved write.

### 8.1 Durable writes on every backend

OPFS (rollback journal) and native SQLite (WAL, `synchronous = FULL` set explicitly, since NORMAL
can lose the last commits on power loss) are durable on commit. On the IndexedDB fallback (SQLite
in memory plus snapshots) the store awaits `adapter.ensureDurable()` after the write commits and
before the promise resolves; only that adapter implements it, so other backends pay nothing.

1. **Group commit.** One snapshot resolves every write scheduled before it; concurrent barriers
   share it, and a barrier skips the background debounce.
2. **Ordered snapshots.** A commit counter `{ epoch, lineage, seq }` is bumped in every write's
   transaction (a TEMP table, never dumped) and stored with the dump; saves are a compare-and-put
   in one IndexedDB transaction, so an older export from another tab never overwrites a newer one.
   The binary snapshot and JSON dump share that transaction. A follower's barrier is routed to the
   leader tab; if the leader goes away, the follower snapshots through whichever worker serves now,
   and nothing resolves on a departed leader's word.
3. **Strict durability.** Barrier snapshots use `{ durability: 'strict' }`.

**Failure.** The write is committed in memory and visible, so it is not rolled back. The promise
rejects with `WriteNotDurableError`, `storage.writes` is `failing`, and `store:write-durability` and
`store:persistence-error` fire. A failed save keeps the write in memory and the outbound queue and
retries (the app must not retry the write). A superseded snapshot cannot be recovered; `writes`
stays `failing` until reload, and only an upload already made in sync's degraded mode saves it.

**Scope and cost.** One barrier per resolved promise (outermost `transaction`, `mutation`,
`insertMany`); `mutate` promises nothing. Reactive queries see the write before it is durable;
`useMutation().isLoading` covers the window. Remote applies do not wait: their watermark rides the
same snapshot. A snapshot is linear in database size, so bulk writes belong in `insertMany` or one
transaction; a store benchmark gates awaited-write p95 at 10,000 records under 250 ms.

### 8.2 Auth: restorable offline

`ready` requires that the session can be restored on an offline reload. `AuthSyncBinding` has an
optional `resolveOfflineRestore()` returning `{ restorable: true, until }`, `{ restorable: false,
reason }` (`signed-out`, `locked`, `non-durable-credentials`, `expired`, `clock-rollback`) or
`{ restorable: 'unknown' }`. `createKoraAuthSync` implements it with the pure
`judgeOfflineRestore(info, now)`: restorable when stored access and refresh tokens carry a user id,
live in storage that survives a reload, and the session is not locked.

- **Token storage** declares `durability: 'durable' | 'session' | 'memory'`. `localStorage` is
  durable; memory and `sessionStorage` are not restorable; a custom store without `durability` is
  `unknown`, never `ready`.
- **`until`** is the earlier of `refreshIssuedAt + maxOfflineGraceMs` and the refresh token's `exp`,
  measured from the stored issue time so it cannot shrink across an offline reload.
- **Re-evaluation.** A timer at `until`, the binding's `subscribe`, and, while restorable, a 30 s
  watchdog comparing wall-clock and `performance.now()` deltas (over 2 s re-runs the binding), plus
  `visibilitychange`, `pageshow`, `online` / `offline`. A clock set back is judged with the reload's
  own test (`CLOCK_ROLLBACK_TOLERANCE_MS`). The binding stays the single judge; a throwing resolver
  reports `unknown`.
- **States.** `n/a` without sync auth or for anonymous access; `loading`; `unknown` for a binding
  without the method or a bare `sync.auth` token function; `restorable`; `not-restorable`. Kora
  never assumes yes: an app with its own sign-in declares
  `createApp({ offline: { auth: () => ({ restorable, until }) } })`, which takes precedence.

### 8.3 What the app is responsible for

`keep` what must work beyond routes opened online; same-origin assets (or cache its own); sign in
while online; bulk writes in `insertMany` or one transaction; pins within quota; show the badge,
`storage.evicted` and `WriteNotDurableError` honestly.

## 9. Testing

The contract: **when the app says `ready`, it must work offline.**

- **Unit.** Marks set only on fully applied finals; cleared by narrowing, retractions and every
  reset; key mismatches; containment; a crash mid-batch followed by an offline engine reads
  `incomplete`; concurrent units never let an older final complete a view with a newer open unit.
  Pins (limits, refused queries, subset modes, holders, StrictMode, killed tabs and bfcache via a
  fake lock manager), files, eviction (every 6.2 case), durable writes with a fake IndexedDB
  (group commit, compare-and-put ordering, failures), auth (every state, timers, clock rollback),
  and a table test of the state rule.
- **Service worker.** Reply, incomplete cache, healing, and refusing a newer deployment's bytes;
  repeated in Chromium by `packages/cli/tests/repro/A4-shell-status-browser.mjs`.
- **End to end.** `assertReadyMeansOffline(page)` from `@korajs/test/playwright` waits for `ready`, goes
  offline, reloads, visits every route, writes, reloads offline again, then checks the upload. The
  offline suite (`e2e/offline/offline-readiness.spec.ts`) runs it on every web template, with
  negative cases that must never observe `ready` (worker blocked, final batch withheld, blob chunks
  blocked, a precache entry deleted, a second build deployed, auth not restorable).
- **Durable writes in a browser.** On the fallback, insert, await, crash the renderer, reopen
  offline: the row is there and queued; a control run without the barrier loses it.

## 10. Record snapshots and other unit kinds

Any delivery path that installs records instead of replaying operations (for example the record
snapshots of [fast first sync](fast-first-sync.md), section 3) is still a delivery unit and follows
4.1: clear the view's marks before installing the first record, write the unit key first when not
one transaction (`upTo` = the snapshot's delivery sequence), and set the mark in the transaction
that moves the watermark (`saveDeliveryWatermarkInTx` with an `OfflineCompletion`).

## 11. Known limits

- A whole-origin wipe is undetectable on the device; a server-side signal could detect, not recover.
- Desktop kept files depend on the WebView's blob store; a Tauri filesystem blob store is not shipped.
- Pin progress is read from the handle; there are no dedicated pin events.
- On the fallback, another tab may see a mark not yet on disk for at most one debounce interval.
- Quarantined records may be missing or stale offline while `ready` is true.
- Cross-origin assets, an app's own login gate, a wrong `offline.auth` declaration and corruption of
  already-stored entries are outside what Kora can prove.
- Cross-tab pruning is tested with a fake lock manager, not a real multi-tab browser run.
- Fallback write latency grows with database size.
