---
"@korajs/server": minor
---

Access rules are no longer behind a flag: a schema that declares `access` is enforced by the sync server, and the built-in stores install it with no option. `experimentalAccessRules` (server) and `accessRulesEnforced` (`store.setSchema`) are deprecated and have no effect; the server option logs a warning. A store without a membership index (a custom store lacking `getMembershipIntervals` or `getAccessIndexState`) is refused for an access schema (`ACCESS_RULES_UNSUPPORTED_STORE`) instead of serving it unchecked, and a session that began streaming before the schema declared rules is closed (`ACCESS_RULES_CHANGED`) and reconnects under them.

A backup restore now starts a new membership index generation, bound into the rules key the server announces, so every device is re-scoped in full at its next handshake. Before, a device that was away during a revoke kept the group's records after a restore, and a device granted while away could miss the records created before its watermark.
