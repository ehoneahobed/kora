# Kora.js

**Offline-first application framework.**

Kora.js makes building offline-first applications as simple as building a Next.js app. Go from `npx create-kora-app@beta` to a working offline-first app in under 10 minutes, writing zero lines of sync, conflict resolution, or distributed systems code.

> The name comes from the West African kora instrument: 21 strings that resonate independently but produce harmony together. Independent devices, independent writes, eventual harmony.

## Status

**Public beta (v1.0.0-beta.14).** beta.14 is a non-breaking follow-up to beta.13: beta.12 servers now upgrade with no manual step, presence works across different access, and the beta.13 rollout fixes are in ([release notes](docs/releases/v1.0.0-beta.14.md)). Coming from 1.0.0-beta.12, read the [upgrade guide](docs/guide/upgrading-to-beta13.md) first (servers first, then clients) and the beta.13 [security advisory](https://github.com/ehoneahobed/kora/security/advisories/GHSA-v63m-pq3j-7m44). The API is what we intend to ship as 1.0; the beta period is for real-world feedback before the stable cut.

Beta packages publish under the `beta` npm dist-tag. Install with `npm install korajs@beta` (or `@korajs/<pkg>@beta`), and scaffold with `npx create-kora-app@beta`: the untagged `create-kora-app` installs the older 0.x line.

| Package | Status | Description |
|---------|--------|-------------|
| `korajs` | Beta | Meta-package: `createApp`, schema-typed collections, queries and transactions |
| `@korajs/core` | Beta | Schema, operations, HLC, version vectors, the per-field CRDT fold |
| `@korajs/store` | Beta | Local storage (SQLite WASM on OPFS, IndexedDB, native SQLite), CRUD, reactive queries |
| `@korajs/merge` | Beta | Cross-record constraints and referential integrity (per-field merging lives in the core fold) |
| `@korajs/sync` | Beta | Sync protocol v2, WebSocket and HTTP long-poll transports, end-to-end encryption |
| `@korajs/server` | Beta | Sync server with Memory, SQLite and PostgreSQL stores, production server, static files |
| `@korajs/react` | Beta | React hooks: `useQuery`, `useMutation`, `useSyncStatus`, `createKoraHooks`, `useRichText` |
| `@korajs/cli` | Beta | `kora create`, `kora dev`, `kora migrate`, `kora generate`, `kora deploy`, offline app shell |
| `@korajs/auth` | Experimental | Authentication, sessions, MFA, organizations, RBAC, passkeys |
| `@korajs/devtools` | Experimental | Browser DevTools extension with sync timeline and conflict inspector |
| `@korajs/vue` | Experimental | Vue composables mirroring the React bindings |
| `@korajs/svelte` | Experimental | Svelte stores mirroring the React bindings |
| `@korajs/tauri` | Experimental | Tauri desktop integration (native SQLite) |

Beta means the API is stable enough to build on and covered by the release gates. Experimental means it works and is tested, but has had less production exposure and its API may still move.

## What It Does

Kora sits alongside your UI layer (React, Vue, Svelte) and owns the entire data plane:

- **Local persistence**: SQLite WASM on OPFS in a worker, a durable IndexedDB fallback, native SQLite for Node.js and Tauri. Kora never silently runs in memory.
- **Reactive queries**: subscribe to query results and get notified when they change.
- **Conflict resolution**: every replica folds a record's operations into a per-field CRDT state (last-write-wins registers, element multisets for arrays, per-key maps, counters, Yjs rich text, custom resolvers), so the result depends only on which operations it holds. Cross-record constraints are enforced by the sync server.
- **Synchronization**: causal order via HLC, version vectors for uploads, a gap-free delivery watermark for downloads, and nothing silently dropped: operations a device cannot apply yet are quarantined and retried.
- **Binary blobs**: content-addressed `blob` fields stored in OPFS, deduplicated, integrity-verified and transferred out of band (`app.blobs`).
- **Offline by default**: every code path works without a network, and scaffolded apps open offline through a service worker.
- **Authentication and encryption**: server-granted sync scopes, sessions, MFA, organizations, RBAC, passkeys, and end-to-end encryption with a shared per-user keyring.
- **Type inference**: schema types flow through `createApp` to collection accessors, queries, transactions and `createKoraHooks`.
- **DevTools**: operation inspector, conflict tracer and sync timeline.
- **Schema migrations**: versioned migrations that apply atomically, backfills that sync, and transforms for devices on older schema versions.

## Quick Start

### Scaffold a new app

```bash
npx create-kora-app@beta my-app
cd my-app
pnpm dev
```

Choose from 13 templates across React, Vue, Svelte and Tauri, each with and without sync (the web ones with or without Tailwind). The recommended default is **React + Tailwind with a SQLite sync server**. Skip the prompts with `--yes`. The [Getting Started](https://ehoneahobed.github.io/kora/getting-started) tutorial walks through a scaffolded app.

### Or start from scratch

```typescript
import { createApp, defineSchema, t } from 'korajs'

const app = createApp({
  schema: defineSchema({
    version: 1,
    collections: {
      todos: {
        fields: {
          title: t.string(),
          completed: t.boolean().default(false),
          createdAt: t.timestamp().auto(),
        },
      },
    },
  }),
})

// CRUD: works offline, always
await app.ready
const todo = await app.todos.insert({ title: 'Ship Kora v1' })
await app.todos.update(todo.id, { completed: true })

// Reactive queries
app.todos
  .where({ completed: false })
  .orderBy('createdAt')
  .subscribe((todos) => {
    console.log('Active todos:', todos)
  })
```

### Enable sync

<!-- docs-check-prelude
import { createApp, defineSchema, t } from 'korajs'
const schema = defineSchema({ version: 1, collections: { todos: { fields: { title: t.string() } } } })
-->

```typescript
const app = createApp({
  schema,
  sync: { url: 'wss://my-server.example.com/kora-sync', autoConnect: true },
})
```

Without `autoConnect: true`, call `await app.sync?.connect()` after `app.ready`.

### Deploy

```bash
kora deploy
```

Generates a Dockerfile, bundles your server, builds your client, and deploys to Fly.io, Railway or AWS. See the [Deployment guide](https://ehoneahobed.github.io/kora/guide/deployment).

### React hooks

<!-- docs-check-prelude
import { createApp, defineSchema, t } from 'korajs'
const app = createApp({
  schema: defineSchema({
    version: 1,
    collections: { todos: { fields: { title: t.string(), completed: t.boolean().default(false) } } },
  }),
})
-->

```tsx
import { useMutation, useQuery, useSyncStatus } from '@korajs/react'

function TodoList() {
  const todos = useQuery(app.todos.where({ completed: false }))
  const { mutate: addTodo } = useMutation(app.todos.insert)
  const status = useSyncStatus()

  return (
    <div>
      <p>Sync: {status.status}</p>
      <button onClick={() => addTodo({ title: 'New todo' })}>Add</button>
      {todos.map((todo) => (
        <div key={todo.id}>{todo.title}</div>
      ))}
    </div>
  )
}
```

## Architecture

Every mutation produces an **Operation**: an immutable, content-addressed record. Operations
reference their causal dependencies, so the log forms a DAG:

```
Operation {
  id: SHA-256 content hash (hash version 2 covers the whole canonical body)
  nodeId: the authoring device
  type: 'insert' | 'update' | 'delete'
  collection, recordId
  data: changed fields only
  previousData: the writer's values before the change
  timestamp: HLC (Hybrid Logical Clock)
  sequenceNumber: per node, unique and gap-free
  causalDeps: ids of direct causal parents
  schemaVersion, hashVersion
}
```

**Ordering** uses Hybrid Logical Clocks (Kulkarni et al.): a total order that respects causality without synchronized clocks.

**Sync** (protocol v2, JSON on the wire) sends a peer only the operations it is missing: version vectors decide what a client uploads, and a durable, gap-free delivery watermark decides what the server delivers.

**Merge** is a deterministic fold that every replica (device, server, restored backup) runs the same way:
1. **Per-field CRDTs**: last-write-wins by HLC for scalars, an element multiset for arrays, per-key last-write-wins for objects, Yjs for rich text, and `merge('counter' | 'max' | 'min' | 'append-only' | 'server-authoritative')`.
2. **Constraints**: unique, capacity and referential rules across records, enforced by the sync server and checked optimistically on devices.
3. **Custom resolvers**: developer functions folded over a field's writes in HLC order.

## Monorepo Structure

```
packages/
  core/             @korajs/core       Schema, operations, HLC, version vectors, the record fold
  store/            @korajs/store      Local storage, CRUD, reactive queries
  merge/            @korajs/merge      Cross-record constraints, referential integrity
  sync/             @korajs/sync       Sync protocol and transports
  server/           @korajs/server     Self-hosted sync server
  react/            @korajs/react      React hooks and bindings
  vue/              @korajs/vue        Vue composables
  svelte/           @korajs/svelte     Svelte stores
  tauri/            @korajs/tauri      Tauri desktop integration
  auth/             @korajs/auth       Authentication, sessions, MFA, RBAC
  devtools/         @korajs/devtools   Browser DevTools extension
  cli/              @korajs/cli        CLI tooling, templates, scaffolding
  create-kora-app/  create-kora-app    npx entry point (delegates to the CLI)
  test/             @korajs/test       Cross-package convergence test utilities
kora/               Meta-package re-exporting core, store, merge, sync
e2e/                Playwright E2E test suite
docs/               VitePress documentation site
```

## Development

### Prerequisites

- Node.js 20+
- pnpm 9+

### Setup

```bash
git clone https://github.com/ehoneahobed/kora.git
cd kora
pnpm install
pnpm build
pnpm test
```

### Commands

```bash
pnpm build              # Build all packages
pnpm test               # Run all unit/integration tests
pnpm typecheck          # TypeScript strict mode check
pnpm lint               # Biome lint and format check
pnpm lint:fix           # Auto-fix lint/format issues
pnpm test:e2e           # Run Playwright E2E tests (requires Chromium)
pnpm benchmark:gates    # Run performance benchmark gates
pnpm test:production-path  # PRODUCTION_PATH convergence tests (korajs)
pnpm test:release-gate  # production-path + reconnect + chaos + benchmarks
pnpm remediation        # remediation tracker: every repro test, writes remediation/STATUS.md
pnpm docs:check-code    # typecheck the docs' code blocks against the built packages
pnpm docs:check-tutorial  # run the Getting Started tutorial against a scaffolded app
pnpm chaos:nightly      # Run chaos convergence test (10 clients, 1000 ops)
pnpm docs:dev           # Start docs site dev server
```

### Running E2E Tests

The E2E suite uses Playwright with a fixture React+Sync app:

```bash
# Install Playwright browsers (first time only)
cd e2e && npx playwright install chromium && cd ..

# Run E2E tests
pnpm test:e2e
```

This automatically starts a Vite dev server and a Kora sync server, then runs CRUD sync, offline convergence, multi-tab, and scaffolding tests.

### Running the Documentation Site

```bash
pnpm docs:dev
```

Opens the VitePress docs site at `http://localhost:5173` with guides, API reference, and examples.

### Tech Stack

| Tool | Purpose |
|------|---------|
| pnpm + Turborepo | Monorepo management |
| tsup | ESM + CJS dual builds |
| TypeScript 5.x | Strict mode everywhere |
| Vitest | Unit and integration testing |
| Playwright | E2E browser testing |
| Biome | Linting and formatting |
| Changesets | Versioning and publishing |
| VitePress | Documentation site |

### CI/CD

| Workflow | Trigger | What it does |
|----------|---------|--------------|
| `ci.yml` | PRs + push to main | Lint, build, docs code blocks, tutorial, tests, typecheck |
| `e2e.yml` | PRs + push to main + manual | Playwright E2E tests, tutorial in Chromium |
| `remediation.yml` | PRs + push to main | Remediation tracker: repro tests and guards |
| `release.yml` | Push to main | Changesets: version PR or npm publish |
| `canary.yml` | Push to main | Canary snapshot releases to npm |
| `docs.yml` | Push to main (docs/**) | Build + deploy docs to GitHub Pages |
| `benchmark-gates.yml` | PRs + push to main | Performance regression gates |
| `chaos-nightly.yml` | Nightly schedule | Chaos convergence test |

## Testing the Framework

### As a developer (local)

The fastest way to try Kora end-to-end:

```bash
# 1. Clone and build
git clone https://github.com/ehoneahobed/kora.git
cd kora
pnpm install
pnpm build

# 2. Run the E2E fixture app (a working React todo app with sync)
cd e2e/fixture-app
pnpm dev:server &          # Start sync server on port 3001
pnpm dev                   # Start Vite dev server

# 3. Open http://localhost:5173 in two browser tabs
#    - Add a todo in tab 1 → it appears in tab 2 via sync
#    - Toggle completed in either tab → reflected in the other
#    - Go offline (DevTools > Network > Offline) → add items → go back online → they sync
```

### Publishing to npm

Once published, anyone can create a new Kora app with a single command:

```bash
npx create-kora-app@beta my-app
cd my-app
pnpm dev
```

**First-time setup:**

```bash
# 1. Login to npm
npm login

# 2. Create the @korajs org on https://www.npmjs.com/org/create (already done)
#    This reserves the @korajs/* package scope

# 3. Create a changeset (describes what changed)
pnpm changeset
#    → Select all packages → choose "minor" → describe: "Initial release"

# 4. Apply version bumps
pnpm changeset version

# 5. Build and publish all packages
pnpm build
pnpm changeset publish
```

After this, all packages are live on npm. The scaffolded project will pin its kora dependencies to the published version automatically.

**Subsequent releases** are automated via CI: push a changeset to `main`, the `release.yml` workflow creates a "Version Packages" PR, and merging it publishes to npm.

### Sharing with remote testers

**Option A: After npm publish (easiest for testers)**

Once packages are on npm, share these instructions:

```bash
npx create-kora-app@beta my-app --template react-tailwind-sync
cd my-app
pnpm dev     # starts the app and its local sync server
# Open http://localhost:5173 in two browser tabs
```

Each tester runs their own local sync server. To test sync **across machines**, one person hosts the sync server and others point to it (see Option D).

**Option B: Before npm publish (from the repo)**

Testers clone the repo and run the fixture app:

```bash
git clone https://github.com/ehoneahobed/kora.git
cd kora
pnpm install
pnpm build

cd e2e/fixture-app
pnpm dev:server &
pnpm dev
# Open http://localhost:5173 in two tabs
```

Or scaffold a standalone project from the local CLI:

```bash
# From the kora repo root (after pnpm install && pnpm build)
node packages/cli/dist/bin.js create ~/my-test-app --template react-sync --skip-install
```

The scaffold pins the published `@korajs/*` versions; to run it against your local build, point
its dependencies at the workspace packages (`pnpm add korajs@link:<repo>/kora ...`) and run
`pnpm dev`.

**Option C: Deploy sync server for multi-device testing**

To test sync across different machines/locations, deploy the sync server:

<!-- docs-check-prelude -->

```typescript
// server.ts: deploy to any Node.js host (Railway, Fly.io, a VPS)
import { MemoryServerStore, createKoraServer } from '@korajs/server'

const server = createKoraServer({
  store: new MemoryServerStore(),
  port: Number(process.env.PORT) || 3001,
})

server.start().then(() => {
  console.log('Kora sync server running')
})
```

For anything beyond a test, use `createProductionServer` with a SQLite or Postgres store and an
auth provider: see [Production Server](https://ehoneahobed.github.io/kora/guide/production-server).
Then each tester's app points to the deployed URL: `sync: { url: 'wss://your-server.example.com', autoConnect: true }`.

**Option D: Quick remote testing with ngrok**

Run everything locally and share via tunnels (no deployment needed):

```bash
# Terminal 1: sync server
cd e2e/fixture-app && pnpm dev:server

# Terminal 2: Vite app (after updating the sync URL, see below)
cd e2e/fixture-app && pnpm dev

# Terminal 3: tunnel the sync server
npx ngrok http 3001
# Note the https URL (e.g., https://abc123.ngrok.io)

# Terminal 4: tunnel the web app
npx ngrok http 5173
# Share this URL with testers
```

Update `e2e/fixture-app/src/main.tsx` to use the ngrok WebSocket URL (`sync: { url: 'wss://abc123.ngrok.io' }`) before starting Vite.

Share the web app tunnel URL. Testers open it in their browsers and their changes sync through your local server in real time.

## Core Principles

1. **Correctness over performance**: a slow merge that is right beats a fast merge that loses data
2. **Developer experience over internal elegance**: the public API must feel inevitable
3. **Explicit over implicit for data**: every merge decision is traceable and loggable
4. **Convention over configuration**: zero-config produces a working offline-first app
5. **Compose, don't reinvent**: SQLite for storage, Yjs for CRDTs, proven algorithms for clocks
6. **Offline is the default**: never assume connectivity

## Documentation

Full documentation is available at **[ehoneahobed.github.io/kora](https://ehoneahobed.github.io/kora/)**.

Covers:
- [Getting Started](https://ehoneahobed.github.io/kora/getting-started): a scaffolded app, a migration, the core API
- [Upgrading to beta.13](https://ehoneahobed.github.io/kora/guide/upgrading-to-beta13): every breaking change from 1.0.0-beta.12 and the code change it needs
- [Schema Design](https://ehoneahobed.github.io/kora/guide/schema-design): field types, the value domain, relations, migrations
- [Conflict Resolution](https://ehoneahobed.github.io/kora/guide/conflict-resolution): the per-field fold, constraints, resolvers
- [Sync Configuration](https://ehoneahobed.github.io/kora/guide/sync-configuration) and [Sync Protocol](https://ehoneahobed.github.io/kora/guide/sync-protocol)
- [Storage Configuration](https://ehoneahobed.github.io/kora/guide/storage-configuration): OPFS, IndexedDB, multi-tab, persistence
- [Authentication](https://ehoneahobed.github.io/kora/guide/authentication) and [Sync Encryption](https://ehoneahobed.github.io/kora/guide/sync-encryption)
- [Production Server](https://ehoneahobed.github.io/kora/guide/production-server) and [Deployment](https://ehoneahobed.github.io/kora/guide/deployment)
- [Error Codes](https://ehoneahobed.github.io/kora/api/errors): every error code with cause and fix
- [API Reference](https://ehoneahobed.github.io/kora/api/): every package

To run docs locally: `pnpm docs:dev`

## License

MIT
