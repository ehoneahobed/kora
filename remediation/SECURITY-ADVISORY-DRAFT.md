# DRAFT security advisory: Kora 1.0.0-beta.12 and earlier

> Draft for the maintainer to review and publish (GitHub Security Advisory + README notice) when the
> fixed release ships. Do not publish exploit details before the fix is available. The repro tests
> in this repository already contain them, so publishing the advisory and pushing this branch
> publicly should happen together with the release.

**Packages:** `@korajs/server`, `@korajs/auth`, `@korajs/sync`, `@korajs/store`, `korajs` (all versions up to and including 1.0.0-beta.12)
**Severity:** Critical, for deployments that serve more than one user or tenant from one sync server.
**Affected:** 1.0.0-beta.12 and earlier
**Fixed in:** 1.0.0-beta.13

## Summary

In multi-user deployments, a client of the Kora sync server could read or modify other users' data:

1. **Unauthenticated writes.** The sync server processed operation batches sent before the authentication handshake.
2. **Client-controlled authorization.** Write authorization was evaluated against values supplied by the client in the operation, not against the stored record. An authenticated user could edit, delete, or take ownership of records belonging to other users.
3. **Client-chosen sync scope.** With the built-in `@korajs/auth` provider, the server used the scope requested by the client in its handshake. A signed-in user could request another user's scope and read and write their data. A handshake could also add collections the server never granted.
4. **Side channels.** Rich-text (Yjs) document updates, presence, and blob transfers were relayed without authentication or scope checks.

Additional high-severity issues fixed in the same release:
- Revoked devices could keep obtaining tokens.
- OAuth account linking was vulnerable to cross-site request forgery.
- Organization invitations could be claimed by any user.
- Offline users were signed out and their sessions destroyed when a token refresh failed for network reasons.
- With end-to-end sync encryption enabled, ciphertext was not bound to its operation and plaintext operations were accepted, so whoever could reach the sync server could inject unauthenticated writes. (Encrypted data was also never readable on another device; 1.0.0-beta.13 replaces the scheme with a per-user keyring.)
- The local store spliced `orderBy` direction and `limit`/`offset` values into SQL (only reachable when an app passes untrusted input to them).

## Am I affected?

You are affected if you run `@korajs/server` (`createKoraSyncServer` or `createProductionServer`) for more than one user, and either:
- you use `@korajs/auth` with the default sync provider; or
- your auth provider returns scopes, but untrusted clients can connect.

Single-user, local-only apps (no `sync` configured) are not affected by the server issues.

## What to do

1. Upgrade all `@korajs/*` packages and `korajs` to 1.0.0-beta.13 or later, sync servers first, then clients. The full migration table is in the 1.0.0-beta.13 release notes.
2. **Breaking change:** sync scopes are now granted only by the server.
   - If you used `@korajs/auth`, configure `resolveScopes` (or rely on the default `userId` derivation) as described in the migration guide.
   - A client handshake can now only narrow its scope.
3. **Breaking change:** clients can no longer move a record to another owner or tenant by writing its scope field. Use a server route for ownership transfer.
4. Review server logs for operations whose `nodeId` does not match the authenticated session's device, and for writes to records outside the writer's scope.

## Workarounds before upgrading

None are complete. If you cannot upgrade immediately:
- do not expose the sync server to untrusted clients;
- run one server per tenant;
- disable rich-text document channels, presence and blob sync.

## Credits

Found during an internal review in October 2026, with field reports from the Bozoma Innovation Hub LMS team.
