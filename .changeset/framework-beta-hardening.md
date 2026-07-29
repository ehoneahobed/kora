---
"@korajs/auth": patch
"@korajs/cli": patch
"@korajs/core": patch
"@korajs/react": patch
"@korajs/server": patch
"@korajs/store": patch
"@korajs/sync": patch
---

Harden the framework paths surfaced by production-style E2E usage.

- Fix generated app templates so auth routes proxy correctly, dev database writes do not trigger Vite full reloads, and cross-origin isolation can be configured for embedded media.
- Keep React auth subscriptions stable through StrictMode remounts, and keep `useQuery` from transiently reporting an empty result while a replacement query subscription is still settling.
- Add query-store snapshot readiness so adapters can distinguish "not emitted yet" from an authoritative empty result.
- Serialize `json`, `object`, and `blob` fields during server materialization, and fail loudly instead of acknowledging an operation whose persistence failed.
- Serialize sync start/stop transitions and retry pending outbound operations when an auth/session transition leaves the connection idle.
- Improve JSON schema validation errors by reporting the exact invalid nested path, including `undefined`, non-finite numbers, and circular objects.
- Fix IndexedDB fallback persistence so logical dumps are durable when binary SQLite export is unavailable, stale binary snapshots cannot shadow newer dumps, and dump-only databases restore correctly.
- Allow production server COEP policy configuration and document route access to the owned Kora data plane.
