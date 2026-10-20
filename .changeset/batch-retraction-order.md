---
'@korajs/sync': patch
'@korajs/server': patch
'@korajs/store': patch
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
- A retracted record's visibility follows delivery order. Delivery batches carry each
  operation's delivery sequence and each retraction's; whichever is later, the record's latest
  delivered operation or its latest retraction, decides. A quarantined insert (undecryptable,
  no schema transform yet, a far-future timestamp) replayed after its record's retraction stays
  hidden, a duplicate re-delivery of an earlier operation does not show it, and any operation
  delivered after the retraction shows it again (`@korajs/store`, `@korajs/sync`).
- An insert onto an existing record (an explicit-id server write) now enters and leaves a
  device's view like an update: it gets a scope entry, or a retraction. Before, a record moved
  out of scope by such an insert was never retracted.
- For a client without the delivery watermark, a relay that retracts a record is sent only
  after every earlier relay carrying an operation of that record is acknowledged. A client that
  stops acknowledging is disconnected; its relays go to the bounded per-instance re-relay
  buffer.

Devices that already kept such a record are not repaired by re-scoping: the access narrowing,
a rules change and the `scopeExit: 'retract'` handshake narrowing all judge the record by the
values the device holds, which are its last in-scope values. Replaying the delivery stream from
watermark 0 against an upgraded server repairs them. The new
`KoraSyncServer.forceFullResync({ userId })` (or `{ nodeId }`) does that for already-shipped
watermark clients (1.0.0-beta.5 and later): their next handshake restarts delivery from 0, and live
sessions reconnect at once.
