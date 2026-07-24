---
"@korajs/store": minor
"korajs": patch
---

Retire SharedWorker-hosted SQLite as a durable storage path. OPFS
SyncAccessHandle is dedicated-worker-only in browsers, so a SharedWorker-hosted
SQLite core cannot obtain durable OPFS storage. Kora now uses the
dedicated-worker leader/follower path as the single durable multi-tab SQLite WASM
path, with Web Locks leader election, BroadcastChannel follower RPC, and
automatic promotion when the leader tab closes.

The `sharedWorkerUrl` option is deprecated and ignored for storage selection. If
it is still provided, Kora logs a one-time warning and transparently uses the
durable dedicated-worker leader/follower path. No application code change is
required for durability; remove `sharedWorkerUrl` when convenient.

When OPFS SyncAccessHandle cannot be acquired, `createApp()` now falls back to
the durable IndexedDB adapter instead of allowing the app to continue on an
in-memory SQLite database. Kora emits `store:storage-fallback` for this recovered
state. `store:opfs-unavailable` is now reserved for the true last-resort case
where both OPFS and IndexedDB are unavailable and the store is running in memory,
so a data-loss condition remains observable rather than silent.

The dedicated-worker leader/follower path also keeps already-open same-origin
tabs reactive. Kora broadcasts committed local operations per database name and
invalidates matching queries in sibling tabs without reapplying the operation.
Worker access is serialized at the leader boundary across whole transaction
spans, so concurrent writes from the leader and followers cannot interleave
between `begin` and `commit`. If a follower disappears while it owns a
transaction span, the leader reclaims it with a real rollback against the SQLite
worker before resuming other clients; followers also send a best-effort leave
message on page unload for faster cleanup. The idle backstop defaults to 10s,
which bounds crash-case unavailability while leaving normal programmatic
transactions ample time to finish.
