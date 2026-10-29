---
"@korajs/core": minor
"@korajs/auth": minor
"korajs": minor
"@korajs/test": minor
---

Offline readiness knows whether the signed-in session survives an offline reload (A3). `AuthSyncBinding` gains `resolveOfflineRestore()`, which `createKoraAuthSync` implements from the stored tokens: restorable only with both tokens stored, on storage that survives a reload, with a refresh token that has not expired and an offline grace (`maxOfflineGraceMs`, measured from the stored refresh token's issue time) that has not run out. A wall clock set back reports `clock-rollback`, and a 30 second watchdog re-checks while the session is restorable. `AuthTokenStorage` gains an optional `durability` (`durable`, `session`, `memory`): the default `localStorage` store is durable, `createMemoryAuthTokenStorage` and `sessionStorage` are not, and a custom store that does not say is `unknown`, so `app.offline` is never `ready` on an assumption. `createAuthTokenStorage({ store, durability })` declares it.

`createApp({ offline: { auth } })` declares restorability for apps with their own sign-in (a bare `sync.auth` token function cannot know). `app.offline.status().auth` is now `restorable`, `not-restorable`, `unknown`, `loading` or `n/a`, and `ready` flips off when the session's limit passes.
