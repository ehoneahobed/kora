---
'korajs': minor
'@korajs/core': minor
'@korajs/react': minor
'@korajs/server': minor
'@korajs/store': minor
'@korajs/sync': minor
---

Harden delivery-stall diagnostics, collision-free collections and events, auth-bound initialization
errors, scope-exit retractions, and independent server-authoritative downlink/uplink scopes.
Permanently reject and acknowledge uplink scope violations so stale shared-device writes cannot
pin the queue, add bounded backoff for transient operation rejections, and expose ingest outcome
metrics.
