# @korajs/cli

The `kora` command for Kora.js: scaffold apps, run the dev environment, generate migrations and
types, check a project, operate and deploy a sync server, and inspect data with Kora Studio.

## Install

Projects created with `create-kora-app` already have it as a dev dependency (`pnpm dev` runs
`kora dev`). Elsewhere:

```bash
pnpm add -D @korajs/cli@beta
```

## Quick start

```bash
npx create-kora-app@beta my-app   # or: kora create my-app
cd my-app
pnpm dev
```

## Commands

| Command | What it does |
|---------|--------------|
| `kora create [name]` | Scaffold from a bundled template (React, Vue, Svelte, with or without Tailwind and sync, or Tauri desktop). Works offline. |
| `kora dev` | Vite, the sync server (`server.ts` or a managed one from `kora.config.ts`) and the schema watcher. |
| `kora migrate` | Diff the schema against its snapshot and write up/down SQL, an operation-transform stub and a manifest; `--apply` runs them on the configured server databases. |
| `kora generate types` / `kora generate hooks` | Optional generated types and React hook stubs (types are already inferred from `defineSchema`). |
| `kora doctor` | Check the project setup and the sync server. |
| `kora status`, `kora logs` | A running server's status and live events. |
| `kora backup create \| restore \| info` | Server backups. |
| `kora compact` | Compact a local SQLite operation log after server acknowledgement. |
| `kora deploy` | Build and deploy to Fly.io, Railway, AWS ECS or AWS Lightsail (`status`, `logs`, `rollback`). |
| `kora studio` | Inspect a database, run a multi-device sync lab, or watch a live server. |
| `kora agents-md` | Write an `AGENTS.md` with Kora's rules for AI coding agents. |

Run `kora <command> --help` for options. The [CLI reference](https://korajs.dev/api/cli) documents
every flag.

## License

MIT
