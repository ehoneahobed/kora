# Kora 1.0.0-beta.13: security and data-safety release (draft)

> Draft. Publish together with `remediation/SECURITY-ADVISORY-DRAFT.md`. This release is **breaking** by design: the maintainer approved breaking changes to close multi-tenant security holes found in beta.12.

## Why upgrade

beta.12 let a client of a multi-user sync server read and modify other users' data, and could silently lose or diverge data in common offline flows. beta.13 closes every known P0 security issue and every Phase 1 item in the remediation tracker. Each fix is proven by a reproduction test that failed on beta.12, and the result was attacked three times by independent red-team reviews.

## Security fixes (summary)

- **The handshake comes first.** The sync server refuses every message until the authenticated handshake completes. This covers operations, acknowledgments, rich-text, presence and blobs, on both WebSocket and HTTP.
- **The server decides what you may write.** Authorization uses the stored record and the resulting record, never values the client sends (`previousData`). It is re-checked inside the store's write path on memory, SQLite and Postgres.
- **The server decides what you may sync.** Scopes are granted by the server from verified identity, and a client handshake can only narrow them. Unresolved bindings and null/undefined grant values fail closed (`SCOPE_REQUIRED`, `INVALID_SCOPE_PREDICATE`).
- **Devices own their node ids.** Operations must come from the session's own node (`NODE_ID_MISMATCH`). Node ids are claimed per user, and anonymous devices get a secret node token.
- **Side channels are isolated per tenant.** Rich-text updates, presence and blobs are authorized and delivered only within scope. Blob references must point at content the writer can read or has uploaded.
- **References to other tenants are refused.** Foreign keys must point at parents inside the writer's scope. Cascades are authorized, and restrict refusals reveal nothing (`RESTRICTED`).
- **History stays with its owner.** Visibility is judged per operation, from the scope values recorded when it was applied, so ownership transfer does not disclose earlier history. Records moving into scope arrive complete, with per-field versions.
- **HTTP long-poll sessions are bound to the user.** Every request is authenticated, using a server-issued session id (`x-kora-session`).
- **Credentials are revocable everywhere.** One `authenticateAccess` check guards every route. Device and user revocation take effect immediately and across server instances; live sessions are ended on revocation, expiry or scope change. Refresh rotation is atomic and safe across tabs.
- **Account flows are hardened.**
  - OAuth state is bound to the browser and purpose.
  - Invitations require the verified invited email.
  - MFA is enforced at sign-in.
  - Reset tokens are never disclosed.
  - Sign-in timing no longer reveals whether an account exists, and rate limiting is per account and per IP.
  - Webhooks are signed with a timestamp and refuse private targets.
  - Passkeys require user verification.
- **Defaults are safer.** Tokens are no longer sent in WebSocket URLs, `X-Forwarded-For` is trusted only from configured proxies, and messages, batches and blob uploads have size limits.

## Data-safety fixes (summary)

- **Offline users stay signed in.** Network errors, timeouts, 5xx responses, rate limits and captive portals no longer sign anyone out or destroy tokens. An explicit `authenticated-offline` state opens the user's own database offline.
- **Edits that leave a reactive query are uploaded.** Local edits outside your upload scope are reported (`sync:operation-rejected`, `OUT_OF_UPLINK_SCOPE`) instead of silently staying local.
- **Secret fields are protected in transactions.** Secret fields written in `app.transaction` / `app.mutation` are hashed or encrypted, as with single writes.
- **Writes after a transaction sync.** Writes made after `app.transaction` are no longer wrongly reported as synced.
- **Array removals stick.** A removal on one device is no longer undone by another device's unchanged copy, and client and server agree.
- **Shared devices keep working.** Many per-user databases on one device no longer stop all writes, because OPFS pool capacity is reserved. Kora never silently runs in memory: it emits `store:durability-lost` and refuses writes unless you opt in.

## Breaking changes and how to migrate

| Change | What to do |
|---|---|
| Sync scopes are granted by the server | With `@korajs/auth`: schema-scoped collections bind to the verified `userId` automatically. Supply other bindings with `scopeValues: async ({ userId }) => ({ orgId })` or a full `resolveScopes`. Custom providers must return scopes for scoped collections, or sessions are refused with `SCOPE_REQUIRED`. Client `syncScope` can only narrow. |
| Clients cannot move records out of their scope | Use a server route (`request.kora` without scope, or an admin path) for ownership transfer. |
| Ops must come from the session's own node; node ids are claimed per user | Use a fresh node id per signed-in user on shared devices. Devices whose node has history from before claims existed are refused with `NODE_ID_CLAIMED` until an admin calls `server.releaseNodeClaim(nodeId)`. Anonymous clients must persist the issued node token. Legacy anonymous clients are accepted with a warning while `allowLegacyAnonymousClaims` is true (default in beta.13, planned to become false). |
| HTTP long-poll protocol | Your HTTP endpoint must pass `sessionId` (from the `x-kora-session` header) and `authorization` to `handleHttpRequest`, and return `x-kora-session`. Cross-origin endpoints must expose that header. Upgrade old HTTP clients. |
| Token not in the WebSocket URL | Set `tokenInUrl: true` only if a proxy requires it. |
| `request.ip` behind a proxy | Set `trustProxy` (hop count or CIDR list). |
| Persistent auth stores required in production | Use `createSqliteUserStore` / `createPostgresUserStore` (revocation storage included), or set `allowInMemory: true` deliberately. |
| `TokenRevocationStore` interface | Custom stores must implement `consume`, `isConsumed` and revocation cut-offs. `isDeviceRevoked` is removed. |
| OAuth | Callbacks need the flow binding (cookie). Linking starts at `POST /auth/oauth/:provider/link/start`. |
| Invitations | Custom OrgStores implement `listMyInvitations(userId)` and `revokeInvitation(orgId, id)`. |
| MFA | MFA users get `MfaRequiredError` at sign-in and complete it with `verifyMfa`. |
| Webhooks | The signature format is `t=…,v1=…`. Verify it with the timestamp tolerance. |
| Passkeys | User verification is required by default. |
| Password reset | Configure `onResetRequested`. Tokens are exposed only with `exposeTokenForDevelopment` (never in production). Wire `onPasswordChanged: authServer.revokeAllForUser` and `new AdminApi({ revokeAllForUser })`. |
| Blob references | A blob field may reference only content you can read or have uploaded. Clients upload bytes before the operation that references them (automatic in beta.13 clients). Bytes uploaded before the upgrade have no owner: existing references keep working, but new references need a re-upload. |
| Durable storage | If OPFS or IndexedDB durability cannot be obtained, writes are refused with `StorageDurabilityError`. Set `store: { allowNonDurable: true }` to accept in-memory storage knowingly. |
| Limits | WebSocket messages over 32 MiB are refused (`maxMessageBytes`). Batches are capped at `maxOpsPerBatch` (1000). Blob pushes and requests are limited (`blobLimits`). |
| Scope helpers | `previousData` is ignored unless you pass `{ includePreviousData: true }`. |
| `AuthSyncState.token` | May be `null` while authenticated-offline. `AuthBoundKoraProvider` gains a `locked` state. |
| Server storage | New `scope_snapshot` column, plus `blob_owners`, `node_claims` and `kora_server_meta` tables. They are created automatically. Snapshots are recomputed once on first start. |
| Wire protocol | New optional fields (protobuf envelope 39–42, `fieldVersions` on scope-entry ops). beta.12 clients interoperate only where noted above. Upgrade clients and server together. |
| New events | `store:durability-lost`, `sync:node-id-rotated`, `sync:operation-rejected` (`OUT_OF_UPLINK_SCOPE`). |

## Known limitations carried into later phases

See `remediation/STATUS.md`; every item has an owner, a phase and a test. The notable ones:
- **Concurrent transactions** can still share sequence numbers (STORE-1/STORE-2, Phase 2).
- **Array and object merges** can still diverge under some multi-device orderings (MERGE-2, Phase 3).
- **Backup restore** is unsafe (STORE-5, Phase 3).
- **Per-database OPFS pools** are still to come (NEW-STORE-5, Phase 2).
- **End-to-end encryption** does not yet work across devices (ENC-1, Phase 4).
- **The app shell** does not yet open offline (NEW-DX-3, Phase 4).
