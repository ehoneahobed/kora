---
'@korajs/server': patch
'@korajs/cli': patch
---

Desktop apps can sign in to a remote sync server. A Tauri WebView loads pages from `tauri://localhost` (or `http(s)://tauri.localhost`), so its calls to the server's auth routes are cross-origin, and the server answered no preflight: sign-in failed with a network error. `createProductionServer` now allows native app shell origins, the comma-separated `KORA_ALLOWED_ORIGINS`, an `allowedOrigins` option and, outside production, `http://localhost` on any port, for `httpRoutes` and `/health`, never with credentials. `kora doctor` no longer asks a Tauri app for the SQLite WASM worker.
