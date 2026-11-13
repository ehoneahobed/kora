---
"@korajs/cli": patch
---

`kora import` restores into a PostgreSQL server older than its client tools. pg_restore 17 opens every restore with `SET transaction_timeout`, which PostgreSQL 16 refuses, so an import with newer tools failed on its first line. The import now leaves out only the opening settings the server doesn't know and restores through psql in one transaction. Schema and data pass through untouched.
