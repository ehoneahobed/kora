---
"@korajs/server": minor
"@korajs/core": patch
"korajs": patch
"@korajs/sync": minor
"@korajs/store": minor
---

With `experimentalAccessRules`, the download stream follows membership changes. When a session's stream reaches a change to the user's memberships, it re-reads them and sends what changed as one re-scope unit at that delivery sequence, starting a batch: a narrowing (the grant now in force per access collection, new `accessNarrowing` batch field) that the client applies to the records it holds, judged on its own values and keeping records with unsent writes, then scope entries (current values) for records the user may now read, filtered by the client's query view. Narrowing on the client removes records that moved or were deleted while the user was revoked, which the server cannot name. A group revoked and granted again, or a membership whose role changed in place since the client's watermark (tracked by a new `role_seq` index column, added to existing databases on open), is re-sent in full. History is gated by the open membership interval: a late joiner receives a group's current state, never the operations written before they joined, on a live session, a reconnect and a fresh device alike. What a reconnecting client holds is rebuilt from the membership intervals at its watermark, so a reconnect after changes made while offline resumes from the watermark. Access collections are reported to clients as unrestricted, so a client's view and its watermark stay the same across membership changes; the server alone enforces the grant. Records leaving an access collection's grant are always retracted. The delivery poll refreshes each session's memberships, so rich-text, presence and blob channels follow a change within one poll interval even when a client's stream is not progressing. `server.access.grant` no longer writes `expiresAt` when the memberships collection does not declare it.

Rule types (`OwnerRule`, `MemberRule`, `OrRule`, ...) are exported from `@korajs/core` and `korajs`, so a schema module with declaration emit can export a schema that uses access rules.

`@korajs/sync` applies a batch's `accessNarrowing` before its retractions and operations (`SyncStore.applyCollectionNarrowing`, implemented by `@korajs/store`); a failure stalls the delivery watermark so the batch is re-sent.
