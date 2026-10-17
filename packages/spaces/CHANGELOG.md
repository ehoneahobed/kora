# @korajs/spaces

## 1.0.0-beta.15

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
- Updated dependencies [2a267d4]
- Updated dependencies [047b788]
- Updated dependencies [34b477d]
- Updated dependencies [28ec1ef]
- Updated dependencies [3caff5e]
  - @korajs/core@1.0.0-beta.15
  - @korajs/server@1.0.0-beta.15
  - @korajs/react@1.0.0-beta.15
