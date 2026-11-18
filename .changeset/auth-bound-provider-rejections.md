---
'@korajs/react': patch
---

`AuthBoundKoraProvider` no longer leaves rejections unhandled. A `resolveSyncState()` that rejects after a failed open, and a `close()` that rejects on unmount, are now logged with `console.error`. An initialization error that can't be shown, because the session ended meanwhile, is logged too instead of being dropped silently.
