---
"@korajs/store": patch
---

Instant updates: a write that has to read its record's base (because a write the overlay did not predict is changing that record, such as an update that changes nothing) now waits for the record's earlier writes to land first. Before, the read could run before an earlier pending write was stored, so the write was shown without that change until its commit, and the commit check reported `store:overlay-diverged` (which turns instant updates off for the collection). The wait counts against the base-read budget, so a slow commit makes the write unpredicted rather than wrong.
