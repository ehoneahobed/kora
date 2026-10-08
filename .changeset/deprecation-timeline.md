---
'@korajs/server': patch
'@korajs/core': patch
---

Protocol 1 (beta.12 clients), `experimental.legacyMerge` and the `allowLegacyAnonymousClaims`
default stay as in beta.13: each would break part of the beta.12 upgrade path this release
completes. The deprecation messages now say a later release refuses them, announced in its notes.
