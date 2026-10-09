---
"@korajs/server": minor
"@korajs/core": patch
---

Experimental: the sync server can enforce access rules (`experimentalAccessRules: true` on the server, `{ accessRulesEnforced: true }` on `store.setSchema`). Uploads to access collections are decided by the rules against the writer's memberships read inside the store's write transaction, so a revoke refuses the next write at once; cascades and rich-text updates follow the same rules. A client insert onto an existing group id is refused (`GROUP_EXISTS`), stamped fields must be present and equal to the writer (`STAMP_REQUIRED`, `STAMP_MISMATCH`), and the memberships collection is server-written (`SERVER_OWNED`). A session's read grant over access collections is compiled from its memberships at handshake (a user always reads their own membership rows); it does not yet follow membership changes until the client reconnects. `server.access.grant`, `revoke`, `transfer` and `sweepExpired` change memberships with logged server writes, and a sweeper ends expired memberships (`accessSweepIntervalMs`). Clients that cannot follow access rules are refused with `CLIENT_TOO_OLD`.
