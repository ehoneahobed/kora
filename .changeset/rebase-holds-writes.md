---
'@korajs/core': patch
'@korajs/store': patch
---

While a clock rebase rewrites operation ids, local writes that start meanwhile wait until its outcome is settled, whether the remap committed or was undone. Before, if the rewrite failed at commit, a write woken by the database lock could depend on ids that had been rolled back. `CausalTracker` gains `hold()` and `settling`.
