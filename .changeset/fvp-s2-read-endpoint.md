---
"@korajs/server": minor
"@korajs/core": minor
"@korajs/store": patch
---

Server read-through endpoint, `POST <syncPath>/read` (first-visit parity, stage S2). A device that has not replicated yet can ask the server for the current rows of a query: authenticated like a handshake, granted by the server (the request's `where` can only narrow the grant), respecting access rules and membership intervals, bounded by row, byte, candidate, request-size, rate and concurrency limits (`readThrough` option), and returning the delivery sequence the rows reflect (`frontier`, read after the rows). A read never returns more than the sync stream would deliver to the same session (enforced by a property test); a record with encrypted operations is never read through (it is left out and the result is `partial`); every truncation is explicit (`reason`, `includedStatus`), work per request is bounded (`maxWork`), cursors are signed (`cursorSecret`). `ServerStore` gains the optional `recordsWithEncryptedOperations`. The query evaluator moved from `@korajs/store` to `@korajs/core/internal` so the server can share it; the store re-exports it unchanged. No client change.
