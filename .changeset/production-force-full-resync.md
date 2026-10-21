---
'@korajs/server': patch
---

`createProductionServer` now exposes `forceFullResync({ userId | nodeId })`, the same as `KoraSyncServer.forceFullResync`: apps built on the production server can repair devices (every device of a user, or one device) without reaching into the server store.
