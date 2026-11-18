---
'@korajs/server': patch
---

The production server compares the operational tokens (admin, metrics, backup and insights) in constant time. It hashes both tokens and compares the digests with `timingSafeEqual`. It used `===` before, which stops at the first wrong character, so response timing could reveal how much of a guessed token was right.
