---
'@korajs/auth': patch
---

TOTP code checks are now atomic. Before, with a store that returns copies (any database-backed `TotpStore`), two requests with the same code both signed in, one recovery code worked twice, and wrong guesses sent in parallel were counted once, which weakened the lockout. Checks for one user now run one at a time in each process.

For a store shared by several server processes, implement the new optional `TotpStore.saveIf(secret, expectedRevision)` as an atomic conditional update. `TotpManager` then makes each write conditional and retries on a fresh read. Store the new `revision` field as is. `InMemoryTotpStore` implements `saveIf` and now returns copies.
