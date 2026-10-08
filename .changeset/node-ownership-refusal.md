---
"@korajs/server": patch
"@korajs/sync": patch
"@korajs/store": patch
"korajs": patch
---

A `NODE_ID_CLAIMED` refusal now says whether another user owns the node
(`nodeOwnership: 'other-principal'`) or it only has history with no recorded owner
(`'unowned'`). A store with a pinned node id (the `createKoraAuthSync` device id) cannot move to
a fresh node, so after `'other-principal'` it refuses local writes (`NODE_OWNED_BY_ANOTHER_USER`)
instead of storing them under a node whose writes could only upload as its owner; the server
accepting the node again lifts it. An `'unowned'` refusal (a beta.12 node awaiting handover or a
bind) keeps writes on.
