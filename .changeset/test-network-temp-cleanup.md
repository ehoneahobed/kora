---
"@korajs/test": patch
---

`createTestNetwork` and `createMixedTestNetwork` no longer leave their `kora-test-*` temporary directory behind. A network whose creation fails (a device that refuses to open, for example) now closes what it started and removes its directory before the error propagates; `close()` removes the directory even when closing a device or the server throws (that error is still raised, and a failure to remove the directory is reported instead of ignored); and a network that is never closed has its directory removed when the process exits normally.
