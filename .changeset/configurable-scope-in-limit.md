---
'@korajs/server': patch
'@korajs/sync': patch
---

Make the `$in` scope predicate limit configurable (F17): `maxScopePredicateValues` (default 100)
in the sync server options. Large grants got cheaper: membership in a normalized `$in` list of 32
or more values is a set lookup instead of a scan, the canonical order no longer uses
locale-aware comparison, and session revalidation compares already-normalized grants without
normalizing them again. `pnpm --filter @korajs/server bench:scope-in` measures handshake,
revalidation and delivery cost for 100, 1,000 and 5,000 values on SQLite and Postgres.
