---
'@korajs/tauri': patch
---

The Tauri SQLite adapter now queues `execute`, `query` and `migrate` behind an open transaction, as the browser adapter does. Before, a standalone write sent while a transaction was open ran inside it, so a ROLLBACK lost the write, and a read could see uncommitted rows. The plugin's database commands now also run on Tauri's async runtime instead of the main thread, so a slow query no longer freezes the window. Rebuild the app to pick up the plugin change.
