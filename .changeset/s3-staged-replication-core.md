---
"@korajs/core": patch
---

New events `sync:staging-started`, `sync:staging-merged` and `sync:staging-discarded` for staged replication of a large first sync.

`sync:staging-merged` also carries `eventCounts` and `listenerErrors`.

`sync:staging-merged` also carries `heldEvents`; `HybridLogicalClock.hasObservedTime()`.
