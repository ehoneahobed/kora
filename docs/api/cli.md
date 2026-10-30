---
title: CLI Reference
description: "Kora CLI reference: create, dev, migrate, generate, doctor, upgrade, status, logs, backup, compact, deploy, studio and agents-md."
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

## Vite plugins (`@korajs/cli/vite`) {#vite}

- `koraServiceWorker(options?)`: the offline app shell (see
  [Offline patterns](/guide/offline-patterns)). The generated worker verifies and heals its own
  precache (digest-checked) and reports its state to `app.offline` as `globalThis.__KORA_SHELL__`
  (`v: 1`); every template renders an `<OfflineBadge />` from it. It also stamps the build id the
  version gate uses (`buildId: false` opts out). On a first visit the worker is registered only
  after the app's first data (the `kora:first-data` event `createApp()` dispatches), at most
  `firstDataTimeoutMs` (default 10000) after `load`, so the precache never competes with it; the
  precache reuses the HTTP cache (each file kept only when its SHA-256 matches the build) and
  downloads byte-identical files, such as the unhashed `sqlite3.wasm` copy, once.
- `koraBuildId()`: only the build id, for apps without the offline shell. After the build is
  written, every page gets `<meta name="kora-build" content="<hash of every deployed file>">`
  (HTML pages hashed with the id normalized; the generated `sw.js` excluded); in `vite dev`, `dev-<server start>`. `createApp()` reads it
  when no `build` option is given. See [App updates and multiple tabs](/guide/app-updates).

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
directive (it also lists the collection's `"enums"`, the enum fields of both schema versions),
which `--apply` expands against each backend's catalog inside the migration's transaction
(SQLite: rebuild the table without the enum `CHECK` / `NOT NULL` that beta.12 DDL created,
keeping every other `CHECK`;
Postgres: drop them, including the `col = 'x'` form Postgres stores a one-value enum check in),
and which does nothing on a table that has none. Adding enum
values or making a field optional is not breaking; removing an enum value is (rows keep it, new
writes of it are refused).

Any other change to an existing collection (a field added, removed or retyped, an index added or
removed) is a `--kora:evolve-table` step, which `--apply` also expands against each database's live
catalog in the migration's transaction. It changes only the fields and indexes it names; every other
column (Kora's own `_version`, `_field_versions`, `_created_at`, `_updated_at`, `_deleted`),
foreign key, index and trigger stays as it is, and so do the operation log, the fold state and every
other `_kora_*` table:

- Postgres: `ADD COLUMN`, `DROP COLUMN`, `ALTER COLUMN ... TYPE ... USING` with the server store's
  column types (`BIGINT`, `DOUBLE PRECISION`, `JSONB`, `BYTEA`).
- SQLite: `ADD COLUMN` when fields are only added; otherwise the table is rebuilt from its catalog
  (SQLite's documented procedure), copying every column it does not name. Indexes on a removed field
  are dropped with it. `CHECK` constraints added by hand are kept, except one that reads a removed
  field, which is dropped with it.
- A retyped field's existing values are converted (`'yes'` to `1`, `'12.5'` to `12.5`). A text that
  is not a number becomes `0` on SQLite (its cast) and the field's default, or `NULL`, on Postgres;
  an unrecognised boolean word becomes the default, or `NULL`, on both. These are only the rows'
  starting values: servers and devices re-fold every record of the collection from its operations at
  their next start, because the fold plan changed.
- Running the step again on a table that already has the target shape changes nothing.

Migrations generated by an earlier `kora migrate` rebuilt the table with fixed SQLite statements
(`_kora_mig_<collection>_new`); `--apply` refuses those on Postgres. Regenerate them (restore
`kora/schema.snapshot.json` to the version they migrate from, delete their files, run `kora migrate`).

Removing a field or changing its type is breaking: the command asks for confirmation (or needs
`--force`; without a terminal it fails). `--dry-run` writes nothing. `--apply` runs the pending
migrations against the configured databases: a SQLite file (`--db`, or the config) and Postgres
when `kora.config.ts` sets `dev.sync.store` to Postgres (its `connectionString`, or `DATABASE_URL`).
Stop the sync servers on that database before `--apply` and start them with the new schema
after it: a server judges access rules against records and an index it builds at start, and a
running one is not told the tables changed.

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
kora doctor [--url http://localhost:3001] [--skip-network] [--strict] [--json]
kora doctor --db <database> [--migrations kora/migrations] [--dry-run-migrations] [--strict]
kora doctor --production [--url https://sync.example.com]
```

Checks the project root, `kora.config`, the schema, the SQLite WASM worker, dependency versions
and, unless `--skip-network`, the sync server and its schema version. Exits non-zero when a check
fails; `--strict` also exits non-zero on a warning (with `--db`, on a warning of the database preflight only, so a project-layout warning never blocks a deploy).

`--json` prints one JSON document instead of text, for CI: `{ "projectRoot", "ok", "summary":
{ "pass", "warn", "fail", "skip" }, "checks": [{ "id", "title", "status", "message", "fix?" }] }`.
Check ids are stable, `status` is `pass`, `warn`, `fail` or `skip`, and the exit code is the same
as in text mode (`ok` is `false` exactly when it is non-zero).

### One schema: `schema-duplicates`

Warns when more than one `defineSchema()` call in the project's source files declares the same
collection names, listing every `file:line`. A client schema and a server schema written twice
drift apart (a field or constraint added to one is missing on the other). Keep one exported
schema (`src/schema.ts`) and import it in the client app, the sync server entry and
`kora.config.ts`, as every template does; see
[One schema for the client and the server](/guide/schema-design#one-schema-for-the-client-and-the-server).
It skips `node_modules`, `dist`, `build`, `fixtures` directories, `*.test.*` / `*.spec.*` files and
declaration files, and ignores a `defineSchema` that appears only in a comment or a string. Two
schemas with different collection names do not trigger it; two workspace packages that both
define a collection of the same name do, so share the schema module between them.

### Production preflight: `--db`

`kora doctor --db` checks the sync server's database against the app you are about to deploy,
before you deploy it. Run it from the app's directory, in CI or by hand:

```bash
kora doctor --db env:DATABASE_URL        # read the URL from a variable (keeps it out of logs)
kora doctor --db postgres://user:pass@db.example.com/app?search_path=kora
kora doctor --db ./.kora/kora-server.db  # SQLite file (or sqlite:/path, file:/path)
```

The database is opened **read-only**: Postgres in one `REPEATABLE READ READ ONLY` transaction
that is rolled back (with a 10 s lock timeout, so it never queues behind the server's own
startup), SQLite with a read-only connection and `query_only`. Nothing is written and no DDL
runs. The password of a URL is never printed. The app needs the driver it already uses for the
server (`postgres` or `better-sqlite3`). With `--db`, the sync server probe runs only when
`--url` is given.

| Check | Fails when | Warns when |
|-------|-----------|------------|
| Database | It is not reachable, or has no Kora `operations` table (wrong database or Postgres schema). | |
| Schema drift | An existing column's type is not what its field kind needs (a kind change without `kora migrate --apply`; the server does not convert columns on start). | The log holds operations of a newer schema version than the app (a rollback). New tables and columns, and columns the schema dropped, are listed only. |
| Constraint where clauses | A unique or capacity `where` can never select a record: `null` (SQL `= NULL`), a boolean (stored as 0/1, not bindable), a json/array/object/richtext field, a value of the wrong type, an enum value the enum does not have. | |
| JSON values stored as strings | | Live rows of `t.json()` / `t.object()` fields read back as JSON-encoded strings (F14, see `findJsonStringValues`). A string is also a valid json value: check what the app writes. |
| Ownerless nodes | | Device node ids hold history but no owner: on a beta.12 database (no `node_claims` table), or on an authenticated server whose app does not use `@korajs/auth` (which hands such nodes over by itself). |
| Protocol-1 clients | | Devices whose latest write received since the database's first beta.13+ start is still a version-1 operation (Kora <= beta.12), judged by server receipt order, not device clocks. Read-only clients leave no trace, and a database never served by beta.13+ is reported as not determinable. |
| Quarantined operations | | Rows sit in `operations_quarantine`. |
| Pending migrations | | Generated migrations not recorded in `_kora_migrations` change a field's kind. Additive ones are fine: the server applies those itself on start. |
| Migration dry run (only with `--dry-run-migrations`) | | A step fails, the steps take **60 s or more**, or a Postgres table stays locked ACCESS EXCLUSIVE (or EXCLUSIVE, SHARE) for **5 s or more**. See below. |
| Startup migration dry run | | The next start will re-fold records, rebuild scope snapshots, run first-upgrade passes or rewrite a table, for an estimated **more than 60 s** before `/health` answers. The estimate (records, operations, rich-text operations and a duration) is printed either way. |

The duration is a rough estimate from rates measured on 2 cores (about 5,000 scalar operations
and 300 rich-text operations re-folded per second); a slower or remote database can take
several times longer. It cannot see changes only the server's configuration makes (operation
transforms added for the first time, explicit `authoritativeNodeIds`), and custom resolver
source is not compared (a TypeScript schema reaches the CLI as JSON). See
[Startup re-materialization](/guide/production-server#startup-re-materialization-upgrading-from-beta-12-or-changing-merge-rules).

In CI, before the deploy step:

```bash
npx kora doctor --db env:DATABASE_URL --strict
```

### Migration dry run: `--dry-run-migrations`

The checks above read; this one writes, to something disposable, so it is opt-in. With `--db`,
`--dry-run-migrations` takes the generated migrations (`kora/migrations`) that the database has
not recorded in `_kora_migrations`, and runs the same steps `kora migrate --apply` would run:

- **SQLite:** on a private **copy** of the file (and its `-wal` file), in the temp directory.
  The live file is only read, and the copy is deleted afterwards. The copy needs as much free
  disk space as the database. Copy while the server is stopped for an exact snapshot.
- **Postgres:** inside `BEGIN` ... `ROLLBACK` on one connection, with `statement_timeout` (120 s)
  and `lock_timeout` (10 s) guards. Nothing is committed. A rolled-back transaction still
  takes real locks while it runs: an `ALTER TABLE` holds ACCESS EXCLUSIVE on the table, which
  blocks every read and write of it until the dry run ends. Run it against a restored backup or
  a replica when the table is busy.

It reports, per step: what it does, the rows of its table (exact on SQLite, the planner's
estimate on Postgres), how long it took, and on Postgres the strongest lock the transaction holds
on the table (read from `pg_locks`) and how long it is held until the end of the migration's
transaction. The total is the estimate for the real run on this data: it was measured, not
modelled, but a copy in the temp directory can be faster than the production disk. A failed step
is reported with its message and the later steps are not run; `kora migrate --apply` would fail
there too and roll back.

The dry run **refuses nothing by itself**: its worst result is a warning. `--strict` is what
turns a warning into a non-zero exit. Check id: `db-migration-dry-run`.

### Production audit: `--production`

`kora doctor --production` audits what a deploy depends on. Each check is independent, has a
stable id, and does not need the schema to load.

| Check id | Warns when |
|----------|-----------|
| `production-access` | The schema has no server-enforced access rules. |
| `production-auth` | `@korajs/auth` is not a dependency (a custom `AuthProvider` may still be valid). |
| `production-worker-delivery` | The build output (`dist/`, or Vite's `build.outDir`) lacks the SQLite WASM binary, the unhashed `assets/sqlite3.wasm` the loader requests or a `*worker*.js` script; it holds TypeScript files; or a host file (`_headers`, `vercel.json`, `netlify.toml`, `nginx.conf`, `Caddyfile`, ...) serves `.wasm` with a media type other than `application/wasm`. Skipped when nothing is built, or when the app forces the `indexeddb` or `sqlite-native` adapter. |
| `production-isolation-headers` | Only when the app's own code uses `SharedArrayBuffer`, `crossOriginIsolated` or `Atomics.wait` and no COOP/COEP header is set by the host files or `createProductionServer`; or when `Cross-Origin-Embedder-Policy: require-corp` is set although nothing needs isolation (it blocks cross-origin images and embeds). Kora's `sqlite-wasm` adapter uses the `opfs-sahpool` VFS, which needs no `SharedArrayBuffer`, so COOP/COEP are **not** required for it and never asked for. |
| `production-runtime-storage` | `store.allowNonDurable: true` is set, the `indexeddb` adapter is forced, or a non-local sync URL in the source or `.env*` files is `ws://` / `http://`. These are static checks only: whether OPFS is available is known in the browser (watch for `store:storage-fallback`). |

With `--url`, the audit also probes the deployed server. It sends no credentials (no
`Authorization` header, no cookies, credentials in the URL are dropped), gives each request 5 s,
and treats an unreachable network or a timeout as a **warning**, so it is safe offline and in CI.
`--url` replaces the dev-server status probe in this mode (that endpoint needs an operational
token). Pass a `ws(s)://` sync URL or an `http(s)://` origin.

| Check id | What it reads |
|----------|---------------|
| `production-server-health` | `GET /health`: reachable, a Kora health document (`status: "ok"`), the server version. A 5xx is a failure; a 404 or a non-Kora body is a warning (a CDN or proxy path, not the server). |
| `production-server-protocol` | The sync protocol the server speaks (the `protocolVersion` it reports in `/health` since 1.0.0-beta.15, else derived from its version: 1 up to `1.0.0-beta.12`, 2 from `1.0.0-beta.13`) against the protocol of the app's installed client; a protocol-1 server for a protocol-2 app warns, as does a server build that differs from the app's `@korajs/server`. |
| `production-server-auth` | `GET /__kora/status` without a token: `200` warns (the operational endpoints are public); `401`/`403` is expected. The `authRequired` boolean in `/health` (reported since 1.0.0-beta.15) is how the probe verifies handshake authentication without credentials: `true` passes, `false` warns that anyone who finds the URL can sync. Handshake authentication happens inside the sync protocol, which a credential-free HTTP request cannot exercise, so an older server that does not report the field is noted as unverified. |

---

## upgrade

```bash
kora upgrade [--tag latest|beta|canary | --to <version>] [--dry-run] [--yes]
             [--allow-downgrade] [--apply-codemods]
```

Moves every Kora package in the project to **one** version, runs your package manager's install,
reports what the new version changed in your code, and finishes with `kora doctor`. Mixed Kora
versions (`korajs` on one beta, `@korajs/react` on another) are what this prevents.

What it does, in order:

1. **Detects the package manager** from the `packageManager` field, else the nearest lockfile
   (`pnpm-lock.yaml`, `yarn.lock`, `bun.lock`/`bun.lockb`, `package-lock.json`), else the one that
   launched the command. A lockfile or `pnpm-workspace.yaml` is taken only from the project itself
   or from a workspace root above it that lists the project (`workspaces` or `packages` globs), and
   the search stops at the repository root, so a stray file in a parent directory is ignored.
2. **Finds every Kora specifier**: `korajs` and `@korajs/*` in `dependencies`, `devDependencies`
   and `optionalDependencies`, in `overrides`, `pnpm.overrides` and `resolutions` (an old override
   would silently pin a package), and in the `catalog`, `catalogs` and `overrides` of a
   `pnpm-workspace.yaml` at or above the project. `create-kora-app` is a scaffolder, not a
   dependency, and is never touched. `workspace:`, `file:`, `link:`, dist-tag and `catalog:`
   references are listed and left alone.
3. **Resolves one target version** from the registry: `--tag` (default `beta` when you are on a
   prerelease, otherwise `latest`) or an exact `--to`. Every package must resolve to the same
   version; if a tag points at different versions per package (a half-published release) the command
   stops and asks for `--to`. `--to` never contacts the registry (it works offline; the install
   reports a version that does not exist). A target older than what you have is refused unless
   `--allow-downgrade`.
4. **Prints the plan**, then the upgrade diagnostics below. `--dry-run` stops here: nothing is
   written, no install, no doctor.
5. **Rewrites the versions** and asks for confirmation (`--yes` skips it; a non-interactive shell
   without `--yes` refuses). Each specifier keeps its own style (`^`, `~` or exact) and the file keeps
   its bytes: only the version string changes. A specifier that cannot be located exactly once
   (a duplicate key, a file that changed) is refused, and if a write fails the files already written
   are restored. Mixed styles and mixed current versions are warned about, as are nested or selector
   overrides (`**/@korajs/core`) that the command cannot rewrite.
6. **Runs the install** (`npm install`, `pnpm install --no-frozen-lockfile`, `yarn install`,
   `bun install`) in the directory that holds the lockfile. Lockfiles and `node_modules` are never
   edited directly.
7. **Runs `kora doctor --skip-network`** from the upgraded CLI. If install or doctor fails, the
   command exits non-zero with the reason and lists every file it modified and how to restore them.
   A project without the `kora` binary gets a distinct message with the `@korajs/cli` install
   command, not a "doctor found problems" one.

For what changes between releases and what to do about it, read the upgrade guide for your target:
[Upgrading to beta.15](/guide/upgrading-to-beta15) (from beta.14) or
[Upgrading to beta.13](/guide/upgrading-to-beta13).

```bash
npx kora upgrade --dry-run          # see the plan and diagnostics
npx kora upgrade --yes              # upgrade to the beta/latest tag, install, run doctor
npx kora upgrade --to 1.0.0-beta.15 # an exact version
npx kora upgrade --tag canary       # the canary dist-tag
```

### Upgrade diagnostics

Codemods live in `packages/cli/src/upgrade/codemods/`. A codemod runs only when the upgrade crosses
the release that introduced its change, scans your source files read-only and prints findings with a
documentation link. None of the built-in ones rewrite code: a rewrite is only offered when it cannot
change behavior, and these cannot be proven safe from source alone.

| Id | Looks for | Why it is a diagnostic |
|----|-----------|------------------------|
| `wire-format-serializers` | `DynamicProtobufSerializer` (removed in beta.13); `ProtobufMessageSerializer` / `NegotiatedMessageSerializer` (no longer negotiated, so both ends must opt in) | Whether to drop protobuf or configure both ends depends on your deployment. |
| `json-field-string-values` | `t.json()` / `t.object()` fields written with `JSON.stringify(...)` or read with `JSON.parse(...)`. Servers before beta.13 decoded one JSON-string layer; beta.13 stores what was written. Existing rows: `findJsonStringValues(store)` from `@korajs/server`. | A string is also a valid json value, so intent cannot be inferred. |
| `defaulted-field-null-checks` | `x.field === null`, `!= null` or `x.field ??` on a field that has a schema `.default(...)`. Records written before the field existed now read the default on the server, not `null` (RT-106). | Whether the check meant "never set" is the author's intent. Findings are informational. |

The schema scan reads field declarations from files that call `defineSchema` (a field and its
`t.<type>(` on one line, as `kora generate` and every template write them).

The registered codemods describe beta.13 changes, so an upgrade from beta.14 to beta.15 runs none
of them; beta.15 has no source rewrite that can be proven safe, and its changes are listed in
[Upgrading to beta.15](/guide/upgrading-to-beta15#not-covered-by-kora-upgrade).

A codemod implements `Codemod` (`id`, `title`, `introducedIn`, `docs`, `run(context)`), where
`context` carries the project root, the source files and the from/to versions, and `run` returns
`findings` (always) and `edits` (only for a safe, unambiguous rewrite). Edits are applied only with
`--apply-codemods`, from the end of each file, and a file that changed since the scan is skipped and
reported. Register a new codemod in `CODEMODS` (`codemods/registry.ts`).

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
