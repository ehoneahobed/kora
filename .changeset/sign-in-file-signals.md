---
"@korajs/auth": patch
"@korajs/server": patch
"@korajs/store": patch
"@korajs/cli": patch
---

Operator insights report sign-in activity and file delivery. `createKoraAuthServer` counts what its routes do (sign-ins, sign-ups, second factors, OAuth, refreshes and verification or reset emails, by outcome and failure code, plus server errors) for the last hour and day, in memory, never an email or id: `auth.activity()`, and `auth.httpRoute` mounts the routes and reports these under `http.auth` in `/__kora/insights` (`httpRoutes: [auth.httpRoute]`; templates use it). Any production HTTP route may report counts through `insights`, sanitized to numbers. Insights also add `files`: file chunk requests served, found nowhere, throttled, and errors since start. `collectBlobGarbage` documents that its grace applies to dry runs (`graceMs: 0` lists everything).
