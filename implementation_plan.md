# Kora.js Implementation Plan

**Version:** 1.0
**Date:** April 4, 2026
**Scope:** Phase 1 (Months 0 through 9, 18 two-week sprints)
**Target:** React developers building collaborative offline-first web applications

---

## 1. Technology Stack (Locked Decisions)

### Core Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Language | TypeScript 5.x (strict mode) | Type safety across client and server; schema type inference |
| Monorepo | Turborepo | Battle-tested on tRPC, Drizzle, TanStack; minimal config |
| Package Manager | pnpm | Workspace protocol, strict dependency isolation, 99M weekly downloads |
| Build | tsup (esbuild under the hood) | Near-zero config per package; ESM + CJS dual builds |
| Testing | Vitest | 10-20x faster than Jest; ESM-first; native TypeScript |
| Versioning | Changesets | PR-integrated version intent; industry standard for monorepos |
| Linting | Biome | Faster than ESLint; formatting + linting in one tool |

### Client-Side Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| SQLite WASM | Official @sqlite.org/sqlite-wasm (v3.51+) | Long-term support from SQLite project; excellent OPFS; 64-bit WASM |
| OPFS | Origin Private File System API | Production-ready across all browsers (Chrome, Safari 17+, Firefox, Edge) |
| Fallback Storage | IndexedDB via idb | Only when WASM/OPFS unavailable |
| CRDT Library | Yjs | Fastest CRDT implementation; proven in production; efficient binary encoding |
| Rich Text CRDT | Y.Text (part of Yjs) | Native rich text collaboration support |
| LWW Fields | Custom implementation over Yjs Y.Map | Hybrid Logical Clocks for causal-respecting total order |
| Reactive Engine | Fine-grained signals (custom) | Framework-agnostic reactivity; lighter than RxJS |
| React Bindings | useSyncExternalStore + custom hooks | React 18+ compatible; concurrent-mode safe |

### Server-Side Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Runtime | Node.js 20+ | LTS stability; broadest hosting compatibility |
| WebSocket | ws library | Battle-tested; lowest overhead Node.js WebSocket |
| HTTP Fallback | Native Node.js http/https | No framework dependency for sync server |
| Database Adapter | Drizzle ORM | TypeScript-native; supports Postgres, MySQL, SQLite |
| Default Database | PostgreSQL via Drizzle | Most common production database; logical replication capable |
| Binary Encoding | Protocol Buffers (protobuf.js) | Compact wire format; schema evolution support |

### CLI and DevTools Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| CLI Framework | citty (by unjs) | Lightweight; TypeScript-first; used by Nuxt |
| Template Engine | giget (by unjs) | Git-based project scaffolding; used by create-nuxt-app |
| DevTools UI | Preact + HTM | Tiny footprint for browser extension panel |
| DevTools Communication | chrome.devtools.panels API + postMessage | Standard extension architecture |

---

## 2. Repository Structure

```
kora/
├── .github/
│   ├── workflows/
│   │   ├── ci.yml                    # Lint, test, build on PR
│   │   ├── release.yml               # Changesets publish on merge to main
│   │   └── benchmark.yml             # Performance regression tests weekly
│   └── CONTRIBUTING.md
│
├── .changeset/
│   └── config.json
│
├── packages/
│   ├── core/                         # @kora/core
│   │   ├── src/
│   │   │   ├── schema/
│   │   │   │   ├── define.ts         # defineSchema(), field type builders
│   │   │   │   ├── types.ts          # Schema type definitions and inference
│   │   │   │   ├── validate.ts       # Runtime schema validation
│   │   │   │   └── migrate.ts        # Schema version transforms
│   │   │   ├── operations/
│   │   │   │   ├── operation.ts      # Operation type definitions
│   │   │   │   ├── log.ts            # Operation log (append-only)
│   │   │   │   └── hash.ts           # Content-addressing (SHA-256)
│   │   │   ├── clock/
│   │   │   │   ├── hlc.ts            # Hybrid Logical Clock implementation
│   │   │   │   └── vector.ts         # Version vector implementation
│   │   │   ├── types.ts              # Shared type exports
│   │   │   └── index.ts
│   │   ├── tests/
│   │   ├── package.json
│   │   ├── tsup.config.ts
│   │   └── vitest.config.ts
│   │
│   ├── store/                        # @kora/store
│   │   ├── src/
│   │   │   ├── adapters/
│   │   │   │   ├── adapter.ts        # Storage adapter interface
│   │   │   │   ├── sqlite-wasm.ts    # SQLite WASM + OPFS adapter
│   │   │   │   ├── sqlite-native.ts  # Native SQLite adapter (Node/Electron)
│   │   │   │   └── indexeddb.ts      # IndexedDB fallback adapter
│   │   │   ├── query/
│   │   │   │   ├── builder.ts        # Fluent query builder API
│   │   │   │   ├── compiler.ts       # Query to SQL compiler
│   │   │   │   ├── reactive.ts       # Reactive query subscriptions
│   │   │   │   └── optimizer.ts      # Query plan optimization
│   │   │   ├── collection.ts         # Collection API (insert, update, delete, where)
│   │   │   ├── database.ts           # Database instance management
│   │   │   └── index.ts
│   │   ├── tests/
│   │   ├── package.json
│   │   ├── tsup.config.ts
│   │   └── vitest.config.ts
│   │
│   ├── merge/                        # @kora/merge
│   │   ├── src/
│   │   │   ├── strategies/
│   │   │   │   ├── auto-merge.ts     # Tier 1: CRDT-based auto-merge
│   │   │   │   ├── lww.ts            # Last-write-wins with HLC
│   │   │   │   ├── crdt-text.ts      # Yjs Y.Text integration for rich text
│   │   │   │   ├── crdt-counter.ts   # Counter CRDT
│   │   │   │   ├── crdt-set.ts       # Add-wins set CRDT
│   │   │   │   └── fractional.ts     # Fractional indexing for list ordering
│   │   │   ├── constraints/
│   │   │   │   ├── engine.ts         # Tier 2: Constraint validation engine
│   │   │   │   ├── unique.ts         # Unique constraint handler
│   │   │   │   ├── capacity.ts       # Capacity constraint handler
│   │   │   │   └── referential.ts    # Referential integrity handler
│   │   │   ├── resolvers/
│   │   │   │   ├── custom.ts         # Tier 3: Custom resolver interface
│   │   │   │   └── server.ts         # Server-decides resolution queue
│   │   │   ├── merge-engine.ts       # Main merge orchestration
│   │   │   └── index.ts
│   │   ├── tests/
│   │   ├── package.json
│   │   ├── tsup.config.ts
│   │   └── vitest.config.ts
│   │
│   ├── sync/                         # @kora/sync
│   │   ├── src/
│   │   │   ├── protocol/
│   │   │   │   ├── handshake.ts      # Version vector exchange
│   │   │   │   ├── delta.ts          # Delta computation and transfer
│   │   │   │   ├── encoding.ts       # Protocol Buffers encoding/decoding
│   │   │   │   └── compression.ts    # Structural + delta compression
│   │   │   ├── transport/
│   │   │   │   ├── transport.ts      # Transport interface definition
│   │   │   │   ├── websocket.ts      # WebSocket transport
│   │   │   │   └── http.ts           # HTTP long-polling transport
│   │   │   ├── engine/
│   │   │   │   ├── sync-engine.ts    # Main sync orchestration
│   │   │   │   ├── queue.ts          # Outbound operation queue
│   │   │   │   ├── bandwidth.ts      # Bandwidth monitoring and adaptation
│   │   │   │   └── partial.ts        # Partial sync scope management
│   │   │   └── index.ts
│   │   ├── tests/
│   │   ├── package.json
│   │   ├── tsup.config.ts
│   │   └── vitest.config.ts
│   │
│   ├── react/                        # @kora/react
│   │   ├── src/
│   │   │   ├── hooks/
│   │   │   │   ├── use-kora.ts       # Main hook: useKora()
│   │   │   │   ├── use-query.ts      # Reactive query hook
│   │   │   │   ├── use-mutation.ts   # Mutation hook with optimistic updates
│   │   │   │   ├── use-sync-status.ts # Sync state hook
│   │   │   │   └── use-connection.ts # Connection quality hook
│   │   │   ├── provider.tsx          # KoraProvider context
│   │   │   └── index.ts
│   │   ├── tests/
│   │   ├── package.json
│   │   ├── tsup.config.ts
│   │   └── vitest.config.ts
│   │
│   ├── server/                       # @kora/server
│   │   ├── src/
│   │   │   ├── adapters/
│   │   │   │   ├── adapter.ts        # Backend database adapter interface
│   │   │   │   ├── postgres.ts       # PostgreSQL adapter (via Drizzle)
│   │   │   │   ├── mysql.ts          # MySQL adapter (via Drizzle) [Phase 2]
│   │   │   │   └── sqlite.ts         # SQLite adapter (for lightweight deploys)
│   │   │   ├── sync/
│   │   │   │   ├── handler.ts        # WebSocket connection handler
│   │   │   │   ├── rooms.ts          # Sync room management
│   │   │   │   └── auth.ts           # Authentication middleware
│   │   │   ├── operations/
│   │   │   │   ├── store.ts          # Server-side operation storage
│   │   │   │   ├── validate.ts       # Server-side operation validation
│   │   │   │   └── replay.ts         # Operation replay for new clients
│   │   │   ├── server.ts             # Server factory (createKoraServer)
│   │   │   └── index.ts
│   │   ├── tests/
│   │   ├── package.json
│   │   ├── tsup.config.ts
│   │   └── vitest.config.ts
│   │
│   ├── devtools/                     # @kora/devtools
│   │   ├── src/
│   │   │   ├── panel/
│   │   │   │   ├── app.tsx           # DevTools panel UI (Preact)
│   │   │   │   ├── timeline.tsx      # Sync timeline visualization
│   │   │   │   ├── conflicts.tsx     # Conflict inspector
│   │   │   │   ├── operations.tsx    # Operation log viewer
│   │   │   │   └── network.tsx       # Network status and simulator
│   │   │   ├── bridge/
│   │   │   │   ├── inject.ts         # Content script injection
│   │   │   │   └── messages.ts       # Page <-> extension messaging
│   │   │   ├── extension/
│   │   │   │   ├── manifest.json     # Chrome extension manifest v3
│   │   │   │   ├── background.ts     # Service worker
│   │   │   │   └── devtools.ts       # DevTools page registration
│   │   │   └── index.ts              # Embedded devtools (non-extension)
│   │   ├── package.json
│   │   ├── tsup.config.ts
│   │   └── vitest.config.ts
│   │
│   └── cli/                          # @kora/cli (also: create-kora-app)
│       ├── src/
│       │   ├── commands/
│       │   │   ├── create.ts         # npx create-kora-app
│       │   │   ├── dev.ts            # kora dev (dev server with devtools)
│       │   │   ├── migrate.ts        # kora migrate (schema migrations)
│       │   │   ├── inspect.ts        # kora inspect (operation log inspection)
│       │   │   └── generate.ts       # kora generate (type generation)
│       │   ├── templates/
│       │   │   ├── react-basic/      # Basic React + Kora template
│       │   │   ├── react-sync/       # React + Kora + sync server template
│       │   │   └── shared/           # Shared template files
│       │   └── index.ts
│       ├── package.json
│       ├── tsup.config.ts
│       └── vitest.config.ts
│
├── apps/
│   ├── docs/                         # Documentation site (Starlight or VitePress)
│   │   ├── src/content/
│   │   │   ├── getting-started/
│   │   │   ├── guides/
│   │   │   ├── api-reference/
│   │   │   └── concepts/
│   │   └── astro.config.mjs
│   │
│   └── playground/                   # Live demo app for testing
│       ├── src/
│       └── package.json
│
├── examples/
│   ├── todo-app/                     # Simple todo (no sync)
│   ├── todo-sync/                    # Todo with sync server
│   ├── collaborative-notes/          # Multi-user real-time notes
│   └── healthcare-scheduling/        # Constraint-based scheduling demo
│
├── benchmarks/
│   ├── store/                        # Storage performance benchmarks
│   ├── merge/                        # Merge engine benchmarks
│   └── sync/                         # Sync protocol benchmarks
│
├── pnpm-workspace.yaml
├── turbo.json
├── package.json
├── tsconfig.base.json
├── biome.json
└── README.md
```

---

## 3. Package Dependency Graph

```
@kora/core  (zero dependencies on other @kora packages)
    ↑
@kora/store  (depends on @kora/core)
    ↑
@kora/merge  (depends on @kora/core, uses Yjs)
    ↑
@kora/sync   (depends on @kora/core, @kora/merge)
    ↑
@kora/server (depends on @kora/core, @kora/sync)

@kora/react  (depends on @kora/core, @kora/store, @kora/sync)
@kora/devtools (depends on @kora/core)
@kora/cli    (depends on all packages for scaffolding)
```

The main developer-facing package `kora` is a meta-package that re-exports from core, store, merge, sync:

```typescript
// kora/package.json
{
  "name": "kora",
  "dependencies": {
    "@kora/core": "workspace:*",
    "@kora/store": "workspace:*",
    "@kora/merge": "workspace:*",
    "@kora/sync": "workspace:*"
  }
}
```

Developer imports from `kora` directly:
```typescript
import { defineSchema, createApp, t } from 'kora'
import { useKora } from 'kora/react'
```

---

## 4. Sprint-by-Sprint Implementation Plan

### Sprint 0 (Pre-development, Week 1-2): Foundation

**Goal:** Repository setup, tooling, CI/CD pipeline, and team alignment.

**Tasks:**

Repository and Tooling Setup:
- Initialize git repository with main/develop branch strategy
- Configure pnpm workspace (pnpm-workspace.yaml)
- Configure Turborepo (turbo.json) with build, test, lint pipelines
- Set up tsup config for all packages
- Set up Vitest config with shared test utilities
- Configure Biome for linting and formatting
- Set up Changesets for versioning
- Configure GitHub Actions: CI (lint + test + build on PR), release (publish on merge)

Architecture Documentation:
- Finalize all interface definitions between packages
- Document the Operation type specification
- Document the sync protocol wire format (Protocol Buffers schema)
- Create Architecture Decision Records (ADRs) for each locked decision

**Deliverables:** Working monorepo where `pnpm install && pnpm build && pnpm test` passes across all empty packages.

---

### Sprint 1-2 (Weeks 3-6): @kora/core

**Goal:** Schema system, operation types, and clock implementations.

**Sprint 1 Tasks:**

Schema Definition Engine:
- Implement `defineSchema()` function with TypeScript type inference
- Implement field type builders: `t.string()`, `t.number()`, `t.boolean()`, `t.enum()`, `t.array()`, `t.timestamp()`, `t.richtext()`, `t.optional()`
- Implement `default()` modifier for all field types
- Implement schema validation (runtime checking of schema definitions)
- Implement TypeScript type generation from schema (infer collection types)
- Implement index declarations in schema
- Write comprehensive tests for schema definition and type inference

**Sprint 2 Tasks:**

Operation System:
- Define Operation type (insert, update, delete, with all metadata fields)
- Implement SHA-256 content addressing for operations
- Implement Operation Log (append-only, in-memory for now)
- Implement causal dependency tracking (each operation records its deps)

Clock Implementations:
- Implement Hybrid Logical Clock (HLC) with physical time + logical counter
- Implement Version Vector (map of nodeId to max sequence number)
- Implement HLC comparison for total ordering
- Implement Version Vector merge and delta computation
- Write property-based tests for clock monotonicity and ordering guarantees

Constraint Definitions:
- Implement constraint declaration in schema (unique, capacity, referential)
- Implement constraint type validation
- Define onConflict strategy types

Relation Definitions:
- Implement relation declaration in schema (many-to-one, many-to-many)
- Implement relation type validation

**Deliverables:** `@kora/core` published to npm (internal). Schema can be defined, validated, and produces correct TypeScript types. Operations can be created, hashed, and appended to the log. HLC and version vectors work correctly.

**Test coverage target:** 95%+ for core.

---

### Sprint 3-4 (Weeks 7-10): @kora/store

**Goal:** Local storage abstraction with SQLite WASM and reactive queries.

**Sprint 3 Tasks:**

Storage Adapter Interface:
- Define the StorageAdapter interface (open, close, execute, query, transaction)
- Implement SQLite WASM adapter using @sqlite.org/sqlite-wasm
- Configure OPFS persistence via opfs-sahpool VFS
- Implement automatic OPFS detection with IndexedDB fallback
- Implement database initialization from Kora schema (CREATE TABLE generation)
- Implement schema-to-SQL type mapping
- Handle Web Worker offloading for SQLite operations (prevent main thread blocking)

Collection API:
- Implement Collection class with insert(), update(), delete(), findById()
- Implement query builder: where(), orderBy(), limit(), offset()
- Map collection operations to SQL queries
- Map collection operations to Operation Log entries (every mutation produces an operation)
- Write integration tests with real SQLite WASM

**Sprint 4 Tasks:**

Reactive Query Engine:
- Implement reactive query subscriptions (collection.where(...).subscribe())
- Implement change detection: when a mutation affects a subscribed query, re-execute and notify
- Implement batched notifications (debounce rapid changes)
- Optimize: track which tables/columns each subscription depends on; only re-execute when relevant data changes

Relational Queries:
- Implement include() for following relations defined in schema
- Implement JOIN compilation from relation definitions
- Handle cascading subscription updates for relational queries

IndexedDB Fallback:
- Implement IndexedDB adapter conforming to StorageAdapter interface
- Implement feature detection (WASM + OPFS available? -> SQLite, else -> IndexedDB)
- Write cross-adapter tests ensuring identical behavior

Database Instance:
- Implement createApp() factory function that wires schema, storage, and collections
- Implement database.collection('name') accessor
- Implement database.close() cleanup

**Deliverables:** `@kora/store` published. Developer can create a schema, insert/query/update/delete data in SQLite WASM, and subscribe to reactive queries. All mutations produce operations in the log.

**Test coverage target:** 90%+. Include performance benchmarks for CRUD operations.

---

### Sprint 5-6 (Weeks 11-14): @kora/merge

**Goal:** Three-tier conflict resolution engine.

**Sprint 5 Tasks:**

Tier 1 Auto-Merge:
- Implement LWW (Last-Write-Wins) merge strategy using HLC ordering
- Implement field-level merging for Y.Map-backed structured data
- Implement Yjs Y.Text integration for richtext fields
- Implement counter CRDT (grow-only counter using Yjs)
- Implement add-wins set CRDT for array fields
- Implement merge strategy selection based on field type in schema:
  - `string` / `number` / `boolean` / `enum` -> LWW
  - `richtext` -> Yjs Y.Text CRDT
  - `array` -> Add-wins set
  - `counter` (new type) -> Counter CRDT

Merge Engine Orchestration:
- Implement MergeEngine class that receives two divergent operation logs
- Implement deterministic merge: apply operations in causal order, resolve field conflicts using strategy
- Write property-based tests: merge(A, B) produces same result as merge(B, A)
- Write property-based tests: merge is idempotent

**Sprint 6 Tasks:**

Tier 2 Constraint Validation:
- Implement constraint evaluation engine
- Implement unique constraint: after auto-merge, check if uniqueness violated; apply onConflict strategy
- Implement capacity constraint: after auto-merge, check if capacity exceeded; apply onConflict strategy
- Implement referential integrity: check if foreign key references valid record; handle orphans
- Implement onConflict strategies: first-write-wins, last-write-wins, priority-field, server-decides
- Implement constraint violation event emission (for DevTools)

Tier 3 Custom Resolvers:
- Implement custom resolver interface: (localValue, remoteValue, baseValue) => resolvedValue
- Implement resolver registration per collection/field in schema
- Implement server-decides queue: when constraint strategy is 'server-decides', queue the conflict for server resolution
- Implement conflict metadata storage (for DevTools conflict inspector)

Yjs Integration Layer:
- Implement Yjs document management per collection (one Y.Doc per sync scope)
- Implement operation-to-Yjs-update mapping (translate Kora operations into Yjs updates)
- Implement Yjs-update-to-operation mapping (translate incoming Yjs updates into Kora operations)
- Implement Yjs garbage collection configuration
- Implement selective Yjs usage (only for fields that need CRDT merging)

**Deliverables:** `@kora/merge` published. All three tiers of conflict resolution work. Given two divergent operation logs, the merge engine produces a deterministic, correct merged state. Constraints are enforced.

**Test coverage target:** 95%+. This is the most critical package. Include adversarial tests (concurrent writes, partition scenarios, clock skew).

---

### Sprint 7-8 (Weeks 15-18): @kora/sync

**Goal:** Sync engine with WebSocket transport.

**Sprint 7 Tasks:**

Sync Protocol Implementation:
- Implement handshake phase: version vector exchange using Protocol Buffers encoding
- Implement delta computation: given two version vectors, compute missing operations
- Implement operation transfer: send missing operations in causal order
- Implement acknowledgment: update sender's knowledge of receiver's state
- Implement resumable sync: track sync progress; interrupted sync resumes from last ack
- Implement idempotent apply: receiving same operation twice is a no-op (content-addressing)

Transport Interface:
- Define KoraTransport interface: send(), receive(), getConnectionQuality(), connect(), disconnect()
- Implement WebSocket transport using ws (server) and native WebSocket (client)
- Implement connection lifecycle: connect, reconnect with exponential backoff, disconnect
- Implement heartbeat/keepalive for connection liveness detection

Outbound Queue:
- Implement persistent outbound queue (operations pending sync)
- Implement queue persistence to local storage (survive page refresh)
- Implement queue ordering: causal order respected
- Implement queue deduplication: operations already acknowledged are pruned

**Sprint 8 Tasks:**

HTTP Long-Polling Transport:
- Implement HTTP transport as fallback when WebSocket unavailable
- Implement long-poll pattern: client polls, server holds request until new operations
- Implement batching: group operations for HTTP efficiency

Bandwidth Adaptation:
- Implement bandwidth monitoring (measure round-trip time, throughput)
- Implement adaptive compression: high bandwidth = minimal compression, low bandwidth = aggressive
- Implement adaptive batching: low bandwidth = larger batches, less frequent
- Implement ConnectionQuality enum: EXCELLENT, GOOD, FAIR, POOR, OFFLINE

Partial Sync:
- Implement sync scope definitions: which collections/rows to sync per client
- Implement scope-aware delta computation: only send operations matching client's scope
- Implement scope change handling: when scope widens, send newly-matching historical operations

Sync Engine Integration:
- Implement SyncEngine class that wires transport, protocol, queue, merge engine, and store
- Implement automatic sync on mutation: when developer calls insert/update/delete, queue operation and attempt sync
- Implement background sync: periodically attempt to sync pending operations
- Implement sync status events: syncing, synced, error, offline

**Deliverables:** `@kora/sync` published. Two browser instances can sync data via WebSocket. Operations flow bidirectionally, conflicts resolve automatically, and the system handles disconnection/reconnection gracefully.

**Test coverage target:** 90%+. Include chaos tests: random disconnections, out-of-order delivery, duplicate delivery, partial network partitions.

---

### Sprint 9-10 (Weeks 19-22): @kora/server

**Goal:** Self-hosted sync server with Postgres adapter.

**Sprint 9 Tasks:**

Server Core:
- Implement createKoraServer() factory function
- Implement WebSocket connection handler (accept connections, authenticate, assign to rooms)
- Implement room management: each sync scope maps to a room; clients in the same room exchange operations
- Implement server-side operation storage (persist all operations for replay to new clients)
- Implement operation replay: when a new client connects, send all operations matching its sync scope

PostgreSQL Adapter:
- Implement Postgres adapter using Drizzle ORM
- Define operation storage schema (operations table with: id, collection, type, data, timestamp, nodeId, schemaVersion, causalDeps)
- Implement efficient operation queries: by collection, by version vector delta, by time range
- Implement connection pooling
- Implement Postgres migration scripts (for the sync server's own schema, not the user's schema)

SQLite Server Adapter:
- Implement SQLite adapter for lightweight deployments (using better-sqlite3)
- Same interface as Postgres adapter
- Intended for development and small-scale production

**Sprint 10 Tasks:**

Authentication:
- Implement auth middleware interface: (request) => { userId, scopes }
- Implement JWT-based default auth
- Implement anonymous auth (for development/prototyping)
- Implement scope-based authorization: server validates that operations match client's authorized scopes

Server-Side Constraint Validation:
- When constraint strategy is 'server-decides', server receives queued conflicts
- Implement server-side resolution: apply business rules, produce resolution operation, broadcast to all clients
- Implement rejection: if operation violates server-side rules, send rejection to originating client

Schema Version Handling:
- Implement schema version detection on incoming operations
- Implement operation transformer chain execution (transform v1 operations to v2 before applying)
- Implement schema version negotiation during handshake

Server CLI Integration:
- Implement `kora server start` command
- Implement `kora server migrate` for server database migrations
- Implement configuration via kora.config.ts

**Deliverables:** `@kora/server` published. Developer can run `kora server start` and have a sync server that accepts WebSocket connections, stores operations in Postgres (or SQLite), replays operations to new clients, and handles auth/scopes.

**Test coverage target:** 90%+. Include multi-client integration tests.

---

### Sprint 11-12 (Weeks 23-26): @kora/react and Integration

**Goal:** React bindings and end-to-end integration testing.

**Sprint 11 Tasks:**

React Hooks:
- Implement KoraProvider context that initializes database and sync
- Implement useKora() hook returning the database instance
- Implement useQuery() hook: `useQuery(db.todos.where({ completed: false }))` returns reactive data
- Use useSyncExternalStore for React 18+ compatibility and concurrent mode safety
- Implement useMutation() hook with optimistic update support
- Implement useSyncStatus() hook: returns current sync state (syncing, synced, offline, error)
- Implement useConnectionQuality() hook: returns EXCELLENT/GOOD/FAIR/POOR/OFFLINE

React-Specific Optimizations:
- Implement query result memoization (don't re-render if data hasn't changed)
- Implement Suspense support for initial data loading
- Implement error boundary integration for sync errors

**Sprint 12 Tasks:**

End-to-End Integration:
- Build integration test suite: full client -> store -> merge -> sync -> server -> sync -> client pipeline
- Test scenarios:
  - Single client, no sync (pure offline)
  - Two clients, WebSocket sync, no conflicts
  - Two clients, concurrent edits, auto-merge resolution
  - Two clients, concurrent edits, constraint violation resolution
  - Client goes offline, makes changes, reconnects, syncs
  - Client offline for extended period (schema version gap), reconnects
  - Three+ clients with complex merge scenarios
  - Partial sync scope changes
- Performance integration tests: measure end-to-end latency for common operations
- Memory usage tests: measure memory growth over time with sustained operations

createApp() Final Integration:
- Wire all packages together in the `kora` meta-package
- Ensure createApp() initializes store, merge engine, sync engine, and optionally connects to server
- Ensure configuration flows correctly from kora.config.ts through all layers
- Implement sensible defaults: zero-config creates a local-only app; adding sync target enables sync

**Deliverables:** Full end-to-end flow works. A React app can import from `kora` and `kora/react`, define a schema, render reactive data, and sync across multiple browser tabs via WebSocket.

---

### Sprint 13-14 (Weeks 27-30): @kora/devtools

**Goal:** Browser DevTools extension and embedded panel.

**Sprint 13 Tasks:**

DevTools Bridge:
- Implement client-side instrumentation: Kora core emits events for all operations, sync events, merge decisions, and conflicts
- Implement message bridge between page context and DevTools extension
- Implement event buffering (store last N events for inspection)

Sync Timeline:
- Build timeline visualization (Preact component) showing operations over time
- Color-code by operation type (insert, update, delete)
- Show sync events (sent, received, applied)
- Click operation to see full payload, schema version, causal deps
- Show causal dependency arrows between operations

Operation Log Viewer:
- Build searchable, filterable operation log table
- Filter by collection, operation type, node, time range
- Show operation details in expandable rows
- Implement time-travel: select a point in the log, show the database state at that moment

**Sprint 14 Tasks:**

Conflict Inspector:
- Build conflict detail view: show conflicting operations side-by-side
- Show base state, local state, remote state, and merged result
- Show which merge tier was used (auto-merge, constraint, custom)
- Show constraint violations and resolution strategy applied
- Allow "replay" with different strategy (what-if analysis)

Network Status Panel:
- Show current connection quality (real-time)
- Show sync queue depth (pending operations)
- Show bandwidth usage
- Show last sync timestamp

Embedded DevTools:
- Build embeddable version (not extension) that can be rendered in-app during development
- Toggle with keyboard shortcut (Ctrl+Shift+K)
- Auto-disabled in production builds

Chrome Extension:
- Build Manifest V3 Chrome extension
- Register DevTools panel via chrome.devtools.panels.create
- Test in Chrome, Edge, Firefox (with WebExtension API)

**Deliverables:** `@kora/devtools` published. Developer can install the Chrome extension or use the embedded panel to inspect sync timeline, operation log, and conflicts in real-time.

---

### Sprint 15-16 (Weeks 31-34): @kora/cli and Templates

**Goal:** CLI tooling and project scaffolding.

**Sprint 15 Tasks:**

CLI Core:
- Implement CLI using citty framework
- Implement `create-kora-app` command:
  - Prompt for project name, template (basic/sync), UI framework (React for Phase 1)
  - Scaffold project using giget template system
  - Install dependencies
  - Initialize git repository
  - Print getting-started instructions

- Implement `kora dev` command:
  - Start Vite dev server (for the app)
  - Start Kora sync server (if configured)
  - Enable embedded DevTools
  - Watch schema file for changes, auto-regenerate types

- Implement `kora migrate` command:
  - Detect schema changes between current and previous version
  - Generate migration operations
  - Apply migration to local store
  - Display migration plan for review

- Implement `kora generate` command:
  - Generate TypeScript types from schema
  - Generate migration stubs for new schema versions

**Sprint 16 Tasks:**

Templates:
- Build `react-basic` template: React + Kora, no sync, simple todo app
- Build `react-sync` template: React + Kora + sync server, multi-user todo app
- Ensure templates work with `create-kora-app`
- Test template scaffolding end-to-end

CLI Polish:
- Implement `kora inspect` command: CLI-based operation log inspection (for debugging without browser)
- Implement colored output, progress indicators, error messages
- Implement `kora --version`, `kora --help` with clear documentation
- Implement update checker (notify when new version available)

**Deliverables:** `create-kora-app` and `@kora/cli` published on npm. Developer can run `npx create-kora-app my-app` and have a working project in under 2 minutes.

---

### Sprint 17-18 (Weeks 35-38): Documentation, Examples, and Launch Prep

**Goal:** Documentation, example apps, performance benchmarks, and launch preparation.

**Sprint 17 Tasks:**

Documentation Site:
- Build documentation site using Astro Starlight (or VitePress)
- Write Getting Started guide (10-minute walkthrough)
- Write Concepts section: offline-first, CRDTs, conflict resolution, sync protocol (accessible, not academic)
- Write API Reference for all public APIs across all packages
- Write Guides section:
  - Setting up sync with a Postgres backend
  - Custom conflict resolution for business rules
  - Schema evolution and migrations
  - Using DevTools to debug sync issues
  - Deploying a Kora sync server
- Write Configuration Reference (kora.config.ts options)

Example Apps:
- Build todo-app example (local only, simplest possible)
- Build todo-sync example (two-user todo with sync server)
- Build collaborative-notes example (rich text collaboration using Y.Text)
- Build healthcare-scheduling example (demonstrates constraint-based conflict resolution with unique appointment slots)

**Sprint 18 Tasks:**

Performance Benchmarks:
- Benchmark local store: inserts/sec, queries/sec, reactive query update latency
- Benchmark merge engine: operations/sec for each merge strategy
- Benchmark sync: end-to-end latency, bandwidth efficiency, reconnection time
- Benchmark on low-end hardware (simulate with CPU throttling)
- Publish benchmark results in documentation
- Set up automated regression benchmarks in CI (fail if performance degrades by >10%)

Launch Preparation:
- Security audit: review all data handling, encryption, auth flows
- npm publish dry run for all packages
- Create GitHub releases with changelogs
- Write announcement blog post
- Create landing page (kora.dev)
- Set up Discord community server
- Prepare launch posts for Hacker News, Twitter/X, Reddit (r/javascript, r/webdev, r/localfirst)

**Deliverables:** Documentation site live. Example apps working and published. Packages published to npm. Ready for public launch.

---

## 5. Module Implementation Specifications

### 5.1 Operation Specification

Every mutation in Kora produces an Operation. This is the atomic unit of the entire system.

```typescript
interface Operation {
  // Identity
  id: string                          // SHA-256 hash of (type + collection + data + timestamp + nodeId)
  nodeId: string                      // UUID of the originating device/node

  // Content
  type: 'insert' | 'update' | 'delete'
  collection: string                  // Collection name from schema
  recordId: string                    // ID of the affected record
  data: Record<string, any> | null    // Field values (null for delete)
  previousData: Record<string, any> | null  // For updates: previous field values (for 3-way merge)

  // Ordering
  timestamp: HLCTimestamp             // Hybrid Logical Clock timestamp
  sequenceNumber: number              // Monotonically increasing per node

  // Causality
  causalDeps: string[]                // Operation IDs this operation depends on (direct parents in DAG)

  // Schema
  schemaVersion: number               // Schema version at time of creation

  // Metadata
  createdAt: number                   // Wall-clock time (informational only, not used for ordering)
}

interface HLCTimestamp {
  wallTime: number                    // Physical time in milliseconds
  logical: number                     // Logical counter for same-millisecond ordering
  nodeId: string                      // Tie-breaking for concurrent HLC values
}
```

### 5.2 Sync Protocol Wire Format

Protocol Buffers schema for sync messages:

```protobuf
syntax = "proto3";

message SyncMessage {
  oneof payload {
    Handshake handshake = 1;
    HandshakeResponse handshake_response = 2;
    OperationBatch operation_batch = 3;
    Acknowledgment acknowledgment = 4;
    ScopeChange scope_change = 5;
    Error error = 6;
  }
}

message Handshake {
  string node_id = 1;
  map<string, uint64> version_vector = 2;  // nodeId -> max sequence number
  uint32 schema_version = 3;
  repeated string sync_scopes = 4;
}

message HandshakeResponse {
  map<string, uint64> version_vector = 1;
  uint32 schema_version = 2;
  bool requires_full_sync = 3;             // True if version gap too large
}

message OperationBatch {
  repeated Operation operations = 1;
  bool is_final = 2;                       // True if this is the last batch in initial sync
}

message Operation {
  string id = 1;
  string node_id = 2;
  OperationType type = 3;
  string collection = 4;
  string record_id = 5;
  bytes data = 6;                          // MessagePack-encoded field values
  bytes previous_data = 7;
  HLCTimestamp timestamp = 8;
  uint64 sequence_number = 9;
  repeated string causal_deps = 10;
  uint32 schema_version = 11;
}

message HLCTimestamp {
  uint64 wall_time = 1;
  uint32 logical = 2;
  string node_id = 3;
}

message Acknowledgment {
  string node_id = 1;
  uint64 max_sequence_acknowledged = 2;
}

message ScopeChange {
  repeated string added_scopes = 1;
  repeated string removed_scopes = 2;
}

message Error {
  ErrorCode code = 1;
  string message = 2;
  repeated string operation_ids = 3;       // Operations that caused the error
}

enum OperationType {
  INSERT = 0;
  UPDATE = 1;
  DELETE = 2;
}

enum ErrorCode {
  UNKNOWN = 0;
  AUTH_FAILED = 1;
  SCOPE_DENIED = 2;
  SCHEMA_MISMATCH = 3;
  CONSTRAINT_VIOLATION = 4;
  OPERATION_REJECTED = 5;
}
```

### 5.3 Merge Engine Decision Tree

```
Incoming operation arrives
    │
    ▼
Is there a conflict? (same recordId + same field modified concurrently)
    │
    ├── NO  → Apply operation directly
    │
    └── YES → Determine field type from schema
              │
              ├── richtext  → Yjs Y.Text CRDT merge (character-level)
              ├── counter   → Counter CRDT merge (additive)
              ├── array     → Add-wins set merge (union)
              │
              └── scalar (string/number/boolean/enum)
                  │
                  └── Apply LWW using HLC ordering
                      │
                      ▼
                  Is there a constraint on this field/collection?
                      │
                      ├── NO  → Accept merged result
                      │
                      └── YES → Evaluate constraint against merged state
                                │
                                ├── Constraint SATISFIED → Accept merged result
                                │
                                └── Constraint VIOLATED
                                    │
                                    └── Apply onConflict strategy:
                                        ├── first-write-wins  → Keep earlier operation's value
                                        ├── last-write-wins   → Keep later operation's value
                                        ├── priority-field    → Compare priority field, higher wins
                                        ├── server-decides    → Queue for server resolution
                                        └── custom            → Invoke developer's resolver function
```

### 5.4 Reactive Query Invalidation

The reactive engine must efficiently determine which subscriptions to re-execute when data changes.

```
Subscription Registry:
  subscription_1: { collection: 'todos', where: { completed: false }, deps: ['todos.completed', 'todos.title'] }
  subscription_2: { collection: 'todos', where: { assignee: 'alice' }, deps: ['todos.assignee'] }
  subscription_3: { collection: 'projects', where: {}, deps: ['projects.*'] }

On mutation (operation applied):
  1. Determine affected collection and fields from operation
  2. Look up subscriptions with matching collection
  3. For each matching subscription:
     a. Check if mutation affects any dependency field
     b. If yes, re-execute the query
     c. Diff result against previous result
     d. If different, notify subscribers
  4. Batch notifications within a microtask to prevent thrashing
```

---

## 6. Testing Strategy

### Test Categories

| Category | Tool | Location | Run Frequency |
|----------|------|----------|---------------|
| Unit tests | Vitest | packages/*/tests/unit/ | Every commit (CI) |
| Integration tests | Vitest | packages/*/tests/integration/ | Every PR (CI) |
| End-to-end tests | Vitest + Playwright | apps/playground/tests/ | Every PR (CI) |
| Property-based tests | fast-check + Vitest | packages/core/tests/properties/ | Every PR (CI) |
| Chaos tests | Custom harness | packages/sync/tests/chaos/ | Nightly (CI) |
| Performance benchmarks | Vitest bench | benchmarks/ | Weekly (CI) |
| Cross-browser tests | Playwright | apps/playground/tests/browser/ | Pre-release |

### Critical Test Scenarios

Merge Engine (highest priority):
- Commutativity: merge(A, B) === merge(B, A) for all operation pairs
- Associativity: merge(merge(A, B), C) === merge(A, merge(B, C))
- Idempotency: merge(A, A) === A
- Constraint enforcement under concurrent violations
- Schema version mismatch during merge

Sync Engine:
- Graceful disconnection and reconnection
- Sync completion after extended offline period (hours/days)
- Partial sync with scope changes mid-session
- Out-of-order operation delivery
- Duplicate operation delivery
- Large operation batch (10,000+ operations)
- Concurrent sync from 10+ clients

Store:
- CRUD correctness across SQLite WASM and IndexedDB
- Reactive query invalidation correctness
- Transaction atomicity
- Storage persistence across page refresh (OPFS)
- Storage quota handling

---

## 7. CI/CD Pipeline

### Pull Request Pipeline (ci.yml)

```yaml
Trigger: push to PR branch
Steps:
  1. Install dependencies (pnpm install)
  2. Lint (biome check)
  3. Type check (tsc --noEmit across all packages)
  4. Build all packages (turbo run build)
  5. Unit tests (turbo run test)
  6. Integration tests (turbo run test:integration)
  7. Bundle size check (report size changes)
```

### Release Pipeline (release.yml)

```yaml
Trigger: merge to main with changeset files
Steps:
  1. Create release PR (changeset version)
  2. On merge of release PR:
     a. Build all packages
     b. Run full test suite
     c. Publish to npm (changeset publish)
     d. Create GitHub releases with changelogs
     e. Deploy documentation site
```

### Nightly Pipeline (benchmark.yml)

```yaml
Trigger: cron (daily at 2am UTC)
Steps:
  1. Run chaos tests (1 hour timeout)
  2. Run performance benchmarks
  3. Compare with baseline
  4. Alert if regression > 10%
```

---

## 8. Team Structure and Responsibilities

### Recommended Team (Phase 1)

| Role | Count | Focus |
|------|-------|-------|
| Core Engine Lead | 1 | @kora/core, @kora/merge (most critical, deepest technical challenge) |
| Storage Engineer | 1 | @kora/store (SQLite WASM, OPFS, reactive queries) |
| Sync Engineer | 1 | @kora/sync, @kora/server (protocol, transport, server) |
| DX Engineer | 1 | @kora/react, @kora/cli, templates, documentation |
| DevTools Engineer | 1 | @kora/devtools (browser extension, visualization) |
| QA/Reliability | 1 | Testing infrastructure, chaos tests, benchmarks, cross-browser |

Total: 6 engineers for Phase 1.

The Core Engine Lead should be the most experienced distributed systems engineer on the team. The merge engine is where the entire product's defensibility lives.

---

## 9. Key Milestones

| Milestone | Sprint | Date (est.) | Criteria |
|-----------|--------|-------------|----------|
| M0: Repo Ready | 0 | Week 2 | Monorepo builds, CI passes |
| M1: Local Store | 4 | Week 10 | Schema + CRUD + reactive queries working in browser |
| M2: Merge Engine | 6 | Week 14 | All three tiers of conflict resolution working |
| M3: Sync Working | 8 | Week 18 | Two browsers syncing via WebSocket |
| M4: Server Ready | 10 | Week 22 | Self-hosted sync server with Postgres |
| M5: React DX | 12 | Week 26 | End-to-end React app working |
| M6: DevTools | 14 | Week 30 | Browser extension with timeline, conflicts, log viewer |
| M7: CLI Ready | 16 | Week 34 | `npx create-kora-app` works end-to-end |
| M8: Launch | 18 | Week 38 | Docs, examples, npm publish, public launch |

---

## 10. Risk Mitigation During Implementation

### Risk: SQLite WASM performance on low-end Android

**Mitigation Sprint:** Sprint 3. Run benchmarks on low-end hardware emulation before committing to SQLite WASM as sole primary. If unacceptable, elevate IndexedDB to co-primary rather than fallback. Decision gate: median query latency under 10ms on Snapdragon 665 equivalent.

### Risk: Yjs integration complexity for structured (non-text) data

**Mitigation Sprint:** Sprint 5. Build a proof-of-concept mapping 100 database rows to Y.Map structures and measure memory overhead and merge correctness. If overhead exceeds 2x raw data size, consider building a custom LWW register with causal ordering instead of using Yjs for structured data, reserving Yjs only for richtext fields.

### Risk: Reactive query invalidation performance at scale

**Mitigation Sprint:** Sprint 4. Benchmark with 1,000 active subscriptions and 100 mutations/second. If invalidation check latency exceeds 5ms per mutation, implement bloom filter-based dependency tracking to reduce subscription scan cost.

### Risk: Protocol Buffers add unnecessary complexity

**Mitigation Sprint:** Sprint 7. Start with JSON encoding for simplicity. Measure wire size and parse performance. Only switch to Protocol Buffers if JSON adds more than 3x bandwidth overhead or parse latency exceeds 1ms per operation batch. This avoids premature optimization while keeping the option open.

---

## 11. Open Decisions to Resolve Before Sprint 1

These must be resolved during Sprint 0:

1. **Node ID generation:** UUID v4 (simple, risk of collision at extreme scale) vs. UUID v7 (time-sortable, slightly more complex). Recommendation: UUID v7 for natural time ordering.

2. **Operation ID generation:** SHA-256 of content (deterministic, enables dedup) vs. UUID + content hash verification. Recommendation: SHA-256 for dedup benefits.

3. **Maximum operation size:** Cap the data field at 1MB? 10MB? Large binaries should be references, not inline. Recommendation: 1MB default, configurable.

4. **WebSocket library for client:** Native WebSocket (zero deps) vs. socket.io (more features, larger). Recommendation: Native WebSocket. We handle reconnection ourselves.

5. **Documentation framework:** Astro Starlight vs. VitePress. Recommendation: Starlight (better for non-blog documentation).

---

*This implementation plan covers Phase 1 of Kora.js. Phases 2 through 4 will be planned after Phase 1 launch based on adoption data and developer feedback.*