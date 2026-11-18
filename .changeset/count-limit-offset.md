---
'@korajs/store': patch
---

`count()` now applies `limit` and `offset`, and returns the number of records `exec()` would return. It used to ignore both and count every match. A query that chained `limit` or `offset` before `count()` now gets the limited count; to count every match, leave them out.
