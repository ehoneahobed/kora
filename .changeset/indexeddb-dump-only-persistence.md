---
"@korajs/store": patch
---

Fix IndexedDB fallback persistence when the browser worker cannot export a binary SQLite image.

The IndexedDB adapter now persists the logical dump first and treats the binary SQLite
snapshot as an optional optimization. When the worker reports `EXPORT_NOT_SUPPORTED`, the
dump is the durable fallback and any stale binary snapshot is removed so it cannot shadow the
newer dump on restore. Opening a database now rehydrates from the logical dump when no binary
snapshot exists (previously it returned early and a dump-only database could not restore), and
export-error detection keys off structured `AdapterError` context rather than message matching.

This makes the durable IndexedDB fallback shipped in the previous release actually round-trip
in browsers and profiles where OPFS and binary SQLite export are unavailable, so no operation
is lost and no blocking `store:persistence-error` is emitted when the logical dump succeeds.
