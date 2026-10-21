---
'@korajs/auth': patch
'@korajs/store': patch
'@korajs/sync': patch
'@korajs/server': patch
'@korajs/core': patch
'korajs': patch
---

Shared browsers: each account gets a device id, and so a sync node, of its own. beta.12 gave every
account on a browser the same device id, so with `store.namespaceByAuthUser` two users' databases
authored under one node; later servers refused every account but the device's first
(`DEVICE_OWNERSHIP_CONFLICT`). The persistent device identity now remembers which account uses
which device id, and a sign-in or sign-up refused for another account's id retries once with a
fresh one (sign-up checks the device id before creating the account). A namespaced database whose
pinned node moved retires the previous node, asks the server by id which of its writes it stores
(`probeOperationIds` / `operationProbe` in the handshake), and re-authors the rest under its own
node (`sync:operations-rewritten`, reason `node-rotation`; `sync:local-node` action
`retired-repaired`). The device's registered owner keeps the old node, and the server hands it over
as before.
