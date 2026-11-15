---
"korajs": minor
"@korajs/tauri": minor
---

`app.storage.deleteDatabase()` works in Tauri apps (native SQLite): it deletes the database file and SQLite's companion files from the app's data directory, with the same refusals as in a browser (open database, unsynced writes unless `force`). An app can now erase one device's copy, for a "reset this device" button, without writing deletes that sync to the server and every other device. The Tauri plugin adds `inspect` and `delete` commands (in `kora-sqlite:default`); `@korajs/tauri` exports `inspectTauriDatabase`, `readTauriDatabase` and `deleteTauriDatabase`.
