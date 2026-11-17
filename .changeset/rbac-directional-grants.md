---
'@korajs/auth': minor
---

**Breaking (beta):** `RbacEngine.resolveScopes` and `OrgScopeResolver.resolve` return a directional `SyncGrant` (`{ downlinkScopes, uplinkScopes }`) instead of one scope map, and the RBAC sync scopes now work.

Before, a read-only grant added a `__readonly: true` key to the scope filter. The sync server treats every scope key as a record filter, so viewers synced no records at all, and their writes were refused only by accident. `'*:read'` was also matched literally, so a role granted `todos:read` got no scope.

Now each collection's directions follow the role's permissions: `<collection>:read` to download, `<collection>:write` to upload (wildcards count). A collection the role may read but not write is in `downlinkScopes` only, so the server sends its records and refuses writes to it. `createKoraAuthServer({ resolveScopes })` and `ExternalJwtProvider({ resolveScopes })` accept a `SyncGrant` and pass it to the server as `downlinkScopes` / `uplinkScopes`. The new `SyncGrant` type is exported from `@korajs/auth/server`.

To migrate: return the grant from `resolveScopes` as is (`(await rbac.resolveScopes(userId, orgId, collections)) ?? {}`), and read `grant.downlinkScopes` where you read the old map.
