---
'@korajs/sync': patch
---

Mounting many live queries is much faster. Registering or removing a live query used to recompute the whole sync view several times, so 1,500 views took about 12.6 s on the main thread. Registrations made in a burst, such as a list mounting a query per row across one render's microtasks, now switch the view once, on the next timer turn. The active views and signature are memoized, and the dedupe sort computes each key once. 1,500 views mount and unmount in a few milliseconds. Any read of the view, and stopping the engine, settles a pending switch first.
