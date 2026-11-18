---
'korajs': patch
---

Docs: `sync.bulkReplication` is on by default only for a browser OPFS database. Node's native SQLite stages a first sync only when the option is set, and IndexedDB and Tauri databases never stage. The guide and JSDoc had said native SQLite staged by default.
