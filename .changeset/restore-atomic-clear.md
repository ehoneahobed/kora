---
"@korajs/server": patch
---

A replace-mode backup restore clears the materialized records and their fold state in the same transaction that replaces the operation log (SQLite and Postgres). Before, a crash between the two left records the restore removed in place, and the next start kept them and indexed their memberships.
