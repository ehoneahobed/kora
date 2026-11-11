---
"@korajs/sync": minor
"@korajs/server": minor
"@korajs/store": minor
"korajs": minor
---

Devices now recover from a server restored underneath them by any means, including database-level restores Kora never sees (`pg_restore`, point-in-time recovery, a copied SQLite file, a disk snapshot). Each delivery batch carries a delivery anchor, the id of the newest operation at or below its max sequence; the device keeps it with its watermark and reports it at handshake. A server whose log holds another operation there was restored and then written past the device's position, so it resyncs the device from 0 instead of resuming above writes the device never received. Nothing to configure; devices and servers from before anchors behave as before. New optional `ServerStore.getDeliveryAnchor` (memory, SQLite and Postgres stores implement it) and `SyncStatePersistence.loadDeliveryAnchors` / `saveDeliveryAnchor`.
