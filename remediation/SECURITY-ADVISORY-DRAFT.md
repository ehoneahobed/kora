<!--
Publish-ready text for the GitHub Security Advisory of the 1.0.0-beta.13 release.
Identical public copy: docs/releases/security-advisory-beta13.md (outside the docs site build;
public only when the repository goes public, which happens after the npm publish).
Publish order and GitHub form fields: docs/releases/npm-publish-checklist-beta.13.md, step (f).
Published on 2026-10-05 as GHSA-v63m-pq3j-7m44.
-->

# Multi-tenant authorization bypass and related vulnerabilities in the Kora.js sync stack

**Advisory:** [GHSA-v63m-pq3j-7m44](https://github.com/ehoneahobed/kora/security/advisories/GHSA-v63m-pq3j-7m44) · **Published:** 2026-10-05, with the 1.0.0-beta.13 release

| | |
|---|---|
| **Ecosystem** | npm |
| **Affected packages** | `@korajs/server`, `@korajs/auth`, `@korajs/sync`, `@korajs/store`, `korajs` |
| **Affected versions** | `<= 1.0.0-beta.12` (every earlier release, including the 0.x `latest` line) |
| **Patched versions** | `1.0.0-beta.13` |
| **Severity** | Critical, for deployments that serve more than one user or tenant from one sync server. CVSS 3.1 `AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N` (9.1) |
| **Weaknesses** | CWE-306, CWE-639, CWE-863, CWE-862, CWE-345, CWE-613, CWE-352, CWE-285, CWE-89 (per issue below) |

## Summary

In multi-user deployments, a client of the Kora sync server (`@korajs/server`) could read or
modify other users' data. The server trusted the client for authentication order, write
authorization, sync scope and operation identity. Version 1.0.0-beta.13 makes the server the trust
boundary: nothing is accepted before the authenticated handshake, the server grants scopes from
verified identity, writes are authorized against the stored record, and every operation's id and
origin are verified.

Single-user, local-only apps (no `sync` configured) are not affected by the server issues.

## Details

### Critical: multi-tenant data access

| # | Issue | CWE |
|---|---|---|
| 1 | **Unauthenticated writes.** The sync server processed operation batches (and acknowledgments, rich-text, presence and blob messages) sent before the authentication handshake completed, over WebSocket and HTTP. | CWE-306 Missing Authentication for Critical Function |
| 2 | **Client-controlled write authorization.** Write authorization was evaluated against values the client supplied in the operation (`previousData`), not against the stored record. An authenticated user could edit, delete or take ownership of records belonging to other users. | CWE-639 Authorization Bypass Through User-Controlled Key |
| 3 | **Client-chosen sync scope.** With the built-in `@korajs/auth` sync provider, the server used the scope the client requested in its handshake. A signed-in user could request another user's or tenant's scope and read and write their data, or add collections the server never granted. | CWE-639, CWE-863 Incorrect Authorization |
| 4 | **Unauthorized side channels.** Rich-text (Yjs) document updates, presence and blob transfers were relayed without authentication or scope checks; blob and foreign-key references could point at other tenants' content. | CWE-862 Missing Authorization |
| 5 | **Spoofed operation identity.** Uploaded operation ids were not verified against their content, and operations were accepted from node ids other than the session's own, so a client could forge or replace operations attributed to other devices. | CWE-345 Insufficient Verification of Data Authenticity |

### High

| # | Issue | CWE |
|---|---|---|
| 6 | Revoked devices could keep obtaining tokens, and revocation did not end live sync sessions. | CWE-613 Insufficient Session Expiration |
| 7 | OAuth account linking was vulnerable to cross-site request forgery (state not bound to the browser and purpose). | CWE-352 Cross-Site Request Forgery |
| 8 | Organization invitations could be claimed by any signed-in user, not only the invited email. | CWE-285 Improper Authorization |
| 9 | With end-to-end sync encryption enabled, ciphertext was not bound to its operation and plaintext operations were accepted, so anyone who could reach the sync server could inject unauthenticated writes. (Encrypted data was also never readable on another device; 1.0.0-beta.13 replaces the scheme with a per-user keyring.) | CWE-345 |
| 10 | Offline users were signed out and their sessions destroyed when a token refresh failed for network reasons (data-availability issue). | — |

### Moderate and hardening

| # | Issue | CWE |
|---|---|---|
| 11 | The local store spliced `orderBy` direction and `limit`/`offset` values into SQL (reachable only when an app passes untrusted input to them). | CWE-89 SQL Injection |
| 12 | Password-reset tokens could be disclosed; sign-in timing revealed whether an account exists; MFA was not enforced at sign-in; webhook deliveries could target private network addresses; passkeys did not require user verification. | CWE-640, CWE-208, CWE-308, CWE-918, CWE-287 |
| 13 | Tokens were sent in WebSocket URLs; `X-Forwarded-For` was trusted from any peer; messages, batches, operations and blob uploads had no size limits. | CWE-598, CWE-348, CWE-770 |

## Am I affected?

You are affected if you run `@korajs/server` (`createKoraSyncServer` or `createProductionServer`)
for more than one user, and either:

- you use `@korajs/auth` with the default sync provider; or
- your auth provider returns scopes, but untrusted clients can connect.

Issues 6 to 8 and 12 affect every deployment of `@korajs/auth`. Issue 9 affects apps that enabled
`sync.encryption`. Issue 11 affects apps that pass untrusted input to `orderBy`, `limit` or
`offset`.

## Patches and upgrade

Upgrade **every** `korajs` and `@korajs/*` package to `1.0.0-beta.13`, **sync servers first,
then clients**:

```bash
pnpm add korajs@1.0.0-beta.13 @korajs/server@1.0.0-beta.13 @korajs/auth@1.0.0-beta.13   # plus every other @korajs/* package you use
```

The `latest` npm dist-tag still points at the older 0.x line, which is affected and has no
patched release: install with the `beta` tag or the exact version.

1.0.0-beta.13 is a breaking release. The changes you will meet first:

1. **Sync scopes are granted only by the server.** With `@korajs/auth`, schema-scoped collections
   bind to the verified `userId` automatically; supply other bindings with
   `scopeValues: async ({ userId }) => ({ orgId })` or a full `resolveScopes`. Custom providers must
   return scopes for scoped collections, or sessions are refused (`SCOPE_REQUIRED`). A client
   handshake can only narrow its scope.
2. **Clients can no longer move a record to another owner or tenant** by writing its scope field.
   Use a server route for ownership transfer.
3. **Operations must come from the session's own node**, and node ids are claimed per user.
   With `@korajs/auth` (every sync template), run the one-time node-binding script with the
   server stopped, or signed-in devices are refused and their offline writes never upload
   ([Upgrading a beta.12 server database](https://ehoneahobed.github.io/kora/guide/production-server#upgrading-a-beta-12-server-database-with-authentication)).
4. **HTTP long-poll endpoints** must pass the `x-kora-session` session id and authorization to
   `handleHttpRequest`.

Every breaking change, with the code change it needs and the one-time server and client
migrations, is in [Upgrading to beta.13](https://ehoneahobed.github.io/kora/guide/upgrading-to-beta13)
and the [1.0.0-beta.13 release notes](./v1.0.0-beta.13.md).

After upgrading, review server logs for operations whose `nodeId` did not match the authenticated
session's device and for writes to records outside the writer's scope; beta.13 refuses and logs
both (`NODE_ID_MISMATCH`, scope refusals, `INVALID_OPERATION_ID`, `FORGED_DUPLICATE`).

## Workarounds

None are complete. If you cannot upgrade immediately:

- do not expose the sync server to untrusted clients;
- run one sync server per tenant;
- disable rich-text document channels, presence and blob sync;
- do not pass untrusted input to `orderBy`, `limit` or `offset`.

## Credits

Found during an internal security review of Kora.js in October 2026, with field reports from the
Bozoma Innovation Hub LMS team.

## Timeline

- October 2026: issues identified and fixed privately.
- Release day: `1.0.0-beta.13` published to npm, source and this advisory published.
