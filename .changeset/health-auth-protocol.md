---
"@korajs/server": minor
"@korajs/cli": minor
---

`/health` on the sync server now reports `authRequired` (a boolean: an auth provider guards the sync handshake) and `protocolVersion` (the highest sync protocol the server speaks), and `getStatus()` carries both. They are additive and leak no secret. `kora doctor --production --url` uses them: `authRequired` lets its credential-free probe verify handshake authentication, and `protocolVersion` replaces the protocol it derived from the version string (a malformed value is ignored, and servers that do not report either field keep the old behavior).
