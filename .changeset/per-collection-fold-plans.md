---
"@korajs/server": minor
"@korajs/cli": patch
---

A schema change re-folds only the collections whose merge rules changed. The server stores (SQLite and Postgres) record each collection's fold plan (`fold_plan_fingerprints`) and stamp each fold state with its collection's plan, as client stores already did, so changing one field's merge strategy in a 50-record collection re-folds those 50 records, not every record of the database (0.1 s instead of 2.6 s for 20,000 others on a laptop). Scope snapshots are dropped and rebuilt per collection too, and access rules are held for a membership-index rebuild only when a re-planned collection feeds the index. Transforms and explicit authorities still re-plan every collection.

Upgrading is free: on the first start, a database whose plan is unchanged is restamped (one statement per collection) and nothing is re-folded; one whose plan changed in the same deploy is fully re-folded once. Rolling deploys keep working across versions: a state stamped with the current whole-schema plan is current, any other stamp is re-folded by the existing sweep. `getFoldMigrationReport().replanned` names the re-planned collections, and `kora doctor --db` estimates only their records and snapshots.
