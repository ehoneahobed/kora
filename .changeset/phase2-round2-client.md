---
"@korajs/sync": patch
"@korajs/store": patch
"@korajs/core": patch
"korajs": patch
"@korajs/devtools": patch
---

Phase 2 round 2 client fixes (RT-42, RT-44, RT-45 client half, RT-46, RT-49):

- Local writes are bound to the signed-in user (`sync.authClient`): the store moves to that user's
  node before the next write, and a node of another user is never uploaded or adopted on this
  user's session (`heldOperations`). New `SyncConfig.principal`, `SyncEngine.refreshPrincipal()`,
  `Store.bindPrincipal()`.
- Per-tab adoption takes turns: a node the server keeps deferring is parked
  (`sync:local-node` `adoption-parked`), causal parents on another local node upload first, and the
  open tab's own writes are never blocked behind an adopted node.
- A cloned database (one node id on two live devices) is detected from a `SEQUENCE_CONFLICT` above
  the session's handshake entry and moves to a fresh node id (`clone-detected`); recovery full
  resyncs are rate-limited.
- An absent own entry in the handshake vector means the server holds none of the node's operations
  (`server-behind`): the device re-uploads them.
- A persistently failing durability barrier no longer stops uploads: after 3 failures the engine
  uploads anyway (`localDurability: 'degraded'`, `sync:durability-degraded`).
