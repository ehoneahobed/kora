---
'@korajs/store': patch
---

Instant updates no longer report a false `store:overlay-diverged` when a write builds on an earlier write that then fails. The commit-time check now skips fields whose stored value depends on their base (merge strategies, arrays, atomic operations) while that base is unsettled, as it already did for the rest of the record. In strict builds the false report raised an error.
