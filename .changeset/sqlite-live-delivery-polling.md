---
"@korajs/server": patch
---

Make live sync resilient to valid operations appended through another server-store
instance.

SQLite server stores now allocate `delivery_seq` values from a durable
`delivery_counter` table inside the append transaction instead of from an
in-memory counter. Multiple `SqliteServerStore` instances sharing the same
database file therefore reserve unique, monotonic delivery sequences, and backup
restore reseeds the durable counter.

`KoraSyncServer` now exposes `relayRetransmitIntervalMs` and
`deliveryPollIntervalMs` options. The default remains 2000ms for compatibility,
but the hard-coded relay tick has been split from delivery-log polling. Live
servers poll the authoritative delivery log and wake delivery-watermark clients
to rescan from their acknowledged cursor, so externally appended operations are
delivered without a server restart while session scope filtering remains intact.

`createProductionServer().start()` now rejects listen errors instead of leaving
startup pending forever when the port cannot be bound.
