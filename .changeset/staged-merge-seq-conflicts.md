---
'@korajs/store': patch
'@korajs/sync': patch
'@korajs/core': patch
---

A staged first sync now merges a log that holds legacy sequence conflicts (operations from beta.12 and earlier that share a node and sequence number). Each conflict row is copied or replayed with its record, exactly as the direct path stores it, so such a device no longer discards the staged download and fetches everything again. A staged log with conflict rows from a local repair still refuses the merge, and the server still refuses new sequence conflicts.
