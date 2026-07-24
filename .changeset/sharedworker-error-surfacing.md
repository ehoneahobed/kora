---
"@korajs/store": patch
---

Surface SharedWorker inner-worker failures instead of hanging. When the inner
SQLite worker spawned by the SharedWorker host fails to load or throws at the top
level (for example the module script or the SQLite WASM binary cannot be fetched
in the nested worker context), the host now relays a `SHARED_WORKER_ERROR` (or
`SHARED_WORKER_SPAWN_FAILED` for a synchronous spawn failure) to every waiting
client and drops the pool so the next request respawns. Previously such a failure
left `open` (and therefore `app.ready`) hanging until the RPC timeout, with no
observable error.
