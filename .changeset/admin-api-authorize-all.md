---
'@korajs/auth': minor
---

**Breaking:** every `AdminApi` method now takes the acting admin's id first and checks it with `isAdmin`. `listUsers(adminId, query?)`, `getUserSessions(adminId, userId)` and `getStats(adminId)` used to skip that check, so they returned every user's email, sessions or counts to whoever could call them. Each call is now also audited, as `admin.user_list`, `admin.session_list` or `admin.stats`.

`deleteUser` and `revokeUserSessions` no longer silently leave a user's tokens valid. When the user store has no token revocation store and no `revokeAllForUser` is configured, they throw `AdminRevocationUnavailableError` (`ADMIN_REVOCATION_UNAVAILABLE`) before deleting anything. The built-in user stores provide a revocation store.

To upgrade, pass the admin's id as the first argument to `listUsers`, `getUserSessions` and `getStats`.
