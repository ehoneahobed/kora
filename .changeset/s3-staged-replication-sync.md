---
"@korajs/sync": patch
---

Staged replication (first-visit parity S3). A device's first sync of a view (delivery base 0, at least `bulkReplication.minOperations` = 2000 server operations, more than one batch) is applied into a scratch replica (`SyncStore.beginBulkReplication`) through the same one-transaction batch path as before (decrypt, verify, transforms, quarantine, chained watermark), and merged into the live database once with the final batch. The live delivery watermark and completion mark are written by the merge, so a crash, reload, stop, view switch or failed merge leaves the live database where it was and the next session replicates again from its watermark; nothing is dropped. A stream that narrows the view or retracts records is applied directly. New `SyncConfig.bulkReplication` (`false` turns it off), the `BulkReplication` types, and the events `sync:staging-started`, `sync:staging-merged` and `sync:staging-discarded`.
