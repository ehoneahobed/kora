---
'@korajs/core': patch
'@korajs/server': patch
'@korajs/auth': patch
'@korajs/store': patch
---

Smaller fixes from the beta.13 rollout:

- `defineSchema` refuses a unique or capacity constraint whose `where` holds an operator object,
  an array, or an unknown field: none could ever match, so the constraint was silently disabled
  (F2).
- `PostgresUserStore.close()` ends the connections of a store made by `createPostgresUserStore`,
  so scripts exit (F11).
- `/health` and `getStatus()` report the real `@korajs/server` version instead of
  `1.0.0-beta.0` (F13).
- A `sqlite3.wasm` download or compile failure fails the store open within seconds with a
  `WorkerInitError` naming the binary, instead of waiting out the 60-second init timeout, and a
  failed SQLite load is not cached, so the next open tries again (F15).
- `undefined` inside a `t.json()` value is written the way JSON writes it (a member is absent, an
  array element is `null`), as the server already stored it, instead of failing the write on the
  device (F12a).
