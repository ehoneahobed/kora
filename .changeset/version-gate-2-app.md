---
"korajs": patch
"@korajs/core": patch
"@korajs/store": patch
"@korajs/devtools": patch
---

Version gate, stage 2: the app API. `createApp({ build })` names the deployment (otherwise the build id the `@korajs/cli/vite` plugins inject, read from `globalThis.__KORA_BUILD__` or `<meta name="kora-build">`; never the package version). In a browser, createApp creates the database's version gate and:

- announces supersession with `app:build-superseded` (`{ currentBuild, newerBuild, preventDefault() }`) before any write is refused, then shows "A new version of this app is available. Reload to continue." with a Reload button, unless a listener called `preventDefault()`, the app set `store.onBuildSuperseded`, `store.buildPrompt` is false, or the app handles the offline shell's `kora:update-available` event (reused for this prompt);
- shows "Your latest changes are not saved yet. Retry, or Export them." with Retry and Export (a JSON download of the in-memory database) while a failed IndexedDB barrier holds retirement, naming the reason when it is known (`QUOTA_EXCEEDED`: storage is full; `STORAGE_UNAVAILABLE`: no storage worker left), and waiting / other-tab messages in a tab whose gate is closed; from the moment retirement starts, `app.close()` saves every admitted write first and is refused (`PersistenceError`, `context.code: 'UNSAVED_WRITES'`) before anything is torn down when that fails;
- stops sync as a retirement step (inbound operations refused meanwhile stall without a `sync:apply-blocked` report); `app.sync.connect()` and `reconnect()` then refuse with `BuildSupersededError`, and no automatic reconnect starts. Queued operations stay in the outbound queue and the new build uploads them;
- refuses blob writes (`app.blobs.put`, `delete`, `pull`, `gc`, and `put` / `delete` on `app.blobs.store`) like every other write.

New: `app.reloadForNewBuild()` (emits `app:before-build-reload` synchronously; under the offline shell it checks for (within 10 s) and activates the newer build's waiting service worker, `KORA_SW_SKIP_WAITING`, and reloads on `controllerchange`, so the reload never brings the old build back; otherwise a plain reload), `store.onBuildSuperseded`, `store.buildPrompt`, `store.allowUncoordinatedTabs`, exports `BuildSupersededError`, `StorageFormatAheadError`, `TabCoordinationUnavailableError`. `BUILD_SUPERSEDED` is a local refusal: it is a mutation's `error`, never its server `rejected` state. A storage format or schema ahead, a superseded tab and missing Web Locks are never answered with an in-memory database. On plain HTTP (not HTTPS, not localhost) the gate is off, as before it, with one console warning.
