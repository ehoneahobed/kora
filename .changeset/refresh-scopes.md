---
'@korajs/server': patch
---

Add `refreshScopes(userId)` to `KoraSyncServer` and the `ProductionServer` handle, and expose
`revalidateSessions()` on `ProductionServer`. After a membership change, an app re-resolves the
user's grant at once instead of waiting for the 30-second revalidation: sessions whose scope
changed end with a retriable `SCOPE_CHANGED`, reconnect with the new grant and apply their
`scopeExit` policy. A session still in its handshake re-checks once established.
