---
'@korajs/sync': patch
'@korajs/server': patch
---

Presence works between pages again. Every page numbered its awareness client from 1, so two pages announced the same id. Each dropped the other's presence as its own echo, and one page leaving cleared the other's presence for everyone.

- **Client:** each page now picks a random 31-bit id.
- **Server:** the relay keeps every connected client under an id no other client uses. Older clients that still announce 1 are covered too.
