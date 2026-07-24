---
"@korajs/store": minor
---

Fix the SharedWorker storage path, which previously hung forever on `open` (so
`app.ready` never resolved).

Two real bugs plus a browser limitation, all found by reproducing in headless
Chromium:

- The host tried to spawn a nested dedicated `Worker` inside the SharedWorker, but
  `Worker` is not defined in `SharedWorkerGlobalScope` in Chromium. The SQLite
  logic is now extracted into a reusable core (`createSqliteWasmCore`) that the
  SharedWorker host runs directly in its own scope, one core per `dbName`. The
  dedicated worker uses the same core. This also removes the inner-id correlation
  bookkeeping, since each request is answered by a Promise from the core.
- The client created `new SharedWorker(url, { name })` without `{ type: 'module' }`.
  The host is an ES module, so a classic SharedWorker could not parse it and failed
  silently. It is now created as a module worker.

Browser limitation surfaced by this work: OPFS `createSyncAccessHandle` is not
available in a SharedWorker in Chromium, so the SharedWorker path cannot persist to
OPFS there. It runs in memory and emits `store:opfs-unavailable`, and the
dedicated-worker leader/follower path remains the persistent multi-tab default.
Applications that need offline persistence should use the leader/follower path, not
the SharedWorker path, on Chromium.

The SharedWorker host entry must set `__KORA_SQLITE_WASM_URL` (via a `?url` import
of the sqlite wasm binary) the same way the dedicated worker entry does, so the
core can locate the hashed WASM asset in production builds.
