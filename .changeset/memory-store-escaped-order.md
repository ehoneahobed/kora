---
'@korajs/server': patch
---

The memory server store now orders strings containing U+0000, U+FFFF or a lone surrogate by their stored escape, as the SQLite and Postgres stores do. It used to order them by decoded code points, so `orderBy` on such values could return a different order on the memory store.
