---
'@korajs/cli': patch
---

Every app created with `create-kora-app` now starts with a `.gitignore`. It keeps `.env` and `.env.*` out of git (but keeps `.env.example`), along with local databases (`.kora/`, `*.db` and their WAL files), `node_modules`, build output and, for desktop apps, `src-tauri/target`. New apps write `KORA_AUTH_SECRET` to `.env` and their databases to `.kora/` on first run, and nothing kept those out of git before. The message shown when the app is created inside an existing git repository no longer claims a git initialization step the CLI never runs.
