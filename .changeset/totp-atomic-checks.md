---
'@korajs/auth': minor
---

TOTP code checks are now atomic. Before, with a store that returns copies (any database-backed `TotpStore`), two requests with the same code both signed in, one recovery code worked twice, and wrong guesses sent in parallel were counted once, which weakened the lockout. Checks for one user now run one at a time in each process.

`TotpStore` gains a required `saveIf(secret, expectedRevision)`: an atomic conditional update, for example `UPDATE ... WHERE user_id = ? AND revision = ?` that checks the affected row count. `TotpManager` makes every write conditional on it and retries on a fresh read, so the guarantee holds across server processes too. It refuses a store without `saveIf` with `TOTP_STORE_NOT_ATOMIC`. Store the new `revision` field as is. `InMemoryTotpStore` implements `saveIf` and now returns copies.
