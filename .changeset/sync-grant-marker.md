---
'@korajs/auth': patch
---

A directional `SyncGrant` carries `type: 'sync-grant'`, and `resolveScopes` results are recognised by that marker rather than by their key names. A plain scope map whose collections are named `downlinkScopes` and `uplinkScopes` is no longer mistaken for a directional grant.
