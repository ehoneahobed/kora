# Kora.js — Implementation Roadmap

> Last updated: 2026-04-05

## Where We Are

Core platform packages and meta-package are implemented, with **1033 tests passing** across the monorepo.

| Package | Tests | Status |
|---------|-------|--------|
| @kora/core | 209 | Complete — HLC, operations, schema, version vectors, events |
| @kora/store | 198 | Browser + Node adapter stack complete, including IndexedDB restore durability fallback |
| @kora/merge | 93 | Three-tier merge working. Yjs richtext integration deferred |
| @kora/sync | 170 | Engine, transports, protocol complete. JSON wire format |
| @kora/server | 112 | Memory + SQLite + PostgreSQL stores; server-side scope filtering enforced |
| @kora/react | 56 | Hooks + query-store integration complete |
| @kora/devtools | 46 | Instrumentation and event capture complete. No browser UI extension yet |
| @kora/cli | 103 | `kora dev` implemented with config, managed sync, schema watch; `migrate` still stubbed |
| kora (meta-package) | 46 | `createApp` + typed `kora/config` entrypoint shipped |

**What works end-to-end today:** A developer can scaffold an app and run `pnpm dev` via `kora dev`, with Vite + optional sync server + schema watcher in one command. Sync server persistence is available for memory, SQLite, and PostgreSQL backends, and server-side scope filtering is active.

**What does not work today:** Remaining major gaps are richtext CRDT merging (Yjs), migration workflow (`kora migrate`), DevTools browser extension UI, protocol hardening (protobuf + HTTP fallback), and benchmark/e2e/publish pipeline completion.

## Current Phase Status

| Phase | Status | Notes |
|-------|--------|-------|
| 1 | Complete | Browser adapter durability flow is implemented, including binary snapshot restore + logical dump fallback |
| 2 | Complete | `createApp` + meta-package shipped with pre-`ready` query semantics aligned and tested |
| 3 | Complete | Persistent server stores implemented (SQLite + PostgreSQL), production-ready baseline |
| 4 | Complete | `kora dev` orchestration + `kora.config.ts` support shipped |
| 5 | Not started | Richtext still intentionally deferred |
| 6 | In progress | Server-side scope filtering implemented; SQL pushdown/compilation remains future optimization |
| 7 | Not started | `kora migrate` still stubbed |
| 8 | Not started | Backend instrumentation exists; browser extension UI not built |
| 9 | Not started | JSON protocol remains default; benchmarks not CI-gated |
| 10 | Not started | E2E/docs/publish automation still pending |

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

**Deliverable:** After Phase 1, `@kora/store` works in every JavaScript environment — Node.js (BetterSqlite3), modern browsers (SQLite WASM + OPFS), older browsers (IndexedDB), and test/SSR (in-memory).

---

## Phase 2: The `createApp` Factory and Meta-Package

**Status:** Complete

**Goal:** `import { createApp, defineSchema, t } from 'kora'` works and wires everything together.

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
export { defineSchema, t } from '@kora/core'
export type { SchemaDefinition, FieldDescriptor } from '@kora/core'
```

**Deliverable:** After Phase 2, a developer writes `const app = createApp({ schema })` and gets a fully typed, reactive, offline-capable data layer with zero configuration.

---

## Phase 3: Server Persistence

**Status:** Complete

**Goal:** The sync server persists operations to a real database. Server restarts do not lose data.

**Why third:** With the client fully functional, the server becomes the bottleneck. An in-memory server is fine for development but unusable for any real deployment.

### 3a. Drizzle ORM Server Store

**Architecture:**
- `DrizzleServerStore` implements the same `ServerStore` interface as `MemoryServerStore`
- Drizzle ORM handles the SQL abstraction — supports PostgreSQL, MySQL, and SQLite
- Schema: two tables — `operations` (the operation log) and `sync_state` (version vectors per node)
- Content-addressed deduplication: `INSERT ... ON CONFLICT (id) DO NOTHING`
- Causal ordering maintained by storing `causalDeps` as JSON array and using topological sort on query

**Tables:**
```sql
CREATE TABLE operations (
  id TEXT PRIMARY KEY,                    -- Content-addressed hash
  node_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('insert', 'update', 'delete')),
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
- Batch inserts for efficiency during initial sync (INSERT ... VALUES (...), (...), ...)
- Version vector reconstruction from `sync_state` table on server start
- Operation range queries for delta computation: `WHERE node_id = ? AND sequence_number BETWEEN ? AND ?`
- Connection pooling via Drizzle's built-in pool management

**Database support:**
- PostgreSQL (recommended for production — best JSON support, robust replication)
- SQLite (development and single-server deployments)
- MySQL (supported but not prioritized)

**Files:**
```
packages/server/src/store/
  drizzle-server-store.ts
  drizzle-server-store.test.ts
  schema.ts                        # Drizzle table definitions
  migrations/                      # SQL migration files
```

### 3b. Server Configuration

```typescript
import { createKoraServer } from '@kora/server'
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
import { defineConfig } from 'kora/config'

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

**Status:** Not started

**Goal:** `t.richtext()` fields merge at the character level using Yjs CRDTs, not LWW.

**Why fifth:** Rich text is a headline feature of offline-first apps (collaborative documents, notes, comments). The merge engine currently throws on richtext fields. This phase makes them work.

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

**Status:** In progress

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
- Scope predicates compile to SQL WHERE clauses on the server store
- The server maintains a scope cache per client session
- When a new operation arrives, the server evaluates it against all connected clients' scopes and pushes to matching clients only
- Scope changes (e.g., user role changes) require a re-handshake

**Files:**
```
packages/sync/src/scopes/
  scope-evaluator.ts
  scope-evaluator.test.ts
  scope-compiler.ts                # Converts scope predicates to SQL
  scope-compiler.test.ts

packages/server/src/scopes/
  server-scope-filter.ts
  server-scope-filter.test.ts
```

**Deliverable:** After Phase 6, multi-tenant applications can use Kora with proper data isolation. Each user only sees and syncs their own data.

---

## Phase 7: CLI `kora migrate` Command

**Status:** Not started

**Goal:** Schema changes are detected, migration plans generated, and applied — locally and to the server.

**Why seventh:** As applications evolve, schemas change. Without a migration system, developers must manually alter databases or wipe data. This phase automates that.

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

**Status:** Not started

**Goal:** A Chrome/Firefox DevTools panel that visualizes sync, merges, operations, and connection state in real time.

**Why eighth:** The instrumentation backend exists (Phase 0 — already built). This phase builds the visual layer. It's last because the framework is fully functional without it, but the developer experience is significantly better with it.

### 8a. DevTools UI (Preact + HTM)

**Panels (as specified in CLAUDE.md):**

1. **Sync Timeline** — Horizontal timeline of operations and sync events. Color-coded by type (insert=green, update=blue, delete=red, sync=purple). Causal dependency arrows between operations. Click to inspect full payload. Zoom and pan.

2. **Conflict Inspector** — Table of merge events. Columns: timestamp, collection, field, strategy, tier, input values, output value. Expandable rows show full `MergeTrace`. Filter by collection, tier, strategy. Highlight constraint violations in amber.

3. **Operation Log** — Searchable list of all operations. Full-text search across collection, recordId, field names, values. Click any operation to see: full payload, causal deps graph, resulting record state. Time-travel: select an operation to see the database state at that point.

4. **Network Status** — Real-time connection quality indicator. Pending operation count with progress bar. Bandwidth graph (operations/second in and out). Last sync timestamp. Version vector visualization.

**Architecture:**
- Preact + HTM for zero-build UI (no bundler needed in the extension)
- `MessageBridge` (already built in @kora/devtools) connects page context to extension panel
- Extension manifest v3 (Chrome) with content script injection
- Event stream from `Instrumenter` → `MessageBridge` → DevTools panel
- Panel state management: local Preact state, no external state library

**Files:**
```
packages/devtools/src/
  ui/
    panel.tsx                      # Main DevTools panel
    timeline/                      # Sync timeline components
    conflicts/                     # Conflict inspector components
    operations/                    # Operation log components
    network/                       # Network status components
    shared/                        # Common UI components
  extension/
    manifest.json                  # Chrome extension manifest v3
    content-script.ts              # Injects bridge into page
    devtools-page.html             # DevTools panel host
    background.ts                  # Service worker
```

**Deliverable:** After Phase 8, developers open Chrome DevTools, click the "Kora" tab, and see exactly what's happening with their data — every operation, every merge decision, every sync event — in real time.

---

## Phase 9: Protocol and Performance Hardening

**Status:** Not started

**Goal:** Production-grade wire format and validated performance targets.

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
@kora/store:
  Insert 10,000 records: < 2 seconds
  Query 1,000 records with WHERE: < 50ms
  Reactive query notification: < 16ms

@kora/merge:
  Merge 1,000 concurrent operations: < 500ms
  LWW comparison: < 1 microsecond

@kora/sync:
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

**Status:** Not started

**Goal:** The full `npx create-kora-app` to production deployment path works flawlessly.

### 10a. End-to-End Test Suite

- Spawn a real Vite dev server + Kora sync server
- Open multiple browser tabs (Playwright)
- Perform CRUD in tab A, verify it appears in tab B
- Kill network (offline mode), perform mutations, restore network, verify convergence
- Run schema migration, verify both tabs see new fields
- Measure time from `npx create-kora-app` to working app (target: under 2 minutes for scaffolding + install)

### 10b. Documentation Site

- API reference generated from JSDoc + TypeScript types
- Getting Started guide (5-minute tutorial)
- Guides: offline patterns, conflict resolution, sync configuration, deployment
- Examples: todo app, collaborative notes, inventory management

### 10c. Publish Pipeline

- Changesets configuration for all 8 packages + meta-package
- npm publish automation in CI
- Canary releases from main branch
- Stable releases from tags

---

## Phase Summary

| Phase | Scope | Status |
|-------|-------|--------|
| **1** | Browser storage (SQLite WASM + IndexedDB) | Complete |
| **2** | `createApp` factory + meta-package | Complete |
| **3** | Server persistence | Complete |
| **4** | `kora dev` command | Complete |
| **5** | Yjs richtext merge | Not started |
| **6** | Sync scopes | In progress |
| **7** | `kora migrate` command | Not started |
| **8** | DevTools browser extension | Not started |
| **9** | Protobuf, HTTP transport, benchmarks | Not started |
| **10** | E2E tests, docs, publish | Not started |

**Updated critical path:** complete Phase 7 migration workflow, then Phase 5 richtext and Phase 8+ launch hardening.
