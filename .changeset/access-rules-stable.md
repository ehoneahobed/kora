---
"@korajs/server": minor
"@korajs/spaces": patch
---

Access rules are no longer behind a flag: a schema that declares `access` is enforced by the sync server, and the built-in stores install it with no option. `experimentalAccessRules` (server) and `accessRulesEnforced` (`store.setSchema`) are deprecated and have no effect; the server option logs a warning. A store without a membership index (a custom store lacking `getMembershipIntervals` or `getAccessIndexState`) is refused for an access schema (`ACCESS_RULES_UNSUPPORTED_STORE`) instead of serving it unchecked, and a session for which the rules are not in force (it started before the schema declared them, or the store is rebuilding its membership index) is refused retriably (`ACCESS_RULES_CHANGED`) on every path (messages, relays, deliveries, Yjs, presence, blobs) and reconnects under them; a write it had in flight is not refused for good.

A replace-mode backup restore (and any rebuild that opens memberships at sequence 0, such as a newly indexed group collection) now starts a new membership index generation, bound into the rules key the server announces, so every device is re-scoped in full at its next handshake. Before, a device that was away during a revoke kept the group's records after a restore, and a device granted while away could miss the records created before its watermark.

`server.access.roleOf` and `tx.roleOf` return `proof`, the value to store as evidence that a role held (`since` repeats across restores). `@korajs/spaces` records it on invitations, so an invitation pending at an index rebuild stops working. Server stores may implement `isAccessIndexReady()`; the built-in ones do.
