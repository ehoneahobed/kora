---
"@korajs/sync": patch
---

A delivery batch is now decrypted and its operation content ids verified up front, before its storage transaction opens, in bounded concurrent groups so the digests overlap. Every operation is still verified, exactly once (a batch that falls back to operation-by-operation application is not verified again); a forged id is quarantined with the same code and events as before, and the order of application is unchanged. Roughly halves the engine's per-operation cost of applying a large batch.
