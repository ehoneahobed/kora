---
'@korajs/tauri': patch
---

The Kora SQLite Tauri plugin's `open` command now refuses a parent (`..`), absolute or empty database path, as `inspect` and `delete` already did. Database connections also refuse `ATTACH` and `VACUUM INTO`, because those could read or write any file the app can reach. Kora never uses them. Even a compromised webview can no longer open or write a database outside the app's data directory.
