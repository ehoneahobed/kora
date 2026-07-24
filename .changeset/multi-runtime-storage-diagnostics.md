---
"@korajs/core": patch
"@korajs/store": patch
"korajs": patch
---

Storage persistence failures are no longer silent. When OPFS is unavailable the
store falls back to a non-persistent in-memory database so the app keeps working,
but anything written that session is lost on reload — previously with no signal.
The SQLite WASM worker now classifies why OPFS could not be used (`lock-conflict`,
`timeout`, or `unsupported`) and the store emits a `store:opfs-unavailable` event,
so the condition is observable instead of a quiet data-loss trap. The most common
cause, `lock-conflict`, is two runtimes on one origin contending for the same
database.

A `store:db-name-collision` event now fires when a runtime attaches to a database
name another runtime on the same origin already owns. That is expected for
multiple tabs of the same app (they share one leader), and the exact clue a
developer needs when two logically separate apps accidentally share the default
store name and should each use a distinct one. Both events surface in DevTools and
via `app.events`. See the new "Multi-runtime storage and isolation" guide.
