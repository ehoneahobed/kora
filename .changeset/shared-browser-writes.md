---
'@korajs/store': patch
---

A browser two users share can no longer store one user's writes as the other's (F9). While the
store's pinned node id (the auth device id) belongs to another user than the one signed in, a
cached session of the second user, local writes throw `NodeOwnedByAnotherUserError`
(`NODE_OWNED_BY_ANOTHER_USER`) instead of landing under the owner's node, from which they would
later upload as the owner's. Transactions also honour a configured `maxOperationBytes` now
(they used the default).
