---
'korajs': patch
'@korajs/merge': patch
'@korajs/store': patch
'@korajs/test': patch
'@korajs/cli': patch
---

Remove the beta.12 pairwise merge pipeline. `experimental.legacyMerge` and `ExperimentalOptions` are gone, a database that ran with the option re-materializes with the fold on its next open, and `MergeAwareSyncStore` no longer takes a merge engine.

`@korajs/merge` no longer exports `MergeEngine`, `mergeField`, `lastWriteWins`, `addWinsSet`, `mergeObject`, `mergeAtomicOps`, the `.merge()` strategy functions, or the `MergeInput`, `MergeResult` and `FieldMergeResult` types, and `korajs` no longer re-exports `MergeEngine`. The cross-record constraint checks, referential integrity and rich-text helpers stay.
