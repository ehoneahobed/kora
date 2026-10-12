---
"@korajs/server": patch
---

`server.access.backfill(memberships)` derives memberships from another source of truth (a collaborators table, an enrollment list) idempotently: memberships that already hold the same role and expiry are left alone, so it can run at every startup without writing. It validates every membership before writing any and reports groups whose record no longer exists (`missingGroups`).
