# @korajs/cli

## 0.3.1

### Patch Changes

- fix(server): use BIGINT for PostgreSQL timestamp columns to prevent overflow

  - **server**: Fixed critical bug where PostgreSQL `INTEGER` columns overflowed for millisecond timestamps (wall_time, received_at, last_seen_at). Now uses `BIGINT`.
  - **server**: Added `/health` endpoint to production server.
  - **auth**: Added `UserStore` interface with `createSqliteUserStore` and `createPostgresUserStore` factory functions.
  - **core**: Added `sync:auth-failed` event for detecting stale auth tokens.
  - **sync**: Sync engine now emits `sync:auth-failed` when the server rejects authentication.
  - **cli**: Added AWS ECS Fargate and Lightsail Container deploy adapters.
  - **cli**: Docker builds now use `--platform linux/amd64` for Apple Silicon compatibility.
  - **cli**: Lightsail adapter forwards `DATABASE_URL`, `AUTH_SECRET`, `PUBLIC_URL` environment variables to containers.
  - **cli**: Fixed trailing slash in Lightsail URLs causing double-slash in sync endpoint.

- Updated dependencies
  - @korajs/core@0.3.1

## 0.3.0

### Patch Changes

- 6a05e88: Performance: Replace O(n²) topological sort with binary heap in @korajs/core (19x faster sync for large operation sets).

  New: @korajs/auth package with sessions, TOTP MFA, organizations, RBAC, passkeys, encrypted tokens, and E2E operation encryption (912 tests).

  New: Full Preact-based DevTools UI panel with sync timeline, conflict inspector, operation log, and network status.

  Docs: Comprehensive documentation refinement — added API references for merge, sync, auth, and devtools; added authentication guide; expanded sync configuration guide; updated all package descriptions.

- Updated dependencies [6a05e88]
  - @korajs/core@0.3.0

## 0.2.0

### Minor Changes

- 6fb50fd: Add `kora deploy` command for one-command deployment to Fly.io and Railway.

  Features:

  - Full Fly.io and Railway adapters with provision, build, deploy, rollback, logs, and status
  - Dockerfile generation with native dependency handling (better-sqlite3)
  - Server bundling via esbuild with CJS compatibility shims
  - Client build with SQLite WASM asset patching (OPFS proxy + unhashed wasm)
  - Deploy state persistence for subsequent deploys
  - Platform config generation (fly.toml, railway.json)
  - Subcommands: `kora deploy status`, `kora deploy logs`, `kora deploy rollback`
  - Non-interactive `--confirm` mode for CI/CD

## 0.1.11

### Patch Changes

- Add Tailwind CSS templates, polished dark-themed UI, --yes/--tailwind/--sync flags, devtools enabled by default, and persistent SQLite server stores in sync templates.

## 0.1.3

### Patch Changes

- Fix Windows compatibility for kora dev command (resolve .cmd shims, spawn with shell)

## 0.1.2

### Patch Changes

- Fix template path resolution in create-kora-app and add package READMEs
- Updated dependencies
  - @korajs/core@0.1.2

## 0.1.1

### Patch Changes

- Add create-kora-app package for npx support

## 0.1.0

### Minor Changes

- Initial release

### Patch Changes

- Updated dependencies
  - @korajs/core@0.1.0
