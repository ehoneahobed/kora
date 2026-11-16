---
'@korajs/server': patch
---

Server hardening:

- A damaged or truncated backup is refused (`BACKUP_CHECKSUM_MISMATCH`, HTTP 400 on the import route) before anything changes. Before, a replace-mode restore of a cut-off file emptied the store and reported success.
- An interrupted upload is never processed, and a malformed `Host` header on a WebSocket upgrade no longer crashes the process. `stop()` ends open dashboard feeds, and a static file read error no longer crashes the process.
- A handshake with `lastDeliverySequence: null` can no longer bypass the access-rules history gate.
- A malformed frame closes the connection, a session closed mid-handshake stays closed, and a non-numeric acknowledgment is ignored.
- The Postgres store's `close()` ends the client it opened.
