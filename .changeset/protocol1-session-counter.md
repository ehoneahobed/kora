---
'@korajs/server': patch
'@korajs/cli': patch
---

Count protocol-1 sessions, and close the SQLite server store's database:

- The server counts sessions that hand-shake on deprecated sync protocol 1 (Kora 1.0.0-beta.12
  and earlier): `legacyProtocolSessions` and `lastLegacyProtocolSessionAt` (epoch ms, or null) in
  `ServerMetricsSnapshot` and `getStatus()` (so `/__kora/status` and `kora status`), and
  `kora_legacy_protocol_sessions_total` / `kora_last_legacy_protocol_session_timestamp_seconds` on
  `/__kora/metrics`. Each connected client in the metrics snapshot carries the `protocolVersion`
  it declared. The counter is in memory and per process, like the other metrics; the
  `session.protocol_deprecated` log event remains the record across restarts. Protocol 1 is
  removed once production servers report none for long enough.
- `SqliteServerStore.close()` now closes the database connection that `createSqliteServerStore`
  opened (checkpointing the WAL and releasing the file). A store constructed on a caller's own
  Drizzle connection still leaves that connection to the caller.
