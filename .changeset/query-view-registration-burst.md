---
'@korajs/sync': patch
---

Mounting many live queries is much faster. Registering or removing a live query used to recompute the whole sync view several times, so 1,500 views took about 12.6 s on the main thread. A burst of registrations made in one tick, such as a list mounting a query per row, now switches the view once, in a microtask, and the active views and signature are memoized. A list of 1,500 rows mounts and unmounts in a few milliseconds, and views mounted one by one cost about six times less. Any read of the view settles a pending switch first.
