# @korajs/cli

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
