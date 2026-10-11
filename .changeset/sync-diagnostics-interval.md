---
"@korajs/sync": patch
---

A stopped or disconnected sync engine no longer keeps its diagnostics interval running (it emitted `sync:diagnostics` every 5 s forever after the first connection). A Node process that used a sync engine can now exit after `stop()`.
