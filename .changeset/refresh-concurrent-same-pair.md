---
'@korajs/auth': patch
---

Concurrent refreshes of one session no longer fail: a duplicate request that arrives while the rotation of the same refresh token is running is served the same rotated pair instead of `409 REFRESH_IN_PROGRESS`. A beta.12 client treats any failed refresh as a sign-out and cleared its tokens (two tabs refreshing together were enough). Rotation security is unchanged: the single grace replay of a lost response is still available afterwards, and any further replay of the old token revokes the family.
