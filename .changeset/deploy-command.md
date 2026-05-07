---
"@korajs/cli": minor
---

Add `kora deploy` command for one-command deployment to Fly.io and Railway.

Features:
- Full Fly.io and Railway adapters with provision, build, deploy, rollback, logs, and status
- Dockerfile generation with native dependency handling (better-sqlite3)
- Server bundling via esbuild with CJS compatibility shims
- Client build with SQLite WASM asset patching (OPFS proxy + unhashed wasm)
- Deploy state persistence for subsequent deploys
- Platform config generation (fly.toml, railway.json)
- Subcommands: `kora deploy status`, `kora deploy logs`, `kora deploy rollback`
- Non-interactive `--confirm` mode for CI/CD
