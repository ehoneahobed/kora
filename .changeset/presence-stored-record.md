---
'@korajs/server': patch
---

Presence and side-channel writes are decided on the stored record (F16, round 3).

- A delivery pass's prefetched rows are passed down the pass instead of held on the session, so
  nothing running meanwhile reuses them. Before, a Yjs doc update could be authorized against a
  row the pass read before the record moved out of the writer's grant, and reach the new owner's
  devices; an upload's reference check and the presence decisions could read such a row too.
- Presence re-decisions after a write run one per record and never let an older read finishing
  last override a newer one; a cursor whose record moved while it was being read is read again.
  A row that writes keep overtaking is never used: the state is shown to nobody until a read
  that no write overtook decides it.
  Every write is noted before presence reads, through a shared `PresenceRecords` reader: one store
  read per burst of writes to a record however many cursors name it, cached until a write touches
  the record (one second at most), at most 16 at once.
- An awareness update the relay drops (stamped with another client's id) no longer repoints the
  sender's presence at the record it named. New `AwarenessRelay.accepts`.
