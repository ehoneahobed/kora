---
"@korajs/server": patch
"@korajs/cli": patch
---

Two fixes found by the packed-artifact release matrix. `createPostgresServerStore` no longer prints a screenful of `relation ... already exists, skipping` notices on every start against an existing database (the store's DDL is idempotent and postgres.js logs each skipped statement by default). `kora doctor --production` no longer reads a `0.0.0-canary-<datetime>` snapshot as a 0.x release that speaks sync protocol 1, which hid a protocol-1 server behind a canary client; a canary build now maps to no protocol, like `1.0.0-canary-*` did.
