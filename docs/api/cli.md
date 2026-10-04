---
title: CLI Reference
description: "Kora CLI reference: create, dev, migrate, generate, doctor, status, logs, backup, compact, deploy, studio and agents-md."
---

# CLI Reference

The `kora` command scaffolds, runs and operates Kora apps. Projects created with
`create-kora-app` have `@korajs/cli` as a dev dependency, so `kora` is available in their package
scripts (`pnpm dev` runs `kora dev`). To install it elsewhere:

```bash
pnpm add -D @korajs/cli@beta
```

Run `kora <command> --help` for the options of any command.

---

## create

```bash
npx create-kora-app@beta [name] [options]
# or, with the CLI installed:
kora create [name] [options]
```

`create-kora-app` is the same command. Without options it asks for the platform, framework,
styling, sync, database and package manager. Templates are bundled in the CLI, so scaffolding works
offline.

| Option | Description |
|--------|-------------|
| `--template <id>` | Skip the questions and use a template (below). |
| `--platform web\|desktop-tauri` | `desktop-tauri` uses the `tauri-react` template. |
| `--framework react\|vue\|svelte` | UI framework (`solid` is listed but not available yet). |
| `--tailwind` / `--no-tailwind` | Tailwind CSS or plain CSS. |
| `--sync` / `--no-sync` | Include a sync server. |
| `--db sqlite\|postgres` | Database of the sync server. |
| `--db-provider <name>` | For Postgres: `local`, `supabase`, `neon`, `railway`, `vercel-postgres`, `custom`. |
| `--auth none` | Only `none` is accepted today (`email-password` and `oauth` are listed but refused). |
| `--pm pnpm\|npm\|yarn\|bun` | Package manager. |
| `--yes`, `-y` | Accept the defaults: `react-tailwind-sync` and the detected package manager. |
| `--skip-install` | Do not install dependencies. |

| Templates | |
|-----------|---|
| React | `react-basic`, `react-sync`, `react-tailwind`, `react-tailwind-sync` |
| Vue | `vue-basic`, `vue-sync`, `vue-tailwind`, `vue-tailwind-sync` |
| Svelte | `svelte-basic`, `svelte-sync`, `svelte-tailwind`, `svelte-tailwind-sync` |
| Desktop | `tauri-react` |

Every template is a todo app with DevTools enabled in development. Sync templates add `server.ts`
(a `createProductionServer` that also mounts `@korajs/auth` routes when `KORA_AUTH_SECRET` is set,
and Google OAuth when its variables are set) and `.env.example`. A project
contains `src/schema.ts`, `src/main.*`, the feature module under `src/modules/todos/`,
`src/kora-worker.ts` (the SQLite WASM worker), `kora.config.ts`, `AGENTS.md` and `README.md`.
[Getting Started](/getting-started) walks through the first run.

---

## dev

```bash
kora dev [--port 5173] [--sync-port 3001] [--no-sync] [--no-watch]
```

Starts Vite and, when sync is enabled, the sync server: the project's `server.ts` (run with `tsx`),
or a managed server from `kora.config.ts` (`dev.sync.store`: `memory`, `sqlite` or `postgres`) when
there is no `server.ts`. It also watches the schema and regenerates `kora/generated/types.ts`.

```typescript
// kora.config.ts
import { defineConfig } from 'korajs/config'

export default defineConfig({
  schema: './src/schema.ts',
  dev: {
    port: 5173,
    sync: { enabled: true, port: 3001, store: { type: 'sqlite', filename: './kora-dev.db' } },
    watch: { enabled: true, debounceMs: 300 },
  },
})
```

---

## migrate

```bash
kora migrate [--dry-run] [--apply] [--schema <path>] [--db <sqlite path>] [--output-dir kora/migrations] [--force]
```

Compares the schema with its last snapshot (`kora/schema.snapshot.json`; the first run only
creates the snapshot) and lists the changes:

```
Detected schema change: v1 → v2
Changes:
  + todos.priority
  ~ todos.tags
```

It then writes, under `kora/migrations/`:

- `NNN-vA-to-vB.ts`: the generated `up` and `down` SQL statements, a `summary` and
  `containsBreakingChanges`
- `NNN-vA-to-vB.transforms.ts`: an `OperationTransform` stub for servers that accept clients on the
  older version
- `NNN-vA-to-vB.json`: the manifest `--apply` uses

A change to a field's value domain only (enum values, required/optional, default) produces no
table rebuild: the migration holds a `--kora:relax-value-domain {"table": ..., "fields": [...]}`
directive, which `--apply` expands against each backend's catalog inside the migration's
transaction (SQLite: rebuild the table without the enum `CHECK` / `NOT NULL` that beta.12 DDL
created; Postgres: drop them), and which does nothing on a table that has none. Adding enum
values or making a field optional is not breaking; removing an enum value is (rows keep it, new
writes of it are refused).

Removing a field or changing its type is breaking: the command asks for confirmation (or needs
`--force`; without a terminal it fails). `--dry-run` writes nothing. `--apply` runs the pending
migrations against the configured databases: a SQLite file (`--db`, or the config) and Postgres
when `kora.config.ts` sets `dev.sync.store` to Postgres (its `connectionString`, or `DATABASE_URL`).

Devices do not use these files: an app's local database migrates when it opens, from the
`migrations` you declare in `defineSchema()` with `migrate()` (see
[Schema Design](/guide/schema-design#migrations)).

---

## generate

```bash
kora generate types [--schema <path>] [--output kora/generated/types.ts]
kora generate hooks [--schema <path>] [--output kora/generated/hooks] [--types ../types]
```

`types` writes `<Collection>Record`, `<Collection>InsertInput` and `<Collection>UpdateInput`
interfaces per collection (for example `TodosRecord`). They are optional: `createApp({ schema })`
already infers every collection type from `defineSchema()`. `hooks` writes per-collection React hook
stubs.

---

## doctor

```bash
kora doctor [--url http://localhost:3001] [--skip-network]
```

Checks the project root, `kora.config`, the schema, the SQLite WASM worker, dependency versions
and, unless `--skip-network`, the sync server and its schema version. Exits non-zero when a check
fails.

---

## Operating a server

These commands talk to a running production server's operational endpoints. Tokens default to
`KORA_ADMIN_TOKEN` (and `KORA_BACKUP_TOKEN` for backups).

| Command | Description |
|---------|-------------|
| `kora status [--url] [--watch] [--token]` | Server status: connections, operations, schema version. `--watch` refreshes live. |
| `kora logs [--url] [--follow] [--level info\|warn\|error] [--token]` | Streams server events. |
| `kora backup create [--url] [--out file.kora] [--token]` | Downloads a backup. |
| `kora backup restore --file <path> [--url] [--merge] [--token]` | Restores one (replaces data unless `--merge`). |
| `kora backup info --file <path>` | Shows a backup's manifest. |

See [Backup and Restore](/guide/backup-restore) and [Production Server](/guide/production-server).

---

## compact

```bash
kora compact --db <local sqlite path> [--schema <path>] [--strategy after-ack|after-days|never] [--days 30]
# defaults: --strategy after-ack, --days 30
```

Compacts a local SQLite database's operation log once the server has acknowledged the operations.

---

## deploy

```bash
kora deploy [--platform fly|railway|aws-ecs|aws-lightsail] [--app <name>] [--region iad] [--prod] [--confirm] [--reset]
kora deploy status
kora deploy logs
kora deploy rollback [id]
```

Generates a Dockerfile, bundles `server.ts`, builds the client with Vite, provisions the app and
deploys it. `--confirm` is non-interactive (for CI) and fails on missing data. State is kept in
`.kora/deploy/` (add it to `.gitignore`); `--reset` deletes it. `render`, `docker` and `kora-cloud`
are listed but not implemented. The project needs a `server.ts` (or `src/server.ts`) and Vite. The
[Deployment guide](/guide/deployment) walks through a first deploy.

| Platform | Requirement |
|----------|-------------|
| Fly.io | `flyctl`, `fly auth login` |
| Railway | `@railway/cli`, `railway login` |
| AWS ECS, AWS Lightsail | Docker running, AWS CLI with `aws configure` (Lightsail also needs `lightsailctl`) |

---

## studio

```bash
kora studio --db path/to/kora.db                       # file mode: inspect a database (read only)
kora studio --lab [--devices 3] [--schema ./src/schema.ts]  # an interactive multi-device sync lab
kora studio --connect wss://host/kora-sync --schema ./src/schema.ts [--token ...]  # live read-only replica
```

Shows records with each field's last writer, operation history, the causal graph, the merge audit
trail and sync state, on `--port` (default 4321). See [Kora Studio](/studio). File mode needs
`better-sqlite3`; lab mode needs `@korajs/test` and `@korajs/server`.

---

## agents-md

```bash
kora agents-md [--framework react|vue|svelte] [--force]
```

Writes an `AGENTS.md` with Kora's rules for AI coding agents into the project (see
[AI Agents](/guide/ai-agents)). `--force` overwrites an existing file.
