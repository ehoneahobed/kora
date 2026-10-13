---
"@korajs/server": patch
---

`server.access.backfill(memberships)` derives memberships from another source of truth (a collaborators table, an enrollment list) idempotently: memberships that already hold the same role and expiry are left alone, so it can run at every startup without writing. It validates every membership before writing any and reports groups whose record no longer exists (`missingGroups`).

`grant`, `revoke` and `backfill` now act on every row holding a user's membership of a group, whatever its id: a memberships collection populated before `server.access` (rows under the app's own ids, or duplicates) is updated in place and left with one row, and `revoke` removes them all.
