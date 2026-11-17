---
'@korajs/sync': patch
---

Closing the app while sync is still starting no longer produces an unhandled `StoreNotOpenError`. `app.close()` destroys the sync engine and then closes the store, so a `connect()` already in flight could fail on a read of the closed store. A start cancelled by `stop()` or `destroy()` now settles quietly, while any other failure still rejects.
