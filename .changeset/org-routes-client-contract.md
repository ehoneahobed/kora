---
'@korajs/auth': patch
---

`OrgClient` now has a server route for every method it calls. A new `routeOrgRequest(orgRoutes, { method, path, userId, body })` dispatches each request `OrgClient` makes to its `OrgRoutes` handler, so one server route serves the whole client. The guide now shows that route, replacing an example whose paths did not match the client.

`OrgRoutes` gains `getMyMembership` (which `switchOrg` reads) and `leaveOrg`. Before, `switchOrg` and `leaveOrg` always failed. `OrgClient` now encodes ids as path segments.
