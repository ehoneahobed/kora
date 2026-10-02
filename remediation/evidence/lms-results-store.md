# LMS report: verification of items #5, #6, #7 (@korajs/store)

Kora 1.0.0-beta.12 (HEAD 91c6350), @sqlite.org/sqlite-wasm 3.51.0-build1, real Chromium (/opt/pw-browsers/chromium), real OPFS, real navigator.locks and BroadcastChannel. Nothing was mocked in the browser runs.

## Repro artifacts (new files only; no existing files were modified)

- `packages/store/tests/repro/browser/LMS-5-6-7.browser.mjs`: 13 real-browser scenarios with 25 checks. Checks assert correct behaviour; a FAIL marks a defect.
- `packages/store/tests/repro/browser/lms-harness/`: esbuild bundle of the built `@korajs/store` and `@korajs/core` dist plus sqlite-wasm, served with COOP/COEP. Includes a raw SAH-pool probe worker that applies the LMS #6 fix verbatim.
- `packages/store/tests/repro/LMS-7.test.ts`: node-level vitest using Node's real BroadcastChannel.
- How to run:
  - Browser suite: `PW_CHROMIUM_PATH=/opt/pw-browsers/chromium node packages/store/tests/repro/browser/LMS-5-6-7.browser.mjs [LMS-5|LMS-6|LMS-7x]`
  - Node test: `pnpm --filter @korajs/store exec vitest run tests/repro/LMS-7.test.ts`
- Full browser output: `scratchpad/lms-store-browser-run.txt`. Result: 11/25 checks pass. The passes are fact checks and correct-today behaviour; the 14 FAILs are the defects.

---

## #5: OPFS pool install "should retry on lock conflicts"

**Problem verdict: PARTIAL.** Silent loss of durable data is real, but the mechanism the report gives is wrong.

### Established facts

**SAH pool behaviour (LMS-5a)**
- A second context installing `kora-opfs` while another holds it fails at once with `NoModificationAllowedError: Access Handles cannot be created if there is another open Access Handle…`.
- Once the holder worker is terminated, a re-install in a new worker succeeds after about 90 ms (first try).
- Default `initialCapacity` is 6 (verified).

**Same-dbName tabs are already handled (LMS-5d/5e/5g, all PASS)**
- A second tab with the same dbName becomes a follower and never installs the pool.
- Follower promotion keeps all data, whether the leader leaves via `adapter.close()` (5d, stable over 4 repeats) or its tab is closed (5e).
- Ten consecutive same-tab reloads all reopened OPFS (5g).
- So the report's scenario of "user opens a second tab" does not trigger this in Kora.

**The real trigger: lock is per dbName, pool is per origin.** The leader lock is `kora-leader-${dbName}` (tab-storage.ts:99). The pool name `'kora-opfs'` is shared by the whole origin (sqlite-wasm-worker-core.ts:45). Two different dbNames on one origin therefore each elect their own leader, and both try to install the pool. This happens with:
- Kora's own `store.namespaceByAuthUser` (`base__user_<id>`): two users in two tabs on a shared device.
- Two Kora apps or stores on the same origin.

**LMS-5b (direct SqliteWasmAdapter): FAIL**
- The second tab's `bob` store opens as `{persistent:false, mode:'memory', fallbackReason:'lock-conflict'}` and emits only the diagnostic `store:opfs-unavailable`.
- Bob's write is gone after reopen (`titles=[]`).

**LMS-5c (what `createApp()` does: falls back to IndexedDbAdapter): FAIL ×2**
- The fallback is durable, but it is a separate dataset from the OPFS one.
- Session 2 (IndexedDB) sees `[]` instead of the session-1 OPFS rows.
- Session 3 (OPFS again) sees only `["opfs-row-session-1"]`, so the session-2 write is invisible.
- `createApp` uses OPFS whenever it can, so writes made during the fallback session are orphaned. The user experiences this as data loss.

**LMS-5f: FAIL ×2, new finding, silent.**
- `promoteToLeader()` (sqlite-wasm-adapter.ts:258-281) reopens without checking `persistent` and never calls `reportStorageMode`.
- If the pool can't be obtained at promotion time, the promoted tab runs in memory with no event (events only `store:db-name-collision`).
- It shows `["after-promotion"]` without the pre-promotion row, accepts writes, and loses them: reopen shows `["before-promotion"]` only.

**Secondary findings**
- `close()` releases the leader lock before `bridge.terminate()` (sqlite-wasm-adapter.ts:239-245). That is the wrong order, because the old worker still holds the SAH handles. I did not reproduce a failure on desktop (5d stable), so this is a latent race on slower devices.
- **Service-worker claim refuted.** `createSyncAccessHandle` is only available in dedicated workers, so a service worker cannot hold SAH pool handles.

### Proposed fix verdict: REJECT

1. **The retry is a no-op (LMS-5h, FAIL).**
   - sqlite-wasm caches the rejected init promise per VFS name.
   - Calling `installOpfsSAHPoolVfs` again in the same worker without `forceReinitIfPreviouslyFailed:true` rethrows the cached `NoModificationAllowedError`, even 2 s after the holder is gone.
   - With `forceReinitIfPreviouslyFailed:true` the retry succeeds (PASS).
2. **Even if fixed, it targets the wrong cause.**
   - When the contention is from another live leader (5b), the holder never goes away, so retrying 3×2 s only adds up to 6 s (plus up to 10 s timeouts) to startup and then still falls back.
   - Blind fixed-delay retry is not state of the art; acquiring a lock and waiting for it is.
3. **Raising capacity to 32 is unrelated to lock conflicts.** It is harmless and belongs under #6.
4. **It keeps the silent memory fallback.**

### Recommended design

1. **Make pool ownership match the lock.** Either option works:
   - (a) Per-database pool: `kora-opfs:<dbName>`, its own directory. Same-dbName contention is then fully covered by the existing leader election. Existing `kora-opfs` files need a one-time move via `pool.exportFile` and `importDb` under a lock.
   - (b) One leader per origin keyed by pool name, hosting every dbName in its worker. The core already caches the pool and supports multiple files. Followers send `dbName` with each RPC.
   - Option (a) is simpler and isolates apps from each other.
2. **Hold a Web Lock for the whole life of the pool.** Acquire `navigator.locks` `kora-opfs-pool:<name>` inside the worker (available in workers) before install, and hold it until `pauseVfs()` or termination.
   - Waiting on a lock replaces retry-by-timer.
   - Keep a short bounded retry with `forceReinitIfPreviouslyFailed:true` (about 50 ms to 1 s, total ≤5 s) only for the residual window while a terminating worker releases its handles (measured at about 90 ms).
3. **Shut down in the right order.** Call `pool.pauseVfs()` (exists in 3.51, releases the handles) or terminate the worker before releasing the leader lock.
4. **Fail closed. Never silently degrade.**
   - Make storage mode part of the open contract.
   - `promoteToLeader` must check `persistent` and report it.
   - Contention is temporary: wait for the lock, show a "waiting for other tab" state, and emit a typed blocking event or error. Don't switch backends.
   - Only "unsupported" may select IndexedDB. Record that choice per origin so later sessions don't switch backends and split the data. Any backend switch must migrate data, never start an empty or disjoint store.

**Severity:** P0 (silent loss of unsynced writes: 5b, 5f; split-brain dataset: 5c).
**Effort:** M to L, about 3–5 days including the migration of pool names and tests.

---

## #6: Auto-evict stale OPFS files when the SAH pool is full

**Problem verdict: PARTIAL.**
- `kora-db-gN` generations: **NOT-FRAMEWORK.** No generation or rotation naming exists in `packages/*/src` or `kora/src`, so this is the LMS app's own scheme.
- Pool exhaustion through Kora's own API: **CONFIRMED, and worse than reported.**

### Evidence

**Slot usage (raw probe)**
- Each database uses 1 slot at rest, plus 1 transient slot for its `-journal` file during every write transaction (`files` shows `/u1.db-journal` mid-transaction).
- `PRAGMA journal_mode = WAL` returns `delete` on opfs-sahpool. Kora's WAL pragma (worker-core:187) is silently ignored (P3, and the docs claim WAL).

**LMS-6a (SqliteWasmAdapter, per-user dbNames like `namespaceByAuthUser`)**
- Users 1–5 work.
- User 6's open creates its file, then fails during DDL with `SQLITE_CANTOPEN: unable to open database file` (journal slot unavailable).
- After that, **existing user 1 can no longer commit any write** (`SQLITE_CANTOPEN`). The whole origin is bricked, for all users.
- `createApp` turns the open failure into a failed app init, with no fallback.

**LMS-6c (FAIL)**
- A failed `SqliteWasmAdapter.open()` does not terminate its worker or release its leader lock. The pool stays locked for the page's lifetime.
- `createApp` does not clean up when `store.open()` throws (initialize-app.ts:98).

**LMS-6b (FAIL ×2): the proposed fix**
- In 3.51 the thrown error is `SQLite3Error: SQLITE_CANTOPEN … unable to open database file`. "SAH pool is full" is only logged internally. The fix's `/SAH pool is full/i` regex never matches, so it is dead code against Kora's pinned version.
- With the matcher widened so it does fire, it unlinked `["/alice.db","/bob.db","/carol.db","/dave.db","/erin.db","/frank.db"]`. Those are six other live databases, each holding an unsynced row: silent loss of unsynced operations.
- It would equally delete:
  - another Kora app's database in the shared `'kora-opfs'` pool;
  - a database another tab is about to open;
  - a file currently open in the same worker. `pool.unlink` (`deletePath`) does not check for open handles.

### Proposed fix verdict: REJECT
It is dead code as written and destructive if made to work.

### Recommended design

1. **Prevent the pool from filling (this alone fixes #6).**
   - Before opening or creating a database, call `await pool.reserveMinimumCapacity(pool.getFileCount() + 2 + headroom)`.
   - Use `initialCapacity` of about 16 or more.
   - Slots are empty pre-allocated files, so this is cheap.
2. **Never evict automatically.**
   - Keep a Kora-owned manifest (a small file in the pool, or an IndexedDB record) of the files Kora created: dbName, created/last-opened time, unsynced-operation count.
   - Expose explicit APIs: `listLocalDatabases()` and `deleteLocalDatabase(name, {force})`.
   - Refuse deletion while unsynced operations exist unless `force` is set.
   - Run deletion only in the pool owner, under its lock, after closing the database.
3. **Namespace the pool per app or database** (shared with #5), so no app can ever see another's files.
4. **On open failure:** unlink only the file this open just created, and only if it is empty. Then terminate the worker and release the locks (fixes 6c).
5. **Surface quota and capacity errors as typed errors** (`StorageCapacityError`) with a recovery path, not a raw `SQLITE_CANTOPEN`.

**Severity:** P0 for `namespaceByAuthUser` or multi-app origins (permanent whole-origin write outage); P2 otherwise.
**Effort:** S for capacity reservation plus open-failure cleanup (about 1 day); M for the manifest and API (2–3 days).

---

## #7: Follower RPC liveness probe should repeat, not fire once

**Problem verdict: PARTIAL.**

### Code facts (tab-storage.ts:343-349)
- The probe is a single `setTimeout(livenessProbeMs = 2000)`, so it is one-shot. **Confirmed.**
- The RPC timeout is **30 s by default** (sqlite-wasm-adapter.ts:106; `FollowerBroadcastBridge` defaults to 30000), **not 120 s**. The report's 120 s must be the LMS app's `workerResponseTimeoutMs`.
- The pong comes from the leader's main thread, not its worker, so a pong does not prove the request is making progress.

### Evidence
- **LMS-7a (PASS): dead leader tab is already fast.**
  - When the leader tab closes, `navigator.locks` grants the lock to the follower. `promoteToLeader` then calls `previousBridge.terminate()`, which rejects the in-flight request.
  - Measured: the in-flight 6 s query was rejected with `Follower bridge terminated` **15 ms** after the leader tab closed. A retry after promotion succeeded.
  - The report's scenario ("leader dies just after the probe → app frozen for 2 minutes") is **refuted** for a leader that actually dies.
- **LMS-7b (FAIL ×2): leader alive but unresponsive.** The leader answers the 2 s probe; then at 3 s its main thread is stuck in a 40 s long task, standing in for a hung or frozen tab.
  - The in-flight request waited the full timeout: `WorkerTimeoutError` 26,990 ms after the hang.
  - A new write while the leader was still hung got `NoLeaderError` after 4,000 ms. The lock is still held, so there is **no failover** and the follower tab cannot write at all until the leader recovers.
  - The repeating probe would shorten the first wait. It does nothing for the second, which is the bigger user-facing problem (for example Android background tabs; the CDP `Page.setWebLifecycleState frozen` call did not freeze the relay in headless Chromium, so a real-device freeze test is still pending).
- **Node `LMS-7.test.ts` (FAIL as expected):** with a leader that hangs after one pong, the request settled at 4001 ms with `WorkerTimeoutError` instead of `NoLeaderError`. The control case (leader dead before the request → `NoLeaderError` at about 400 ms) passes.

### Proposed fix verdict: ACCEPT-WITH-CHANGES
It is a low-value improvement, and the snippet as written is incomplete:
- It does not show `settle()` clearing `probeInterval`. Unless it does, every request leaves an interval pinging forever, which turns into a ping storm.
- One interval per request is wasteful. Use one watchdog per bridge, active while `pending.size > 0`.
- Failing an in-flight **write** on a missed heartbeat is ambiguous: the leader may have committed it.
  - Requests need stable IDs with leader-side dedupe or a response cache.
  - Alternatively, write requests should be re-verified after recovery.
  - Kora operations are content-addressed, which helps for operation inserts but not for raw `execute` or transaction spans.

### Recommended design
1. **Leader-pushed heartbeat** on the BroadcastChannel (about 1 s while followers are registered), carrying `leaderEpoch` and progress for in-flight request IDs. The follower watchdog fails pending requests after N missed beats with a typed error (`LeaderUnresponsiveError`, distinct from `NoLeaderError`).
2. **`AbortSignal` support** on `send()` so callers and the reactive layer can cancel.
3. **Prevent the hung or frozen-leader case at the source** using the Page Lifecycle API:
   - On `freeze`/`pagehide` (and optionally `visibilitychange` hidden for longer than X s), the leader calls `pauseVfs()` or terminates its worker, then releases the lock. A visible follower is promoted.
   - On `resume`, it rejoins as a follower.
   - Do **not** use `navigator.locks` `steal`: the hung leader's worker would still hold the SAH handles.
4. **Keep promotion as the authoritative path for dead tabs** (already correct). Make `terminate()` reject with a typed retriable `KoraError` instead of a plain `Error`.

**Severity:** P2.
**Effort:** S for heartbeat, watchdog and typed errors (about 1 day); M for lifecycle handoff plus request-ID dedupe (2–3 days).

---

## Extra findings (outside the report)

| ID | Finding | Severity |
|----|---------|----------|
| E1 | `promoteToLeader` ignores `persistent:false`, so the promoted tab silently runs in memory (5f) | P0, part of #5 |
| E2 | A failed `open()` leaks the worker and leader lock, keeping the pool held for the page's lifetime (6c) | P1 |
| E3 | `PRAGMA journal_mode=WAL` is a silent no-op on opfs-sahpool (actual mode is `delete`); CLAUDE.md says WAL | P3 |
| E4 | `close()` releases the leader lock before terminating the worker that holds the pool. Latent handoff race, not reproduced on desktop | P2 |
| E5 | The IndexedDB fallback dataset is disjoint from OPFS, so the backend can switch per session (5c) | P0, part of #5 |
