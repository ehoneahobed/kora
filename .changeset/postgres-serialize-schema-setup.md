---
'@korajs/server': patch
---

Two server instances starting together on one Postgres database (an overlapping deploy) no longer deadlock during schema setup: setup runs under a cross-instance advisory lock, and the scope-snapshot reset takes its row locks in the same order as the re-materialization (fold-state rows before operation rows). The pool given to `PostgresServerStore` needs at least two connections while setup runs.
