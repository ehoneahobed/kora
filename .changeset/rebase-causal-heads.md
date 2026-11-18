---
'@korajs/core': patch
'@korajs/store': patch
---

After a clock rebase, the next local write depends on the rebased operations' new ids. Before, the in-memory causal heads still named ids the rebase had deleted. The rebase's read phase now runs in the same transaction as its rewrite, so no local write can land in between, and the rebase runs under the write gate, so a superseded tab can't rewrite the log. `CausalTracker` gains `remapIds`.
