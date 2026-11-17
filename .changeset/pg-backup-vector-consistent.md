---
'@korajs/server': patch
---

A Postgres server backup's version vector now matches its rows. `exportBackup` used to record the store's live vector, read after the rows. An operation committed in between was claimed by the vector without being in the backup. A replace restore then told that operation's device the server already had it, so the device never sent it again and it was lost. The vector is now computed from the exported operations, which is how the store builds it when it starts.
