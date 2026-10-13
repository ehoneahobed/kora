---
"@korajs/spaces": patch
---

New package: `@korajs/spaces`, sharing on top of access rules (experimental, with `experimentalAccessRules`). `spacesCollections({ roles, ownerRole, manageRole, groups })` adds the access configuration and three collections (members, pending invitations, server-only invitation secrets); `spacesRoutes` serves invite, re-send, revoke, describe, accept, decline, change role, remove, leave and transfer, each one `kora.transaction`; `transferSpace` is the operator's transfer; `koraAuthIdentity` identifies callers with `@korajs/auth`; `createSpaces` is the client (`accept` resolves once the device holds the membership); `useMembers`, `useInvitations` and `useMyRole` read the local store. Invitation tokens are stored as hashes, bound to the verified invited address, and stop working when re-sent or when the inviter's role or the space's owner changes. Invitation limits per space, per address and per user are on by default. Guide: `docs/guide/sharing.md`.
