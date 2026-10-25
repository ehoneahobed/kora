---
'@korajs/server': patch
---

When the payload gate withholds an update from a live relay, the relay's retractions are re-counted against the operations that stay, so a record that left and re-entered the scope in one relay does not end removed.
