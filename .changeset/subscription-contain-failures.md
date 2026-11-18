---
'@korajs/store': patch
---

A live query whose post-query step fails (settling pending writes, the read hook or the result comparison) now gets the error on its own subscription, with phase `refresh`, while the other queries in the same refresh still get their rows. Before, the failure rejected the whole refresh, and every remaining query on screen stayed stale.
