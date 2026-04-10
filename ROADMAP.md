# Kora.js — Implementation Roadmap

> Last updated: 2026-04-06

## Where We Are

Core platform packages and meta-package are implemented, with **1133 tests passing** across the monorepo.

| Package | Tests | Status |
|---------|-------|--------|
| @korajs/core | 231 | Complete — HLC, operations, schema, version vectors, events, type inference utilities |
| @korajs/store | 222 | Browser + Node adapter stack complete, including IndexedDB restore durability fallback, relational `.include()` queries |
| @korajs/merge | 97 | Three-tier merge working, including Yjs richtext CRDT merge strategy |
| @korajs/sync | 180 | Engine, transports, protocol complete. Negotiated JSON/protobuf + HTTP long-polling fallback |
| @korajs/server | 118 | Memory + SQLite + PostgreSQL stores (both using Drizzle ORM); server-side scope filtering and HTTP sync endpoint support |
| @korajs/react | 60 | Hooks + query-store integration complete (generic type threading) |
| @korajs/devtools | 49 | Instrumentation backend + browser DevTools extension UI complete |
| @korajs/cli | 130 | `kora dev` implemented; `kora migrate` diff/generate/apply workflow complete; 4-template system with Tailwind CSS, polished UI, `--yes`/`--tailwind`/`--sync` flags |
| kora (meta-package) | 46 | `createApp` + typed `kora/config` entrypoint shipped, with typed overload for full schema inference |

**What works end-to-end today:** A developer can scaffold an app via `npx create-kora-app` (with 4 template choices: Tailwind/CSS x sync/local-only) and run `pnpm dev` via `kora dev`, with Vite + optional sync server + schema watcher in one command. Templates ship with polished dark-themed UIs, DevTools enabled by default, and persistent SQLite server stores. CLI supports `--yes`/`--tailwind`/`--sync` flags for fast scaffolding. Sync server persistence is available for memory, SQLite, and PostgreSQL backends (both using Drizzle ORM query builders), server-side scope filtering is active, and `kora migrate` supports end-to-end diff/generate/apply with ordered idempotent execution. Full end-to-end type inference flows from `defineSchema()` through `createApp()` to collection accessors and React hooks. Relational queries via `.include()` resolve many-to-one and one-to-many relations.

**What works today:** E2E Playwright test suite, VitePress documentation site, and CI/CD pipelines (main CI, release via Changesets, canary snapshots, E2E, docs deployment) are all in place.

### Known Issues

- **`@korajs/react` test environment:** All 60 React tests pass when run within the package (`cd packages/react && npx vitest run`), but 45 fail when run from the monorepo root due to missing `jsdom` environment configuration in the root vitest setup.

## Current Phase Status

| Phase | Status | Notes |
|-------|--------|-------|
| 1 | Complete | Browser adapter durability flow is implemented, including binary snapshot restore + logical dump fallback |
| 2 | Complete | `createApp` + meta-package shipped with pre-`ready` query semantics aligned and tested |
| 3 | Complete | Persistent server stores implemented (SQLite + PostgreSQL) using Drizzle ORM query builders, production-ready baseline |
| 4 | Complete | `kora dev` orchestration + `kora.config.ts` support shipped |
| 5 | Complete | Richtext fields merge with Yjs CRDTs, serialize as binary updates, and expose React hook bindings with undo/redo |
| 6 | Complete | Server-side scope filtering enforced for delta, relay, and inbound operation paths |
| 7 | Complete | `kora migrate` supports diff/generate/apply with breaking-change confirmation and idempotent ordered execution |
| 8 | Complete | DevTools extension routes instrumented events into a multi-panel browser UI in real time |
| 9 | Complete | Protobuf negotiation, HTTP fallback, benchmark gates, and nightly chaos convergence gating are in place |
| 10 | Complete | E2E Playwright suite, VitePress docs site, CI/CD pipelines (main, release, canary, e2e, docs) |
| Cross-cutting | Complete | End-to-end type inference, relational `.include()` queries, full Drizzle ORM migration |
| **11** | **Complete** | Developer experience & launch polish — 4-template system, Tailwind support, polished UI, persistent server stores, 130 CLI tests |

---

## Guiding Principle

Every phase below produces a **shippable increment** — something a developer can use in a real project. No stubs left behind. No "we'll fix this later" shortcuts. Each implementation targets production correctness first, then performance.

---

## Phase 1: Browser Storage Layer

**Status:** Complete

**Goal:** Kora apps persist data in the browser with the same guarantees as the Node.js adapter.

**Why first:** Nothing else matters if data doesn't survive a page refresh. This is the single biggest gap between the current state and a usable framework.

### 1a. SQLite WASM Adapter (Primary)

The production storage engine for all browser environments.

**Architecture:**
- Main thread exposes async `StorageAdapter` interface
- Dedicated Web Worker runs `@sqlite.org/sqlite-wasm` (v3.51+)
- Worker uses OPFS SyncAccessHandle Pool VFS (`opfs-sahpool`) for durable persistence
- Communication via `MessageChannel` with structured clone transfer (zero-copy for ArrayBuffers)
- WAL journal mode for concurrent read/write performance

**Implementation details:**
- Worker lifecycle: lazy initialization on first database interaction, not on page load
- Connection pooling: single write connection, multiple read connections via WAL
- Transaction semantics: write transactions serialize through the worker's single write connection; read queries execute concurrently
- Error propagation: worker errors are serialized with full context and re-thrown as `StorageError` on the main thread
- Graceful degradation: if OPFS is unavailable, fall back to in-memory SQLite with a console warning directing the developer to the IndexedDB adapter

**Files:**
```
packages/store/src/adapters/
  sqlite-wasm-adapter.ts          # Main-thread adapter (async facade)
  sqlite-wasm-worker.ts           # Web Worker (runs SQLite)
  sqlite-wasm-channel.ts          # MessageChannel protocol types
  sqlite-wasm-adapter.test.ts     # Tests (using happy-dom or similar)
```

**Tests:**
- Open/close lifecycle
- CRUD operations through the async bridge
- Transaction atomicity (partial failure rolls back)
- Concurrent reads during write transaction
- Worker crash recovery (re-initialize and replay)
- OPFS persistence (write, close, reopen, verify data survives)

### 1b. IndexedDB Adapter (Fallback)

For environments where WASM or OPFS is unavailable (older browsers, some mobile webviews).

**Architecture:**
- Direct `idb` wrapper implementing `StorageAdapter`
- Each collection maps to an IndexedDB object store
- Operations log stored in a dedicated object store
- Indexes created from schema definition
- Transactions map to IndexedDB transactions with appropriate durability hints

**Implementation details:**
- Use `idb` library (thin typed wrapper over IndexedDB API)
- SQL-like query execution: translate `WHERE` clauses to IndexedDB key ranges where possible, fall back to cursor iteration with in-memory filtering for complex predicates
- Schema migration: IndexedDB `onupgradeneeded` handler creates/modifies object stores
- No WAL equivalent — IndexedDB transactions are auto-committing, so batch writes into single transactions for atomicity

**Files:**
```
packages/store/src/adapters/
  indexeddb-adapter.ts            # Full adapter implementation
  indexeddb-adapter.test.ts       # Tests (using fake-indexeddb)
```

### 1c. Adapter Auto-Detection

```typescript
// Internal: detect the best available adapter at runtime
function detectAdapter(): 'sqlite-wasm' | 'indexeddb' | 'memory' {
  if (typeof globalThis.FileSystemSyncAccessHandle !== 'undefined') return 'sqlite-wasm'
  if (typeof globalThis.indexedDB !== 'undefined') return 'indexeddb'
  return 'memory'  // SSR or test environments
}
```

**Deliverable:** After Phase 1, `@korajs/store` works in every JavaScript environment — Node.js (BetterSqlite3), modern browsers (SQLite WASM + OPFS), older browsers (IndexedDB), and test/SSR (in-memory).

---

## Phase 2: The `createApp` Factory and Meta-Package

**Status:** Complete

**Goal:** `import { createApp, defineSchema, t } from 'korajs'` works and wires everything together.

**Why second:** With storage working, we can build the orchestration layer that connects store + sync + merge into a single developer-facing object.

### 2a. `createApp` Implementation

The factory function that is the entire public API surface for most developers.

**What it does:**
1. Validates and freezes the schema
2. Detects and initializes the appropriate storage adapter
3. Creates the `Store` with collections, queries, subscriptions
4. If `sync` config is provided: creates `SyncEngine`, connects transport, starts sync
5. If `devtools` is enabled: attaches `Instrumenter` to event emitter
6. Returns a `KoraApp` object with typed collection accessors

**Interface:**
```typescript
interface KoraApp {
  // Dynamic collection accessors — one per collection in the schema
  // e.g., app.todos.insert(), app.todos.where(), etc.
  readonly [collectionName: string]: Collection

  // Lifecycle
  readonly ready: Promise<void>       // Resolves when store is initialized
  close(): Promise<void>              // Tears down store, sync, workers

  // Sync (only present if sync configured)
  readonly sync?: {
    readonly status: SyncStatus
    connect(): Promise<void>
    disconnect(): Promise<void>
  }

  // Event emitter for DevTools and custom instrumentation
  readonly events: KoraEventEmitter
}
```

**Key design decisions:**
- `createApp` is synchronous — returns the app immediately. Storage initialization happens in the background; `app.ready` is a promise that resolves when the store is open. Queries before `ready` resolves return empty results (not errors).
- Collection accessors are created dynamically from the schema using `Proxy` or explicit property definition, with full TypeScript inference via generic type parameter on `createApp<Schema>`.
- The merge engine is internal — wired between sync and store. Incoming remote operations go through merge before being applied to the store.
- The `close()` method is critical: it disconnects sync, flushes pending writes, closes the storage adapter, and terminates Web Workers. Failure to call `close()` must not lose data (outbound queue persists independently).

**Files:**
```
kora/src/
  create-app.ts                   # Factory function
  create-app.test.ts
  kora-app.ts                     # KoraApp class
  kora-app.test.ts
  adapter-detection.ts            # Runtime adapter selection
  adapter-detection.test.ts
  index.ts                        # Re-exports everything
```

### 2b. Meta-Package Re-Exports

```typescript
// kora/src/index.ts
export { createApp } from './create-app'
export type { KoraApp } from './kora-app'

// Re-export developer-facing APIs from packages
export { defineSchema, t } from '@korajs/core'
export type { SchemaDefinition, FieldDescriptor } from '@korajs/core'
```

**Deliverable:** After Phase 2, a developer writes `const app = createApp({ schema })` and gets a fully typed, reactive, offline-capable data layer with zero configuration.

---

## Phase 3: Server Persistence

**Status:** Complete

**Goal:** The sync server persists operations to a real database. Server restarts do not lose data.

**Why third:** With the client fully functional, the server becomes the bottleneck. An in-memory server is fine for development but unusable for any real deployment.

### 3a. Drizzle ORM Server Stores

**Architecture:**
- `SqliteServerStore` and `PostgresServerStore` both implement the `ServerStore` interface using Drizzle ORM typed query builders
- Drizzle ORM handles the SQL abstraction — both stores use `insert().values().onConflictDoNothing()` and `onConflictDoUpdate()` for atomic writes
- Schema: two tables — `operations` (the operation log) and `sync_state` (version vectors per node)
- Content-addressed deduplication: `insert(...).onConflictDoNothing({ target: operations.id })`
- DDL stays as raw SQL via Drizzle's `sql` template (standard practice without drizzle-kit)

**Tables:**
```sql
CREATE TABLE operations (
  id TEXT PRIMARY KEY,                    -- Content-addressed hash
  node_id TEXT NOT NULL,
  type TEXT NOT NULL,
  collection TEXT NOT NULL,
  record_id TEXT NOT NULL,
  data TEXT,                              -- JSON
  previous_data TEXT,                     -- JSON
  wall_time INTEGER NOT NULL,
  logical INTEGER NOT NULL,
  timestamp_node_id TEXT NOT NULL,
  sequence_number INTEGER NOT NULL,
  causal_deps TEXT NOT NULL DEFAULT '[]', -- JSON array
  schema_version INTEGER NOT NULL,
  received_at INTEGER NOT NULL,           -- Server reception timestamp
  INDEX idx_node_seq (node_id, sequence_number),
  INDEX idx_collection (collection),
  INDEX idx_received (received_at)
);

CREATE TABLE sync_state (
  node_id TEXT PRIMARY KEY,
  max_sequence_number INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
```

**Implementation details:**
- All reads use Drizzle query builder: `db.select().from(operations).where(and(eq(...), between(...)))`
- All writes use Drizzle insert builder: `db.insert(operations).values(row).onConflictDoNothing()`
- Version vector upsert: `db.insert(syncState).values(...).onConflictDoUpdate({ target: syncState.nodeId, set: { maxSequenceNumber: sql\`MAX/GREATEST(...)\` } })`
- PostgresServerStore: in-memory version vector cache hydrated on init, `createPostgresServerStore()` factory dynamically imports `postgres` + `drizzle-orm/postgres-js`
- SqliteServerStore: synchronous Drizzle calls via `.all()` / `.run()` (better-sqlite3 is synchronous)
- Operation range queries for delta computation via Drizzle `between()` operator

**Database support:**
- PostgreSQL (recommended for production — best JSON support, robust replication)
- SQLite (development and single-server deployments)

**Files:**
```
packages/server/src/store/
  sqlite-server-store.ts           # SQLite store using Drizzle (BetterSQLite3Database)
  sqlite-server-store.test.ts
  postgres-server-store.ts         # PostgreSQL store using Drizzle (PostgresJsDatabase)
  postgres-server-store.test.ts
  drizzle-schema.ts                # Drizzle SQLite table definitions (sqliteTable)
  drizzle-pg-schema.ts             # Drizzle PostgreSQL table definitions (pgTable)
  server-store.ts                  # ServerStore interface
  memory-server-store.ts           # In-memory store (testing)
```

### 3b. Server Configuration

```typescript
import { createKoraServer } from '@korajs/server'
import { drizzle } from 'drizzle-orm/postgres-js'

const server = createKoraServer({
  store: drizzle(connectionString),  // or: 'memory' for development
  auth: tokenAuthProvider(validateFn),
  port: 3001,
})
```

**Deliverable:** After Phase 3, the sync server is production-grade. Operations survive restarts, support PostgreSQL/MySQL/SQLite backends, and handle concurrent clients efficiently.

---

## Phase 4: CLI `kora dev` Command

**Status:** Complete

**Goal:** `pnpm dev` starts a complete development environment with hot reload, sync server, and DevTools.

**Why fourth:** With client storage and server persistence working, the dev command can wire them together into a seamless development experience.

### 4a. Development Server Orchestration

**What `kora dev` starts:**
1. **Vite dev server** (port 5173) — serves the application with HMR
2. **Kora sync server** (port 3001) — only if `sync` is configured in schema or `kora.config.ts`
3. **Schema file watcher** — watches `src/schema.ts` (configurable), regenerates types on change via `kora generate types`
4. **DevTools injection** — injects a script tag for the DevTools panel (Ctrl+Shift+K)

**Architecture (implemented):**
- Uses managed child processes (`spawn`) to run project-local binaries (Vite, tsx, kora)
- Supports sync startup via either `server.ts/server.js` or managed sync mode from `kora.config.ts`
- Uses `fs.watch` with debounce for schema watching + type regeneration
- Unified process manager handles SIGINT/SIGTERM and coordinated shutdown

**Graceful shutdown sequence:**
1. Signal received → stop accepting new connections
2. Flush sync server outbound queues
3. Close Vite dev server
4. Terminate sync server child process
5. Print summary (operations synced, errors encountered)

**Files:**
```
packages/cli/src/commands/dev/
  dev-command.ts                   # Replaces current stub
  process-manager.ts               # Orchestrates child processes
  process-manager.test.ts
  schema-watcher.ts                # Watches schema file, triggers type regen
  schema-watcher.test.ts
  vite-integration.ts              # Programmatic Vite server
  vite-integration.test.ts
```

### 4b. `kora.config.ts` Support

```typescript
// kora.config.ts — developer writes this
import { defineConfig } from 'korajs/config'

export default defineConfig({
  schema: './src/schema.ts',
  dev: {
    port: 5173,
    sync: {
      port: 3001,
      store: 'memory',   // or PostgreSQL connection string
    },
  },
})
```

**Deliverable:** After Phase 4, `npx create-kora-app my-app && cd my-app && pnpm dev` produces a running application in the browser with hot reload, local persistence, and optional sync — the "under 10 minutes" promise fulfilled.

---

## Phase 5: Yjs Rich Text Integration

**Status:** Complete

**Goal:** `t.richtext()` fields merge at the character level using Yjs CRDTs, not LWW.

**Why fifth:** Rich text is a headline feature of offline-first apps (collaborative documents, notes, comments). Phase 5 moves richtext from basic support into fully polished editor/sync workflows.

### Implemented

- Yjs-backed richtext merge strategy (`crdt-text`) in `@korajs/merge`
- Richtext serialization helpers for string/Uint8Array/Buffer handling in `@korajs/store`
- Initial `useRichText(collection, recordId, field)` hook in `@korajs/react` with persistence wiring
- Undo/redo controls exposed through `useRichText` via Yjs `UndoManager`
- Incremental Yjs update tracking with periodic in-memory compaction before persistence
- Focused tests for strategy merge behavior, serializer correctness, and hook load/persist flow
- Merge engine integration coverage now includes conflicting richtext-field scenarios

### 5a. Yjs Field Merger

**Architecture:**
- Each `richtext` field stores its value as a Yjs `Y.Doc` state vector (binary `Uint8Array`)
- On insert: create a new `Y.Doc`, populate `Y.Text` with initial content, serialize state
- On update: deserialize both local and remote `Y.Doc` states, apply Yjs merge (`Y.applyUpdate`), serialize merged state
- Storage: richtext fields stored as BLOB (SQLite) / ArrayBuffer (IndexedDB)
- React integration: expose a `useRichText(recordId, fieldName)` hook that returns a `Y.Text` instance for binding to editors (TipTap, ProseMirror, Slate)

**Merge integration:**
```
Field kind: richtext
Tier 1 strategy: Yjs CRDT merge (not LWW)
Process:
  1. Decode base state (Y.Doc from previousData or initial empty doc)
  2. Decode local state (Y.Doc)
  3. Decode remote state (Y.Doc)
  4. Apply both update vectors to base → merged Y.Doc
  5. Encode merged state → store as new value
  6. Emit MergeTrace with strategy: 'crdt-text'
```

**Key considerations:**
- Yjs state vectors can be large for long documents. Implement incremental updates: store the base state + a list of update deltas. Periodically compact (merge all deltas into a single state vector).
- Yjs has its own undo/redo system. Expose it through the API for DevTools integration.
- The Yjs `Y.Doc` must be shared across the sync and store layers — don't create redundant copies.

**Files:**
```
packages/merge/src/strategies/
  yjs-richtext.ts                  # Yjs merge strategy
  yjs-richtext.test.ts

packages/store/src/serialization/
  richtext-serializer.ts           # Y.Doc encode/decode
  richtext-serializer.test.ts

packages/react/src/hooks/
  use-rich-text.ts                 # Y.Text binding hook
  use-rich-text.test.ts
```

**Deliverable:** After Phase 5, developers can use `t.richtext()` fields that merge concurrent edits at the character level — no conflicts, no data loss, suitable for collaborative document editing.

---

## Phase 6: Sync Scopes and Server-Side Filtering

**Status:** Complete

**Goal:** Each client only receives operations it's authorized to see. The server enforces access control.

**Why sixth:** Without scopes, every client sees every operation — a security and performance problem. This phase adds the authorization boundary.

### 6a. Scope Definition and Enforcement

**Developer API:**
```typescript
const app = createApp({
  schema,
  sync: {
    url: 'wss://my-server.com/kora',
    scopes: {
      todos: (ctx) => ({ where: { userId: ctx.userId } }),
      // projects: no scope = full access (admin)
    },
  },
})
```

**Server-side enforcement:**
- During handshake, the server receives the client's auth context (from auth provider)
- The server evaluates scope functions against the auth context to determine which operations to send
- Operation batches are filtered: only operations matching the client's scope are included
- Scope evaluation is cached per session — re-evaluated on reconnect or explicit scope change

**Implementation:**
- Scope predicates are enforced from auth context for each client session
- Delta sync payloads are filtered before they are sent to clients
- Relayed operations are filtered against each session's scope map
- Inbound out-of-scope operations are dropped before persistence/relay
- Scope changes (e.g., user role changes) require a re-handshake

**Files:**
```
packages/sync/src/
  types.ts                         # Client-side scope function typing

packages/server/src/scopes/
  server-scope-filter.ts
  server-scope-filter.test.ts

packages/server/src/session/
  client-session.ts                # Scope enforcement for delta/relay/inbound flows
  client-session.test.ts
```

**Deliverable:** After Phase 6, multi-tenant applications can use Kora with proper data isolation. Each user only sees and syncs their own data.

---

## Phase 7: CLI `kora migrate` Command

**Status:** Complete

**Goal:** Schema changes are detected, migration plans generated, and applied — locally and to the server.

**Why seventh:** As applications evolve, schemas change. Without a migration system, developers must manually alter databases or wipe data. This phase automates that.

### Implemented so far

- Schema snapshot baseline and schema loading from TS/JS modules
- Structural schema diffing (collections, fields, indexes)
- SQL migration generation with up/down statements
- Migration file emission under `kora/migrations/`
- Optional apply flow for SQLite and Postgres backends
- Pending migration discovery/execution in deterministic file order
- Idempotent apply with `_kora_migrations` skip checks for already-applied migrations

### Completion notes

- Breaking-change confirmation prompts are supported (with `--force` for non-interactive flows)
- Richer transform handling exists for lossy field type changes with safety guards on unsafe required conversions
- Migration apply flow executes pending files deterministically and skips already-applied entries via `_kora_migrations`
- Integration-focused test coverage now verifies skip/idempotency and ordered pending apply behavior

### 7a. Schema Diff Engine

- Compare two `SchemaDefinition` objects (old vs new)
- Detect: added collections, removed collections, added fields, removed fields, changed field types, changed defaults, added/removed indexes, added/removed constraints
- Produce a `MigrationPlan` with ordered steps

### 7b. Migration Generator

- Translate `MigrationPlan` into SQL ALTER TABLE statements
- Handle type changes that require data transformation (e.g., `string` → `enum`: validate existing data)
- Generate a TypeScript migration file with `up()` and `down()` functions
- Store migration history in a `_kora_migrations` table

### 7c. Migration Runner

- Apply migrations to local SQLite/IndexedDB stores
- Apply migrations to server database
- Discover and execute pending migration files in order
- Skip already-applied migrations using `_kora_migrations` tracking
- Support dry-run mode (show what would change without applying)
- Handle migration conflicts (two developers add fields concurrently)

**Developer flow:**
```bash
$ kora migrate
  Detected schema change: v1 → v2

  Changes:
    + todos.priority (enum: low, medium, high, default: medium)
    ~ todos.tags (string → array<string>)
    - todos.deprecated_field

  Generated migration: kora/migrations/002-add-priority.ts

  ? Apply migration to local store? (y/n)
```

**Files:**
```
packages/cli/src/commands/migrate/
  migrate-command.ts               # Replaces current stub
  schema-differ.ts                 # SchemaDefinition diff
  schema-differ.test.ts
  migration-generator.ts           # Diff → SQL migration
  migration-generator.test.ts
  migration-runner.ts              # Applies migrations
  migration-runner.test.ts
```

**Deliverable:** After Phase 7, schema evolution is a first-class workflow. Developers change their schema, run `kora migrate`, and both client and server databases are updated safely.

---

## Phase 8: DevTools Browser Extension

**Status:** Complete

**Goal:** A Chrome/Firefox DevTools panel that visualizes sync, merges, operations, and connection state in real time.

**Why eighth:** The instrumentation backend exists (Phase 0 — already built). This phase builds the visual layer. It's last because the framework is fully functional without it, but the developer experience is significantly better with it.

### Implemented

- Extension routing pipeline from page `window.postMessage` events → content script → background router → DevTools panel
- Panel-state model builder for timeline/conflicts/operations/network views
- DevTools panel renderer with live updates across all core event categories
- Extension scaffold files (`manifest.json`, background/content/devtools scripts, panel host HTML)
- Unit/integration coverage for panel-state derivation and per-tab port routing behavior

### 8a. DevTools UI

**Panels (as specified in CLAUDE.md):**

1. **Sync Timeline** — Horizontal timeline of operations and sync events. Color-coded by type (insert=green, update=blue, delete=red, sync=purple). Causal dependency arrows between operations. Click to inspect full payload. Zoom and pan.

2. **Conflict Inspector** — Table of merge events. Columns: timestamp, collection, field, strategy, tier, input values, output value. Expandable rows show full `MergeTrace`. Filter by collection, tier, strategy. Highlight constraint violations in amber.

3. **Operation Log** — Searchable list of all operations. Full-text search across collection, recordId, field names, values. Click any operation to see: full payload, causal deps graph, resulting record state. Time-travel: select an operation to see the database state at that point.

4. **Network Status** — Real-time connection quality indicator. Pending operation count with progress bar. Bandwidth graph (operations/second in and out). Last sync timestamp. Version vector visualization.

**Architecture:**
- Lightweight module-based panel UI rendered from derived event state
- `MessageBridge` (already built in @korajs/devtools) connects page context to extension panel
- Extension manifest v3 (Chrome) with content script injection
- Event stream from `Instrumenter` → `MessageBridge` → DevTools panel
- Panel state management: local in-panel event state, no external state library

**Files:**
```
packages/devtools/src/
  ui/
    panel.ts                       # Main DevTools panel renderer
    panel-state.ts                 # Timeline/conflict/operation/network model builder
    panel-state.test.ts
  extension/
    devtools.ts                    # Registers the DevTools panel
    panel.ts                       # Panel runtime wiring
    port-router.ts                 # Background per-tab routing logic
    port-router.test.ts
    manifest.json                  # Chrome extension manifest v3
    content-script.ts              # Injects bridge into page
    devtools-page.html             # DevTools panel host
    background.ts                  # Service worker
```

**Deliverable:** After Phase 8, developers open Chrome DevTools, click the "Kora" tab, and see exactly what's happening with their data — every operation, every merge decision, every sync event — in real time.

---

## Cross-Cutting: Type Inference, Relational Queries, and Drizzle Migration

**Status:** Complete

These three features span multiple packages and were implemented as a unified effort after Phase 8.

### End-to-End Type Inference

Full compile-time type inference from `defineSchema()` through `createApp()` to collection accessors and React hooks. Zero code generation, zero runtime changes — pure TypeScript generics (same pattern as Drizzle ORM, Zod, tRPC).

**What it provides:**
- `defineSchema<const T>()` preserves the literal schema shape at the type level via `const` type parameter + phantom `__input` brand
- `FieldBuilder<Kind, Req, Auto>`, `EnumFieldBuilder<Values, Req, Auto>`, `ArrayFieldBuilder<ItemKind, Req, Auto>` carry full type information
- `InferRecord<Fields>` maps field builders → TypeScript types (string, number, boolean, enum literals, typed arrays)
- `InferInsertInput<Fields>` produces correct required/optional keys (auto fields excluded, defaulted/optional fields optional)
- `InferUpdateInput<Fields>` makes all non-auto fields optional
- `TypedKoraApp<S>` provides typed collection accessors: `app.todos.insert({...})` gets full autocomplete and type checking
- `QueryBuilder<T>` threads the generic through `useQuery<T>()` in React hooks

**Files:**
```
packages/core/src/schema/infer.ts          # InferFieldType, InferRecord, InferInsertInput, InferUpdateInput
packages/core/src/schema/infer.test.ts     # 19 type-level tests with expectTypeOf
packages/core/src/schema/types.ts          # FieldBuilder generic upgrades (Req, Auto params)
packages/core/src/schema/define.ts         # defineSchema<const T>, TypedSchemaDefinition
kora/src/types.ts                          # TypedKoraApp, TypedCollectionAccessor, TypedKoraConfig
kora/src/create-app.ts                     # Typed overload for createApp
packages/store/src/query/query-builder.ts  # QueryBuilder<T> generic
packages/react/src/hooks/use-query.ts      # useQuery<T> generic threading
packages/react/src/query-store/query-store.ts  # QueryStore<T> generic
```

### Relational Queries (`.include()`)

Separate-queries pattern (like Prisma) — primary query runs first, then batch-fetches related records. No SQL JOINs. Works with all adapters.

**What it provides:**
- `app.todos.where({ completed: false }).include('project').exec()` resolves many-to-one relations
- `app.projects.where({}).include('todos').exec()` resolves one-to-many relations
- Null FK values produce `null` relation property
- Subscription manager re-evaluates when included collections mutate
- FK REFERENCES in SQL generation with auto-indexing of FK columns

**Files:**
```
packages/store/src/query/query-builder.ts  # include(), resolveIncludes(), resolveManyToOneInclude(), resolveOneToManyInclude()
packages/store/src/query/pluralize.ts      # pluralize() / singularize() utilities
packages/store/src/query/pluralize.test.ts # 10 tests
packages/store/src/query/include.test.ts   # 9 integration tests
packages/store/src/types.ts                # include/includeCollections in QueryDescriptor
packages/store/src/subscription/subscription-manager.ts  # Include-aware flush
packages/core/src/schema/sql-gen.ts        # FK REFERENCES + auto-index generation
packages/core/src/schema/sql-gen.test.ts   # 3 new FK tests
```

### Full Drizzle ORM for Server Stores

Both `SqliteServerStore` and `PostgresServerStore` now use Drizzle ORM typed query builders for all reads and writes. See Phase 3 for details.

---

## Phase 9: Protocol and Performance Hardening

**Status:** Complete

**Goal:** Production-grade wire format and validated performance targets.

### Implemented so far

- Protobuf message serializer in `@korajs/sync` (`ProtobufMessageSerializer`) with operation/message roundtrip coverage
- Runtime wire-format negotiation (`json` / `protobuf`) via handshake `supportedWireFormats` and `selectedWireFormat`
- Negotiated serializer support in sync engine and server sessions, with JSON compatibility fallback
- WebSocket client/server transports updated to send/receive string or binary payloads
- HTTP long-polling client transport in `@korajs/sync` (POST send + GET receive + optional WebSocket upgrade)
- Server-side HTTP sync request handling in `@korajs/server` with long-poll queueing and ETag support
- Performance benchmark gates implemented for `@korajs/store`, `@korajs/merge`, and `@korajs/sync`, plus CI workflow execution
- Nightly chaos convergence suite added (`10 clients × 1,000 ops`, `10% drop`, `5% duplicate`) with scheduled CI workflow

### 9a. Protobuf Wire Format

Replace JSON serialization with Protocol Buffers for the sync protocol.

- Define `.proto` files for all message types (Handshake, OperationBatch, Acknowledgment, Error)
- Use `protobufjs` for encode/decode
- Backward-compatible: negotiate format during handshake (protobuf preferred, JSON fallback)
- Expected bandwidth reduction: 40-60% over JSON for typical operation payloads

### 9b. HTTP Long-Polling Transport

For environments where WebSocket is unavailable (corporate proxies, serverless functions).

- Implements the same `Transport` interface as WebSocket
- Uses HTTP POST for sending operations, GET with long-polling for receiving
- Automatic upgrade to WebSocket when available
- ETag-based caching for delta responses

### 9c. Performance Benchmarks in CI

Implement the benchmarks specified in CLAUDE.md as CI-enforced gates:

```
@korajs/store:
  Insert 10,000 records: < 2 seconds
  Query 1,000 records with WHERE: < 50ms
  Reactive query notification: < 16ms

@korajs/merge:
  Merge 1,000 concurrent operations: < 500ms
  LWW comparison: < 1 microsecond

@korajs/sync:
  Initial sync 10,000 operations: < 5 seconds
  Incremental sync 1 operation: < 200ms end-to-end
  Version vector delta: < 10ms for 100 nodes
```

### 9d. Chaos Test Suite

The CLAUDE.md-specified chaos test: 10 clients, 1,000 operations each, 10% message drop, 5% duplicate rate. All clients must converge to identical state within 60 seconds.

- Uses `ChaosTransport` (already built) with `MemoryTransport` backbone
- Runs nightly in CI
- Failure = build-breaking regression

**Deliverable:** After Phase 9, the sync protocol is bandwidth-efficient, works over HTTP fallback, and performance is continuously validated against published targets.

---

## Phase 10: End-to-End Integration and Launch Readiness

**Status:** Complete

**Goal:** The full `npx create-kora-app` to production deployment path works flawlessly.

### 10a. End-to-End Test Suite

Playwright-based E2E tests in `e2e/` workspace package with a dedicated fixture app (`e2e/fixture-app/`):

- **CRUD sync test:** Insert/update/delete across 2 browser contexts, verify operations sync via WebSocket server
- **Offline convergence test:** Tab goes offline, makes mutations, comes back online — both tabs converge
- **Multi-tab test:** Same browser context, 2 pages, verify sync across tabs
- **CLI scaffolding test:** Verifies `kora create` generates expected files under 10 seconds

Infrastructure: Playwright config auto-starts Vite dev server (port 5199) + sync server (port 3099). Chromium only, serial workers, 60s timeout, trace on first retry.

### 10b. Documentation Site

VitePress documentation site in `docs/` workspace package:

- **Landing page** with hero section and feature highlights
- **Getting Started** — 5-minute tutorial from scaffold to sync
- **Guides:** Schema Design, Offline Patterns, Conflict Resolution, Sync Configuration, React Hooks, DevTools, Deployment
- **API Reference:** Core, Store, Server, React, CLI — manual docs with function signatures, parameter tables, and code examples
- **Examples:** Todo App, Collaborative Notes

### 10c. Publish Pipeline

GitHub Actions CI/CD workflows:

- **`ci.yml`** — PRs + push to main: lint → build → test → typecheck
- **`release.yml`** — Push to main: Changesets action creates "Version Packages" PR or publishes to npm
- **`canary.yml`** — Push to main: publishes canary snapshots when no pending changesets
- **`e2e.yml`** — Push to main + manual: runs Playwright E2E suite
- **`docs.yml`** — Push to main (docs/** changes) + manual: builds VitePress → deploys to GitHub Pages

---

## Phase 11: Developer Experience & Launch Polish

**Status:** Complete

**Goal:** Make `npx create-kora-app` produce a polished, impressive app out of the box. Expand the template system with Tailwind CSS support, improve default styling, enable DevTools by default, and ship persistent server stores in sync templates.

**Why now:** All 10 technical phases are complete, but the first-impression developer experience has gaps. Templates ship with bare inline styles, no CSS framework choice, memory-only sync servers, and no quick-start flags. This phase bridges the gap between "technically correct" and "delightful to use."

### 11a. Template System Upgrade (4 Templates)

Expand from 2 templates to 4, adding Tailwind CSS variants:

| Template | Sync? | Styling | Default? |
|----------|-------|---------|----------|
| `react-tailwind-sync` | Yes | Tailwind CSS + lucide-react | **Recommended** |
| `react-tailwind` | No | Tailwind CSS + lucide-react | |
| `react-sync` | Yes | Plain CSS (dark theme) | |
| `react-basic` | No | Plain CSS (dark theme) | |

**New CLI flags:**
- `--yes` / `-y` — accept all defaults (react-tailwind-sync + detected PM)
- `--tailwind` / `--no-tailwind` — skip styling prompt
- `--sync` / `--no-sync` — skip sync prompt

**Updated interactive flow:**
1. Project name (unchanged)
2. Template — 4 options with `React + Tailwind (with sync)` recommended
3. Package manager (unchanged)

### 11b. Polished Template UI

All templates get a visual overhaul:

**Tailwind templates (`react-tailwind-sync`, `react-tailwind`):**
- Dark theme with Tailwind CSS utility classes
- `lucide-react` icons (CheckCircle2, Circle, Plus, Trash2, Wifi, WifiOff, etc.)
- Stat cards (Total / Remaining / Done)
- Filter tabs (All / Active / Completed) with badge counts
- Styled add form with loading state
- Todo list with toggle icons, strikethrough, timestamp, hover-delete
- Sync status indicator (sync variants only)
- "Powered by Kora" footer

**Plain CSS templates (`react-sync`, `react-basic`):**
- New `src/index.css` with CSS custom properties, system font stack, dark theme reset
- Rewritten `App.tsx` with proper CSS class-based styling (no inline styles)
- Same features as Tailwind but simpler presentation

### 11c. DevTools Enabled by Default

All 4 templates include `devtools: true` in `createApp` config. The instrumenter is lightweight — only emits events when the browser extension is installed.

### 11d. Persistent Server Stores

Sync templates ship with SQLite persistence by default (`createSqliteServerStore`) instead of `MemoryServerStore`. Server data survives restarts. Comments in `server.ts` show how to switch to PostgreSQL.

### Implementation Steps

| Step | What | Status |
|------|------|--------|
| 1 | Update `types.ts` — 4 templates, new flags | Complete |
| 2 | Update `create-command.ts` — new prompt flow, flag handling | Complete |
| 3 | Create `react-tailwind-sync` template | Complete |
| 4 | Create `react-tailwind` template | Complete |
| 5 | Upgrade `react-sync` template — CSS, devtools, SQLite store | Complete |
| 6 | Upgrade `react-basic` template — CSS, devtools | Complete |
| 7 | Update tests for all 4 templates | Complete |
| 8 | Build and verify — 130 tests passing (up from 120) | Complete |

**Deliverable:** After Phase 11, `npx create-kora-app my-app` produces a visually polished, dark-themed todo app with Tailwind CSS, sync status, DevTools enabled, and persistent server storage — all with zero configuration.

---

## Shipped Phases (1–11)

| Phase | Scope | Status |
|-------|-------|--------|
| **1** | Browser storage (SQLite WASM + IndexedDB) | Complete |
| **2** | `createApp` factory + meta-package | Complete |
| **3** | Server persistence (Drizzle ORM) | Complete |
| **4** | `kora dev` command | Complete |
| **5** | Yjs richtext merge | Complete |
| **6** | Sync scopes | Complete |
| **7** | `kora migrate` command | Complete |
| **8** | DevTools browser extension | Complete |
| **Cross-cutting** | Type inference, relational queries, Drizzle migration | Complete |
| **9** | Protobuf, HTTP transport, benchmarks, chaos | Complete |
| **10** | E2E tests, docs, publish pipeline | Complete |
| **11** | Developer experience & launch polish | Complete |

---

# Part 2: The Path to Mass Adoption

**Where Phases 1–11 stop:** Kora has a feature-complete runtime. A developer can scaffold a polished app, run it locally, sync across devices, debug with DevTools, migrate schemas, and self-host the sync server.

**What's still missing:** The lifecycle. From "running locally" to "in production with users" there is no paved path. From "first impression" to "second project" there is no remembered context. From "React only" to "the rest of the frontend ecosystem" there are no bindings. From "I have an existing app" to "I want offline-first" there is no migration story.

Phases 12–23 close those gaps.

## The Core Thesis

No offline-first framework owns the full lifecycle. PouchDB requires CouchDB. ElectricSQL requires Docker + Postgres + manual sync service setup. PowerSync has a steep learning curve. None have a `create-X-app` *and* a `deploy` command *and* managed hosting. None get a developer to production in under 15 minutes.

If Kora owns the entire lifecycle — create, develop, deploy, monitor, evolve — the same way Vercel owns it for Next.js, it becomes the default choice. Not because the CRDT engine is better (though it is), but because the developer never has to think.

---

## Phase 12: CLI & Onboarding Overhaul

**Status:** Planned

**Goal:** Make the first 60 seconds with Kora indistinguishable from the best CLI experiences in the ecosystem (Next.js, Astro, Nuxt). Add the missing scaffold-time choices that should never be a post-install scramble.

**Why now:** Phases 1–11 nailed the runtime. Phase 11 polished templates. But the prompt experience still uses citty's built-in select rendering, which lacks the arrow-key polish, intro/outro framing, and persistent preferences that developers expect in 2026. And the scaffold doesn't yet ask developers what kind of database they want — a critical decision that's currently made after the project is created.

### 12a. Modern Prompt System (`@clack/prompts`)

Replace citty's built-in select prompts with `@clack/prompts`. Citty stays as the command framework; `@clack/prompts` becomes the interactive layer.

**What changes:**
- Arrow-key navigation for every selection
- Grouped intro/outro framing (`intro()`, `outro()`, `note()`)
- Spinner animations (`spinner()`) for install steps and long operations
- Confirmation prompts with `yes`/`no` highlighting
- Multi-line text input for connection strings
- Visual consistency with the broader UnJS / Nuxt ecosystem

**Trade-off considered:** `@clack/prompts` is ~4KB gzipped and adds one dependency. It's actively maintained, TypeScript-native, and the modern standard. The alternative (`prompts`, used by Next.js) is smaller but less polished out of the box.

### 12b. Expanded `create-kora-app` Prompts

The prompt flow becomes:

1. **Project name** (with `validate-npm-package-name`)
2. **UI framework** — React (available initially); Vue, Svelte, Solid (shown as "coming soon" to signal roadmap)
3. **Tailwind CSS** — Yes / No
4. **Sync** — Enable multi-device sync? Yes / No
5. **Server-side database** *(only when sync = Yes)* — SQLite (zero-config) / PostgreSQL (production-scale)
6. **Database provider** *(only when PostgreSQL)* — Local / Supabase / Neon / Railway / Vercel Postgres / Custom connection string
7. **Authentication** — None / Email + Password / OAuth (latter two greyed out until Phase 14 ships)
8. **Package manager** — auto-detected default, with override

Each choice is bypassable via CLI flag (`--framework`, `--db`, `--db-provider`, `--auth`, `--pm`). `--yes` accepts every default in one shot.

### 12c. Composable Template Layers

Today, each `template/` directory is a complete copy. Adding a new combination (e.g., React + Tailwind + Postgres + Sync) means a new directory. This does not scale to 4 frameworks × 2 styling × 2 sync × N db providers.

**New approach:** templates compose from layers.

```
packages/cli/templates/
  base/                  # Shared: tsconfig, .gitignore, README skeleton
  ui/
    react/               # main.tsx, App.tsx, vite.config.ts
    vue/                 # (Phase 19)
    svelte/              # (Phase 19)
  style/
    tailwind/            # tailwind.config, postcss, themed App.tsx
    plain/               # index.css, themed App.tsx
  sync/
    enabled/             # server.ts, kora.config.ts with sync, .env.example
    disabled/            # local-only main.tsx
  db/
    sqlite/              # better-sqlite3 deps, server.ts variant
    postgres/
      local/             # docker-compose snippet + .env template
      supabase/          # Supabase-specific .env, link helper
      neon/
      railway/
      vercel-postgres/
  auth/
    none/
    email-password/      # (Phase 14)
    oauth/               # (Phase 14)
```

The CLI assembles the chosen layers into the final project. Each layer is independently testable.

### 12d. Remembered Preferences

Use the `conf` library (same package Next.js uses). On first run, save the developer's choices. On subsequent runs, the first prompt becomes:

```
◆  Welcome back!
│  ● Use previous settings (React + Tailwind + Sync + SQLite + pnpm)
│  ○ Customize
```

Stored under the OS-appropriate config dir.

### 12e. Auto-Detection Improvements

- Detect package manager from `npm_config_user_agent` (already done)
- Detect editor (VS Code, Cursor, Windsurf, Zed) and offer to install the relevant extension or workspace settings
- Detect existing `.git` and skip `git init`
- Detect monorepo context (pnpm workspace, Turborepo) and offer to add Kora as a workspace package

**Files:**
```
packages/cli/src/prompts/                    # @clack/prompts wrappers
  ui-prompts.ts
  db-prompts.ts
  auth-prompts.ts
  preferences.ts                              # conf integration
packages/cli/src/templates/composer.ts        # Layer assembly
packages/cli/src/templates/composer.test.ts
packages/cli/templates/base/
packages/cli/templates/ui/react/
packages/cli/templates/style/{tailwind,plain}/
packages/cli/templates/sync/{enabled,disabled}/
packages/cli/templates/db/{sqlite,postgres/...}/
```

**Deliverable:** After Phase 12, `npx create-kora-app my-app` is a beautiful, modern CLI experience with arrow-key navigation, sensible defaults, remembered preferences, and scaffold-time database choice — equivalent in polish to `create-next-app` and `create-astro`.

---

## Phase 13: `kora deploy` — The Game Changer

**Status:** In Progress

**Goal:** A single command takes a Kora project from local development to a live production URL on the developer's chosen platform — including infrastructure, database, secrets, and SSL.

**Why now:** This is the single most impactful feature Kora can ship after Phase 11. It is what separates a library from a platform. No competing offline-first framework has it.

### Phase 13 implementation progress (updated)

**Completed so far:**
- `deploy` command wired into `kora` CLI (`packages/cli/src/bin.ts`)
- deploy state persistence (`.kora/deploy/deploy.json`) with tests
  - read/write/update/reset flows
- generated artifact foundation:
  - Dockerfile
  - `.dockerignore`
  - Fly config generation (`fly.toml`)
- server bundling now uses **esbuild** (replaces placeholder artifact)
- adapter contract (`DeployAdapter`) implemented and used by command flow
- concrete **Fly adapter** implemented and integrated:
  - detect/install/authenticate/provision/build/deploy
  - rollback/logs/status methods wired into command surface
- `--confirm` mode now fails fast when required values are missing
- deploy subcommands currently wired:
  - `kora deploy status`
  - `kora deploy logs`
  - `kora deploy rollback`

**Still to build for Phase 13 completion:**
- full Railway adapter implementation (**in progress**: adapter + `railway.json` generator scaffolded)
- full Render adapter implementation
- Docker adapter implementation (self-hosted deploy workflow)
- Kora Cloud adapter stub-to-real transition deferred to Phase 21
- CI-centric polish for `--confirm` end-to-end flows and docs examples
- remaining deploy subcommands:
  - `kora deploy env list`
  - `kora deploy env set KEY value`
  - `kora deploy db shell`
  - `kora deploy db backup`
- platform-specific artifact generators not yet added:
  - `railway-json-generator.ts`
  - `render-yaml-generator.ts`
  - `docker-compose-generator.ts`

### 13a. Platform Adapter Architecture

Each supported platform implements a `DeployAdapter` interface:

```typescript
interface DeployAdapter {
  name: 'fly' | 'railway' | 'render' | 'docker' | 'kora-cloud'
  detect(): Promise<boolean>           // Is the platform CLI installed?
  install(): Promise<void>             // Install the platform CLI if missing
  authenticate(): Promise<void>        // Login flow
  provision(config: ProjectConfig): Promise<ProvisionResult>
    // Creates app, provisions database, sets secrets
  build(config: ProjectConfig): Promise<BuildArtifacts>
    // Vite client + esbuild server bundle
  deploy(artifacts: BuildArtifacts): Promise<DeployResult>
    // Returns the live URL
  rollback(deployment: string): Promise<void>
  logs(options: LogOptions): AsyncIterable<LogLine>
  status(): Promise<DeploymentStatus>
}
```

**Initial adapters (in priority order):**
1. **Fly.io** — Full WebSocket support, regional deployment, Postgres add-on, generous free tier
2. **Railway** — Excellent DX, plugin system for Postgres, simple pricing
3. **Render** — Free tier with caveats, GitHub-first workflow
4. **Docker** — Generates Dockerfile + docker-compose.yml for any host (VPS, Kubernetes, ECS)
5. **Kora Cloud** — Stub now, fully wired in Phase 21

### 13b. Generated Deployment Artifacts

`kora deploy` generates a `.kora/deploy/` directory with:

- **Dockerfile** — Multi-stage: builder (installs deps, builds client, bundles server) → production (slim runtime image)
- **Platform config** — `fly.toml`, `railway.json`, `render.yaml`, or `docker-compose.yml`
- **`.dockerignore`** — Excludes `node_modules`, `.env`, `.git`, test artifacts
- **`server-bundled.js`** — Server entry bundled with esbuild into a single file (zero external deps for the runtime)
- **`deploy.json`** — Records platform, app name, region, database connection ID. Used by subsequent runs.

All generated files include a `# Generated by kora deploy — do not edit manually` header. `.kora/` is added to `.gitignore` by default; the developer can opt to commit it.

### 13c. Auto-Provisioning Flow

```
$ kora deploy

┌  Kora Deploy
│
◆  Where do you want to deploy?
│  ● Fly.io (recommended for sync apps — full WebSocket support)
│  ○ Railway
│  ○ Render
│  ○ Docker (self-hosted)
│  ○ Kora Cloud (coming soon)
│
◇  Scanning project...
│  ✓ Detected: Kora app with sync (PostgreSQL store, React client)
│  ✓ Found: kora.config.ts, schema.ts, server.ts
│
◆  Fly CLI not installed. Install now?
│  ● Yes  ○ Skip (I'll install manually)
│
◇  Authenticating with Fly.io...
│  ✓ Logged in as user@example.com
│
◆  App name?
│  my-app-kora
│
◆  Region?
│  ● iad (US East — closest to you)
│  ○ lhr (London)
│  ○ syd (Sydney)
│  ○ Other...
│
◇  Provisioning...
│  ✓ Created Fly app: my-app-kora
│  ✓ Provisioned Postgres cluster: my-app-kora-db
│  ✓ Set secrets: DATABASE_URL, PORT
│  ✓ Configured COOP/COEP headers for SharedArrayBuffer support
│
◇  Building...
│  ✓ Client built (Vite → dist/, 412 KB gzipped)
│  ✓ Server bundled (esbuild → server-bundled.js, 2.1 MB)
│  ✓ Docker image built (94 MB)
│
◇  Deploying...
│  ✓ Image pushed
│  ✓ Health check passed
│  ✓ Traffic routed
│
└  Live at: https://my-app-kora.fly.dev
   Sync:    wss://my-app-kora.fly.dev/kora-sync

   Next:
   • kora deploy logs        — stream live logs
   • kora deploy --prod      — promote to production
   • kora deploy rollback    — revert this deployment
```

### 13d. Subsequent Deployments

After the first run, `.kora/deploy/deploy.json` records all the choices. Subsequent runs skip every prompt:

```
$ kora deploy
  Deploying to Fly.io (my-app-kora, iad)...
  ✓ Built client + server
  ✓ Deployed (4.2s)
  Live at: https://my-app-kora.fly.dev
```

Use `--platform` to override (forces re-prompt), `--reset` to wipe `.kora/deploy/`.

### 13e. CI/CD Integration

```yaml
# .github/workflows/deploy.yml
- run: npx kora deploy --prod --confirm
  env:
    FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
```

`--confirm` reads everything from `.kora/deploy/deploy.json`, fails fast if anything is missing, never prompts.

### 13f. Deployment Subcommands

```bash
kora deploy logs                  # Stream live server logs
kora deploy status                # Current deployment status
kora deploy rollback              # Revert to previous deployment
kora deploy rollback <id>         # Revert to a specific deployment
kora deploy env list              # List remote environment variables
kora deploy env set KEY value     # Set a remote environment variable
kora deploy db shell              # Open a psql/sqlite shell on remote
kora deploy db backup             # Trigger a backup
```

**Files:**
```
packages/cli/src/commands/deploy/
  deploy-command.ts
  deploy-command.test.ts
  adapters/
    adapter.ts                       # DeployAdapter interface
    fly-adapter.ts
    fly-adapter.test.ts
    railway-adapter.ts
    railway-adapter.test.ts
    render-adapter.ts
    render-adapter.test.ts
    docker-adapter.ts
    docker-adapter.test.ts
  artifacts/
    dockerfile-generator.ts
    docker-compose-generator.ts
    fly-toml-generator.ts
    railway-json-generator.ts
    render-yaml-generator.ts
  builder/
    client-builder.ts                # Vite invocation
    server-bundler.ts                # esbuild
  state/
    deploy-state.ts                  # .kora/deploy/deploy.json
    deploy-state.test.ts
```

**Deliverable:** After Phase 13, every Kora developer has a one-command path to production. The 15-minute promise becomes real.

---

## Phase 14: Built-in Authentication

**Status:** Planned

**Goal:** Authentication that understands offline-first. JWT-based local validation, sync-scope integration, and React hooks — all configured in `kora.config.ts`.

**Why now:** Every real app needs auth. If Kora does not ship it, developers bolt on Auth0, Clerk, or Supabase Auth, and the integration with sync scopes becomes manual and error-prone. This is the second biggest adoption blocker after deployment.

### 14a. Auth Provider Architecture

```typescript
// kora.config.ts
import { defineConfig } from 'korajs/config'
import { koraAuth, oauthAuth, customAuth } from 'korajs/auth'

export default defineConfig({
  auth: koraAuth({
    methods: ['email-password', 'magic-link'],
    sessionDuration: '30d',
    requireEmailVerification: true,
  }),
  // OR
  auth: oauthAuth({
    providers: ['google', 'github', 'apple'],
    redirectUrl: '/auth/callback',
  }),
  // OR
  auth: customAuth({
    verify: async (token) => {
      // Bring your own auth (Clerk, Auth0, Supabase, etc.)
      return { userId: '...', role: '...' }
    },
  }),
})
```

### 14b. Offline-First JWT Validation

The single hardest problem with auth in offline-first apps: traditional auth checks the server on every request, which breaks offline.

Kora's approach:
- The auth provider issues a JWT signed with a public/private keypair
- The public key is bundled into the client at build time (or fetched + cached on first connect)
- The client validates the JWT locally on every operation — no network needed
- Token refresh happens opportunistically when the client is online
- Expired tokens queue mutations until re-authentication completes; the queue persists across restarts

### 14c. Sync Scope Integration

Auth context flows automatically into sync scopes:

```typescript
sync: {
  scopes: {
    todos: (ctx) => ({ where: { userId: ctx.userId } }),
    projects: (ctx) => ({
      where: ctx.role === 'admin' ? {} : { ownerId: ctx.userId }
    }),
  }
}
```

The server validates the JWT, extracts the auth context, evaluates each scope predicate, and only sends matching operations to that client. Phase 6's scope infrastructure already enforces this — Phase 14 just provides the auth context.

### 14d. React Hooks and Components

```typescript
import { AuthProvider, useAuth, SignInForm } from 'korajs/react'

function App() {
  return (
    <AuthProvider>
      <KoraProvider app={app}>
        <Routes />
      </KoraProvider>
    </AuthProvider>
  )
}

function ProtectedPage() {
  const { user, signOut } = useAuth()
  if (!user) return <SignInForm />
  return <Dashboard userId={user.id} />
}
```

Pre-built components (`<SignInForm>`, `<SignUpForm>`, `<MagicLinkForm>`, `<OAuthButtons>`) are headless by default — they accept className/style props and can be themed to match any design system.

### 14e. Server-Side Auth Endpoints

When using `koraAuth()`, the Kora server exposes:
- `POST /auth/signup` — email + password registration
- `POST /auth/signin` — email + password login
- `POST /auth/magic-link` — request magic link
- `GET  /auth/verify?token=...` — verify email or magic link
- `POST /auth/refresh` — refresh JWT
- `POST /auth/signout` — invalidate session

Stored in the same database as sync data (separate `auth_users` and `auth_sessions` tables, managed via Drizzle).

**Files:**
```
packages/auth/                       # NEW PACKAGE: @korajs/auth
  src/
    index.ts
    providers/
      kora-auth.ts                   # Email/password + magic link
      oauth-auth.ts                  # OAuth (Google, GitHub, Apple)
      custom-auth.ts                 # BYO verify function
    jwt/
      sign.ts
      verify.ts
      jwks.ts
    storage/
      auth-store.ts                  # Drizzle schema for users + sessions
packages/react/src/auth/
  auth-provider.tsx
  use-auth.ts
  components/
    sign-in-form.tsx
    sign-up-form.tsx
    magic-link-form.tsx
    oauth-buttons.tsx
packages/server/src/auth/
  auth-routes.ts                     # Mounted on /auth/*
  jwt-validator.ts                   # For sync handshake
```

**Deliverable:** After Phase 14, a developer enables auth with a single config block. Sync scopes are enforced automatically. The app works offline even with auth enabled. No third-party auth provider is needed (but any is supported as an option).

---

## Phase 15: Encryption & Privacy

**Status:** Planned

**Goal:** Make Kora the only sync framework that can credibly serve healthcare, finance, legal, and any other regulated industry — by giving developers four levels of encryption (none, at-rest, field-level E2EE, full E2EE), with key management, recovery, and multi-device sync that just works.

**Why now:** Without an encryption story, Kora is excluded from regulated verticals — exactly the verticals where offline-first is most valuable. Healthcare clinics, field surveyors, attorneys, and finance teams need offline-first more than anyone, but cannot adopt a framework whose servers can read their data. This phase turns that blocker into Kora's strongest competitive moat: *the only sync platform that literally cannot read your users' data.*

This phase must land before Phase 21 (Kora Cloud), because the cloud pitch depends on it ("we host your sync server but never see your data").

### 15a. Encryption Modes

Four modes, picked by the developer based on threat model. No coercion — apps that genuinely don't need encryption can opt out entirely.

| Mode | Server can read | Constraints | Sync scopes | Server-side query | Use case |
|------|-----------------|-------------|-------------|-------------------|----------|
| `none` | Everything | All tiers | Yes | Yes | Demos, internal tools, public-data apps, learning |
| `at-rest` (default) | Everything (server side) | All tiers | Yes | Yes | Most consumer and B2B apps |
| `field-level` | Plaintext fields only | Tier 2 on plaintext only | On plaintext fields | On plaintext fields | **Healthcare, finance, legal, education** |
| `end-to-end` | Nothing (metadata only) | Tier 1+3 only (advisory) | Metadata only | No | Maximum-privacy apps (whistleblowing, secrets, end-to-end messaging) |

The `none` mode exists deliberately. Encryption has overhead, complexity, and recovery risk. Apps that store public data, demo content, or genuinely non-sensitive information should be free to skip it. Forcing encryption on everyone would be a bandage, not a design.

```typescript
// Mode 0: None — opt out (for non-sensitive apps)
const app = createApp({
  schema,
  encryption: { mode: 'none' }
})

// Mode 1: At-rest — default, zero config
const app = createApp({ schema })

// Mode 2: Field-level E2EE — sensitive fields opaque to server
const app = createApp({
  schema,
  encryption: {
    mode: 'field-level',
    keyProvider: 'device-keychain',
    recovery: { strategy: 'mnemonic' },
  }
})

// Mode 3: Full E2EE — server stores opaque ciphertext only
const app = createApp({
  schema,
  encryption: {
    mode: 'end-to-end',
    keyProvider: { type: 'kms', provider: 'aws-kms', keyId: '...' },
    recovery: { strategy: 'kms' },
  }
})
```

### 15b. At-Rest Encryption (Mode 1, default)

- Local SQLite/IndexedDB database file encrypted with AES-256-GCM
- Key stored in OS keychain (iOS Keychain, Android Keystore, macOS Keychain, Windows DPAPI, libsecret on Linux)
- For browsers: key derived from a non-extractable WebCrypto key bound to the origin
- Server sees plaintext — all existing sync, merge, constraint, and scope behavior is unchanged
- Overhead: ~5–10% on writes, negligible on reads (modern AES-NI)
- Defends against: device theft, backup leakage (iCloud, Google Drive), sandbox escape on the same device

This is the default for any new Kora app. Zero config required.

### 15c. Field-Level E2EE (Mode 2 — the sweet spot)

The developer marks sensitive fields with `.encrypted()` in the schema. Those fields are opaque to the server; everything else stays plaintext, so sync, indexes, sort, and scope filters keep working.

```typescript
patients: {
  fields: {
    id: t.string(),                            // plaintext (routing)
    clinicId: t.string(),                      // plaintext (sync scope)
    createdAt: t.timestamp(),                  // plaintext (sort/index)
    firstName: t.string().encrypted(),         // ciphertext
    lastName: t.string().encrypted(),          // ciphertext
    ssn: t.string().encrypted().blindIndex(),  // hashed for equality search
    diagnosis: t.richtext().encrypted(),       // CRDT state encrypted as a blob
    bloodType: t.enum([...]).encrypted(),      // ciphertext
  },
  indexes: ['clinicId', 'createdAt'],          // only on plaintext fields
}
```

Per-field encryption rules:
- Encryption happens at the operation level, before the operation is hashed and signed
- `previousData` for updates is also encrypted (otherwise old values leak)
- Tier 1 LWW merge works on ciphertext directly (compares timestamps, picks winner)
- Tier 1 for `array` fields: encrypted set merged on the client only
- Tier 1 for `richtext` fields: entire Yjs state encrypted as a blob, merged on client; loses incremental delta sync (acceptable trade-off)
- Tier 2 constraints declared on encrypted fields are client-side only and marked "advisory" in docs
- Optional `.blindIndex()` modifier enables exact-match equality queries via salted hashes
- Range queries on encrypted fields are deliberately unsupported (order-preserving encryption schemes have known weaknesses)

### 15d. Full E2EE (Mode 3)

All operations encrypted before leaving the device. Server stores opaque ciphertext, routes only by node ID and timestamps. Constraints become client-side only (Tier 2 of the merge engine degrades to "advisory"). Use cases: end-to-end messaging, whistleblowing tools, secret-tier health records.

### 15e. Key Management

Encryption is easy. Keys are where 90% of E2EE projects die. Kora ships multiple key providers and lets the developer pick one per app:

| Provider | Backing | Recovery | Multi-device | Best for |
|----------|---------|----------|--------------|----------|
| `device-keychain` (default) | OS keychain / WebCrypto | None or escrow opt-in | Single device | Personal apps |
| `passphrase` | Argon2id-derived | Mnemonic | Yes | Personal data apps |
| `mnemonic` | BIP39 24-word phrase | Mnemonic | Yes | Crypto-style apps |
| `kms` | AWS / GCP / Azure KMS or HSM | Org admin | Yes | **Enterprise, healthcare** |
| `social` | Shamir's Secret Sharing | K-of-N trusted contacts | Yes | High-trust, high-value |
| `custom` | Developer-provided | Developer-defined | Developer-defined | Escape hatch |

Internally Kora uses **envelope encryption**: a randomly generated Data Encryption Key (DEK) encrypts the data; the DEK is wrapped by a Key Encryption Key (KEK) from the chosen provider. This makes key rotation cheap (re-wrap the DEK, no data re-encryption) and multi-device key sharing tractable.

### 15f. Multi-Device Key Sync

- Each device has its own X25519 keypair, generated locally and stored in the device keystore
- The master DEK is wrapped once per device and stored in sync metadata
- Adding a new device: existing device approves and re-wraps the DEK with the new device's public key (QR pairing flow or in-app approval)
- Lost device: revoke its key, rotate the KEK
- Inspired by Signal's safety number flow and 1Password's secret key model

### 15g. Recovery

Recovery is the hardest UX problem in E2EE. Kora offers four strategies, all opt-in and explicit:

- `mnemonic`: BIP39 phrase shown to user at setup, never stored anywhere
- `social`: Shamir's Secret Sharing — split into N shares, K of N reconstruct the key, distribute to trusted contacts
- `kms`: org-managed via AWS KMS / GCP KMS / Azure Key Vault — admin can recover for departed employees
- `escrow`: opt-in cloud escrow with passphrase wrap — user accepts that losing both device and passphrase means losing data
- `none`: no recovery; lost device = lost data (acceptable for some apps, must be explicit)

The framework is loud about the trade-offs in docs, CLI prompts, and runtime warnings. **Lost keys = lost data is a fundamental property of E2EE; we make it impossible to ignore.**

### 15h. Architecture Changes

This phase touches several existing packages:

- `@korajs/core` — `t.encrypted()` and `.blindIndex()` field modifiers; encryption metadata in operations; encryption mode in app config
- `@korajs/store` — encrypted column storage; blind index implementation; local DB file encryption layer; opt-out for `mode: 'none'`
- `@korajs/merge` — Tier 1 LWW on ciphertext; Tier 2 advisory mode for encrypted fields; Yjs blob-merge fallback
- `@korajs/sync` — `encrypted_fields` map in wire protocol; device key exchange messages; Ed25519 operation signatures
- `@korajs/server` — never decrypts encrypted fields; refuses constraints declared on encrypted fields with a clear error message
- `@korajs/devtools` — encrypted values shown as `[encrypted: 142 bytes]` by default with explicit decrypt-in-DevTools opt-in
- `@korajs/react` — `useEncryptionStatus()` hook; `<EncryptionGate>` component for unlock UI

Algorithms (all from libsodium / `@noble/ciphers` / WebCrypto — nothing homegrown):
- AES-256-GCM (data encryption)
- ChaCha20-Poly1305 (alternative for non-AES-NI devices)
- X25519 (key exchange)
- Ed25519 (operation integrity signatures)
- Argon2id (passphrase KDF)
- HKDF (key derivation)

### 15i. Compliance Documentation

Ship encryption with first-class compliance documentation:

- HIPAA mapping (Security Rule technical safeguards: §164.312)
- GDPR mapping (Article 32, data minimization, right to erasure via tombstones)
- SOC 2 CC6.1 / CC6.7 mapping
- Threat model document
- "When to use which mode" decision tree
- Sample BAA templates for self-hosters
- Penetration test report (15j)

### 15j. External Security Audit

Non-negotiable: a real cryptography firm (Trail of Bits, NCC Group, Cure53, or equivalent) audits the encryption implementation before 1.0. The report is published. Findings are remediated before shipping. **No homegrown encryption story is trustworthy without an external audit.** Budget for it now.

### 15k. The Healthcare Pitch (the moat)

After Phase 15, the Kora pitch to a HIPAA compliance officer becomes:

> Your patients' names, SSNs, diagnoses, and notes are encrypted on the device before they ever leave. Our sync server stores opaque ciphertext. We literally cannot read your patient data — not for support, not for law enforcement, not for anything. You don't need a Business Associate Agreement with us, because we're never a business associate. We never touch PHI.

> Your clinic's metadata — patient IDs, appointment times, which doctor saw which patient — is plaintext on the server, so sync, real-time updates, and per-doctor data scoping all work natively. The sensitive content stays opaque.

> Your patients' phones work offline. A nurse in a basement room with no signal can still see, edit, and create records. When connectivity returns, everything syncs and conflicts are merged automatically.

> If a phone is stolen, the local database is encrypted at rest with a key bound to the device biometrics. The thief gets nothing.

> If your IT team needs to recover a clinician's data after they leave, your KMS holds the recovery key. We never have access.

That story is unique in this market. Supabase, Firebase, PowerSync, ElectricSQL, Replicache, Zero — all of them can read your data. After Phase 15, only Kora can credibly claim ignorance. The same story works for finance (PCI-adjacent), legal (attorney-client privilege), education (FERPA), government, journalism, mental health, dating, and family chat.

### 15l. Known Limitations (Documented Honestly)

- **Metadata leakage**: even with full E2EE, the server sees timestamps, operation sizes, device IDs, causal graph structure, sync frequency. Adequate for most threat models; insufficient for high-stakes anonymity (whistleblowing, dissidents) without additional padding/dummy traffic
- **No server-side full-text search on encrypted fields**: blind indexes cover equality only
- **No range queries on encrypted fields**: order-preserving encryption schemes are deliberately excluded for safety
- **CRDT richtext on encrypted fields**: blob-based merging only, no incremental delta sync, larger payloads
- **Lost keys = lost data**: a fundamental property of E2EE, not a bug

**Files:**
```
packages/core/src/encryption/
  field-modifiers.ts                 # t.encrypted(), .blindIndex()
  encryption-metadata.ts             # Operation-level encryption envelope
  field-modifiers.test.ts
packages/store/src/encryption/
  at-rest.ts                         # Local DB file encryption layer
  blind-index.ts
  at-rest.test.ts
packages/merge/src/encrypted/
  ciphertext-lww.ts                  # LWW on encrypted values
  encrypted-richtext.ts              # Yjs blob-merge fallback
  ciphertext-lww.test.ts
packages/sync/src/encryption/
  wire-format.ts                     # encrypted_fields in protocol
  device-key-exchange.ts
  operation-signing.ts               # Ed25519 integrity
  wire-format.test.ts
packages/sync/src/key-management/
  envelope.ts                        # DEK/KEK envelope encryption
  providers/
    device-keychain.ts
    passphrase.ts
    mnemonic.ts
    kms.ts
    social-recovery.ts
  envelope.test.ts
packages/react/src/encryption/
  use-encryption-status.ts
  encryption-gate.tsx
docs/guide/
  encryption.md                      # Mode selection guide
  hipaa-compliance.md
  gdpr-compliance.md
  threat-model.md
  key-management.md
```

**Deliverable:** After Phase 15, a developer building a healthcare, finance, or legal app can adopt Kora without an exception request. Encryption is a one-line config change for at-rest, a `.encrypted()` schema modifier for field-level E2EE, and a documented opt-out (`mode: 'none'`) for apps that genuinely don't need it. An external security audit validates the implementation before 1.0.

---

## Phase 16: Database Provider Adapters

**Status:** Planned

**Goal:** Make it trivial to use any popular Postgres provider (Supabase, Neon, Railway, Vercel Postgres, Render Postgres, Fly Postgres) or Postgres alternative (Turso/libSQL) with Kora.

**Why now:** Phase 12 introduces "PostgreSQL" as a scaffold-time choice. But "set up a Postgres database" is still a barrier for many developers. Each provider has its own setup flow, connection string format, and SSL requirements. Kora can hide all of that.

### 16a. Provider Catalog

| Provider | Type | Free Tier | Notes |
|----------|------|-----------|-------|
| Supabase | Postgres | Yes | Most popular, includes auth (ignored — Phase 14 owns auth) |
| Neon | Postgres | Yes | Serverless, branching, fast cold starts |
| Railway Postgres | Postgres | Trial | Tightly integrates with `kora deploy --platform railway` |
| Vercel Postgres | Postgres | Yes | Powered by Neon, integrates with Vercel projects |
| Fly Postgres | Postgres | Yes (small) | Tightly integrates with `kora deploy --platform fly` |
| Render Postgres | Postgres | 90 days | Managed Postgres alongside Render web services |
| Turso (libSQL) | SQLite (distributed) | Yes | Edge-replicated SQLite |

### 16b. Provider Adapters

Each provider gets a small adapter that knows:
- How to construct/parse its connection string
- SSL requirements (`sslmode=require`, custom CA, etc.)
- Optional setup helpers (e.g., create a Supabase project via CLI, link a Neon branch)
- Pricing/quota guidance shown during scaffolding

```typescript
interface DbProviderAdapter {
  id: 'supabase' | 'neon' | 'railway' | 'vercel' | 'fly' | 'render' | 'turso'
  displayName: string
  freeTier: boolean
  parseConnectionString(input: string): ConnectionConfig
  formatConnectionString(config: ConnectionConfig): string
  setup?(): Promise<{ connectionString: string }>  // Interactive setup
  documentation: string                              // URL to provider docs
}
```

### 16c. Scaffold Integration

When the developer picks PostgreSQL in Phase 12's scaffold, the next prompt is:

```
◆  Postgres provider
│  ● Supabase (free tier, hosted)
│  ○ Neon (free tier, serverless)
│  ○ Railway Postgres (free trial)
│  ○ Vercel Postgres (free tier)
│  ○ Local Postgres (Docker)
│  ○ Other (paste connection string)
```

For Supabase/Neon, Kora can prompt to authenticate and create a project automatically (via the provider's CLI/API). For others, paste the connection string. For "Local Postgres," generate a `docker-compose.yml` snippet.

### 16d. Deploy Integration

When the developer runs `kora deploy`, the deploy adapter knows which provider was chosen at scaffold time. If the deploy platform has a tightly-integrated Postgres offering (Fly + Fly Postgres, Railway + Railway Postgres), Kora can offer to provision a fresh database on the deploy platform during first deployment. Otherwise, it uses the existing connection string from `.env`.

**Files:**
```
packages/cli/src/db-providers/
  provider.ts                        # DbProviderAdapter interface
  supabase.ts
  supabase.test.ts
  neon.ts
  neon.test.ts
  railway-pg.ts
  vercel-pg.ts
  fly-pg.ts
  render-pg.ts
  turso.ts
  local-postgres.ts                  # Docker compose generator
```

**Deliverable:** After Phase 16, picking a database provider during `create-kora-app` is as simple as picking a deploy target. The connection string, SSL config, and `.env` are all set up automatically.

---

## Phase 17: Production Templates

**Status:** Planned

**Goal:** Replace toy todo lists with industry-specific templates that demonstrate where offline-first is genuinely transformative — and that developers can fork as the starting point for real products.

**Why now:** The current 4 templates all build the same todo app. They prove the framework works, but they do not prove the value. A field worker, a retail owner, or a healthcare clinic does not think "I need a CRDT framework" — they think "I need an app that works without wifi." Templates are the bridge between feature and benefit.

### 17a. Template Catalog (initial)

| Template | Domain | Why Offline Matters |
|----------|--------|---------------------|
| `inventory` | Warehouse / retail stock management | Workers move between racks where wifi is spotty |
| `field-data` | Survey / inspection forms | Crews work in remote sites with no connectivity |
| `pos` | Point of sale | Internet outages cannot stop sales |
| `chat` | Team / customer messaging | Real-time when online, queued when offline |
| `project-tracker` | Trello/Linear-style board | Edits work everywhere, sync resolves conflicts |
| `notes` | Notion-style document editor | Yjs-backed rich text, multi-device editing |
| `crm` | Lightweight customer relationship | Sales reps in the field |
| `bookings` | Appointments / reservations | Offline-tolerant, conflict-resolving |

Each template:
- Is a complete, deployable app (not a snippet)
- Includes seed data and a styled UI
- Has its own README explaining the domain and architecture choices
- Is referenced from the docs site as a learning resource
- Is independently maintained with its own CI

### 17b. Template Repository Structure

Templates live in a separate repo (`korajs/templates`) and are pulled via `giget`:

```bash
npx create-kora-app my-shop --template inventory
npx create-kora-app my-app --template gh:user/custom-template   # Community templates
```

The CLI's template selection prompt becomes a two-tier menu: **Quick Start** (the base templates from Phase 11/12) and **Production Templates** (from this phase).

### 17c. Template Quality Bar

Every production template must:
- Pass the same lint/test/build CI as the core packages
- Include at least one realistic offline scenario in its E2E tests
- Demonstrate constraint-based merge resolution (Phase 6 tier 2)
- Use sync scopes with at least one user role
- Ship with `kora deploy` pre-configured (Dockerfile, fly.toml stub)
- Include screenshots/screencast in the README

**Deliverable:** After Phase 17, a developer landing on the Kora docs sees real applications they can deploy in minutes — not just todo lists. The "what is this for?" question answers itself.

---

## Phase 18: AI-First Development

**Status:** Planned

**Goal:** Make Kora the most AI-friendly framework for building apps. Claude, GPT, Cursor, Windsurf, and Claude Code should be able to scaffold and modify Kora apps from natural language with near-zero error rate.

**Why now:** AI-assisted development is the dominant development pattern. Frameworks that are predictable, typed, and minimal in API surface win in this world. Kora already meets those criteria; this phase makes it explicit.

### 18a. `AGENTS.md` in Every Template

Every Kora template ships with an `AGENTS.md` file that gives AI tools instant context:

```markdown
# Building with Kora.js

This is a Kora.js offline-first app. Read this before making changes.

## Adding a new data collection
1. Add the collection to `src/schema.ts` using `t.string()`, `t.number()`, etc.
2. Run `kora generate types` to refresh TypeScript types
3. Use it: `app.collectionName.insert({...})`, `.where()`, `.update()`, `.delete()`

## React data patterns (DO NOT use fetch/axios for app data)
- `useQuery(app.todos.where({...}))` — reactive, no loading state needed
- `useMutation(app.todos.insert)` — fire-and-forget by default

## Conflict resolution
- Default: last-writer-wins per field
- For rich text: use `t.richtext()` (Yjs CRDT)
- For constraints: define `constraints` block in schema

## Deploying
- `kora deploy` — interactive deploy
- `kora deploy --confirm` — CI mode

## What NOT to do
- Don't write fetch calls for data managed by Kora
- Don't bypass the schema (use `t.*` types only)
- Don't import from `@korajs/internal` packages
```

### 18b. `kora scaffold` — CRUD Generation

```bash
$ kora scaffold todos

  Generated:
  ✓ src/components/TodoList.tsx        — list with useQuery
  ✓ src/components/TodoForm.tsx        — insert/update form
  ✓ src/components/TodoItem.tsx        — single item with actions
  ✓ src/pages/TodosPage.tsx            — wires it together

  Run pnpm dev to see it.
```

This is huge for AI agents: generate a schema → run `kora scaffold` → working CRUD UI. Zero distributed-systems knowledge required.

Options:
- `--style tailwind|plain` — match the template's styling
- `--component-only` — skip the page wrapper
- `--with-tests` — generate Vitest tests for the components

### 18c. Kora MCP Server

Ship `@korajs/mcp` — a [Model Context Protocol](https://modelcontextprotocol.io) server that exposes Kora's capabilities to any MCP-compatible AI tool (Claude Desktop, Claude Code, Cursor, etc.):

**Tools exposed:**
- `kora.schema.read` — read the current schema
- `kora.schema.add_collection` — add a new collection
- `kora.schema.add_field` — add a field to an existing collection
- `kora.scaffold` — generate UI components
- `kora.migrate.preview` — show what a schema change would do
- `kora.deploy.status` — check deployment status

**Resources exposed:**
- The current schema (as a structured resource)
- The current operation log (for debugging)
- The deployment state

This means an AI agent inside Cursor can: read the schema, propose a change, preview the migration, scaffold UI, and deploy — all through MCP, with no shell-out required.

### 18d. Editor Rules Files

Generate editor-specific rules files during scaffolding:
- `.cursorrules` — Cursor IDE
- `.windsurfrules` — Windsurf
- `.claude/CLAUDE.md` — Claude Code
- `AGENTS.md` — universal

Each contains the same content as 17a in the editor's preferred format.

**Files:**
```
packages/mcp/                        # NEW PACKAGE: @korajs/mcp
  src/
    server.ts
    tools/
      schema-tools.ts
      scaffold-tools.ts
      migrate-tools.ts
      deploy-tools.ts
    resources/
      schema-resource.ts
      operations-resource.ts
packages/cli/src/commands/scaffold/
  scaffold-command.ts
  scaffold-command.test.ts
  generators/
    list-generator.ts
    form-generator.ts
    item-generator.ts
    page-generator.ts
packages/cli/templates/_shared/AGENTS.md
packages/cli/templates/_shared/.cursorrules
packages/cli/templates/_shared/.windsurfrules
```

**Deliverable:** After Phase 18, building a Kora app is faster with AI than building any other kind of app, because the framework's API surface is small enough for the AI to hold in context and the schema is the single source of truth.

---

## Phase 19: Framework Bindings

**Status:** Planned

**Goal:** Vue, Svelte, Solid, and React Native developers get the same first-class Kora experience as React developers.

**Why now:** React-only excludes roughly 60% of the frontend ecosystem. Each binding is small (~200–400 lines wrapping `@korajs/store` and `@korajs/sync` with the framework's reactivity primitives), but together they 3–4× the addressable market.

### 19a. `@korajs/vue`

Vue 3 composables that mirror the React hooks API:

```typescript
import { useKoraQuery, useKoraMutation, useSyncStatus } from '@korajs/vue'

const todos = useKoraQuery(() => app.todos.where({ completed: false }))
// todos is a Ref<Todo[]>, reactive, no loading state for local data

const { mutate: addTodo } = useKoraMutation(app.todos.insert)
const status = useSyncStatus()
```

Implementation: wraps `app.todos.where(...).subscribe()` in a `shallowRef` updated via Vue's reactivity system.

### 19b. `@korajs/svelte`

Svelte 5 runes API:

```svelte
<script>
  import { koraQuery, koraMutation, syncStatus } from '@korajs/svelte'

  const todos = koraQuery(() => app.todos.where({ completed: false }))
  const addTodo = koraMutation(app.todos.insert)
  const status = syncStatus()
</script>

{#each todos.value as todo}
  <li>{todo.title}</li>
{/each}
```

Implementation: uses `$state` and `$effect` to bridge subscription updates into Svelte's reactivity.

### 19c. `@korajs/solid`

Solid signals integration:

```typescript
import { useKoraQuery, useKoraMutation } from '@korajs/solid'

const todos = useKoraQuery(() => app.todos.where({ completed: false }))
// todos is an Accessor<Todo[]>

return <For each={todos()}>{(todo) => <li>{todo.title}</li>}</For>
```

### 19d. `@korajs/react-native` and `@korajs/expo`

The hardest binding because the storage adapter has to change:

- React Native uses **`expo-sqlite`** (Expo) or **`op-sqlite`** (bare React Native) instead of SQLite WASM
- No web workers — adapters run on the main thread (JS bridge)
- File system paths use platform-specific APIs
- Background sync uses platform-native task scheduling (Expo BackgroundTask, iOS BGTaskScheduler, Android WorkManager)
- The React hooks themselves work unchanged (they are React, not React DOM)

This phase lights up Kora for the entire mobile market — and mobile is where offline-first matters most.

**Files:**
```
packages/vue/                        # NEW PACKAGE
packages/svelte/                     # NEW PACKAGE
packages/solid/                      # NEW PACKAGE
packages/react-native/               # NEW PACKAGE
packages/expo/                       # NEW PACKAGE
  src/adapters/
    expo-sqlite-adapter.ts
    op-sqlite-adapter.ts
  src/background/
    expo-background-sync.ts
    ios-bg-task-scheduler.ts
    android-work-manager.ts
```

**Deliverable:** After Phase 19, Kora is a viable choice for any frontend stack. Vue, Svelte, and Solid devs get hooks/composables they expect; React Native and Expo devs get true native offline-first.

---

## Phase 20: Documentation Expansion

**Status:** Planned (the docs site itself already exists — VitePress at `docs/`, deployed to GitHub Pages via `.github/workflows/docs.yml`, base path `/kora/`)

**Goal:** Grow the existing VitePress docs site into a learning destination on par with the Vercel and Astro docs.

**Why now:** Phase 10 shipped a solid documentation foundation: landing page, Getting Started, guides for Schema Design / Storage Configuration / Offline Patterns / Conflict Resolution / Sync Configuration / React Hooks / DevTools / Deployment, API references, and 2 examples (Todo App, Collaborative Notes). As Phases 12–18 ship new features, the docs need to grow alongside them — and the format needs to expand beyond reference documentation into tutorials, recipes, and real-world case studies.

### 20a. Cookbook (Real-World Recipes)

A new `cookbook/` section with copy-pasteable solutions to common problems:

- "How do I add a 'last seen' timestamp that updates without conflicts?"
- "How do I implement soft delete with restore?"
- "How do I show a conflict resolution UI when the merge engine asks for human input?"
- "How do I sync only the data the user is viewing right now?"
- "How do I handle file attachments with offline-first?"
- "How do I implement undo/redo across the entire app?"
- "How do I add full-text search?"
- "How do I migrate from Firebase/Supabase/Pocketbase to Kora?"

Each recipe is short, focused, and includes a runnable example.

### 20b. Video Tutorials

- "Build a complete offline-first todo app in 15 minutes" (the 15-minute promise, recorded)
- "Deploy Kora to Fly.io" (companion to Phase 13)
- "Adding auth to your Kora app" (companion to Phase 14)
- "Conflict resolution explained: tier 1, 2, 3 with visual examples"
- "DevTools tour: debugging sync issues"

Hosted on YouTube, embedded in the docs.

### 20c. Interactive Playground

A web-based playground where developers can experiment with schemas, queries, and sync without installing anything:

- Embedded Monaco editor
- Live preview pane (running Kora in the browser via SQLite WASM)
- Multi-tab sync simulation (open the same playground in two tabs, see them converge)
- Shareable URLs for snippets
- Linked from the docs landing page

This doubles as a marketing tool: "Try Kora without leaving your browser."

### 20d. Production-Ready Matrix

A table at `/docs/production-readiness` that lists every feature with its current status:

| Feature | Status | Notes |
|---------|--------|-------|
| SQLite WASM storage | Production | Tested, benchmarked |
| IndexedDB fallback | Production | |
| PostgreSQL server store | Production | |
| Sync scopes | Production | |
| Yjs richtext | Production | |
| `kora deploy` | Beta | Phase 13 |
| Built-in auth | Planned | Phase 14 |
| Vue bindings | Planned | Phase 19 |
| React Native | Planned | Phase 19 |
| Kora Cloud | Planned | Phase 21 |

Trust = adoption multiplier. This page is critical.

### 20e. Migration Guides

Migration guides double as marketing. Ship them before Phase 22 lands:
- "Migrating from PouchDB to Kora"
- "Migrating from RxDB to Kora"
- "Migrating from Firebase Realtime DB to Kora"
- "Migrating from Supabase Realtime to Kora"
- "Adding Kora to an existing React/Vue/Svelte app"

### 20f. Case Studies

Once early adopters start shipping, write 5–10 case studies:
- Domain (field services, healthcare, retail, etc.)
- Why offline-first mattered
- What the team built
- Quotes and metrics

**Deliverable:** After Phase 20, the Kora docs site is the definitive learning resource for offline-first development on the web — not just a reference manual.

---

## Phase 21: Kora Cloud — Managed Sync

**Status:** Planned (long-term)

**Goal:** A managed hosting platform for Kora apps. Push-button deployment, managed databases, observability, and scale-to-zero pricing — the way Vercel is for Next.js.

**Why now:** Self-hosting is the #1 adoption blocker for indie developers, startups, and non-technical builders. Phase 13 (`kora deploy`) lowers the bar dramatically, but a hosted offering removes it entirely. This is also Kora's monetization path — the open-source framework stays free forever; the hosting service funds ongoing development.

### 21a. Platform Capabilities

- **Managed sync server** — Auto-scaled, multi-region, zero infrastructure to manage
- **Managed Postgres** — Auto-provisioned per project, branching for previews, automated backups
- **WebSocket relay** — Handles tens of thousands of concurrent sync connections
- **CDN-served clients** — Static client bundles served from the edge
- **Observability dashboard** — Sync health, connected devices, operation throughput, conflict rate, latency percentiles
- **Preview deployments** — Every PR gets its own URL with its own database (cleaned up on PR close)
- **Rollbacks** — One click reverts to any previous deployment
- **Custom domains + automatic SSL**
- **Audit logs** (team plans)
- **OpenTelemetry export** (enterprise plans)

### 21b. Developer Experience

```bash
$ kora login
  ✓ Logged in as user@example.com

$ kora deploy
  # First time: creates project on Kora Cloud, provisions database
  # Subsequent: rebuilds and redeploys
  → https://my-app.kora.app

$ kora deploy --prod
  → https://my-app.com (custom domain)
```

**Git integration:** Connect a GitHub repo → every push to main auto-deploys to production, every PR auto-deploys to a preview URL with a PR comment.

### 21c. Pricing Model (conceptual)

| Tier | Price | Limits |
|------|-------|--------|
| **Hobby** | Free | 1 project, 100 active devices, 1 GB sync storage, 5K ops/day, community support |
| **Pro** | $20/mo | Unlimited projects, 10K devices, 50 GB, 500K ops/day, custom domains, email support |
| **Team** | $99/mo | Multiple seats, audit logs, SSO, SLA, priority support |
| **Enterprise** | Custom | On-prem option, dedicated instance, security review, dedicated CSM |

### 21d. Why the Economics Work

Offline-first apps have a unique property: the server is lightweight. Most computation happens on-device. The server is just a relay and persistence layer. Compared to a traditional backend (which runs business logic on every request), Kora Cloud's per-user infrastructure cost is 5–10× lower. That makes generous free tiers viable — and free tiers are the engine of developer adoption.

### 21e. Build Order

Kora Cloud is the largest single project on this roadmap. Sub-phases:

1. **20.1 — Control plane MVP** — User accounts, projects, single-region deployment
2. **20.2 — Hosted Postgres** — Branching, backups, restore
3. **20.3 — Multi-region** — Sync server replicas, geo-DNS
4. **20.4 — Observability dashboard**
5. **20.5 — Preview deployments + Git integration**
6. **20.6 — Billing + tier enforcement**
7. **20.7 — Public beta**
8. **20.8 — GA**

**Deliverable:** After Phase 21, deploying a Kora app is as simple as `git push`. The 15-minute promise becomes a 5-minute promise. Developers who do not want to think about infrastructure never have to.

---

## Phase 22: Migrate from Existing Projects

**Status:** Planned (far future — depends on Phases 12–20)

**Goal:** A `kora import` workflow that takes an existing app (any framework, any backend) and produces a Kora-powered version, preserving the data, the UI, and as much of the business logic as possible.

**Why eventually:** The biggest growth lever for any framework is incremental adoption. Most developers will not rewrite a working app to try a new framework — but they will try Kora alongside their existing app, then migrate piece by piece. Today there is no path. Phase 22 builds that path.

This phase is intentionally placed late because it depends on every preceding phase being mature. There is no point in importing into an immature framework.

### 22a. `kora import` — Project Detection and Analysis

```bash
$ cd my-existing-project
$ kora import

┌  Kora Import
│
◇  Analyzing project...
│  ✓ Framework: React + Vite
│  ✓ State management: Zustand (3 stores detected)
│  ✓ Data layer: REST API (12 endpoints) + React Query
│  ✓ Auth: Supabase Auth
│  ✓ Database: Supabase Postgres (schema introspected)
│
◆  Migration approach
│  ● Side-by-side (recommended) — Add Kora alongside, migrate gradually
│  ○ Full rewrite — Generate a fresh Kora project from this one
│
◆  Generate Kora schema from
│  ● Supabase schema (introspected, 7 tables)
│  ○ TypeScript types in src/types/
│  ○ JSON sample data
│
◇  Generating...
│  ✓ kora.config.ts
│  ✓ src/schema.ts (7 collections, 42 fields)
│  ✓ src/kora-app.ts (createApp wired up)
│  ✓ src/kora-shims/ (compatibility shims for existing code)
│  ✓ MIGRATION.md (step-by-step migration guide)
│
└  Next steps:
   1. Read MIGRATION.md
   2. Run pnpm dev to verify both Kora and your existing app work
   3. Migrate one route or component at a time
```

### 22b. Framework Adapters

Each frontend framework gets a detector + analyzer:
- **React** (Vite, CRA, Remix, Next.js)
- **Vue** (Vite, Nuxt)
- **Svelte** (Vite, SvelteKit)
- **Angular**

The detector identifies:
- The build tool and config
- The state management library (Redux, Zustand, Jotai, MobX, Pinia, Vuex, Svelte stores, NgRx)
- The data fetching library (React Query, SWR, Apollo, urql, RTK Query)
- The auth provider (Auth0, Clerk, Supabase, Firebase, NextAuth)
- The UI library (MUI, Chakra, Tailwind, shadcn)

### 22c. Schema Inference

Kora generates a schema from whichever source is available:
- **Database introspection** — Connect to Postgres/MySQL/SQLite/Supabase, read the schema, map columns to `t.string()`/`t.number()`/etc.
- **TypeScript types** — Parse `.ts` files, extract `interface`/`type` declarations, map to schema
- **GraphQL schema** — Parse `.graphql` files
- **Prisma schema** — Parse `schema.prisma`
- **Drizzle schema** — Parse Drizzle table definitions
- **OpenAPI spec** — Parse `openapi.yaml` for REST APIs
- **JSON sample** — Infer types from a JSON document

Inference is lossy — the developer reviews and confirms the generated schema before it is written.

### 22d. Compatibility Shims

For side-by-side migration, generate shims that make Kora collections look like the existing data layer:

```typescript
// Generated: src/kora-shims/use-todos.ts
// This shim lets existing useTodos() calls return Kora data instead of REST data
import { useQuery as useKoraQuery } from '@korajs/react'
import { app } from '../kora-app'

export function useTodos() {
  const todos = useKoraQuery(() => app.todos.where({}).orderBy('createdAt', 'desc'))
  return { data: todos, isLoading: false, error: null }  // Matches React Query shape
}
```

The shim layer means existing components do not need to change — they just import from `kora-shims` instead of `api`. The developer can refactor each component to use Kora directly when ready.

### 22e. Backend Importers

For backend migration:
- **Firebase Realtime DB / Firestore** — Export collections, transform to Kora operations, import
- **Supabase Postgres** — Direct table-to-collection migration with FK preservation
- **Pocketbase** — Schema + data migration
- **REST API** — Walk all endpoints, infer types, snapshot data
- **CSV / JSON** — Batch import with schema inference

Each importer respects pagination, rate limits, and provides resume-on-failure.

### 22f. AI-Assisted Migration

The hardest part of migration is the long tail of edge cases — custom validation, complex business logic, weird state shapes. Phase 22 ships with an AI-assisted mode (powered by the Phase 18 MCP server) that can:
- Analyze a single component and propose a Kora-based rewrite
- Translate Redux reducers into Kora schema constraints
- Migrate Zustand stores into Kora collection wrappers
- Convert React Query hooks into Kora query subscriptions

This is optional and requires developer review before any code is written.

**Files:**
```
packages/import/                     # NEW PACKAGE: @korajs/import
  src/
    cli.ts                           # kora import command
    detectors/
      react-detector.ts
      vue-detector.ts
      svelte-detector.ts
      angular-detector.ts
      state-mgmt-detector.ts
      data-layer-detector.ts
      auth-detector.ts
    inference/
      postgres-introspect.ts
      typescript-types-parser.ts
      graphql-schema-parser.ts
      prisma-schema-parser.ts
      drizzle-schema-parser.ts
      openapi-parser.ts
      json-sample-inference.ts
    shims/
      react-query-shim-generator.ts
      zustand-shim-generator.ts
      pinia-shim-generator.ts
      svelte-store-shim-generator.ts
    backend-importers/
      firebase-importer.ts
      firestore-importer.ts
      supabase-importer.ts
      pocketbase-importer.ts
      rest-api-importer.ts
      csv-importer.ts
    migration-guide-generator.ts
```

**Deliverable:** After Phase 22, an existing React/Vue/Svelte project can adopt Kora incrementally. No rewrites required. The developer migrates one component, one route, one feature at a time, on their own schedule. Adoption stops being a binary decision.

---

## Phase 23: Kora Studio (Long Term)

**Status:** Planned (long-term, post-Phase 21)

**Goal:** A web-based, low-code interface that lets non-developers build offline-first applications without writing schema code, queries, or React.

**Why eventually:** Phase 12 made the CLI great for developers. Phase 17 made templates great for technical founders. Phase 18 made AI tools great for vibe coders. But there is a fourth audience: non-developers who need an offline-first app for their specific job and have no programming background — small business owners, field researchers, educators, healthcare workers in remote regions.

For them, even `npx create-kora-app` is too much. They need a browser tab.

### 23a. Visual Schema Builder

- Drag-and-drop fields onto a canvas
- Field types as palette items (text, number, date, picture, location, etc.)
- Relationships drawn as arrows between collections
- Validation rules as visual constraints
- Real-time preview of the resulting schema as Kora code (for the curious)

### 23b. Visual UI Builder

- Pre-built layouts: list, grid, kanban, calendar, map, form
- Each layout binds to a collection with one click
- Theming via a curated palette (no CSS knowledge required)
- "Add a button" → choose from pre-built actions (insert, update, delete, navigate)

### 23c. One-Click Deploy

- "Publish" button → app is live on a Kora Cloud subdomain
- Custom domain via Pro tier
- Sharing via URL or QR code (great for field teams)

### 23d. Template Gallery

- Industry templates from Phase 17, installable with one click
- Community-contributed templates

### 23e. Code Export

- "Eject to code" button generates a full Kora project (the developer can take over from there)
- This is the bridge between no-code and pro-code

**Deliverable:** After Phase 23, building an offline-first app no longer requires being a developer. Kora becomes accessible to the millions of non-technical builders who need offline-first the most but have been excluded from it entirely.

---

## Phase 24: Enterprise & Teams

**Status:** Planned (long-term)

**Goal:** Make Kora viable for regulated industries, large teams, and on-prem deployments.

**Why eventually:** Once Kora has traction with indie devs and SMBs, the next growth tier is enterprise. Enterprise has different requirements: compliance, multi-tenancy, audit, SSO, SLA. None of these are blockers for individual developers, but all of them are blockers for procurement.

### 24a. Multi-Tenancy

- Row-level isolation per tenant
- Per-tenant scope evaluation
- Per-tenant rate limiting and quotas
- Dashboard for tenant management

### 24b. Audit Logging

- Every operation, every merge decision, every sync event recorded with actor + timestamp + diff
- Export to SIEM systems (Splunk, Datadog, Sumo Logic)
- Immutable audit log with cryptographic tamper detection

### 24c. Compliance

- SOC 2 Type II certification for Kora Cloud
- GDPR data residency (EU regions)
- HIPAA-eligible deployments (BAA available)
- Data export / deletion endpoints (right to be forgotten)

### 24d. SSO and Team Management

- SAML 2.0
- SCIM provisioning
- Role-based access control (admin, developer, viewer, billing)
- Team invitation flow

### 24e. On-Prem and Air-Gapped

- Helm chart for Kubernetes
- Terraform modules for AWS/GCP/Azure
- Air-gapped installer (no internet required for deployment)
- Customer-supplied certificates and KMS

### 24f. SLA Tiers

- Standard: 99.9% uptime
- Pro: 99.95% uptime + 24/7 incident response
- Enterprise: 99.99% uptime + dedicated CSM

**Deliverable:** After Phase 24, Kora is procurement-ready. Banks, hospitals, and Fortune 500s can adopt it without exception requests.

---

## Adoption Bottlenecks (Ranked)

| Rank | Bottleneck | Impact | Fix | Phase |
|------|-----------|--------|-----|-------|
| 1 | No deployment story | Blocks production use entirely | `kora deploy` | 13 |
| 2 | No auth integration | Every real app needs it | Built-in auth + sync scopes | 14 |
| 3 | CLI lacks polish | First impression matters | `@clack/prompts`, arrow keys | 12 |
| 4 | No scaffold-time database choice | Decision happens after install | Scaffold-time DB selection | 12 |
| 5 | No encryption / privacy story | Excludes healthcare, finance, legal, education entirely | At-rest + field-level + full E2EE, opt-out for non-sensitive apps, external audit | 15 |
| 6 | No managed hosting | Self-hosting scares indie devs | Kora Cloud | 21 |
| 7 | React-only | Excludes ~60% of frontend devs | Vue, Svelte, Solid bindings | 19 |
| 8 | No mobile bindings | Misses huge offline-first market | React Native + Expo | 19 |
| 9 | Toy templates only | Does not prove real-world value | Industry templates | 17 |
| 10 | Docs need depth (cookbook, video, playground) | Existing VitePress site lacks recipes and tutorials | Docs expansion | 20 |
| 11 | No scaffold/codegen | Slower for AI tools and humans | `kora scaffold` + MCP server | 18 |
| 12 | No database provider integration | Postgres setup is friction | Provider adapters (Supabase, Neon, etc.) | 16 |
| 13 | No incremental adoption path | Cannot try Kora in an existing app | `kora import` | 22 |

Note: the docs site already exists (VitePress on GitHub Pages). The bottleneck is depth and format, not existence. The encryption story is the highest-leverage unlock after deploy and auth — it doesn't just remove friction, it opens entire regulated verticals (healthcare, finance, legal, education) that are otherwise off-limits to Kora.

---

## The 15-Minute Promise

```
0:00   npx create-kora-app my-app
       → Arrow-key through: React → Tailwind → Sync → Postgres (Supabase) → pnpm
       → Dependencies install

2:00   cd my-app && pnpm dev
       → App running locally with offline-first storage
       → Modify schema.ts for your data model

5:00   Build UI with useQuery / useMutation
       → Everything works offline automatically
       → Open two browser tabs, see real-time sync

10:00  kora deploy
       → Pick Fly.io, auto-provision Postgres
       → Build + deploy

13:00  App is live at https://my-app.fly.dev
       → Open on phone + laptop
       → Turn off wifi, make changes
       → Turn wifi back on, changes sync

15:00  Share the URL. Production offline-first app.
```

Zero distributed-systems knowledge. Zero sync code. Zero conflict-resolution code. Zero infrastructure management.

---

## Quarter-by-Quarter Execution Plan

| Quarter | Phases | Milestone |
|---------|--------|-----------|
| **Q2 2026** | 12, 13 (parts) | CLI overhaul ships. `kora deploy` private beta with Fly + Railway adapters. |
| **Q3 2026** | 13 (full), 14, 15 (parts), 16 | `kora deploy` GA. Built-in auth ships. At-rest encryption ships as default. Database provider adapters. |
| **Q4 2026** | 15 (rest), 17, 18, 20 (parts) | Field-level + full E2EE ship. Key management + recovery. External security audit kicks off. Production templates. AI-first features (`kora scaffold`, MCP server). Cookbook launches. |
| **Q1 2027** | 19, 20 (rest) | Encryption audit report published. Vue + Svelte bindings GA. React Native private beta. Interactive playground. Video tutorials. |
| **Q2 2027** | 21 (parts) | Kora Cloud private beta opens (E2EE-first pitch: "we never see your data"). |
| **Q3 2027** | 21 (more), 19 (RN GA) | Kora Cloud public beta. React Native ships. |
| **Q4 2027** | 21 (GA), 24 (start) | Kora Cloud GA. Enterprise foundations begin. |
| **2028+** | 22, 23, 24 (rest) | `kora import`. Kora Studio. Enterprise GA. |

---

## Success Metrics

| Metric | Target | Measured Where |
|--------|--------|----------------|
| Time-to-first-production (TTFP) | < 15 minutes | User testing, opt-in telemetry |
| Time-to-second-deploy | < 60 seconds | CLI telemetry |
| `npx create-kora-app` to running dev server | < 90 seconds | CLI telemetry |
| `kora deploy` first run to live URL | < 5 minutes | CLI telemetry |
| Apps still running 30 days after deploy | > 70% | Kora Cloud analytics |
| Weekly active sync projects | Trending up monthly | Kora Cloud + GitHub stars proxy |
| Issues opened per deploy | < 0.1 | GitHub issues / deploy count |
| First-time deployer NPS | > 50 | Post-deploy survey |
| Docs cookbook recipes | > 50 | Repo count |
| Production templates | > 8 | Template repo count |

---

## What Makes This State of the Art (Not a Bandage)

1. **Owning the lifecycle, not just the runtime.** Every competitor stops at the library level. Kora becomes a platform.
2. **Deployment as a first-class command, not a docs page.** `kora deploy` is the difference between a library and a product.
3. **Auth designed for offline.** Not bolted-on JWT validation, but local validation that survives disconnection.
4. **Privacy as a feature, not a checkbox.** Field-level and full E2EE that lets developers serve healthcare, finance, and legal verticals without their hosting provider becoming a Business Associate. The only sync framework that can credibly claim "we never see your data" — and the only one that lets developers opt out of encryption when they don't need it.
5. **AI as a first-class user.** When AI tools can scaffold Kora apps from natural language with zero errors, adoption scales beyond the developer population.
6. **Templates that solve real problems.** Field data, POS, inventory — domains where offline-first is required, not optional. These industries are underserved by modern frameworks.
7. **The Vercel playbook applied to offline-first.** Free open-source framework → managed cloud with generous free tier → enterprise. The infrastructure economics work because offline-first servers are lightweight, and the encryption story makes the cloud pitch unbeatable.
8. **A migration path, not a rewrite ultimatum.** `kora import` lets developers adopt Kora gradually in existing apps. Adoption stops being a binary choice.
9. **A no-code on-ramp for non-developers.** Kora Studio brings offline-first to people who need it most but cannot code.

---

## Roadmap at a Glance

| Phase | Scope | Status |
|-------|-------|--------|
| **1** | Browser storage (SQLite WASM + IndexedDB) | Complete |
| **2** | `createApp` factory + meta-package | Complete |
| **3** | Server persistence (Drizzle ORM) | Complete |
| **4** | `kora dev` command | Complete |
| **5** | Yjs richtext merge | Complete |
| **6** | Sync scopes | Complete |
| **7** | `kora migrate` command | Complete |
| **8** | DevTools browser extension | Complete |
| **Cross-cutting** | Type inference, relational queries, Drizzle migration | Complete |
| **9** | Protobuf, HTTP transport, benchmarks, chaos | Complete |
| **10** | E2E tests, docs, publish pipeline | Complete |
| **11** | Developer experience & launch polish | Complete |
| **12** | CLI & onboarding overhaul (`@clack/prompts`, scaffold-time DB) | Planned |
| **13** | `kora deploy` (Fly, Railway, Render, Docker) | Planned |
| **14** | Built-in auth (offline-first JWT, sync scope integration) | Planned |
| **15** | Encryption & privacy (none / at-rest / field-level / full E2EE, key management, external audit) | Planned |
| **16** | Database provider adapters (Supabase, Neon, Turso, etc.) | Planned |
| **17** | Production templates (inventory, POS, field-data, chat, etc.) | Planned |
| **18** | AI-first development (AGENTS.md, `kora scaffold`, MCP server) | Planned |
| **19** | Framework bindings (Vue, Svelte, Solid, React Native/Expo) | Planned |
| **20** | Documentation expansion (cookbook, video, playground) | Planned |
| **21** | Kora Cloud (managed sync hosting) | Planned |
| **22** | Migration from existing projects (`kora import`) | Planned (far future) |
| **23** | Kora Studio (low-code visual builder) | Planned (long term) |
| **24** | Enterprise & teams (multi-tenancy, audit, compliance) | Planned (long term) |

---

*Kora: independent strings, shared harmony.*
