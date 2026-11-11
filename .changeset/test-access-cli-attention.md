---
"@korajs/test": minor
"@korajs/cli": minor
---

`TestServer` exposes `access` (`grant`, `revoke`, `transfer`) and takes `accessSweepIntervalMs`, so a test can add and remove collaborators and check what their devices receive. `TestDevice.sync()` now flushes writes made before the first sync, as it does on later syncs. After `kora deploy --platform kora-cloud`, the CLI lists settings production still needs (with what each is for, from `.env.example`) and any problems Kora Cloud found in the code, with where to fix them.
