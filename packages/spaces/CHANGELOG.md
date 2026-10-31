# @korajs/spaces

## 1.0.0-beta.15

### Minor Changes

- 8411be3: Access rules can require a real membership: `member(field, minRole, { grants: false })` and `memberOfKey(field, minRole, { grants: false })` hold only through a row of the memberships collection or ownership of the group record, never through a capability grant (`AuthContext.accessGrants`, such as a share link), whatever role the grant names. Evaluation, the compiled download scope and history gating all honor it, so a group reached only through a grant never enters such a rule's scope; a user holding both is judged on the membership's role. `defineSchema` refuses a non-boolean `grants` and leaves the default out of the resolved rule, so the read-rules key of existing schemas is unchanged (turning `grants` off changes it, and devices are re-scoped once). `MembershipView.roleOf` and `groupKeys` take an optional `{ grants: false }` for `custom()` checks; without it they count grants as before. On the server, grant-derived intervals now carry `source: 'grant'` (never stored, reconciled or reported by `roleOf`). `@korajs/spaces` declares `space_members` and `space_invitations` with `{ grants: false }`: a share-link holder receives the space's records, not its member list or its invitations (the read rules change, so each device of an app using the kit is re-scoped once after the upgrade).

### Patch Changes

- 34b477d: Access rules are no longer behind a flag: a schema that declares `access` is enforced by the sync server, and the built-in stores install it with no option. `experimentalAccessRules` (server) and `accessRulesEnforced` (`store.setSchema`) are deprecated and have no effect; the server option logs a warning. A store without a membership index (a custom store lacking `getMembershipIntervals` or `getAccessIndexState`) is refused for an access schema (`ACCESS_RULES_UNSUPPORTED_STORE`) instead of serving it unchecked, and a session for which the rules are not in force (it started before the schema declared them, or the store is rebuilding its membership index) is refused retriably (`ACCESS_RULES_CHANGED`) on every path (messages, relays, deliveries, Yjs, presence, blobs) and reconnects under them; a write it had in flight is not refused for good.

  A replace-mode backup restore (and any rebuild that opens memberships at sequence 0, such as a newly indexed group collection) now starts a new membership index generation, bound into the rules key the server announces, so every device is re-scoped in full at its next handshake. Before, a device that was away during a revoke kept the group's records after a restore, and a device granted while away could miss the records created before its watermark.

  `server.access.roleOf` and `tx.roleOf` return `proof`, the value to store as evidence that a role held (`since` repeats across restores). `@korajs/spaces` records it on invitations, so an invitation pending at an index rebuild stops working. Server stores may implement `isAccessIndexReady()` and `accessIndexGeneration()` (the built-in ones do): sessions are refused while any instance rebuilds the index (a schema install, a transform change or a restore; the rebuilds are counted, a failure part-way keeps access rules out of force until one succeeds, and `roleOf` throws a retriable `ACCESS_INDEX_NOT_READY` meanwhile), and sessions compiled before a rebuild are ended (at their next message, or by `server.revalidateAccessSessions()`, which runs on every delivery poll and after `/__kora/backup/import`).

- a1261fa: New package: `@korajs/spaces`, sharing on top of access rules (experimental, with `experimentalAccessRules`). `spacesCollections({ roles, ownerRole, manageRole, groups })` adds the access configuration and three collections (members, pending invitations, server-only invitation secrets); `spacesRoutes` serves invite, re-send, revoke, describe, accept, decline, change role, remove, leave and transfer, each one `kora.transaction`; `transferSpace` is the operator's transfer; `koraAuthIdentity` identifies callers with `@korajs/auth`; `createSpaces` is the client (`accept` resolves once the device holds the membership); `useMembers`, `useInvitations` and `useMyRole` read the local store. Invitation tokens are stored as hashes, bound to the verified invited address, and stop working when re-sent or when the inviter's role or the space's owner changes. Invitation limits (pending per space, per inviter and address, per inviter, requests per user) are on by default. Guide: `docs/guide/sharing.md`.
- Updated dependencies [24f5531]
- Updated dependencies [6c72c04]
- Updated dependencies [4ddcff5]
- Updated dependencies [6fd998a]
- Updated dependencies [946dd42]
- Updated dependencies [8667762]
- Updated dependencies [5a2e9df]
- Updated dependencies [962db5d]
- Updated dependencies [003d7bf]
- Updated dependencies [2a267d4]
- Updated dependencies [0b461fa]
- Updated dependencies [047b788]
- Updated dependencies [8411be3]
- Updated dependencies [34b477d]
- Updated dependencies [a5c61ff]
- Updated dependencies [28ec1ef]
- Updated dependencies [714ebd2]
- Updated dependencies [b91b0ee]
- Updated dependencies [12ad88c]
- Updated dependencies [180923d]
- Updated dependencies [b8f9e6f]
- Updated dependencies [f16c664]
- Updated dependencies [ed1877a]
- Updated dependencies [16ed395]
- Updated dependencies [622e628]
- Updated dependencies [9afd6a0]
- Updated dependencies [d45441e]
- Updated dependencies [4d5f2a2]
- Updated dependencies [3caff5e]
- Updated dependencies [95f5a26]
- Updated dependencies [dec63c6]
- Updated dependencies [ea9f219]
- Updated dependencies [941c67e]
- Updated dependencies [ab20522]
- Updated dependencies [2b9b8b5]
- Updated dependencies [89cb4c4]
- Updated dependencies [aa834a9]
- Updated dependencies [35d91bd]
- Updated dependencies [e9bba9b]
- Updated dependencies [678e2ff]
- Updated dependencies [87e09ca]
- Updated dependencies [0b461fa]
- Updated dependencies [2c44930]
- Updated dependencies [b378fb9]
- Updated dependencies [8816154]
- Updated dependencies [1c9dbe0]
- Updated dependencies [0388bd7]
- Updated dependencies [68cbb70]
- Updated dependencies [df7a430]
- Updated dependencies [b7f964a]
  - @korajs/core@1.0.0-beta.15
  - @korajs/server@1.0.0-beta.15
  - @korajs/react@1.0.0-beta.15
