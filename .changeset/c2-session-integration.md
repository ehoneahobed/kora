---
"@korajs/server": patch
---

Delivery visibility index (C2.5 to C2.7): access-rules sessions and the handshake pre-pass now read through the index. An access session reads the sources of its grant, of its memberships (one key per case of `operationTouchesMemberships`: rows naming the user, a group owned by or transferred to or from the user, deletion or restore of a held group, revival of a group the user holds only a row for) and of its own node, and a membership change ends the chunk so the next read uses the sources of the new grant. `collectVisibleNodeIds` reads through the index to its covered frontier, then the global scan for the tail. `delivery.partition_miss` is logged once per store, collection and field. Every read the index cannot fully answer still falls back to the global scan, and `filterDeliveryChunk` stays the only authority on what a session receives.

The delivery poll now indexes the gap an older instance leaves during a rolling deploy (`ServerStore.catchUpDeliveryIndex`), at the cost of one read when there is none.
