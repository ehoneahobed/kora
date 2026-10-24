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
(`DEVICE_OWNERSHIP_CONFLICT`). The persistent device identity now holds one device id per account
that signed in on the device (and one unused id), storing nothing about the accounts; every
sign-in, sign-up and OAuth callback offers them all (`deviceCandidates`) and the auth server picks
the one registered to the account, else an unregistered one (sign-up checks before creating the
account; an MFA sign-in registers it only after the second factor; when every candidate is refused
the browser replaces its unused id and retries once). A namespaced database whose pinned node moved retires the previous node, asks the server
by id which of its own writes it stores (`probeOperationIds` / `operationProbe` in the handshake),
and re-authors the rest under its own node (`sync:operations-rewritten`, reason `node-rotation`;
`sync:local-node` action `retired-repaired`), never an operation it received under that node, and
not while a tab still has the node open. The device's registered owner keeps the old node, and the
server hands it over as before.
