---
"@korajs/sync": patch
---

A first visit's staged replication now waits (at most 2.5 s) for the page to report idle time before applying its first batch, so the download no longer competes with the app starting. On a throttled CPU this removes the burst of long main-thread tasks between 2 and 4 seconds of a fast-network first visit.
