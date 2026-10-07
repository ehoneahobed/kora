---
'@korajs/server': patch
'@korajs/auth': patch
'@korajs/cli': patch
---

One default location for the template databases (F8, F10): every template, the Tauri one
included, now uses `./.kora/kora-server.db` and `./.kora/kora-auth.db` in `server.ts`,
`.env.example` and its README (the Tauri server used `./kora-server.db`, and two different
auth paths). `createSqliteServerStore`, `createSqliteUserStore` and `createSqliteOAuthStores`
create the directory of their database file, so these defaults work on a fresh checkout.
