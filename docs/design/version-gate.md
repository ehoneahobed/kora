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
- The older tab tells the user: "A new version is available. Reload." On by default,
  replaceable by the app (decision 7 of offline readiness: defaults on, customizable).
- A storage format version, written only by code that knows it, refused by code that does not.
- Same behaviour on OPFS and the IndexedDB fallback.

Non-goals: running two builds side by side; downgrades (a newer format is never opened by an
older build: refused, as RT-109 does for schemas); cross-origin or cross-browser coordination.

## 3. Identity: build and storage format

- **`build`**: a string identifying the code. The Vite plugin injects the service worker's
  `VERSION` (hash of the precached files, `packages/cli/src/vite/service-worker.ts`) as
  `__KORA_BUILD__`; without the plugin it is the `korajs` package version. Only equality
  matters, never ordering.
- **`format`**: an integer, the Kora storage format this code reads and writes (internal tables,
  IndexedDB keys, snapshot layout). Starts at `1` with this design; bumped only by a release
  that changes the layout. Ordered.
- **Stored format.** Written once per format change, by the first build that uses it, never by
  older code:
  - OPFS / native: `_kora_meta('storage_format')`, set in the same transaction as the migration
    that introduces the format.
  - IndexedDB fallback: a `format` field in the snapshot version record (`<db>::version`),
    written atomically with the compare-and-put save (#52).
  - On open, a stored format higher than the code's refuses the open
    (`StorageFormatAheadError`, event `store:format-ahead`), like `store:schema-ahead`. It never
    falls back to an empty database.

## 4. Protocol (existing storage channel)

Every tab already joins `storageChannelName(dbName)`. Two messages are added; heartbeats carry
the identity too.

| Message | Sent by | Payload |
|---|---|---|
| `kora-build-hello` | every tab at open, before its first write; on `pageshow` (bfcache) | `{ build, format, tabId }` |
| `kora-build-retired` | a tab that stopped writing for a newer build | `{ build, tabId }` |
| `kora-leader-heartbeat` (existing) | leader | adds `{ build, format }` |

Rules:
1. A tab that hears a `hello` (or heartbeat) with a **higher `format`**, or with an **equal
   format and a different `build` whose tab opened later**, retires (section 5). Equal build:
   nothing happens. Lower format: the sender retires, not the receiver.
2. A newer tab does not write until every older tab it heard has sent `kora-build-retired`, or
   has gone silent for the existing leader-silence bound (`MISSED_BEATS_UNRESPONSIVE`). It waits
   at most 10 s, then reports `store:build-gate-timeout` and proceeds (an old tab that cannot
   answer is frozen or gone: frozen tabs already release the leader lock, NEW-STORE-10).
3. If the older tab is the storage leader, it releases leadership after retiring (the existing
   suspend path: worker terminated, then lock released), so the newer tab is promoted and opens
   its own worker. A newer tab never relays writes through an older build's worker.

"Opened later" is decided by the tab's open time in its `hello`; ties break on `tabId`. Two tabs
of different builds and the same format are therefore resolved deterministically: the
latest-opened build wins, which during a deployment is the new one.

## 5. Retiring a tab (the older build)

In order, before sending `kora-build-retired`:

1. **Stop new writes.** Every write API (`insert`, `update`, `delete`, `transaction`,
   `mutation`, `useMutation`) rejects with `BuildSupersededError` (`code: 'BUILD_SUPERSEDED'`,
   `retriable: true`) instead of running. Nothing is partly applied.
2. **Finish what was confirmed.** Transactions already started complete. On the IndexedDB
   fallback the tab flushes its snapshot (`ensureDurable`); a failure is reported
   (`store:persistence-error`), and the leader still releases (holding on would block the new
   build forever).
3. **Stop sync.** The sync engine disconnects (`intentionalDisconnect`). Unsent operations are
   already in the database's outbound queue (`_kora_sync_queue`, persisted before upload), so
   the new build uploads them: nothing queued is lost or sent twice (content-addressed ids).
4. **Release leadership** if held (section 4, rule 3).
5. **Prompt.** Emit `app:build-superseded` (`{ currentBuild, newerBuild }`) and, unless the app
   called `event.preventDefault()` or set `store.onBuildSuperseded`, show the default prompt:
   "A new version of this app is available. Reload to continue." with a Reload button. When the
   offline-shell plugin is present, the same UI as its update prompt is reused
   (`kora:update-available`).

After retiring, reads keep working where they can (as a follower of the new leader); a query the
newer schema broke surfaces as a query error. The tab never un-retires: only a reload (which
loads the new build) brings writes back.

Writes the app tried after retiring were never applied: they reject, so `mutateAsync` callers
and `useMutation().error` see them, and the app can keep the user's input in its form until the
reload.

## 6. Service-worker updates

The offline shell (`packages/cli/src/vite/service-worker.ts`) already waits for the user to
accept an update before activating it, so an old page is never served new assets. With the
gate:
- Accepting the update in one tab reloads that tab into the new build; its `hello` retires every
  other old tab, which then shows the prompt instead of writing on. Without the gate those tabs
  would keep writing with old code.
- A page loaded online that bypassed an older active worker (shift-reload) is a newer build than
  the worker's offline copy; offline readiness reports `other-build` (section 7 there). The gate
  covers the storage side: whichever page is newer wins, the other retires.

## 7. Builds that predate the gate (one-time limitation)

A build without the gate never sends `hello` and ignores it, so it cannot be told to stop. During
the **first** deployment of a gated build:
- The gated tab detects them: a heartbeat without `build` means a pre-gate leader. It reports
  `store:legacy-build-detected` and shows the prompt in the **newer** tab: "Close other tabs of
  this app, then reload", and does not write until no pre-gate heartbeat was heard for the
  silence bound. A pre-gate follower sends no heartbeat and cannot be detected; on the IndexedDB
  fallback its saves are ordered only if it runs #52.
- From the second gated deployment on, every tab speaks the protocol.
- Release notes for beta.15 state this once: "Close all tabs of the app after upgrading to
  beta.15."

## 8. API summary

```typescript
app.on('app:build-superseded', (event) => {
  event.preventDefault()          // replace the default prompt
  showMyBanner(event.newerBuild)  // then call location.reload() when the user accepts
})
createApp({ store: { onBuildSuperseded: ({ newerBuild }) => showMyBanner(newerBuild) } })

// Errors
BuildSupersededError     // code 'BUILD_SUPERSEDED', retriable: a newer build owns the database
StorageFormatAheadError  // code 'STORAGE_FORMAT_AHEAD': stored format is newer than this code
```

Events: `app:build-superseded`, `store:format-ahead`, `store:build-gate-timeout`,
`store:legacy-build-detected`. DevTools shows each tab's build and format.

## 9. Tests

Deterministic (mock channel and workers, no timers except fake ones):
1. Old leader + new tab, IndexedDB fallback: the old tab's queued snapshot is flushed, the old
   tab's later write rejects with `BUILD_SUPERSEDED`, the new tab's first write lands after the
   old tab's `retired`, a reload holds every confirmed write of both.
2. Same on OPFS (mock pool): the new tab becomes leader on its own worker; no request of the new
   build reaches the old worker.
3. Unsent operations in the old tab's outbound queue are uploaded once by the new build.
4. The old tab freezes before answering: the new tab proceeds after the bound and reports
   `store:build-gate-timeout`; the frozen tab, resumed, is retired on `pageshow`.
5. Stored format ahead: open refuses with `StorageFormatAheadError`, nothing written.
6. Same build in two tabs: no retirement, no prompt.
7. Pre-gate heartbeat: `store:legacy-build-detected`, newer tab holds writes until silence.
8. Default prompt shown; `preventDefault()` and `onBuildSuperseded` replace it.
9. Service worker: accepting the update in tab A retires tab B (end-to-end in the existing
   Playwright offline suite).

## 10. Rollout

1. beta.15: format `1`, protocol, retirement, default prompt, events and errors; OPFS and
   IndexedDB fallback; templates use the default prompt.
2. #52's "Known limitations" entry ("a tab on an older release left open during a deployment can
   still overwrite a newer snapshot") is closed for every deployment after the first gated one.
3. Any later release that changes the storage layout bumps `format` and states it in its notes.
