---
'@korajs/cli': patch
---

A Vite build that fails before writing its output folder now shows its own compiler error. `koraBuildId()` and `koraServiceWorker()` no longer throw a missing-directory error from `closeBundle` on top of it.
