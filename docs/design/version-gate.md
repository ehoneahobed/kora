# Design: version gate (one build writes a database at a time)

Status: proposal, not implemented. Target: 1.0.0-beta.15. Date: 2026-10-20 (round 3).
Related: offline readiness (`docs/design/offline-readiness.md`, PR #50, sections 7, 8.1 and 12),
IndexedDB snapshot ordering (#52, merged: lineages, compare-and-put, `SNAPSHOT_SUPERSEDED`),
multi-tab transaction isolation (#59, merged), schema ceiling (RT-109).

## 1. Problem

Tabs of one origin share one database (one storage leader, followers relay over the storage
`BroadcastChannel`). During a deployment, an old tab stays open next to a tab running the new
build. Today nothing stops the old tab from writing:

- **IndexedDB fallback.** An old build saves snapshots with an unconditional put. #52 (merged)
  orders snapshots between tabs that run it, but a pre-#52 tab can still overwrite a newer
  snapshot (stated in #52's changeset, `.changeset/idb-snapshot-ordering.md`, which points here). Round 3 and 4 of #52 tried to reconcile old and new copies after
  the fact (stamped legacy copies, subset comparison, preserved copies); each round found a new
  loss path. Reconciling after an old build wrote is the wrong layer.
- **OPFS.** One SQLite file, so no snapshot race, but an old leader runs old code against data a
  new build may already have migrated (the schema ceiling refuses only at open, RT-109), and a
  new tab that joins as a follower of an old leader runs new code through an old worker (#55
  already has to detect such a worker and fall back to one statement per message).
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
- **`openSeq`**: the tab's place in the order tabs of this origin opened the database. Not a
  clock: wall time can move backwards (NTP, a manual change, a VM resume) and two tabs can open
  in the same millisecond, so `Date.now()` cannot say which tab opened later. At open, before
  its tab lock (4.1), the tab allocates `openSeq` from a counter record in a small IndexedDB
  database of its own, `kora-gate` (key: the database name), in one `readwrite` transaction:
  read `n`, write `n + 1`, take `n + 1`. IndexedDB serializes `readwrite` transactions on a store
  across tabs, so two tabs never get the same value and a later allocation always gets a higher
  one, whatever the clock does. The record is never reset (deleting the Kora database leaves
  it, as #52 leaves the epoch counter) and is fixed for the tab's life, including across bfcache.
  IndexedDB exists on every browser that runs OPFS or the fallback; if the allocation fails,
  the open fails like any other storage open failure (`store:durability-lost` path), never with
  a guessed order. `openedAt` (wall time) and a random `tabId` are kept for DevTools display
  only.
- **Ordering key** `(format, openSeq)`: the higher key wins. No ties exist. Format first, so a
  newer format always wins regardless of open order; within a format the later-opened tab wins,
  which during a deployment is the new build and during a rollback is the previous one.
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

- At open, right after allocating `openSeq`, every tab acquires an exclusive **tab lock** named
  `kora-tab:<db>:` followed by its identity as JSON (`{ build, format, openSeq, tabId }`). It
  holds the lock for its life and releases it on retirement and close. On `pagehide` and
  `freeze` it releases it only under the lifecycle rule below; it re-acquires it on `pageshow` /
  `resume` before doing anything else.
- **Lifecycle release never outruns durability.** Releasing the tab lock is what lets a newer
  build open storage, so a tab releases it on `pagehide` / `freeze` only when every write it
  committed is durable:
  - OPFS: a committed write is durable, and the existing suspend path (worker terminated, then
    leader lock released, NEW-STORE-10) runs first. Release at once.
  - IndexedDB fallback: the tab releases the tab lock synchronously only when it has no committed
    write outside a stored snapshot (the scheduler's persisted generation equals its scheduled
    one and no flush is in flight). Otherwise it does **not** release it in the handler: it
    starts the snapshot (`flushNow()`, as `visibilitychange` already does) and releases the tab
    lock in that flush's continuation, after the snapshot is stored. If the page is frozen
    first, the lock stays held while the tab is frozen, so the newer tab waits (rule 2, its
    `store:build-gate-waiting` names the tab) until the old tab resumes and finishes the flush,
    or is closed or discarded, which releases the lock with the in-memory database. Nothing a
    discarded tab held was a confirmed write: offline readiness 8.1 resolves an IndexedDB-fallback
    write only once a stored snapshot holds it, and a write whose snapshot is then refused
    rejects (`SNAPSHOT_SUPERSEDED`, #52). The two layers are independent: the gate stops the
    newer build from restoring an older snapshot while confirmed writes are in flight, and #52
    stops the older tab's late save from landing over the newer build's lineage.
- **Discovery** = `navigator.locks.query()`, filtered to held `kora-tab:<db>:` locks. It is
  authoritative and needs no reply from the other tabs, so silent followers and tabs that have
  not yet processed any message are seen.

### 4.1.1 Missing coordination APIs: the gate fails closed

Today `acquireTabStorageSession()` treats a runtime without Web Locks or `BroadcastChannel` as
single-tab (every instance is its own leader). In a browser that is not true: two tabs would
each keep an in-memory SQLite copy and save competing snapshots. The gate therefore never turns
itself off in a browser; it degrades to something weaker but still exclusive, or refuses:

| Runtime | Gate |
|---|---|
| No `window` / `document` (Node, workers of the server, native adapters) | Not applied: one process owns the database file (`better-sqlite3`, Tauri plugin). |
| Browser, Web Locks and `BroadcastChannel` | Full protocol (4.1 to 4.3). |
| Browser, Web Locks, no `BroadcastChannel` | **Exclusive single tab.** Followers cannot relay without a channel, so only one tab may use the database: every tab requests the exclusive lock `kora-db:<db>` before storage open and holds it for its life (released under the same lifecycle rule as the tab lock). A tab that cannot get it does not open storage; it waits in the queue, reports `store:tab-exclusive` (`{ heldBy: identity }`, read from its tab lock through `query()`) and its default UI says "This app is open in another tab. Close it to continue here." Version gate: discovery still works (`query()`), so a newer tab waiting behind an older one shows the build-gate prompt; the older tab cannot be told to retire without a channel, it simply keeps the database until it is closed. One writer, always. |
| Browser, no Web Locks | No exclusion primitive exists. Storage open refuses with `TabCoordinationUnavailableError` (`code: 'TAB_COORDINATION_UNAVAILABLE'`, event `store:tab-coordination-unavailable`). Escape hatch, like `store.allowNonDurable`: `store.allowUncoordinatedTabs: true` opens it single-tab as today, with a dev console warning that two tabs can lose each other's writes. No supported browser lacks Web Locks (Safari 15.4+, all Chromium and Firefox releases Kora supports), so this mainly affects test environments (jsdom, happy-dom), which set the flag. |

### 4.2 Messages (existing storage channel)

Every tab already joins `storageChannelName(dbName)`. Messages carry the full identity, so any
receiver can apply the rules without remembering an earlier message (a tab back from bfcache
missed them).

| Message | Sent by | Payload |
|---|---|---|
| `kora-build-hello` | every tab after acquiring its tab lock (open, `pageshow`, `resume`), and again each heartbeat interval while its gate is waiting | `{ build, format, openSeq, tabId }` |
| `kora-build-retired` | a tab that finished retiring (section 5), just before releasing its tab lock | `{ build, format, openSeq, tabId }` |
| `kora-leader-heartbeat` (existing) | leader | adds `{ build, format, openSeq, tabId }` |

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
   (alive, possibly busy finishing a transaction, a slow IndexedDB flush, or frozen with a
   flush pending, 4.1), so proceeding would break the one-writer invariant; a discarded tab,
   and a frozen or bfcached tab with nothing unsaved, has already released its lock. After 10 s of waiting the newer tab reports `store:build-gate-waiting`
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
2. **Stop new writes.** Every write entry point (`insert`, `insertMany` (#55), `update`,
   `delete`, `transaction`, `mutation`, `useMutation`, and sync's application of received
   batches) rejects with
   `BuildSupersededError` (`code: 'BUILD_SUPERSEDED'`, `retriable: true`) instead of starting.
   Nothing is partly applied. Received sync batches that are refused are not applied and do not
   advance the delivery watermark, so the new build receives them again from the watermark, in
   delivery order (retractions included, #54), and a record's visibility is decided there by
   the same delivery-order rule. `BUILD_SUPERSEDED` is a local refusal: it rejects the call
   (`useMutation().error`), it is not a server refusal and never appears in `useMutation`'s
   `rejected` state (#57).
3. **Drain every started write.** Each write entry point registers its promise in an in-flight
   set when it starts (not only transactions: single `insert` / `update` / `delete` calls, the
   sync applier, the outbound-queue bookkeeping, the watermark update). Retirement awaits every
   entry in the set to settle. A started write is never cancelled midway: it commits, or it fails
   and rejects to its caller as it would have anyway.
4. **Durability barrier.** Only after the drain: on the IndexedDB fallback the tab flushes its
   snapshot (`ensureDurable`), so everything the tab committed (confirmed writes, received
   operations it applied, outbound-queue and watermark bookkeeping) is in a stored snapshot.
   **A failed barrier keeps the gate closed.** Quota exhaustion or a transient IndexedDB error
   can leave committed state only in this tab's memory; releasing the tab lock would let the
   new build restore the last stored snapshot without it. So the tab does not continue to step
   5: it reports `store:persistence-error`, retries the barrier with backoff (and on every
   heartbeat, `visibilitychange` and the user's Retry), and keeps its tab lock until a barrier
   succeeds. Its prompt changes to "Your latest changes are not saved yet (storage is full).
   Free up space, then Retry." with Retry and Export buttons (export: a download of the
   in-memory database through the adapter's existing dump, `exportDump`, the explicit recovery
   path that preserves the data when the user cannot free space). The newer tab's `store:build-gate-waiting` carries `reason:
   'unsaved-writes'` and its prompt says the older tab needs attention. Only the user closing
   the older tab ends this without a snapshot; nothing it then loses was a confirmed write
   (offline readiness 8.1: an IndexedDB-fallback write resolves only once a stored snapshot
   holds it). A barrier rejected with `SNAPSHOT_SUPERSEDED` (#52: this tab's lineage was
   replaced) is not retried: those writes already rejected to their callers, the replacing
   lineage is authoritative, and retirement continues. OPFS: no step (committed is durable).
5. **Stop sync.** The sync engine disconnects (`intentionalDisconnect`). Unsent operations are
   already in the database's outbound queue (`_kora_sync_queue`, persisted before upload), so
   the new build uploads them: nothing queued is lost or sent twice (content-addressed ids).
   A disconnect also ends the server's wait for this session's relay acknowledgements (#54);
   unacknowledged relays go to the re-relay buffer and reach the new build's session.
6. **Give up storage roles.** Leader: release leadership (section 4.3, rule 4); after the drain
   no follower holds an open transaction span on this worker (#59 binds a span to the worker
   that answered its BEGIN, and a span cut by the release fails retriably with
   `BridgeTerminatedError`). Follower: `cancelPromotionWatch()`.
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
- **Templates** (all 13) ship a small helper, `src/lib/form-draft.ts` (Vue: a composable,
  Svelte: a store). It is template code, not framework API: nothing in `korajs` persists form
  state, and no form gets a draft unless its code calls the helper.

### 6.1 Form drafts: privacy rules

Form answers can be health data, credentials or anything else a form builder collects, and a
plain `sessionStorage` copy sidesteps Kora's at-rest protection. The helper therefore follows
five rules (owner review, PR #61):

1. **Opt-in per form.** `useFormDraft(formKey, initial, { fields })` drafts nothing by default;
   a form opts in by calling it, and only the fields it lists are drafted (an allow-list, so a
   field added to the form later is not drafted until it is listed). The templates enable it on
   their own non-sensitive forms only (the todo / note title and body). The framework has no
   default-on draft behaviour, and the guide says so.
2. **Sensitive fields excluded by default.** Even when listed, the helper never drafts: a field
   whose input is `type="password"` (the helper reads the bound element's `type`, so a field
   that becomes a password input stops being drafted at once and its stored value is removed);
   a schema field declared `t.secret()` (the templates pass the collection, the helper reads
   the field kind); and a field the app marks sensitive (`{ sensitive: ['ssn', 'diagnosis'] }`,
   or `data-kora-sensitive` on the input). Drafting such a field needs an explicit per-field
   override (`{ allowSensitive: ['field'] }`), which the guide discourages.
3. **No plaintext drafts when encryption is enabled.** When the app enables encryption (an
   `encryption` config, or `app.encryption` present), the helper never writes `sessionStorage`.
   It stores the draft through Kora's encrypted path if one is available (a local-only
   `_kora_drafts` entry whose values are sealed with the app's encryption key, written only
   while `app.encryption.getStatus()` is unlocked) and otherwise stores nothing: no draft, the
   form simply is not restored after the reload. Which of the two ships in beta.15 is a build
   decision (Deferred, below); plaintext is never the fallback.
4. **Consumed on restore, cleared on sign-out.** A draft is removed from storage as soon as it
   has been restored into the form (the restored values live in component state from then on;
   the helper writes a fresh draft only on the next change). Sign-out (`signOut()` of
   `@korajs/auth`) clears every draft of the tab: the helper keeps its keys under one prefix (`kora-draft:<db>:`) and the templates' auth
   wiring removes that prefix on the `signed-out` state and on a change of user id. A draft is
   also tagged with the user id it was written under and is ignored and removed if restored
   under another.
5. **Tests** for each rule (section 10, tests 16 to 20).

- **Guidance** (offline-readiness guide): which forms deserve drafts, keys per record
  (`edit-todo:<id>`), the five rules above, and that a form collecting sensitive answers either
  marks them sensitive or does not use the helper.

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

createApp({ store: { allowUncoordinatedTabs: true } }) // tests only: no Web Locks (4.1.1)

// Errors
BuildSupersededError              // code 'BUILD_SUPERSEDED', retriable; { collection, operation }
StorageFormatAheadError           // code 'STORAGE_FORMAT_AHEAD': stored format is newer than this code
TabCoordinationUnavailableError   // code 'TAB_COORDINATION_UNAVAILABLE': browser without Web Locks
```

Events: `app:build-superseded`, `app:before-build-reload`, `store:format-ahead`,
`store:build-gate-waiting` (`{ waitingFor, reason: 'live-writer' | 'unsaved-writes' }`),
`store:build-unidentified`, `store:legacy-build-detected`, `store:tab-exclusive`,
`store:tab-coordination-unavailable`. DevTools shows each tab's build, format, `openSeq` and
`openedAt`.

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
8. Ordering: same format, both orders and concurrent opens (allocations interleaved in the mock
   IndexedDB), a tab returning from bfcache that missed every `hello`: the later `openSeq` wins;
   higher format wins over a later open; rollback (build B then build A reopened) retires B; the
   mock clock moved backwards between two opens, and two opens in the same mock millisecond,
   still let the later-opened tab win.
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
16. Drafts are opt-in: a template form that does not call the helper, and a listed form's
    unlisted field, write nothing to storage; `korajs` alone writes no draft.
17. Sensitive fields: a `type="password"` input, a `t.secret()` field, a field marked
    `sensitive` or `data-kora-sensitive` are absent from the stored draft; an input switched to
    `type="password"` after a draft was written removes its value; `allowSensitive` drafts it.
18. Encryption on: with an `encryption` config, nothing is written to `sessionStorage` (spy on
    `Storage.prototype.setItem`); the draft is either in the encrypted store (sealed, unreadable
    without the key, not written while locked) or absent, per the build decision.
19. Restore consumes: after a restore the storage key is gone; a second reload without edits
    restores nothing.
20. Sign-out and user change clear: every `kora-draft:<db>:` key is removed on sign-out and on a
    user-id change; a draft tagged with another user id is not restored and is removed.
21. IndexedDB fallback lifecycle: a confirmed write still inside the debounce when `pagehide`
    fires: the tab lock is released only after the snapshot holding it is stored; frozen before
    the flush ends, the newer tab's gate stays closed (`reason: 'unsaved-writes'`) until the old
    tab resumes and finishes it or is discarded; a reload of the newer tab holds the write.
22. Failed barrier: retirement with `ensureDurable()` rejecting (quota mock) keeps the tab lock,
    reports `store:persistence-error`, the newer tab stays gated; when the quota mock is lifted
    the retry succeeds and the newer tab opens with every confirmed write; `SNAPSHOT_SUPERSEDED`
    does not hold the gate.
23. Coordination APIs: no `BroadcastChannel` (Web Locks present): a second tab does not open
    storage and reports `store:tab-exclusive`, then opens when the first closes; no Web Locks:
    open refuses with `TAB_COORDINATION_UNAVAILABLE` unless `allowUncoordinatedTabs`.

## 11. Rollout

1. beta.15: format `1`, `openSeq`, tab locks, protocol, retirement, default prompt,
   `koraBuildId()`, the fail-closed coordination fallback, events and errors; OPFS and IndexedDB
   fallback; templates use the default prompt and the opt-in form-draft helper (6.1).
2. The limitation stated in #52's changeset ("a tab still running an earlier build ... can still
   overwrite a newer snapshot while it stays open during a deployment") is closed for every
   deployment after the first gated one.
3. Any later release that changes the storage layout bumps `format` and states it in its notes
   (including that redeploying the previous build is refused on databases already opened by
   it).

## 12. Deferred to the build

Questions this design cannot settle on paper; the build PR answers each with code and a test.

- **Encrypted draft backend (6.1 rule 3).** Whether beta.15 ships a sealed `_kora_drafts` store
  or simply disables drafts when encryption is enabled. Both satisfy the rule; the choice
  depends on how cheaply the local key can be reached from the template helper.
- **`openSeq` store.** Whether the counter lives in its own `kora-gate` IndexedDB database or in
  an object store of the fallback's existing database (OPFS apps have no fallback database open),
  and its cost on the open path (one small `readwrite` transaction, to be measured).
- **IndexedDB lifecycle release.** How often a frozen tab with a pending flush keeps a newer tab
  waiting in practice (Chromium freezes hidden tabs after minutes, not on hide); if it is
  common, start the snapshot on `visibilitychange` before any freeze (already done today) and
  measure whether it always finishes first.
- **`useFormDraft` field-kind detection** in Vue and Svelte (reading the bound input's `type`)
  and the exact shape of the templates' sign-out wiring per auth template.
- **Detecting a pre-gate follower** (section 8): only if a cheap probe exists; otherwise the
  release-note instruction stands.
