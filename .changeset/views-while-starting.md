---
'@korajs/sync': patch
---

Live queries that mount while the app is still loading its stored sync positions are now cheap too. A burst of them is checked once to decide whether to reconnect, instead of rebuilding the whole view after every one: 1,500 rows took about 1.4 s and now take about 4 ms.
