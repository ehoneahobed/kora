# Design: version gate (one build writes a database at a time)

Code: `packages/store/src/multi-tab/version-gate.ts` (store layer: identity, tab locks,
discovery, retirement steps), `packages/store/src/multi-tab/open-seq.ts` (open-order counter),
`kora/src/version-gate.ts` (app layer: build id, prompt, reload, sync stop),
`packages/cli/src/vite/build-id.ts` (`koraBuildId()`), `packages/core/src/bindings/form-draft.ts`
(form drafts). Related: `docs/design/offline-readiness.md`.

## 1. Problem

Tabs of one origin share one database: one storage leader, with followers relaying over the
storage `BroadcastChannel`. During a deployment an old tab stays open next to a tab running the
new build. Without coordination the old tab keeps writing:

- **IndexedDB fallback.** Snapshots are ordered between tabs that implement snapshot lineages
  (compare-and-put, `SNAPSHOT_SUPERSEDED`), but code that predates that ordering can still
  overwrite a newer snapshot. Reconciling old and new copies after the fact repeatedly turned up
  new loss paths; the fix belongs one layer up, in stopping the old writer.
- **OPFS.** One SQLite file, so no snapshot race, but an old leader runs old code against data a
  new build may already have migrated (the schema ceiling refuses only at open), and a new tab
  that joins as a follower of an old leader runs new code through an old worker.
- **Internal storage layout.** Kora-internal tables and keys change between releases. Without a
  version for that layout, old code cannot know it must not write it.

## 2. Goals and non-goals

Goals:

- At most one build writes a database at any time. When a tab on a newer build opens, every
  older tab stops writing **before** the newer tab writes, and no write the older tab confirmed
  is lost.
- The older tab tells the user "A new version is available. Reload." **before** any of its writes
  is refused, and the reload need not cost the user what they were typing (section 6). On by
  default, replaceable by the app.
- A storage format version, written only by code that knows it, refused by code that does not.
- The same behaviour on OPFS and the IndexedDB fallback.
- Rollbacks work: among builds of the same format the later-opened one wins, so reopening the app
  on the previous build retires tabs of the withdrawn one.

Non-goals: running two builds side by side; downgrades across a format change (a newer format is
never opened by an older build, so a release that bumps `format` cannot be rolled back by
redeploying the previous build); cross-origin or cross-browser coordination.

## 3. Identity: build, storage format, ordering key

- **`build`**: a string that differs between any two deployments. Only equality matters. Sources,
  in order:
  1. `createApp({ build })`, for apps with a deploy id (commit SHA, CI build number) or without
     Vite.
  2. `__KORA_BUILD__`, injected by the `@korajs/cli/vite` plugins: `koraBuildId()` hashes every
     deployed file; `koraServiceWorker()` includes it. Every template uses one of them.
  3. Neither: Kora derives a fingerprint of `format` and the schema (collections, fields,
     version), which still retires old tabs on every schema change, and reports
     `store:build-unidentified` once per open (a console warning in development). It never falls
     back to the `korajs` package version: two deployments of one app usually share it, so an old
     tab would stay writable through an application-only change. A deployment that changes only
     mutation code is not gated in this mode, and the warning says so.
- **`format`**: an integer, the Kora storage format this code reads and writes
  (`KORA_STORAGE_FORMAT`, currently `1`). Bumped only by a release that changes the internal
  layout.
- **`openSeq`**: the tab's place in the order tabs of this origin opened the database. Not a
  clock: wall time can move backwards and two tabs can open in the same millisecond. At open,
  before taking its tab lock, a tab allocates `openSeq` from a counter record in a small IndexedDB
  database of its own, `kora-gate` (key: the database name), in one `readwrite` transaction: read
  `n`, write `n + 1`, take `n + 1`. IndexedDB serializes `readwrite` transactions on a store
  across tabs, so no two tabs get the same value and a later allocation always gets a higher one.
  The counter lives apart from the fallback's snapshot database because OPFS apps never open that
  one. If the allocation fails, the open fails like any storage open failure; the gate never
  guesses an order. `openedAt` and a random `tabId` exist for DevTools display only.
- **Ordering key** `(format, openSeq)`: the higher key wins (`tabId` breaks a tie
  deterministically, though none occur). Format first, so a newer format always wins; within a
  format the later-opened tab wins, which is the new build during a deployment and the previous
  one during a rollback.
- **Stored format.** Written once per format change, by the first build that uses it:
  - OPFS / native: `_kora_meta('storage_format')`, in the transaction of the migration that
    introduces the format.
  - IndexedDB fallback: a `format` field in the snapshot version record (`<db>::version`),
    written atomically with the compare-and-put save.
  - On open, a stored format higher than the code's refuses the open (`StorageFormatAheadError`,
    event `store:format-ahead`). It never falls back to an empty database.

## 4. Discovery and protocol

### 4.1 Roster: a Web Lock per tab

Messages alone cannot tell a new tab which tabs exist: a follower sends nothing unprompted, and a
hello is delivered asynchronously, so a tab could write before an old follower processed it. The
roster is held in Web Locks instead:

- Right after allocating `openSeq`, every tab acquires an exclusive **tab lock** named
  `kora-tab:<db>:` followed by its identity as JSON (`{ build, format, openSeq, tabId }`) and
  holds it for its life.
- **Discovery** is `navigator.locks.query()` filtered to held `kora-tab:<db>:` locks. It is
  authoritative and needs no reply, so silent followers and tabs that have not processed any
  message are seen.
- **Page lifecycle.** On `freeze` or a back-forward-cache `pagehide`, a tab releases its storage
  roles and then its tab lock at once, on OPFS and the IndexedDB fallback alike. A frozen tab
  cannot run, so letting it keep the database would stall every other tab. On the fallback, a
  write resolves only once a stored snapshot holds it, so a takeover never loses a confirmed
  write; later unsaved writes of the frozen tab are refused when it resumes
  (`SNAPSHOT_SUPERSEDED`). A tab still opening, promoting or closing keeps both its roles and
  its lock until that step ends. On `pageshow` / `resume` it re-acquires its tab lock and runs
  discovery before doing anything else; a tab that resumes after a newer build opened never
  re-attaches: requests queued behind its suspension fail retriably and it retires.
- **Leaders without a tab lock.** A gated leader also holds a marker lock carrying its identity
  (`kora-gated-leader-id:<db>:<identity>`), so a newer build's gate waits for another build's
  leader even when that tab's tab lock is already gone.

### 4.1.1 Missing coordination APIs

A runtime without Web Locks or `BroadcastChannel` used to be treated as single-tab. In a browser
that is not true: two tabs would each keep an in-memory SQLite copy and save competing snapshots.
So the gate degrades to something weaker but still exclusive, or refuses:

| Runtime | Gate |
|---|---|
| No `window` / `document` (Node, native adapters) | Not applied: one process owns the database file. |
| Not a secure context (plain HTTP) | Browsers expose no Web Locks there. The gate is off (mode `insecure-context`, one console warning per page) rather than refusing to open. |
| Web Locks and `BroadcastChannel` | Full protocol. |
| Web Locks, no `BroadcastChannel` | **Exclusive single tab.** Followers cannot relay without a channel, so every tab requests the exclusive lock `kora-db:<db>` before opening storage. A tab that cannot get it waits, reports `store:tab-exclusive` (`{ heldBy }`) and its default UI asks the user to close the other tab. One writer, always. |
| Secure context, no Web Locks | No exclusion primitive. Open refuses with `TabCoordinationUnavailableError` (`TAB_COORDINATION_UNAVAILABLE`, event `store:tab-coordination-unavailable`) unless `store.allowUncoordinatedTabs: true`, meant for test environments such as jsdom. |

### 4.2 Messages (existing storage channel)

Every message carries the sender's full identity, so a receiver can apply the rules without
remembering earlier messages (a tab back from the back-forward cache missed them).

| Message | Sent by |
|---|---|
| `kora-build-hello` | every tab after acquiring its tab lock, and on every heartbeat interval while its gate waits |
| `kora-build-retired` | a retiring tab, just before it releases its tab lock |
| `kora-build-unsaved` | a retiring tab whose durability barrier failed (`unsaved: true`) or recovered (`unsaved: false`) |
| `kora-leader-heartbeat` | the storage leader; carries its identity |

### 4.3 Rules

1. **Who retires.** A tab retires (section 5) as soon as it learns, from discovery, a hello or a
   heartbeat, of a tab with a **different build and a higher key**. Same build: nothing happens,
   whatever the key. A tab never retires for a lower key.
2. **The write gate.** A tab's write gate opens, and `app.ready` resolves, only when discovery
   (run after its own tab lock is held) shows no tab of a different build with a higher key
   (otherwise it retires) and none with a lower key. For each lower-keyed tab it posts a hello
   and waits for that tab's lock to be released (a `shared` request is granted only then). There
   is **no deadline**: a tab holding its lock is a live writer, and proceeding would break the
   one-writer invariant. After 10 s the newer tab reports `store:build-gate-waiting`
   (`{ waitingFor, reason }`) and its default UI asks the user to close the older tab; it keeps
   waiting.
3. **Storage open waits for the gate.** The newer tab defers its storage open (DDL, migrations,
   the format write, snapshot restore) until the gate opens, so it never runs new code through an
   older build's worker.
4. **Leadership.** An older leader releases leadership while retiring (worker terminated, then
   lock released); an older follower cancels its queued leader-lock request. Independently, a tab
   **granted** the leader lock runs discovery before opening a worker and, if a newer build is
   listed, releases the lock unopened and retires. So an old follower that wins the lock before
   processing the newer tab's hello still never opens an old worker.
5. **Resume.** A tab back from `freeze` or the back-forward cache re-runs discovery before its
   gate reopens. A retired tab never re-acquires a tab lock.

Same format, different builds, opened in either order or concurrently: both see each other, the
lower key retires, the higher key waits for it. Deterministic, and the latest-opened build wins.

## 5. Retiring a tab (the older build)

In order. Steps 1 and 2 run in the same task, so no write is refused before the prompt shows.

1. **Announce.** Emit `app:build-superseded` (`{ currentBuild, newerBuild }`) and, unless a
   handler called `event.preventDefault()` or the app set `store.onBuildSuperseded`, show the
   default prompt with a Reload button (reusing the offline shell's update prompt when present).
2. **Stop new writes.** Every write entry point (`insert`, `insertMany`, `update`, `delete`,
   `transaction`, mutations, and sync's application of received batches) rejects with
   `BuildSupersededError` (`BUILD_SUPERSEDED`, retriable) instead of starting. Nothing is partly
   applied. Refused delivery batches do not advance the delivery watermark, so the new build
   receives them again in order. `BUILD_SUPERSEDED` is a local refusal: it rejects the call
   (`useMutation().error`) and is never reported as a server rejection.
3. **Drain.** Every write registers in an in-flight set when it starts (single calls,
   transactions, the sync applier, outbound-queue and watermark bookkeeping). Retirement awaits
   all of them. A started write commits or fails as it would have; it is never cut midway.
4. **Durability barrier.** IndexedDB fallback only (on OPFS a commit is durable): the tab flushes
   its snapshot so everything it committed is stored. A retiring follower whose leader already
   closed settles against the stored `<db>::version` record without a worker. **A failed
   barrier keeps the gate closed**: the tab reports `store:persistence-error`, retries with
   backoff (and on heartbeats, visibility changes and the user's Retry), and keeps its tab lock
   until a barrier succeeds. Its prompt names the cause (`QUOTA_EXCEEDED`,
   `STORAGE_UNAVAILABLE`, or generic) and offers Retry and Export (a download of the in-memory
   database, for when the user cannot free space). Waiting tabs report `reason:
   'unsaved-writes'`. A barrier refused with `SNAPSHOT_SUPERSEDED` is not retried: those writes
   already rejected to their callers and the replacing lineage is authoritative. From the moment
   retirement starts, `close()` saves every admitted write first and is refused
   (`UNSAVED_WRITES`) when that fails.
5. **Stop sync.** The sync engine disconnects. Unsent operations are already in the persisted
   outbound queue, so the new build uploads them; content-addressed ids mean nothing is lost or
   sent twice.
6. **Give up storage roles.** Leader: release leadership (rule 4); after the drain no follower
   holds an open transaction span on this worker, and a span cut by the release fails retriably.
   Follower: cancel the promotion watch.
7. **Leave.** Post `kora-build-retired`, then release the tab lock; that release opens the newer
   tab's gate.

After retiring, reads keep working where they can (as a follower of the new leader). The tab
never un-retires: only a reload, which loads the new build, brings writes back.

## 6. Keeping the user's input across the reload

Writes refused after retiring were never applied: callers see `BUILD_SUPERSEDED` and the prompt
is already visible. What a form contains, and whether it may be stored, is an application
decision, so the framework persists nothing by default. It provides:

- `BuildSupersededError` carries `{ collection, operation }`, never the data.
- `app.reloadForNewBuild()`: emits `app:before-build-reload` synchronously (handlers save what
  they need), activates the newer build's waiting service worker, then reloads under the offline
  shell. The default prompt's Reload button calls it; custom prompts call the same method.
- `useFormDraft` (React, Vue and Svelte bindings over a core controller), an opt-in per-form
  draft in `sessionStorage`. Templates use it on their own non-sensitive forms.

### 6.1 Form drafts: privacy rules

Form answers can be health data, credentials or anything else, and a plain `sessionStorage` copy
would sidestep Kora's at-rest protection. So:

1. **Opt-in, allow-listed.** Nothing is drafted unless a form calls `useFormDraft`, and only the
   fields it lists; a field added to the form later is not drafted until listed.
2. **Sensitive fields never drafted**, even when listed: a field bound to a password-like input
   (`type="password"`, or `autocomplete` `current-password`, `new-password`, `one-time-code`,
   `cc-*`; once seen, for the life of the form, so a "show password" toggle does not start
   drafting it), one marked `data-kora-sensitive`, a schema field declared `t.secret()`, and a
   field the app lists in `sensitive` (dotted paths remove nested values). `allowSensitive`
   overrides this per field and is discouraged.
3. **Fail closed.** A listed field whose input element cannot be resolved (values set from code,
   wrapper components) is not drafted unless named in `safe`.
4. **No plaintext when encryption is on.** With encryption enabled nothing is stored at all; the
   form is simply not restored after the reload.
5. **Short-lived.** A draft is removed as soon as it is restored. Every draft of the database
   (one key prefix, `kora-draft:<db>:`) is removed on sign-out or a change of user; a draft
   written under another known user is removed, never restored; while the user is unknown
   (`userId: undefined`) nothing is restored, consumed or saved.

## 7. Service-worker updates

The offline shell (`packages/cli/src/vite/service-worker.ts`) waits for the user to accept an
update before activating it. Accepting it in one tab reloads that tab into the new build; its tab
lock and hello retire every other old tab, which then shows the prompt instead of writing on. A
page loaded online that bypassed an older active worker is a newer build than the worker's
offline copy; whichever tab has the higher key wins.

## 8. Builds that predate the gate

A build without the gate holds no tab lock and ignores hellos, so it cannot be told to stop. The
gate detects a pre-gate **leader** as a holder of the storage leader lock without the
gated-leader marker (4.1): it reports `store:legacy-build-detected`, waits with
`reason: 'legacy-build'` until that leader lock is released, and asks the user to close other
tabs. A pre-gate **follower** sends nothing and cannot be detected. This matters only
during the first deployment of a gated build; from the next one on, every tab speaks the protocol.

## 9. API summary

```typescript
createApp({ schema, build: import.meta.env.VITE_COMMIT_SHA }) // optional; the Vite plugins inject one

app.on('app:build-superseded', (event) => {
  event.preventDefault()          // replace the default prompt (runs before any write is refused)
  showMyBanner(event.newerBuild)  // call app.reloadForNewBuild() when the user accepts
})
createApp({ store: { onBuildSuperseded: ({ newerBuild }) => showMyBanner(newerBuild) } })
app.on('app:before-build-reload', () => saveWhatTheFormNeeds())

createApp({ store: { allowUncoordinatedTabs: true } }) // tests only: no Web Locks (4.1.1)

BuildSupersededError              // 'BUILD_SUPERSEDED', retriable; { collection, operation }
StorageFormatAheadError           // 'STORAGE_FORMAT_AHEAD': stored format newer than this code
TabCoordinationUnavailableError   // 'TAB_COORDINATION_UNAVAILABLE': browser without Web Locks
```

Events: `app:build-superseded`, `app:before-build-reload`, `store:format-ahead`,
`store:build-gate-waiting` (`reason: 'live-writer' | 'unsaved-writes' | 'legacy-build'`),
`store:build-unidentified`, `store:legacy-build-detected`, `store:tab-exclusive`,
`store:tab-coordination-unavailable`. DevTools shows each tab's build, format, `openSeq` and
`openedAt`.

## 10. Tests

All deterministic: mock `BroadcastChannel`, mock Web Locks with `query()`, mock workers, fake
timers.

- `packages/store/src/multi-tab/version-gate.test.ts`: ordering (both open orders, concurrent
  opens, a clock moved backwards, two opens in the same millisecond, higher format beats a later
  open, rollback), identity fallback, same-build tabs, the waiting report, missing coordination
  APIs, pre-gate leaders told apart from gated ones.
- `packages/store/tests/integration/version-gate.test.ts`, on the browser storage paths (one OPFS
  file per database; fallback workers restoring from fake IndexedDB): the new tab never reaches
  the old worker, including through an old follower that wins the leader lock; the drain; refused
  inbound batches; failed and recovered durability barriers; `close()` during retirement;
  freezes while opening or promoting; leaders without a tab lock; resume after a newer build;
  the stored format refusing an open.
- `kora/tests/integration/version-gate-app.test.ts`, the app layer: the announcement precedes
  every refusal, every kind of write refuses with `BUILD_SUPERSEDED`, sync stops and stays
  stopped, queued operations are uploaded once by the new build, the default prompt can be
  replaced.
- Form drafts: `packages/core/src/bindings/form-draft.test.ts` and each binding's
  `use-form-draft.test.ts` (React, Vue, Svelte) cover the rules in 6.1.

## 11. Known limits

- **First gated deployment.** A pre-gate follower cannot be detected (section 8); on the
  IndexedDB fallback its saves are ordered only if it implements snapshot lineages.
- **Clearing site data with tabs open** restarts the `openSeq` counter, so a tab opened afterwards
  can get a lower key than one still open from before and retire in its favour. Reloading every
  tab restores the order.
- **Schema fingerprint fallback.** Without a build id, deployments that change only application
  code are not gated.
- **Plain HTTP.** The gate is off outside a secure context.
- **No downgrade across a format change** (section 2).
