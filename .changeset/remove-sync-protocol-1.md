---
'@korajs/core': patch
'@korajs/sync': patch
'@korajs/server': patch
'@korajs/devtools': patch
'@korajs/cli': patch
---

Remove sync protocol 1 (Kora 1.0.0-beta.12 and earlier). A server now refuses such a client at the handshake, before authentication, with the non-retriable `PROTOCOL_VERSION_UNSUPPORTED` and logs `session.protocol_refused`. Update those apps before upgrading the server. Operations those versions wrote keep their version-1 ids and stay valid: an updated device can still upload them, and any id the server cannot verify is refused with `INVALID_OPERATION_ID`.

Removed with it: `PROTOCOL_V1_DEPRECATED`, the `sync:protocol-deprecated` and `sync:unverified-legacy-operation` events, the `unverifiedLegacyOperations`, `legacyProtocolSessions` and `lastLegacyProtocolSessionAt` metrics, the `kora_legacy_protocol_sessions_total` and `kora_last_legacy_protocol_session_timestamp_seconds` gauges, and the protocol line in `kora status`.
