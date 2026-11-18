---
'@korajs/sync': patch
---

The outbound queue's append shortcut (added in this release) now compares a new operation with the latest timestamp in the queue, not with its last entry. In a rare arrival order, the shortcut could place an operation after one that a full causal sort puts after it. The order stayed causal, but it wasn't the queue's canonical order.
