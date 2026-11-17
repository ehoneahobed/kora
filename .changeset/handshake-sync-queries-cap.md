---
'@korajs/server': patch
'@korajs/sync': patch
---

A handshake's query views (`syncQueries`) can no longer stall the server.
- **Server validation:** the server now refuses a malformed list (`INVALID_SYNC_QUERIES`) and more entries than `maxSyncQueries` (new option, default 1000; `SYNC_QUERIES_LIMIT`) before working on it.
- **Faster deduplication:** deduplicating and comparing views no longer compares every pair. 5,000 views take milliseconds instead of seconds, and 20,000 used to block the server for about 70 s. The results are identical.
- **Client cap:** the client stays under the limit on its own: past 500 views it widens the busiest collections to the whole collection, which covers every view and syncs more, never less.
