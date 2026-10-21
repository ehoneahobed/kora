---
"@korajs/cli": patch
"korajs": patch
---

Version gate, stage 3: a build id for every Vite build. `koraServiceWorker()` now stamps `<meta name="kora-build" content="<id>">` into built pages (opt out with `buildId: false`), and the new standalone `koraBuildId()` plugin (from `@korajs/cli/vite`) does the same for apps without the offline shell. The id is a hash of every deployed file once the build is written (chunks, HTML pages with the id itself normalized, files copied from `publicDir`, files other plugins wrote), except the generated `sw.js`; each file is hashed separately and combined with length-prefixed paths. In `vite dev` it is `dev-<server start>`. `createApp()` reads it when no `build` option is given (an unstamped placeholder is ignored), so tabs of two deployments never write the local database at the same time, including deployments that change only application code. Every web template already uses `koraServiceWorker()`; Tauri templates need none (native SQLite is not gated).
