---
"@korajs/cli": minor
---

`kora doctor --db <url>`: a read-only preflight of the sync server's production database
(Postgres URL, SQLite path, or `env:NAME`) before a deploy. It reports schema drift (column types
a field kind change left behind, a schema rollback), constraint `where` clauses that can never
match, json/object values stored as encoded strings (F14), ownerless device nodes, devices still
on protocol 1, quarantined operations and generated migrations that change field kinds, and a
dry run of the startup migration: what the next start re-folds and rebuilds, with a rough
duration, warning when it exceeds 60 seconds. The database is opened in a read-only transaction
and the URL's password is never printed. Exits non-zero on a failure; `--strict` also fails on
warnings.
