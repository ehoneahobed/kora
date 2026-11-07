---
"@korajs/sync": patch
"@korajs/store": patch
---

A first visit's staged replication hands the main thread back every few milliseconds instead of applying a 100-operation batch as one task, and the post-merge event replay runs in smaller slices. On a throttled CPU (4x) this halves the number of main-thread stalls over 50 ms and the blocking time while the app prepares offline; the data written and its order are unchanged.
