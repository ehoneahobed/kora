---
"@korajs/core": minor
"@korajs/server": minor
"@korajs/spaces": minor
---

Access rules can require a real membership: `member(field, minRole, { grants: false })` and `memberOfKey(field, minRole, { grants: false })` hold only through a row of the memberships collection or ownership of the group record, never through a capability grant (`AuthContext.accessGrants`, such as a share link), whatever role the grant names. Evaluation, the compiled download scope and history gating all honor it, so a group reached only through a grant never enters such a rule's scope; a user holding both is judged on the membership's role. `defineSchema` refuses a non-boolean `grants` and leaves the default out of the resolved rule, so the read-rules key of existing schemas is unchanged (turning `grants` off changes it, and devices are re-scoped once). `MembershipView.roleOf` and `groupKeys` take an optional `{ grants: false }` for `custom()` checks; without it they count grants as before. On the server, grant-derived intervals now carry `source: 'grant'` (never stored, reconciled or reported by `roleOf`). `@korajs/spaces` declares `space_members` and `space_invitations` with `{ grants: false }`: a share-link holder receives the space's records, not its member list or its invitations (the read rules change, so each device of an app using the kit is re-scoped once after the upgrade).
