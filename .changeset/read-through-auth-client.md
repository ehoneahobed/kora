---
"korajs": patch
---

`sync.firstVisit.readThrough` now works for apps that sign in through `sync.authClient` (`createKoraAuthSync`). Before, such apps (KoraForms, KoraDocs) never used the read endpoint, so a first visit showed nothing until the local database opened and the download ran. The read uses the binding's token while a user is signed in, refreshes it once after a 401, waits briefly while the session is still being restored, and leaves the first screen to the local store when nobody is signed in.
