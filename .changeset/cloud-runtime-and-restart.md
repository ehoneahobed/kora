---
"@korajs/cli": patch
---

On Kora Cloud, `kora deploy status` says how the running version is doing (healthy or failing, why, and when Kora Cloud last checked), not only whether the latest deployment finished. New: `kora deploy restart` starts the running version again with the same release and data.
