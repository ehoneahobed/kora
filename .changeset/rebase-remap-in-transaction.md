---
'@korajs/core': patch
'@korajs/store': patch
---

A clock rebase now remaps the causal heads and advances the clock inside its own transaction, before it commits. A local write queued right behind the rebase no longer depends on a deleted operation id, and no longer stamps a time below the rebased operations. `CausalTracker.remapIds` returns an undo, used if the rewrite doesn't commit.
