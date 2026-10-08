---
'@korajs/merge': patch
'@korajs/server': patch
---

A unique constraint's `where` now also selects the records a write is compared against, on
devices and on the server: in "unique `slug` among `status: 'published'`" a draft no longer
collides with a published form. When a write moves a record into the group and creates a
duplicate (publishing a draft whose slug is taken), the server undoes that write (the status
change) instead of deleting the record, and the winner is decided by when each record entered
the group.
