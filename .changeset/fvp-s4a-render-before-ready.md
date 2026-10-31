---
"korajs": patch
"@korajs/react": patch
"@korajs/vue": patch
"@korajs/svelte": patch
"@korajs/core": patch
"@korajs/store": patch
"@korajs/sync": patch
"@korajs/auth": patch
"@korajs/cli": patch
---

First-visit parity, stage S4a: `KoraProvider` (React, Vue, Svelte) renders its children before `app.ready`, and the SQLite WASM and the store runtime load after the first paint. New `waitForStorage` prop restores the old gate (the provider renders `fallback` until the store is open). Until the store opens, `useQuery` and its siblings return empty values (`useQueryState().ready` is `false`) and `app.<collection>.where(...)` returns a deferred query with the same descriptor and `queryKey` as the real one. Writes made through `useMutation` before the store opens are queued, saved to a small IndexedDB journal first, and applied in order once the store opens; a tab closed in between does not lose them, and the next visit applies what is left (per user, with Web Locks so two tabs never apply an entry twice). A direct `await app.todos.insert(...)` before `app.ready` still throws `AppNotReadyError`; writes that use atomic helpers wait in memory only and are not journaled. `await app.ready` keeps its meaning, and a connection requested with `autoConnect` or `app.sync.connect()` now starts in parallel with the store open.

`korajs`'s `createApp` is a small shell that loads the runtime with a dynamic import after the first paint (or at once outside a browser). New `lite` entries (`@korajs/core/lite`, `@korajs/store/lite`, `@korajs/sync/lite`) hold the few modules the first paint needs so bundlers do not pull the runtime in with them; the packages declare `"sideEffects": false`. The templates drop the startup `fallback`, call `app.sync?.connect()` without waiting for `ready`, and show their empty state only once `useQueryState().ready`; the offline-shell registration script is minified. `KoraAppLike` gains an optional `collections`, and `SyncTransport` an optional `warmUp(url)`.
