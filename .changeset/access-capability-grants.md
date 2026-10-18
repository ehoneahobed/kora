---
"@korajs/server": minor
"@korajs/core": patch
---

Capability grants: an auth provider can return `accessGrants` on a session's `AuthContext` (a share link, a signed URL), each a role in a group held without a membership. Under access rules every rule that admits members of the group admits the session, anonymous sessions included, for reads, writes, rich text, presence and blobs. Grants the schema cannot honor (not a group collection, an unknown role, a missing or deleted group, an expired grant) give nothing; `roleOf`, `server.access` and `@korajs/spaces` never see them; a change of grants ends the session at its next credential check and re-scopes the device in full. Membership rules (`member`, `memberOfKey`) now evaluate the memberships resolved for the principal even when it is anonymous (empty unless the server granted capabilities).
