---
"@korajs/server": patch
---

Make relay delivery durable across reconnects, closing the remaining window in the
reliable-relay fix.

Reliable relay retransmits unacknowledged relay batches while the connection stays up,
but a relay dropped just before the client disconnected was lost with the session
(and delta sync on reconnect could not recover it, because a later operation had
advanced the client's version vector past the missing one). The server now buffers a
disconnecting client's unacknowledged relay operations by node id and, when that client
reconnects and reaches streaming, replays them through the normal relay path (re-filtered
by the reconnected session's current scope). The buffer is deduped by operation id,
bounded per node, and expired by age so a client that never returns cannot grow it.
