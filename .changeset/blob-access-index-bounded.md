---
'@korajs/server': patch
---

The server's blob access index no longer keeps a cached set for every download scope it has seen. It's capped at 10,000 sets and evicts the least recently used first. Sets built from a collection are dropped as soon as that collection is invalidated, and expired sets are swept as new ones are cached. Memory no longer grows with the number of past users and group scopes.
