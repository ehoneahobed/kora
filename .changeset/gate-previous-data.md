---
"@korajs/server": patch
---

The sync server's last outbound gate now covers updates, not only deletes. In an access-rules collection, an update that moves a record into a member's group no longer delivers the old group's content as `previousData` (to a connected device, to one that joins later, in a live relay or in a version-vector delta). An update's `previousData` is kept whole when the record's values before the update (the server's own snapshot, never the writer's claim) are admitted for the recipient at the update's delivery sequence, which is every update that does not move a record in. Otherwise every entry that differs from the new value is cut (the copy keeps the id and declares no hash version, like a redacted delete). The fold reads the writer's base for arrays, objects, counters and custom resolvers, so cutting those would make a replica fold differently; a record entering the recipient's scope already arrives whole before the update that moved it (a scope entry carrying the folded state), so such an update is withheld instead of cut. Without a scope entry the base is cut anyway: confidentiality first.

An uploaded delete may carry no payload: a delete with `data`, `previousData` or `atomicOps` is refused (`INVALID_DELETE_PAYLOAD`) and never stored or relayed. `fieldVersions` and `foldState` (unhashed, server-authored metadata) are stripped from every uploaded operation on arrival, so a delete carrying only those is accepted without them. Real client deletes (`data` and `previousData` null, with their `mutationName` and `transactionId`) are unchanged.

Known gap, not changed here: the folded state a scope entry carries keeps array elements removed before the record entered the scope (and a counter's base).
