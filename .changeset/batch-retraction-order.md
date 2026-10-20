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
- A quarantined insert (undecryptable, no schema transform yet, a far-future timestamp) whose
  record was retracted later in the same batch no longer shows the record when the quarantine
  replays it: a record retracted before its insert stays hidden until a server scope entry
  brings it back (`@korajs/store`).
- For a client without the delivery watermark, a relay that retracts a record is sent only
  after every earlier relay carrying an operation of that record is acknowledged, so a lost and
  retransmitted relay (an HTTP long-poll response) cannot land after the retraction.

Devices that already kept such a record are not repaired by re-scoping: the access narrowing,
a rules change and the `scopeExit: 'retract'` handshake narrowing all judge the record by the
values the device holds, which are its last in-scope values. Replaying the delivery stream from
watermark 0 against an upgraded server repairs them. The new
`KoraSyncServer.forceFullResync({ userId })` (or `{ nodeId }`) does that for already-shipped
watermark clients (1.0.0-beta.5 and later): their next handshake restarts delivery from 0, and live
sessions reconnect at once.
