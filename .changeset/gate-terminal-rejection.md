---
'@korajs/store': patch
---

A version gate closed while it was opening, or retired by a newer build, keeps that rejection. A later `open()` returns it instead of opening again. Only failures that can be retried are forgotten.
