---
"@korajs/cli": patch
---

`kora import --platform kora-cloud --accept-unverified <count>` accepts exactly the operations a refused import reported as not matching their content hashes (written by the app's own scripts around the server's checks). Kora Cloud keeps checking them for later changes.
