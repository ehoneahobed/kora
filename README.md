# Kora.js

**Offline-first application framework.**

Kora.js makes building offline-first applications as simple as building a Next.js app. Go from `npx create-kora-app` to a working offline-first app in under 10 minutes, writing zero lines of sync, conflict resolution, or distributed systems code.

> The name comes from the West African kora instrument: 21 strings that resonate independently but produce harmony together. Independent devices, independent writes, eventual harmony.

## Status

**Early development** — core and store packages are implemented with 350+ tests. Not yet ready for production use.

| Package | Status | Description |
|---------|--------|-------------|
| `@kora/core` | Implemented | Schema, operations, HLC, version vectors, types |
| `@kora/store` | Implemented | Local storage, CRUD, reactive queries, subscriptions |
| `@kora/merge` | Planned | Three-tier conflict resolution engine |
| `@kora/sync` | Planned | Sync protocol and transports |
| `@kora/server` | Planned | Self-hosted sync server |
| `@kora/react` | Planned | React hooks and bindings |
| `@kora/devtools` | Planned | Browser DevTools extension |
| `@kora/cli` | Planned | CLI tooling and scaffolding |

## What It Does

Kora sits alongside your UI layer (React, Vue, Svelte) and owns the entire data plane:

- **Local persistence** — SQLite WASM with OPFS, IndexedDB fallback
- **Reactive queries** — Subscribe to query results, get notified on changes
- **Conflict resolution** — Three-tier merge: auto-merge, constraints, custom resolvers
- **Synchronization** — Causal ordering via Hybrid Logical Clocks, delta sync via version vectors
- **Offline by default** — Every code path works without network. Sync is a bonus, not a requirement.

## Quick Start

```typescript
import { createApp, defineSchema, t } from 'kora'

const app = createApp({
  schema: defineSchema({
    version: 1,
    collections: {
      todos: {
        fields: {
          title: t.string(),
          completed: t.boolean().default(false),
        }
      }
    }
  })
})

// CRUD — works offline, always
const todo = await app.todos.insert({ title: 'Ship Kora v1' })
await app.todos.update(todo.id, { completed: true })

// Reactive queries
app.todos
  .where({ completed: false })
  .orderBy('title')
  .subscribe((todos) => {
    console.log('Active todos:', todos)
  })

// Add one line to enable sync
const app = createApp({
  schema,
  sync: { url: 'wss://my-server.com/kora' }
})
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

**Sync** uses version vectors for efficient delta computation — only send operations the other side hasn't seen.

**Merge** is three-tiered:
1. **Auto-merge** — LWW for scalars, add-wins set for arrays, Yjs CRDT for rich text
2. **Constraints** — Unique, capacity, referential integrity with configurable resolution
3. **Custom resolvers** — Developer-provided functions for domain-specific logic

## Monorepo Structure

```
packages/
  core/       @kora/core    — Schema, operations, HLC, version vectors
  store/      @kora/store   — Local storage, CRUD, reactive queries
  merge/      @kora/merge   — Three-tier conflict resolution
  sync/       @kora/sync    — Sync protocol and transports
  server/     @kora/server  — Self-hosted sync server
  react/      @kora/react   — React hooks and bindings
  devtools/   @kora/devtools — Browser DevTools extension
  cli/        @kora/cli     — CLI tooling and scaffolding
kora/         Meta-package re-exporting core, store, merge, sync
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
pnpm build       # Build all packages
pnpm test        # Run all tests
pnpm typecheck   # TypeScript strict mode check
pnpm lint        # Biome lint and format check
pnpm lint:fix    # Auto-fix lint/format issues
```

### Tech Stack

| Tool | Purpose |
|------|---------|
| pnpm + Turborepo | Monorepo management |
| tsup | ESM + CJS dual builds |
| TypeScript 5.x | Strict mode everywhere |
| Vitest | Testing |
| Biome | Linting and formatting |
| Changesets | Versioning and publishing |

## Core Principles

1. **Correctness over performance** — A slow merge that's right beats a fast merge that loses data
2. **Developer experience over internal elegance** — The public API must feel inevitable
3. **Explicit over implicit for data** — Every merge decision is traceable and loggable
4. **Convention over configuration** — Zero-config produces a working offline-first app
5. **Compose, don't reinvent** — SQLite for storage, Yjs for CRDTs, proven algorithms for clocks
6. **Offline is the default** — Never assume connectivity

## License

MIT
