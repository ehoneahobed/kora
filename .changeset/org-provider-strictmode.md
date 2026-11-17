---
'@korajs/auth': patch
---

`OrgProvider` now works under React StrictMode. StrictMode reruns effects on mount, and that rerun destroyed the org session while the context still held it, so `useOrg` stopped following `switchOrg`. Its double render also left behind a session that never removed its client listener. Org sessions are now shared per client and reference-counted, the same way `AuthProvider`'s are, and released shortly after the last provider unmounts.
