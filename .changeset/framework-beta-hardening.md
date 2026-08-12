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
- Register broad and unsupported-only live queries as collection-wide sync subsets, so mixed narrow and `where({})` subscriptions cannot starve admin-style broad views.
- Invalidate a client's delivery watermark when the server resolves a different authoritative scope than the client requested, forcing a scoped backfill instead of skipping operations hidden under the old view.
- Treat retryable per-operation rejections as unacknowledged on the client, and have the server acknowledge only through the last safely processed operation. Stale-scope pushes now remain queued for rescope/retry instead of being silently dropped.
- Make delivery-stream retransmission stale-aware so slow or large server-to-client batches are not re-sent on every retry tick while the original ack is still in flight.
- Add a serialized `sync.reconnect()` control and use it for auth-driven scope refreshes and query-subset reconnects, avoiding app-level disconnect/connect races during permission changes.
- Load local `.env` files in `kora dev` and generated sync servers before auth/server setup, so first-run auth configuration mounts consistently whether the app is started by the CLI or the server is run directly.
- Update generated template docs to use `/kora-sync` WebSocket endpoints for `VITE_SYNC_URL`, avoiding noisy root-path WebSocket retries from copied defaults.
- Pin `create-kora-app` template dependencies to the exact Kora prerelease when the CLI itself is a prerelease, avoiding accidental stable-range resolution or split beta installs.
- Improve JSON schema validation errors by reporting the exact invalid nested path, including `undefined`, non-finite numbers, and circular objects.
- Fix IndexedDB fallback persistence so logical dumps are durable when binary SQLite export is unavailable, stale binary snapshots cannot shadow newer dumps, and dump-only databases restore correctly.
- Allow production server COEP policy configuration and document route access to the owned Kora data plane.
