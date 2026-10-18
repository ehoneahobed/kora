---
"@korajs/server": patch
---

Changing operation transforms or merge rules in a rolling deploy no longer leaves records folded with the previous plan. Each fold state records the plan it was folded with (SQLite, Postgres): a record an instance on the previous plan writes during the re-fold is folded again with the new plan, by the re-fold or by the next delivery poll of an instance on the new plan (`store.refoldOutdatedRecords()`), with the membership index rebuilt when memberships are involved.
