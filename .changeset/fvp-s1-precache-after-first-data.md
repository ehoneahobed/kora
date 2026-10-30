---
"@korajs/cli": patch
"korajs": patch
---

First-visit parity, stage S1: the offline shell's precache no longer competes with the app's first data, and no longer downloads the app a second time.

- `koraServiceWorker()`: on a first visit (a page no service worker controls yet) the worker is registered, and the shell precached, only after the app's first data (the new `kora:first-data` event), at most `firstDataTimeoutMs` (new option, default 10 s) after `load`, then at an idle moment. A page a worker already controls registers at `load`, as before.
- The install takes each file from the HTTP cache first (`only-if-cached`, then `cache: 'default'`), keeping it only when its SHA-256 equals the build's digest, and falls back to `cache: 'reload'` as before. Byte-identical files (the unhashed `sqlite3.wasm` copy of the hashed WASM) are downloaded once and stored under every URL; previously both were precached and downloaded, because Vite's hash `1f8bVu-G` contains `-` and was not recognised as one. On the default template's cold first load this takes the requests that reach the server from 26 to 17 and the body bytes from 1.53 MB to 0.81 MB: the main bundle and the WASM are each downloaded once.
- `korajs`: `createApp` publishes `globalThis.__KORA_FIRST_DATA__` (`pending`, then `done`) and dispatches `kora:first-data` once the first data is in: at `app.ready` for a local-only app; for a syncing app when the first delivery batch is applied, the session is caught up, or sync stops until someone acts (signed out, locked, blocked) or an attempt ends offline.
