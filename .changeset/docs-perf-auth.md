---
"@korajs/core": patch
"@korajs/devtools": minor
"@korajs/auth": minor
"@korajs/store": patch
"@korajs/merge": patch
"@korajs/sync": patch
"@korajs/server": patch
"@korajs/react": patch
"@korajs/cli": patch
"korajs": patch
---

Performance: Replace O(n²) topological sort with binary heap in @korajs/core (19x faster sync for large operation sets).

New: @korajs/auth package with sessions, TOTP MFA, organizations, RBAC, passkeys, encrypted tokens, and E2E operation encryption (912 tests).

New: Full Preact-based DevTools UI panel with sync timeline, conflict inspector, operation log, and network status.

Docs: Comprehensive documentation refinement — added API references for merge, sync, auth, and devtools; added authentication guide; expanded sync configuration guide; updated all package descriptions.
