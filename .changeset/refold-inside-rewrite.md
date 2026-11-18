---
'@korajs/store': patch
---

A clock rebase, a node rotation or a re-author now re-folds the affected records in the same transaction that rewrites their operations. Before, the re-fold ran in a second transaction. A crash in between left fold states holding the old timestamps or ids, which order remote writes differently from every other replica and never recover. For rotations and re-authors, the fresh node's registration and its user binding are written in that same transaction too, so a crash can no longer leave the re-authored writes without their owner.
