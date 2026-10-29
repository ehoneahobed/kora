---
"@korajs/test": minor
---

New subpath `@korajs/test/playwright`: offline helpers for Playwright end-to-end tests, learned from koraforms. `goOffline`/`goOnline`, `firstVisitOffline`, `killTab` (CDP `Page.crash`, Chromium only), `openProfile`/`restartProfile` (relaunch the same persistent user data directory), `skewClock` (offsets `Date.now()`, `new Date()` and `Date()` only), `throttleNetwork` (CDP presets `slow-4g`, `fast-3g`, `slow-3g`, `2g`, `offline`, `none`), `blockServiceWorker`, `waitForOfflineStatus`/`readOfflineStatus`/`hasReason` (read `app.offline.status()` through a configurable accessor, default `app.offline`), and the offline-readiness contract as two helpers: `assertReadyMeansOffline` (when the status reads `ready`, reload offline and assert the shell, the data and a write that survives another reload) and `expectNeverReady` (records whether `ready` was ever observed while a negative scenario runs, in Node and in an in-page probe).

`playwright-core` is an optional peer dependency used for types only; nothing is imported from it at runtime, and the main `@korajs/test` entry does not load the new subpath.
