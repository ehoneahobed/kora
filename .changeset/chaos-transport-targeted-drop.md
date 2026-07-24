---
"@korajs/sync": patch
---

Add a deterministic targeted-drop hook to `ChaosTransport` (`ChaosConfig.dropPredicate`).
When it returns true for a message and direction, that message is dropped
unconditionally, independent of `dropRate`. This lets convergence tests reproduce an
exact fault (for example dropping one specific operation to force a version-vector
gap) instead of relying on probabilistic drops, keeping such tests deterministic per
CLAUDE.md's no-timing-dependent-tests rule.
