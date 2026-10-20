---
'@korajs/sync': patch
'@korajs/server': patch
---

Retractions apply in stream order within a delivery batch. A client applied every retraction of
a batch before the batch's operations, so a record that entered the device's view and left it
again within one batch (inserted, then moved out of scope) was retracted before its insert and
then materialized: the device kept a record outside its view. This affects access-rule
collections and `scopeExit: 'retract'`.

- Each retraction now carries `afterOperations`, its position among the batch's operations, and
  the client applies operations and retractions in that order. The client declares this with
  `orderedRetractions` in its handshake.
- For a client that does not declare it, the server cuts the delivery batch (and splits a relay)
  before a retraction whose record has an earlier operation in it, so older clients converge
  too.
- A retraction without a position (from an older server) still applies before the operations.

Devices that already kept such a record are corrected by the record's next scope change or a
full resync.
