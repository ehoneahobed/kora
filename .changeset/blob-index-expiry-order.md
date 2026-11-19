---
'@korajs/server': patch
---

The blob access index now sweeps expired scope sets in the order they were built. A set that a read had moved behind newer ones survived every sweep until it was read again or evicted.
