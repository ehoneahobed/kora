---
'@korajs/core': patch
'@korajs/store': patch
'korajs': patch
---

A returning visit opens the local database faster (first-visit parity, warm navigation).

- The quick operation-log integrity check runs until a scan has repaired or confirmed the log once (`log_integrity_trusted`); later opens skip it. The full scan (`kora doctor`, repairs) is unchanged.
- The SQLite WASM worker skips the schema DDL when the database already ran this exact DDL (`_kora_ddl_state`). A migration clears the fingerprint first, so the next open re-applies everything.
- The one-time constraint relaxation (RT-101) runs until it has completed once (`value_domain_relaxed`), and again after any migration.
- `createApp` starts the SQLite worker as the runtime chunk loads, so the WASM download and compile overlap the version gate and the tab election. A follower tab, a refused open or an unclaimed worker (after 60 s) stops it.
- The fixed offline statuses are exported from `@korajs/core/lite`, so the first paint no longer carries `computeOfflineState` (about 1.9 KiB gzip off the critical path).
