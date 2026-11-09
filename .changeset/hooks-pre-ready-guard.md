---
'@korajs/react': patch
---

Test only: every exported React hook is mounted against an app whose `getStore()` throws until ready, so a hook that asks for the store while rendering fails CI instead of breaking a read-through page.
