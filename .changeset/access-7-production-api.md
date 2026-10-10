---
"@korajs/server": minor
---

Access rules: `createProductionServer` exposes the access API as `server.access` and to custom routes as `request.access`, so an "accept invitation" route can grant a membership; `AccessApi`, `GrantInput`, `GroupRef` and `AccessApiError` are exported from `@korajs/server`. New guide: Access Rules.
