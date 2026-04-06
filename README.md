# Kora.js

**Offline-first application framework.**

Kora.js makes building offline-first applications as simple as building a Next.js app. Go from `npx create-kora-app` to a working offline-first app in under 10 minutes, writing zero lines of sync, conflict resolution, or distributed systems code.

> The name comes from the West African kora instrument: 21 strings that resonate independently but produce harmony together. Independent devices, independent writes, eventual harmony.

## Status

**Feature-complete** — all 9 packages implemented with 1138+ tests. Includes E2E tests, documentation site, and CI/CD pipelines.

| Package | Tests | Description |
|---------|-------|-------------|
| `@korajs/core` | 231 | Schema, operations, HLC, version vectors, type inference |
| `@korajs/store` | 225 | Local storage (SQLite WASM, IndexedDB, native SQLite), CRUD, reactive queries |
| `@korajs/merge` | 99 | Three-tier conflict resolution with Yjs CRDT richtext merge |
| `@korajs/sync` | 180 | Sync protocol, WebSocket + HTTP transports, protobuf wire format |
| `@korajs/server` | 118 | Sync server with Memory, SQLite, and PostgreSQL stores (Drizzle ORM) |
| `@korajs/react` | 60 | React hooks: `useQuery`, `useMutation`, `useSyncStatus`, `useRichText` |
| `@korajs/devtools` | 49 | Browser DevTools extension with sync timeline, conflict inspector |
| `@korajs/cli` | 130 | `kora create`, `kora dev`, `kora migrate`, `kora generate` |
| `kora` | 46 | Meta-package with `createApp`, full type inference from schema to hooks |

## What It Does

Kora sits alongside your UI layer (React, Vue, Svelte) and owns the entire data plane:

- **Local persistence** — SQLite WASM with OPFS, IndexedDB fallback, native SQLite for Node.js
- **Reactive queries** — Subscribe to query results, get notified on changes within one frame (16ms)
- **Conflict resolution** — Three-tier merge: auto-merge (LWW/CRDT), constraints, custom resolvers
- **Synchronization** — Causal ordering via HLC, delta sync via version vectors, protobuf wire format
- **Offline by default** — Every code path works without network. Sync is a bonus, not a requirement.
- **Full type inference** — Schema types flow through `createApp` to collection accessors and React hooks
- **DevTools** — Real-time operation inspector, conflict tracer, sync timeline in a browser extension
- **Schema migrations** — Diff, generate, and apply schema changes with `kora migrate`

## Quick Start

### Scaffold a new app

```bash
npx create-kora-app my-app
cd my-app
pnpm dev
```

Choose from 4 templates: **React + Tailwind (with sync)** (recommended), React + Tailwind (local-only), React + CSS (with sync), or React + CSS (local-only). Or skip the prompts:

```bash
npx create-kora-app my-app --yes    # Recommended defaults
```

This gives you a polished dark-themed React app with local persistence, reactive queries, DevTools, and optional sync — all working out of the box.

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
        }
      }
    }
  })
})

// CRUD — works offline, always
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

### Enable sync (one line)

```typescript
const app = createApp({
  schema,
  sync: { url: 'wss://my-server.com/kora' }
})
```

### React hooks

```tsx
import { KoraProvider, useQuery, useMutation, useSyncStatus } from '@korajs/react'

function TodoList() {
  const todos = useQuery(app.todos.where({ completed: false }))
  const { mutate: addTodo } = useMutation((data) => app.todos.insert(data))
  const status = useSyncStatus()

  return (
    <div>
      <p>Sync: {status.status}</p>
      <button onClick={() => addTodo({ title: 'New todo' })}>Add</button>
      {todos.map(todo => <div key={todo.id}>{todo.title}</div>)}
    </div>
  )
}
```

## Architecture

Every mutation produces an **Operation** — an immutable, content-addressed record that forms a DAG:

```
Operation {
  id: SHA-256 hash (content-addressed)
  type: 'insert' | 'update' | 'delete'
  collection: string
  recordId: string
  data: { ...changed fields only }
  previousData: { ...for 3-way merge }
  timestamp: HLC (Hybrid Logical Clock)
  sequenceNumber: number
  causalDeps: string[]
}
```

**Ordering** uses Hybrid Logical Clocks (Kulkarni et al.) — total order that respects causality without synchronized clocks.

**Sync** uses version vectors for efficient delta computation — only send operations the other side hasn't seen. Wire format negotiates between JSON and Protocol Buffers.

**Merge** is three-tiered:
1. **Auto-merge** — LWW for scalars, add-wins set for arrays, Yjs CRDT for rich text
2. **Constraints** — Unique, capacity, referential integrity with configurable resolution
3. **Custom resolvers** — Developer-provided functions for domain-specific logic

## Monorepo Structure

```
packages/
  core/       @korajs/core     — Schema, operations, HLC, version vectors
  store/      @korajs/store    — Local storage, CRUD, reactive queries
  merge/      @korajs/merge    — Three-tier conflict resolution
  sync/       @korajs/sync     — Sync protocol and transports
  server/     @korajs/server   — Self-hosted sync server
  react/      @korajs/react    — React hooks and bindings
  devtools/   @korajs/devtools — Browser DevTools extension
  cli/        @korajs/cli      — CLI tooling and scaffolding
kora/         Meta-package re-exporting core, store, merge, sync
e2e/          Playwright E2E test suite
docs/         VitePress documentation site
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
pnpm test               # Run all unit/integration tests (1138+ tests)
pnpm typecheck          # TypeScript strict mode check
pnpm lint               # Biome lint and format check
pnpm lint:fix           # Auto-fix lint/format issues
pnpm test:e2e           # Run Playwright E2E tests (requires Chromium)
pnpm benchmark:gates    # Run performance benchmark gates
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
| `ci.yml` | PRs + push to main | Lint, build, test, typecheck |
| `e2e.yml` | Push to main + manual | Playwright E2E tests |
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
npx create-kora-app my-app
cd my-app
pnpm install
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
npx create-kora-app my-app --template react-tailwind-sync
cd my-app
pnpm install
pnpm dev
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
node packages/cli/dist/index.js create ~/my-test-app --template react-sync

cd ~/my-test-app
pnpm install
pnpm dev:server &
pnpm dev
```

**Option C: Deploy sync server for multi-device testing**

To test sync across different machines/locations, deploy the sync server:

```typescript
// server.ts — deploy to any Node.js host (Railway, Render, Fly.io, VPS)
import { createKoraServer, MemoryServerStore } from '@korajs/server'

const server = createKoraServer({
  store: new MemoryServerStore(),
  port: Number(process.env.PORT) || 3001,
})

server.start().then(() => {
  console.log('Kora sync server running')
})
```

Then each tester's app points to the deployed URL:

```typescript
sync: { url: 'wss://your-server.example.com' }
```

**Option D: Quick remote testing with ngrok**

Run everything locally and share via tunnels — no deployment needed:

```bash
# Terminal 1: sync server
cd e2e/fixture-app && pnpm dev:server

# Terminal 2: Vite app (after updating sync URL — see below)
cd e2e/fixture-app && pnpm dev

# Terminal 3: tunnel the sync server
npx ngrok http 3001
# Note the https URL (e.g., https://abc123.ngrok.io)

# Terminal 4: tunnel the web app
npx ngrok http 5173
# Share this URL with testers
```

Update `e2e/fixture-app/src/main.tsx` to use the ngrok WebSocket URL before starting Vite:
```typescript
sync: { url: 'wss://abc123.ngrok.io' }
```

Share the web app tunnel URL. Testers open it in their browsers and their changes sync through your local server in real time.

## Core Principles

1. **Correctness over performance** — A slow merge that's right beats a fast merge that loses data
2. **Developer experience over internal elegance** — The public API must feel inevitable
3. **Explicit over implicit for data** — Every merge decision is traceable and loggable
4. **Convention over configuration** — Zero-config produces a working offline-first app
5. **Compose, don't reinvent** — SQLite for storage, Yjs for CRDTs, proven algorithms for clocks
6. **Offline is the default** — Never assume connectivity

## Documentation

Full documentation is available at **[ehoneahobed.github.io/kora](https://ehoneahobed.github.io/kora/)**.

Covers:
- [Getting Started](https://ehoneahobed.github.io/kora/getting-started) — Zero to working app in 5 minutes
- [Schema Design](https://ehoneahobed.github.io/kora/guide/schema-design) — Field types, relations, versioning
- [Storage Configuration](https://ehoneahobed.github.io/kora/guide/storage-configuration) — Client and server storage, multiple apps, PostgreSQL
- [Sync Configuration](https://ehoneahobed.github.io/kora/guide/sync-configuration) — Auth, scopes, encryption, transports
- [React Hooks](https://ehoneahobed.github.io/kora/guide/react-hooks) — useQuery, useMutation, useSyncStatus
- [Conflict Resolution](https://ehoneahobed.github.io/kora/guide/conflict-resolution) — Three-tier merge engine
- [Deployment](https://ehoneahobed.github.io/kora/guide/deployment) — Self-hosting, Docker, scaling
- [API Reference](https://ehoneahobed.github.io/kora/api/) — Complete reference for all packages

To run docs locally: `pnpm docs:dev`

## License

MIT
