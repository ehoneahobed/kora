# Design: version gate (one build writes a database at a time)

Status: proposal, not implemented. Target: 1.0.0-beta.15. Date: 2026-10-20.
Related: offline readiness (`docs/design/offline-readiness.md`, PR #50, sections 7 and 12),
IndexedDB snapshot ordering (PR #52, "Known limitations"), schema ceiling (RT-109).

## 1. Problem

Tabs of one origin share one database (one storage leader, followers relay over the storage
`BroadcastChannel`). During a deployment, an old tab stays open next to a tab running the new
build. Today nothing stops the old tab from writing:

- **IndexedDB fallback.** An old build saves snapshots with an unconditional put. PR #52 orders
  snapshots between tabs that run it, but a pre-#52 tab can still overwrite a newer snapshot
  ("Known limitations" in #52). Round 3 and 4 of #52 tried to reconcile old and new copies after
  the fact (stamped legacy copies, subset comparison, preserved copies); each round found a new
  loss path. Reconciling after an old build wrote is the wrong layer.
- **OPFS.** One SQLite file, so no snapshot race, but an old leader runs old code against data a
  new build may already have migrated (the schema ceiling refuses only at open, RT-109), and a
  new tab that joins as a follower of an old leader runs new code through an old worker.
- **Internal storage layout.** Kora-internal tables and keys change between releases (snapshot
  keys, fold state). There is no version for that layout, so old code cannot know it must not
  write it.

## 2. Goals and non-goals

Goals:
- At most one build writes a database at any time. When a tab on a newer build opens, every
  older tab stops writing **before** the newer tab writes, and no write the older tab confirmed
  is lost.
- The older tab tells the user "A new version is available. Reload." **before** any of its
  writes is refused, and the reload does not cost the user what they were typing (section 6).
  On by default, replaceable by the app (decision 7 of offline readiness: defaults on,
  customizable).
- A storage format version, written only by code that knows it, refused by code that does not.
- Same behaviour on OPFS and the IndexedDB fallback.
- Rolling a deployment back works: among builds of the same format, the later-opened one wins,
  so reopening the app on the previous build retires tabs of the withdrawn one.

Non-goals: running two builds side by side; downgrades across a format change (a newer format is
never opened by an older build: refused, as RT-109 does for schemas, so a release that bumps
`format` cannot be rolled back by redeploying the previous build); cross-origin or cross-browser
coordination.

## 3. Identity: build, storage format, ordering key

- **`build`**: a string that differs between any two deployments of the app. Only equality
  matters, never ordering. Sources, in order:
  1. `createApp({ build })`, for apps that already have a deploy id (commit SHA, CI build
     number) or do not use Vite.
  2. `__KORA_BUILD__`, injected by the `@korajs/cli/vite` plugins. `koraServiceWorker()` injects
     its `VERSION` (hash of the precached files, `packages/cli/src/vite/service-worker.ts`). A new
     `koraBuildId()` plugin (included in `koraServiceWorker()`, usable alone) injects a hash of
     the emitted bundle for apps without the offline shell. Every template uses one of them.
  3. Neither: the gate cannot tell two deployments apart. Kora does **not** fall back to the
     `korajs` package version (two deployments of the same app usually share it, so an old tab
     would stay writable through an application-only schema or mutation change). It derives a
     fingerprint of `format` and the schema (collections, fields, version), which still retires
     old tabs on every schema change, and reports `store:build-unidentified` once per open (dev:
     console warning naming the two fixes above). A deployment that changes only mutation code
     is then not gated; the warning says so.
- **`format`**: an integer, the Kora storage format this code reads and writes (internal tables,
  IndexedDB keys, snapshot layout). Starts at `1` with this design; bumped only by a release
  that changes the layout. Ordered.
- **`openedAt`, `tabId`**: the tab's open time (`Date.now()` at `createApp`, fixed for the tab's
  life, including across bfcache) and a random id. Tabs of one origin share one machine clock,
  so comparing `openedAt` is meaningful; `tabId` breaks ties.
- **Ordering key** `(format, openedAt, tabId)`: the higher key wins. Format first, so a newer
  format always wins regardless of open time; within a format the later-opened tab wins, which
  during a deployment is the new build and during a rollback is the previous one.
- **Stored format.** Written once per format change, by the first build that uses it, never by
  older code:
  - OPFS / native: `_kora_meta('storage_format')`, set in the same transaction as the migration
    that introduces the format.
  - IndexedDB fallback: a `format` field in the snapshot version record (`<db>::version`),
    written atomically with the compare-and-put save (#52).
  - On open, a stored format higher than the code's refuses the open
    (`StorageFormatAheadError`, event `store:format-ahead`), like `store:schema-ahead`. It never
    falls back to an empty database.

## 4. Discovery and protocol

### 4.1 Roster: a Web Lock per tab

Messages alone cannot tell a new tab which tabs exist: a follower sends nothing unprompted, and
a hello is delivered asynchronously, so a tab could write before an old follower has processed
it. The roster is therefore held in Web Locks, which every browser Kora's multi-tab storage runs
on already has (`isMultiTabStorageSupported`):

- At open, before anything else, every tab acquires an exclusive **tab lock** named
  `kora-tab:<db>:` followed by its identity as JSON (`{ build, format, openedAt, tabId }`). It
  holds the lock for its life and releases it on retirement, close, `pagehide` and `freeze`
  (the same points that already release the leader lock, NEW-STORE-10), re-acquiring it on
  `pageshow` / `resume` before doing anything else.
- **Discovery** = `navigator.locks.query()`, filtered to held `kora-tab:<db>:` locks. It is
  authoritative and needs no reply from the other tabs, so silent followers and tabs that have
  not yet processed any message are seen.

A runtime without Web Locks or `BroadcastChannel` runs one tab per database already (every
instance is its own leader); the gate is a no-op there.

### 4.2 Messages (existing storage channel)

Every tab already joins `storageChannelName(dbName)`. Messages carry the full identity, so any
receiver can apply the rules without remembering an earlier message (a tab back from bfcache
missed them).

| Message | Sent by | Payload |
|---|---|---|
| `kora-build-hello` | every tab after acquiring its tab lock (open, `pageshow`, `resume`), and again each heartbeat interval while its gate is waiting | `{ build, format, openedAt, tabId }` |
| `kora-build-retired` | a tab that finished retiring (section 5), just before releasing its tab lock | `{ build, format, openedAt, tabId }` |
| `kora-leader-heartbeat` (existing) | leader | adds `{ build, format, openedAt, tabId }` |

### 4.3 Rules

1. **Who retires.** A tab retires (section 5) as soon as it knows of a tab with a **different
   build and a higher ordering key**, learned from discovery, a `hello`, or a heartbeat. Equal
   build: nothing happens, whatever the key. A tab never retires for a lower key; the other tab
   retires when it learns of this one.
2. **The write gate.** A tab's write gate opens, and `app.ready` resolves, only when discovery
   (run after its own tab lock is held) shows no tab of a different build with a higher key
   (otherwise the tab retires instead) and no tab of a different build with a lower key. For
   each lower-keyed tab it found, it posts `hello` and waits for that tab's lock to be released
   (`navigator.locks.request(name, { mode: 'shared' })` is granted only then). Nothing else
   opens the gate: there is **no deadline**. A tab still holding its lock is a live writer
   (alive, possibly busy finishing a transaction or a slow IndexedDB flush), so proceeding
   would break the one-writer invariant; a frozen, discarded or bfcached tab has already
   released its lock. After 10 s of waiting the newer tab reports `store:build-gate-waiting`
   (`{ waitingFor: identity[] }`) and its default UI says "Another tab of this app is still
   open on an older version. Close it to continue."; it keeps waiting.
3. **Storage open waits for the gate.** The newer tab defers its storage open (DDL, migrations,
   the format write, snapshot restore) until the gate opens, so it never runs new code through
   an older build's worker, not even to open.
4. **Leadership.** An older leader releases leadership as part of retiring (the existing suspend
   path: worker terminated, then lock released). An older follower cancels its queued leader-lock
   request (`cancelPromotionWatch()`) as part of retiring. Independently, a tab **granted** the
   leader lock (promotion or first open) runs discovery before opening a worker; if a tab of a
   different build with a higher key is listed, it releases the lock unopened and retires. So an
   old follower that wins the lock before it has processed the newer tab's `hello` still never
   opens an old worker, and the newer tab (whose tab lock was held before its `hello`) is next.
5. **Resume.** A tab back from `freeze` or bfcache re-acquires its tab lock and runs discovery
   before its gate reopens; rule 1 retires it if a newer build appeared meanwhile. A retired
   tab never re-acquires a tab lock.

Same format, different builds, opened in either order or concurrently: both tabs see each other
in discovery, the lower key retires, the higher key waits for it. Deterministic, and the
latest-opened build wins, so a rollback deployment wins over the build it replaces.

## 5. Retiring a tab (the older build)

In order. Steps 1 and 2 run in the same task, so no write can be refused before the prompt is
on screen.

1. **Announce.** Emit `app:build-superseded` (`{ currentBuild, newerBuild }`) and, unless the app
   called `event.preventDefault()` or set `store.onBuildSuperseded`, show the default prompt:
   "A new version of this app is available. Reload to continue." with a Reload button. When the
   offline-shell plugin is present, the same UI as its update prompt is reused
   (`kora:update-available`). An app handler runs synchronously in this step; it shows its own
   UI before step 2.
2. **Stop new writes.** Every write entry point (`insert`, `update`, `delete`, `transaction`,
   `mutation`, `useMutation`, and sync's application of received batches) rejects with
   `BuildSupersededError` (`code: 'BUILD_SUPERSEDED'`, `retriable: true`) instead of starting.
   Nothing is partly applied. Received sync batches that are refused are not applied and do not
   advance the delivery watermark, so the new build receives them again.
3. **Drain every started write.** Each write entry point registers its promise in an in-flight
   set when it starts (not only transactions: single `insert` / `update` / `delete` calls, the
   sync applier, the outbound-queue bookkeeping, the watermark update). Retirement awaits every
   entry in the set to settle. A started write is never cancelled midway: it commits, or it fails
   and rejects to its caller as it would have anyway.
4. **Durability barrier.** Only after the drain: on the IndexedDB fallback the tab flushes its
   snapshot (`ensureDurable`), so every write that resolved is inside the flushed snapshot. A
   failure is reported (`store:persistence-error`, handled as in offline readiness section 8)
   and retirement continues: holding on would block the new build forever.
5. **Stop sync.** The sync engine disconnects (`intentionalDisconnect`). Unsent operations are
   already in the database's outbound queue (`_kora_sync_queue`, persisted before upload), so
   the new build uploads them: nothing queued is lost or sent twice (content-addressed ids).
6. **Give up storage roles.** Leader: release leadership (section 4.3, rule 4). Follower:
   `cancelPromotionWatch()`.
7. **Leave.** Post `kora-build-retired`, then release the tab lock; that release opens the newer
   tab's gate.

After retiring, reads keep working where they can (as a follower of the new leader); a query the
newer schema broke surfaces as a query error. The tab never un-retires: only a reload (which
loads the new build) brings writes back.

## 6. Keeping the user's input across the reload

Writes refused after retiring were never applied: they reject, so `mutateAsync` callers and
`useMutation().error` see `BUILD_SUPERSEDED`, and the prompt is already visible (section 5). The
input the user was typing must survive the reload the prompt asks for. What a form contains, and
whether it may be stored, is an application decision, so the framework does not persist form
state itself. It provides two hooks, and the templates use them:

- **Framework.** `BuildSupersededError` carries `{ collection, operation }` (never the data). The
  default prompt's Reload button calls `app.reloadForNewBuild()`, which emits
  `app:before-build-reload` synchronously (handlers save what they need) and then calls
  `location.reload()`. Apps with their own prompt call the same method.
- **Templates** (all 13) ship a ~30-line helper, `src/lib/form-draft.ts` (Vue: a composable,
  Svelte: a store), used by their forms: `useFormDraft(formKey, initial)` mirrors the form's
  values into `sessionStorage` (per tab, survives a reload, gone when the tab closes) on every
  change, restores them on mount, and clears them when the submit resolves. A submit that
  rejects with `BUILD_SUPERSEDED` leaves the form and its draft intact. Because drafts are
  written on change, nothing depends on the reload going through the app's handler.
- **Guidance** (offline-readiness guide): which forms deserve drafts, keys per record
  (`edit-todo:<id>`), and to drop the helper for fields that must not sit in plaintext in
  `sessionStorage` (apps using end-to-end encryption for sensitive fields).

## 7. Service-worker updates

The offline shell (`packages/cli/src/vite/service-worker.ts`) already waits for the user to
accept an update before activating it, so an old page is never served new assets. With the
gate:
- Accepting the update in one tab reloads that tab into the new build; its tab lock and `hello`
  retire every other old tab, which then shows the prompt instead of writing on. Without the
  gate those tabs would keep writing with old code.
- A page loaded online that bypassed an older active worker (shift-reload) is a newer build than
  the worker's offline copy; offline readiness reports `other-build` (section 7 there). The gate
  covers the storage side: whichever tab has the higher key wins, the other retires.

## 8. Builds that predate the gate (one-time limitation)

A build without the gate holds no tab lock, never sends `hello` and ignores it, so it cannot be
told to stop. During the **first** deployment of a gated build:
- The gated tab detects them: a heartbeat without `build` means a pre-gate leader. It reports
  `store:legacy-build-detected` and shows the prompt in the **newer** tab: "Close other tabs of
  this app, then reload", and does not write until no pre-gate heartbeat was heard for the
  silence bound (`MISSED_BEATS_UNRESPONSIVE`). A pre-gate follower sends no heartbeat and holds
  no tab lock, so it cannot be detected; on the IndexedDB fallback its saves are ordered only if
  it runs #52.
- From the second gated deployment on, every tab speaks the protocol.
- Release notes for beta.15 state this once: "Close all tabs of the app after upgrading to
  beta.15."

## 9. API summary

```typescript
createApp({ schema, build: import.meta.env.VITE_COMMIT_SHA }) // optional; plugins inject one

app.on('app:build-superseded', (event) => {
  event.preventDefault()          // replace the default prompt (runs before any write is refused)
  showMyBanner(event.newerBuild)  // call app.reloadForNewBuild() when the user accepts
})
createApp({ store: { onBuildSuperseded: ({ newerBuild }) => showMyBanner(newerBuild) } })
app.on('app:before-build-reload', () => saveWhatTheFormNeeds())

// Errors
BuildSupersededError     // code 'BUILD_SUPERSEDED', retriable; { collection, operation }
StorageFormatAheadError  // code 'STORAGE_FORMAT_AHEAD': stored format is newer than this code
```

Events: `app:build-superseded`, `app:before-build-reload`, `store:format-ahead`,
`store:build-gate-waiting`, `store:build-unidentified`, `store:legacy-build-detected`.
DevTools shows each tab's build, format and ordering key.

## 10. Tests

Deterministic (mock channel, mock Web Locks with `query()`, mock workers, fake timers only):
1. Old leader + new tab, IndexedDB fallback: the old tab's queued snapshot is flushed, the old
   tab's later write rejects with `BUILD_SUPERSEDED`, the new tab's first write lands after the
   old tab's tab lock is released, a reload holds every confirmed write of both.
2. Same on OPFS (mock pool): the new tab becomes leader on its own worker; no request of the new
   build, including its open and migrations, reaches the old worker.
3. Unsent operations in the old tab's outbound queue are uploaded once by the new build.
4. Old follower that has not yet processed the `hello` (message delivery held back): the new tab
   still sees it through `query()` and does not write until its lock is released.
5. Old tab mid-way through a slow transaction (or a slow snapshot flush) for 60 fake seconds: the
   new tab's gate stays closed, `store:build-gate-waiting` fires at 10 s, the gate opens only on
   the lock release. Frozen old tab: its lock was released on `freeze`, the new tab proceeds;
   resumed, it re-runs discovery and retires.
6. A non-transactional `insert` started before retirement and completing after it: retirement
   waits for it, it is inside the flushed snapshot, and no write resolves after
   `kora-build-retired`.
7. Old leader + old follower + new tab, with the old follower's lock request first in the queue:
   the old follower is granted the leader lock, sees the new tab in discovery, releases unopened;
   the new tab becomes leader; no old worker is started.
8. Ordering: same format, both orders and concurrent opens, a tab returning from bfcache that
   missed every `hello`: the later `openedAt` (tie: `tabId`) wins; higher format wins over a
   later open; rollback (build B then build A reopened) retires B.
9. Identity: no `build` option and no plugin gives a schema fingerprint and
   `store:build-unidentified`; two deployments differing only in schema still retire.
10. Stored format ahead: open refuses with `StorageFormatAheadError`, nothing written.
11. Same build in two tabs: no retirement, no prompt, no waiting.
12. Pre-gate heartbeat: `store:legacy-build-detected`, newer tab holds writes until silence.
13. Prompt order: `app:build-superseded` (and the default prompt) precede the first
    `BUILD_SUPERSEDED` rejection; `preventDefault()` and `onBuildSuperseded` replace the prompt.
14. Templates: a form with typed input, tab superseded, submit rejected, Reload: the input is
    restored after the reload and cleared after a successful submit.
15. Service worker: accepting the update in tab A retires tab B (end-to-end in the existing
    Playwright offline suite).

## 11. Rollout

1. beta.15: format `1`, tab locks, protocol, retirement, default prompt, `koraBuildId()`,
   events and errors; OPFS and IndexedDB fallback; templates use the default prompt and the
   form-draft helper.
2. #52's "Known limitations" entry ("a tab on an older release left open during a deployment can
   still overwrite a newer snapshot") is closed for every deployment after the first gated one.
3. Any later release that changes the storage layout bumps `format` and states it in its notes
   (including that redeploying the previous build is refused on databases already opened by
   it).
