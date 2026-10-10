---
"@korajs/core": minor
"@korajs/server": minor
"korajs": patch
---

Access rules: `access.groups.<collection>.history: 'full'` gives new members of a group its whole history (default `'joined'`: its state when they join, then its changes). `createProductionServer` exposes the access API as `server.access` and to custom routes as `request.access`, so an "accept invitation" route can grant a membership; `AccessApi`, `GrantInput`, `GroupRef` and `AccessApiError` are exported from `@korajs/server`. New guide: Access Rules.
