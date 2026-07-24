---
"@korajs/merge": patch
"@korajs/store": patch
---

Fix non-deterministic merges of plain-string richtext values, which could diverge
replicas.

When a richtext field is set to a plain string (a full replacement rather than a
collaborative Yjs edit), the merge engine converted it to a Yjs update with a random
clientId at merge time. Two replicas merging the same values could therefore produce
different bytes, a non-deterministic merge that never converges.

A plain-string richtext value is now resolved by last-write-wins (deterministic),
since a string replacement is not a collaborative edit. The CRDT merge is used only
when both sides are Yjs byte updates, which carry stable, baked-in clientIds. The
store also encodes a plain string to richtext bytes with a fixed clientId, so the same
string materializes to identical bytes on every device.
