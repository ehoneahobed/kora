---
'@korajs/auth': patch
---

`createKoraAuthSync` loads the stored session of an auth client nobody initialized. Sync waits while the client is `loading`, and only the auth provider (`@korajs/auth/react` and the other bindings) called `initialize()`, so an app that used the client directly (a desktop till, a plain script) stayed signed out of sync after every restart, with a valid session stored. Found on KoraPOS.
