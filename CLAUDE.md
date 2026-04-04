# CLAUDE.md - Kora.js Development Guide

You are building **Kora.js**, an offline-first application framework. This file is your primary reference for every decision you make. Read it completely before writing any code. Return to it when you face ambiguity.

---

## MISSION

Kora.js makes building offline-first applications as simple as building Next.js applications. A developer should go from `npx create-kora-app` to a working offline-first app in under 10 minutes, writing zero lines of sync, conflict resolution, or distributed systems code.

Kora is not a database, not a sync engine, not a backend service. It is an **opinionated application framework** that sits alongside the developer's UI layer (React, Vue, Svelte, Flutter) and owns the entire data plane: local persistence, reactive queries, conflict resolution, synchronization, and connectivity adaptation.

The name comes from the West African kora instrument: 21 strings that resonate independently but produce harmony together. Independent devices, independent writes, eventual harmony.

---

## WHAT YOU ARE BUILDING

A monorepo containing these packages:

```
kora/                       # Meta-package re-exporting core, store, merge, sync
packages/
  core/                     # @kora/core - Schema, operations, clocks, types
  store/                    # @kora/store - Local storage (SQLite WASM, IndexedDB)
  merge/                    # @kora/merge - Three-tier conflict resolution
  sync/                     # @kora/sync - Sync protocol and transports
  server/                   # @kora/server - Self-hosted sync server
  react/                    # @kora/react - React hooks and bindings
  devtools/                 # @kora/devtools - Browser DevTools extension
  cli/                      # @kora/cli - CLI tooling and scaffolding
```

---

## CORE PRINCIPLES (Ranked by Priority)

When you face a tradeoff, consult this ranking:

1. **Correctness over performance.** A slow merge that produces the right result is infinitely better than a fast merge that loses data or violates constraints. Never optimize at the expense of correctness. Write the correct version first. Optimize only when benchmarks show a problem.

2. **Developer experience over internal elegance.** The public API must be beautiful. The internals can be pragmatic. If making the internals uglier produces a cleaner developer-facing API, do it. The developer never sees the internals.

3. **Explicit over implicit for anything involving data.** Operations, merges, and sync decisions must be traceable. Every merge decision should be loggable. Every operation should be inspectable. No "magic" that hides what happened to the developer's data.

4. **Convention over configuration.** Sensible defaults for everything. Zero-config should produce a working offline-first app. Configuration is an escape hatch, not a requirement.

5. **Compose existing technology, do not reinvent.** Use SQLite for storage, Yjs for CRDTs, proven algorithms for clocks. Build the glue, not the primitives. Only build from scratch when no existing solution meets our correctness requirements.

6. **Offline is the default state.** Never write code that assumes connectivity. Every code path must work when the network is unavailable. Connectivity is a bonus that enables sync, not a prerequisite that enables functionality.

---

## TECHNOLOGY STACK

These decisions are locked. Do not deviate or substitute.

### Monorepo and Build

| Tool | Version | Purpose |
|------|---------|---------|
| pnpm | 9+ | Package manager. Use workspace protocol (`workspace:*`) for inter-package deps |
| Turborepo | Latest | Monorepo orchestration. Configure in `turbo.json` |
| tsup | Latest | Build tool. ESM + CJS dual builds. Use esbuild under the hood |
| Vitest | Latest | Testing. Use `vitest` not `jest`. Configure per package |
| Biome | Latest | Linting and formatting. Single tool, not ESLint + Prettier |
| Changesets | Latest | Versioning and publishing |
| TypeScript | 5.x | Strict mode everywhere. `"strict": true` in all tsconfig files |

### Client-Side

| Component | Package | Why |
|-----------|---------|-----|
| SQLite WASM | `@sqlite.org/sqlite-wasm` (v3.51+) | Official build. Best OPFS support. Long-term maintenance guaranteed |
| OPFS | Origin Private File System API | Primary persistence. Production-ready in all browsers 2026 |
| IndexedDB | `idb` | Fallback only. Used when WASM/OPFS unavailable |
| CRDT | `yjs` | Fastest CRDT library. For rich text fields and complex merge types |
| React bindings | `react` 18+ | useSyncExternalStore for concurrent-mode safety |

### Server-Side

| Component | Package | Why |
|-----------|---------|-----|
| Runtime | Node.js 20+ | LTS |
| WebSocket | `ws` | Lightest Node.js WebSocket implementation |
| Database ORM | `drizzle-orm` | TypeScript-native. Supports Postgres, MySQL, SQLite |
| Wire format | `protobufjs` | Compact binary encoding for sync protocol |

### CLI and DevTools

| Component | Package | Why |
|-----------|---------|-----|
| CLI framework | `citty` | Lightweight. TypeScript-first. Used by Nuxt team |
| Scaffolding | `giget` | Git-based template system |
| DevTools UI | `preact` + `htm` | Tiny footprint for browser extension |

---

## PACKAGE DEPENDENCY RULES

```
@kora/core       -> (no @kora dependencies)
@kora/store      -> @kora/core
@kora/merge      -> @kora/core
@kora/sync       -> @kora/core, @kora/merge
@kora/server     -> @kora/core, @kora/sync
@kora/react      -> @kora/core, @kora/store, @kora/sync
@kora/devtools   -> @kora/core
@kora/cli        -> (all packages, dev dependency)
```

**Strict rules:**
- A package may NEVER import from a package that depends on it (no circular deps)
- @kora/core has ZERO dependencies on other @kora packages. It is the foundation.
- External dependencies must be minimal. Before adding a dependency, ask: can this be implemented in under 100 lines? If yes, implement it.

---

## CODE STYLE AND CONVENTIONS

### TypeScript

```typescript
// ALWAYS: Explicit return types on exported functions
export function createApp(config: KoraConfig): KoraApp { ... }

// ALWAYS: Use interfaces for object shapes, types for unions/intersections
interface Operation {
  id: string
  type: OperationType
}
type OperationType = 'insert' | 'update' | 'delete'

// ALWAYS: Use const assertions for literal types
const MERGE_STRATEGIES = ['auto-merge', 'lww', 'first-write-wins', 'server-decides', 'custom'] as const
type MergeStrategy = typeof MERGE_STRATEGIES[number]

// NEVER: any. Use unknown and narrow with type guards.
// NEVER: non-null assertions (!). Handle the null case.
// NEVER: @ts-ignore or @ts-expect-error in production code. Fix the type.
// NEVER: enums. Use const objects with as const or string literal unions.
```

### Naming

```
Files:           kebab-case.ts (merge-engine.ts, sync-handler.ts)
Interfaces:      PascalCase, no I prefix (Operation, not IOperation)
Types:           PascalCase (MergeStrategy, ConnectionQuality)
Functions:       camelCase (createApp, defineSchema)
Constants:       UPPER_SNAKE_CASE (MAX_OPERATION_SIZE, DEFAULT_BATCH_SIZE)
Packages:        @kora/package-name
Test files:      same-name.test.ts (merge-engine.test.ts)
```

### File Structure Per Package

```
packages/example/
  src/
    index.ts              # Public API exports ONLY. No implementation here.
    internal.ts           # Internal exports (shared within package, not public)
    types.ts              # Type definitions
    [feature]/
      [feature].ts        # Implementation
      [feature].test.ts   # Co-located tests (unit tests)
  tests/
    integration/          # Integration tests that span multiple internal modules
    fixtures/             # Test data and fixtures
  package.json
  tsup.config.ts
  vitest.config.ts
  README.md
```

### Exports

```typescript
// index.ts - ONLY re-exports. This is the public API contract.
export { defineSchema, type SchemaDefinition } from './schema/define'
export { createApp, type KoraApp, type KoraConfig } from './app'
export { t } from './schema/types'

// NEVER export internal utilities, helpers, or implementation details from index.ts
// NEVER use export * (barrel exports). Be explicit about every export.
```

### Error Handling

```typescript
// ALWAYS: Create specific error classes extending KoraError
export class KoraError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'KoraError'
  }
}

export class MergeConflictError extends KoraError {
  constructor(
    public readonly operationA: Operation,
    public readonly operationB: Operation,
    public readonly field: string
  ) {
    super(
      `Merge conflict on field "${field}" in collection "${operationA.collection}"`,
      'MERGE_CONFLICT',
      { operationA: operationA.id, operationB: operationB.id, field }
    )
  }
}

// NEVER: throw generic Error('something went wrong')
// NEVER: swallow errors silently. Log or propagate.
// ALWAYS: Include enough context to debug without reproduction
```

### Comments

```typescript
// Write comments that explain WHY, not WHAT.

// BAD:
// Increment counter
counter++

// GOOD:
// HLC requires the logical counter to advance on every local event,
// even if wall-clock time hasn't changed, to maintain causal ordering.
counter++

// Use JSDoc for all public API functions:
/**
 * Creates a new Kora application instance.
 *
 * @param config - Application configuration including schema and optional sync settings
 * @returns A KoraApp instance with reactive collections ready for use
 *
 * @example
 * ```typescript
 * const app = createApp({
 *   schema: defineSchema({
 *     todos: {
 *       fields: {
 *         title: t.string(),
 *         completed: t.boolean().default(false)
 *       }
 *     }
 *   })
 * })
 * ```
 */
export function createApp(config: KoraConfig): KoraApp { ... }
```

---

## ARCHITECTURE SPECIFICATIONS

### The Operation (Atomic Unit of the Entire System)

Every mutation produces an Operation. This is the most important type in the codebase. Get it right.

```typescript
interface Operation {
  /** SHA-256 hash of (type + collection + recordId + data + timestamp + nodeId). Content-addressed. */
  id: string

  /** UUID v7 of the originating device. Time-sortable. */
  nodeId: string

  /** What happened */
  type: 'insert' | 'update' | 'delete'

  /** Which collection (from schema) */
  collection: string

  /** ID of the affected record. UUID v7 for inserts, existing ID for update/delete. */
  recordId: string

  /** Field values. null for delete. For updates, contains ONLY changed fields. */
  data: Record<string, unknown> | null

  /** For updates: previous values of changed fields (enables 3-way merge). null for insert/delete. */
  previousData: Record<string, unknown> | null

  /** Hybrid Logical Clock timestamp. Used for causal ordering. */
  timestamp: HLCTimestamp

  /** Monotonically increasing per node. Used in version vectors. */
  sequenceNumber: number

  /** Operation IDs this operation causally depends on (direct parents in the DAG). */
  causalDeps: string[]

  /** Schema version at time of creation. Used for migration transforms. */
  schemaVersion: number
}

interface HLCTimestamp {
  /** Physical wall-clock time in milliseconds */
  wallTime: number

  /** Logical counter. Increments when wallTime hasn't changed since last event. */
  logical: number

  /** Node ID for tie-breaking. Ensures total order even with identical wall+logical. */
  nodeId: string
}
```

**Rules for Operations:**
- Operations are IMMUTABLE. Once created, never modified.
- Operations are CONTENT-ADDRESSED. The id is derived from the content. Same content = same id.
- Operations include CAUSAL DEPENDENCIES. This forms a DAG, not a linear log.
- The operation log is APPEND-ONLY. Operations are never removed (except by compaction, which is a separate, explicit process).
- For updates, `data` contains ONLY the fields that changed, not the full record. This enables field-level merging.
- `previousData` is required for updates because it enables 3-way merge (base, local, remote).

### Hybrid Logical Clock (HLC)

Implement according to the Kulkarni et al. paper. The HLC provides a total order that respects causality without requiring synchronized clocks.

```typescript
class HybridLogicalClock {
  private wallTime: number = 0
  private logical: number = 0
  private nodeId: string

  /**
   * Generate a new timestamp for a local event.
   * Rule: wallTime = max(physical_time, current_wallTime). If wallTime unchanged, increment logical.
   */
  now(): HLCTimestamp {
    const physicalTime = Date.now()
    if (physicalTime > this.wallTime) {
      this.wallTime = physicalTime
      this.logical = 0
    } else {
      this.logical++
    }
    return { wallTime: this.wallTime, logical: this.logical, nodeId: this.nodeId }
  }

  /**
   * Update clock on receiving a remote timestamp.
   * Rule: wallTime = max(physical_time, current_wallTime, remote_wallTime).
   * Logical counter follows the source of the max wallTime.
   */
  receive(remote: HLCTimestamp): HLCTimestamp {
    const physicalTime = Date.now()
    if (physicalTime > this.wallTime && physicalTime > remote.wallTime) {
      this.wallTime = physicalTime
      this.logical = 0
    } else if (remote.wallTime > this.wallTime) {
      this.wallTime = remote.wallTime
      this.logical = remote.logical + 1
    } else if (this.wallTime === remote.wallTime) {
      this.logical = Math.max(this.logical, remote.logical) + 1
    } else {
      this.logical++
    }
    return { wallTime: this.wallTime, logical: this.logical, nodeId: this.nodeId }
  }

  /**
   * Compare two timestamps. Returns negative if a < b, positive if a > b, zero if equal.
   * Total order: wallTime first, then logical, then nodeId (lexicographic).
   */
  static compare(a: HLCTimestamp, b: HLCTimestamp): number {
    if (a.wallTime !== b.wallTime) return a.wallTime - b.wallTime
    if (a.logical !== b.logical) return a.logical - b.logical
    return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0
  }
}
```

**HLC Rules:**
- NEVER use `Date.now()` directly for ordering. Always go through the HLC.
- The HLC must be monotonic: each call to `now()` returns a timestamp strictly greater than the previous one.
- Protect against clock drift: if `Date.now()` returns a value more than 60 seconds behind the current HLC wallTime, log a warning. If more than 5 minutes behind, refuse to generate timestamps (this indicates a severe clock issue).

### Version Vectors

```typescript
type VersionVector = Map<string, number>  // nodeId -> max sequence number seen from that node

function mergeVectors(a: VersionVector, b: VersionVector): VersionVector {
  const merged = new Map(a)
  for (const [nodeId, seq] of b) {
    merged.set(nodeId, Math.max(merged.get(nodeId) ?? 0, seq))
  }
  return merged
}

function deltaOperations(
  localVector: VersionVector,
  remoteVector: VersionVector,
  operationLog: OperationLog
): Operation[] {
  // Return operations that local has but remote doesn't
  const missing: Operation[] = []
  for (const [nodeId, localSeq] of localVector) {
    const remoteSeq = remoteVector.get(nodeId) ?? 0
    if (localSeq > remoteSeq) {
      missing.push(...operationLog.getRange(nodeId, remoteSeq + 1, localSeq))
    }
  }
  // Sort by causal order before returning
  return topologicalSort(missing)
}
```

### Schema System

The schema is the developer's primary interaction point. It must be beautiful.

```typescript
// This is what the developer writes:
import { defineSchema, t } from 'kora'

export default defineSchema({
  version: 1,

  collections: {
    todos: {
      fields: {
        title: t.string(),
        completed: t.boolean().default(false),
        assignee: t.string().optional(),
        tags: t.array(t.string()).default([]),
        notes: t.richtext(),            // CRDT-enabled rich text
        priority: t.enum(['low', 'medium', 'high']).default('medium'),
        dueDate: t.timestamp().optional(),
        createdAt: t.timestamp().auto(), // Set automatically on insert
      },
      indexes: ['assignee', 'completed', 'dueDate'],
      constraints: {
        // Optional: Tier 2 conflict resolution constraints
      }
    }
  },

  relations: {
    todoBelongsToProject: {
      from: 'todos',
      to: 'projects',
      type: 'many-to-one',
      field: 'projectId',
      onDelete: 'set-null'  // or 'cascade', 'restrict', 'no-action'
    }
  }
})
```

**Schema implementation rules:**
- `defineSchema()` must produce full TypeScript type inference. When the developer writes `app.todos.insert({...})`, their IDE must autocomplete field names and type-check values.
- Field type builders (`t.string()`, `t.boolean()`, etc.) use the builder pattern and return typed descriptors.
- `t.richtext()` fields are backed by Yjs Y.Text. All other fields use HLC-based LWW.
- `t.auto()` modifier means the field is set automatically (e.g., `createdAt` set on insert). The developer cannot provide a value.
- Schema validation runs at app initialization time, not at build time. Throw a clear error if the schema is invalid.
- Generate SQL CREATE TABLE statements from the schema. Map types: `string` -> TEXT, `number` -> REAL, `boolean` -> INTEGER (0/1), `enum` -> TEXT with CHECK constraint, `timestamp` -> INTEGER (milliseconds), `array` -> TEXT (JSON-serialized), `richtext` -> BLOB (Yjs state).

### Three-Tier Merge Engine

This is the most critical component. The merge engine determines what happens when concurrent operations modify the same data.

**Tier 1: Auto-Merge (Default for all fields)**

```
Field Type     -> Merge Strategy
string         -> LWW (Last-Write-Wins via HLC)
number         -> LWW
boolean        -> LWW
enum           -> LWW
timestamp      -> LWW
array          -> Add-wins set (union of elements)
richtext       -> Yjs Y.Text CRDT (character-level merge)
```

LWW implementation:
```typescript
function lastWriteWins<T>(
  localValue: T,
  remoteValue: T,
  localTimestamp: HLCTimestamp,
  remoteTimestamp: HLCTimestamp
): T {
  const comparison = HybridLogicalClock.compare(localTimestamp, remoteTimestamp)
  // Positive = local is later, negative = remote is later, zero = impossible (different nodeIds guarantee different timestamps)
  return comparison >= 0 ? localValue : remoteValue
}
```

**Tier 2: Constraint Validation**

After auto-merge produces a result, check constraints declared in the schema. If violated, apply the constraint's `onConflict` strategy.

```typescript
interface Constraint {
  type: 'unique' | 'capacity' | 'referential'
  fields: string[]
  where?: Record<string, unknown>    // Optional filter (e.g., only active records)
  onConflict: 'first-write-wins' | 'last-write-wins' | 'priority-field' | 'server-decides' | 'custom'
  priorityField?: string             // Required when onConflict is 'priority-field'
  resolve?: (local: unknown, remote: unknown, base: unknown) => unknown  // Required when onConflict is 'custom'
}
```

Constraint evaluation flow:
1. Auto-merge produces a candidate state
2. For each constraint on the affected collection, evaluate against candidate state
3. If constraint satisfied: accept candidate
4. If constraint violated: apply onConflict strategy to produce a valid state
5. Emit a `constraint-violation` event (for DevTools)

**Tier 3: Custom Resolvers**

For fields where neither auto-merge nor declarative constraints suffice:

```typescript
// Developer writes:
const schema = defineSchema({
  collections: {
    inventory: {
      fields: {
        productId: t.string(),
        quantity: t.number()
      },
      resolve: {
        quantity: (local, remote, base) => {
          // Additive merge: apply both deltas to base
          const localDelta = local - base
          const remoteDelta = remote - base
          return Math.max(0, base + localDelta + remoteDelta)
        }
      }
    }
  }
})
```

**Merge engine rules:**
- DETERMINISTIC: Given the same set of operations, every node must produce the identical merged state. Test this with property-based tests.
- COMMUTATIVE: merge(A, B) must equal merge(B, A). Test this exhaustively.
- IDEMPOTENT: Applying the same operation twice must produce the same result as applying it once.
- Every merge decision must be loggable. Create a MergeTrace type that records: the conflicting operations, the strategy applied, the input values, and the output value. This feeds DevTools.

### Reactive Query System

```typescript
// Developer writes:
const todos = app.todos.where({ completed: false }).orderBy('createdAt')

todos.subscribe((results) => {
  // Called whenever the result set changes
  console.log(results)
})
```

Implementation approach:
- Each query registers with a SubscriptionManager
- The SubscriptionManager maintains a dependency map: which queries depend on which collections/fields
- When a mutation is applied to the store, the SubscriptionManager checks which subscriptions might be affected
- Only affected subscriptions are re-executed
- Re-execution happens in a microtask (batch multiple mutations into a single re-evaluation cycle)
- Results are diffed against previous results; subscribers are only notified if the result actually changed

**Performance targets:**
- Subscription check per mutation: under 1ms with 1,000 active subscriptions
- Full re-evaluation of an affected query: under 5ms for typical queries
- Time from mutation to subscriber notification: under 16ms (one frame at 60fps)

If subscription checking becomes a bottleneck, implement bloom filter-based dependency tracking.

### Sync Protocol

The sync protocol runs over any transport (WebSocket, HTTP, Bluetooth, etc.). It speaks in Protocol Buffers messages.

**Sync flow:**

```
Client                                    Server
  |                                         |
  |--- Handshake(versionVector, schema) --->|
  |                                         |
  |<-- HandshakeResponse(versionVector) ----|
  |                                         |
  |--- OperationBatch(missing ops) -------->|  (client sends ops server doesn't have)
  |                                         |
  |<-- OperationBatch(missing ops) ---------|  (server sends ops client doesn't have)
  |                                         |
  |<-- Acknowledgment --------------------- |
  |--- Acknowledgment --------------------->|
  |                                         |
  |  (real-time bidirectional streaming)    |
  |                                         |
  |<-- OperationBatch(new ops) -------------|  (as other clients push changes)
  |--- OperationBatch(new ops) ------------>|  (as local mutations happen)
```

**Sync rules:**
- Operations are sent in CAUSAL ORDER. Dependencies before dependents.
- The protocol is IDEMPOTENT. Receiving the same operation twice is a no-op (content-addressing catches duplicates).
- The protocol is RESUMABLE. If connection drops mid-sync, resume from the last acknowledged sequence number, not from the beginning.
- Initial sync (new client) receives all operations matching its sync scope. For large datasets, this is paginated in batches with `is_final` flag on the last batch.
- Outbound queue persists to local storage. Operations survive page refresh and are sent when connection is re-established.

### Storage Adapter Interface

```typescript
interface StorageAdapter {
  /** Open or create the database */
  open(schema: SchemaDefinition): Promise<void>

  /** Close the database and release resources */
  close(): Promise<void>

  /** Execute a write query (INSERT, UPDATE, DELETE) within a transaction */
  execute(sql: string, params?: unknown[]): Promise<void>

  /** Execute a read query (SELECT) */
  query<T>(sql: string, params?: unknown[]): Promise<T[]>

  /** Execute multiple operations atomically */
  transaction(fn: (tx: Transaction) => Promise<void>): Promise<void>

  /** Apply a schema migration */
  migrate(from: number, to: number, migration: MigrationPlan): Promise<void>
}

interface Transaction {
  execute(sql: string, params?: unknown[]): Promise<void>
  query<T>(sql: string, params?: unknown[]): Promise<T[]>
}
```

**Implementation priority:**
1. SQLite WASM with OPFS (primary, implement first)
2. IndexedDB via `idb` (fallback, implement second)
3. Native SQLite via `better-sqlite3` (server-side and Electron, implement third)

**SQLite WASM initialization:**
- Load SQLite WASM lazily (not on page load). Initialize on first database interaction.
- Use OPFS SyncAccessHandle Pool VFS (`opfs-sahpool`) for persistence.
- Run SQLite in a Web Worker to avoid blocking the main thread.
- If OPFS is unavailable (rare in 2026 but possible), fall back to IndexedDB with a console warning.
- Set WAL mode for better concurrent read/write performance: `PRAGMA journal_mode=WAL`

---

## DEVELOPER-FACING API DESIGN

The public API is the product. Every function, hook, and type the developer touches must feel inevitable. Like it could not have been designed any other way.

### createApp()

```typescript
import { createApp, defineSchema, t } from 'kora'

// Minimal (local-only, zero config)
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

// With sync (add one line to enable)
const app = createApp({
  schema,
  sync: {
    url: 'wss://my-server.com/kora'
  }
})

// Full configuration (escape hatches)
const app = createApp({
  schema,
  store: {
    adapter: 'sqlite-wasm',    // or 'indexeddb', 'sqlite-native'
    name: 'my-app-db',
  },
  sync: {
    url: 'wss://my-server.com/kora',
    transport: 'websocket',     // or 'http'
    auth: async () => ({ token: await getAuthToken() }),
    scopes: {
      todos: (ctx) => ({ where: { userId: ctx.userId } }),
    },
    encryption: {
      enabled: true,
      key: 'user-passphrase'    // or keyProvider function
    }
  },
  devtools: process.env.NODE_ENV === 'development'
})
```

### Collection API

```typescript
// Insert
const todo = await app.todos.insert({
  title: 'Ship Kora v1',
  // completed defaults to false (from schema)
  // createdAt set automatically (t.timestamp().auto())
})
// Returns: { id: 'uuid-v7', title: 'Ship Kora v1', completed: false, createdAt: 1712188800000 }

// Find by ID
const todo = await app.todos.findById('uuid-v7')

// Update (partial - only changed fields)
await app.todos.update('uuid-v7', { completed: true })

// Delete
await app.todos.delete('uuid-v7')

// Query
const active = await app.todos
  .where({ completed: false })
  .orderBy('createdAt', 'desc')
  .limit(10)
  .exec()

// Reactive subscription
const unsubscribe = app.todos
  .where({ completed: false })
  .orderBy('createdAt')
  .subscribe((todos) => {
    // Called immediately with current data, then on every change
  })

// Relational query
const todosWithProject = await app.todos
  .where({ completed: false })
  .include('project')  // follows todoBelongsToProject relation
  .exec()

// Count
const count = await app.todos.where({ completed: false }).count()
```

### React Hooks

```typescript
import { KoraProvider, useQuery, useMutation, useSyncStatus } from 'kora/react'

// Provider (wraps app)
function App() {
  return (
    <KoraProvider app={app}>
      <TodoList />
    </KoraProvider>
  )
}

// Query hook (reactive, re-renders on data change)
function TodoList() {
  const todos = useQuery(app.todos.where({ completed: false }).orderBy('createdAt'))
  // todos is always up-to-date. No loading states for local data.

  return todos.map(todo => <TodoItem key={todo.id} todo={todo} />)
}

// Mutation hook
function AddTodo() {
  const addTodo = useMutation(app.todos.insert)

  return (
    <button onClick={() => addTodo({ title: 'New todo' })}>
      Add
    </button>
  )
}

// Sync status
function SyncIndicator() {
  const status = useSyncStatus()
  // status: 'connected' | 'syncing' | 'synced' | 'offline' | 'error'
  // Also: status.pendingOperations (number), status.lastSyncedAt (timestamp)
}
```

**React hook rules:**
- `useQuery` returns data synchronously (from local store). No loading spinner needed for local data.
- `useQuery` uses `useSyncExternalStore` under the hood for React 18+ concurrent mode safety.
- Mutations are fire-and-forget. `useMutation` does not return a promise by default (optimistic). The developer can `await` if they need confirmation.
- `useSyncStatus` re-renders only when status changes, not on every sync event.

---

## TESTING REQUIREMENTS

### Unit Tests

Every exported function must have unit tests. Test the contract (inputs/outputs), not the implementation.

```typescript
// GOOD: Tests the contract
test('HLC.compare returns positive when a is later than b', () => {
  const a: HLCTimestamp = { wallTime: 1000, logical: 0, nodeId: 'a' }
  const b: HLCTimestamp = { wallTime: 999, logical: 0, nodeId: 'b' }
  expect(HybridLogicalClock.compare(a, b)).toBeGreaterThan(0)
})

// BAD: Tests the implementation
test('HLC internal counter increments', () => {
  // Don't test private state
})
```

### Property-Based Tests (Critical for Merge Engine)

Use `fast-check` with Vitest. These are REQUIRED for the merge engine and clock implementations.

```typescript
import { fc } from '@fast-check/vitest'

// REQUIRED: Merge commutativity
test.prop([operationArb, operationArb])('merge is commutative', (opA, opB) => {
  const resultAB = mergeEngine.merge(opA, opB)
  const resultBA = mergeEngine.merge(opB, opA)
  expect(resultAB).toEqual(resultBA)
})

// REQUIRED: Merge idempotency
test.prop([operationArb])('merge is idempotent', (op) => {
  const once = mergeEngine.apply(op)
  const twice = mergeEngine.apply(op) // apply same op again
  expect(once).toEqual(twice)
})

// REQUIRED: HLC monotonicity
test.prop([fc.nat()])('HLC.now() is always monotonically increasing', (n) => {
  const clock = new HybridLogicalClock('test')
  const timestamps = Array.from({ length: n % 1000 }, () => clock.now())
  for (let i = 1; i < timestamps.length; i++) {
    expect(HybridLogicalClock.compare(timestamps[i], timestamps[i - 1])).toBeGreaterThan(0)
  }
})

// REQUIRED: Version vector delta correctness
test.prop([versionVectorArb, versionVectorArb])('delta includes all missing ops', (local, remote) => {
  const delta = deltaOperations(local, remote, mockLog)
  // Every operation in delta should be one that local has and remote doesn't
  for (const op of delta) {
    const localSeq = local.get(op.nodeId) ?? 0
    const remoteSeq = remote.get(op.nodeId) ?? 0
    expect(op.sequenceNumber).toBeGreaterThan(remoteSeq)
    expect(op.sequenceNumber).toBeLessThanOrEqual(localSeq)
  }
})
```

### Integration Tests

Test cross-package flows. These live in the consuming package's test directory.

Required integration scenarios:
- Insert -> Operation created -> Written to store -> Readable via query
- Insert on client A -> Sync to server -> Sync to client B -> Visible on client B
- Concurrent update on A and B -> Both sync -> Both converge to same state
- Constraint violation during merge -> Correct resolution strategy applied
- Client offline -> Multiple mutations -> Reconnect -> All operations sync
- Schema v1 client reconnects to schema v2 server -> Operations transformed correctly

### Chaos Tests

For the sync engine. Run nightly in CI.

```typescript
// Simulate unreliable network
class ChaosTransport implements KoraTransport {
  constructor(
    private inner: KoraTransport,
    private config: {
      dropRate: number      // 0-1, probability of dropping a message
      duplicateRate: number // 0-1, probability of duplicating a message
      reorderRate: number   // 0-1, probability of reordering messages
      maxLatency: number    // ms, random delay up to this value
    }
  ) {}
}

// Required chaos test: 10 clients, 1000 operations each, 10% drop rate, 5% duplicate rate
// All clients must converge to identical state within 60 seconds of all operations being generated.
```

### Performance Benchmarks

Track and enforce with CI. Fail the build if regression exceeds 10%.

```
@kora/store:
  - Insert 10,000 records: < 2 seconds
  - Query 1,000 records with WHERE: < 50ms
  - Reactive query notification latency: < 16ms (one frame)

@kora/merge:
  - Merge 1,000 concurrent operations: < 500ms
  - LWW comparison: < 1 microsecond

@kora/sync:
  - Initial sync of 10,000 operations: < 5 seconds
  - Incremental sync of 1 operation: < 200ms (end-to-end)
  - Version vector delta computation: < 10ms for 100 nodes
```

---

## DEVTOOLS IMPLEMENTATION

DevTools is core product. Not an afterthought.

### Architecture

```
Page Context                    DevTools Extension
+------------------+           +------------------+
| Kora App         |           | DevTools Panel   |
|   |               |           |   (Preact UI)   |
|   v               |           |                  |
| Kora Instrumenter|---msg---->| Message Bridge   |
|   (emits events) |           |   |               |
+------------------+           |   v               |
                               | Timeline View    |
                               | Conflict View    |
                               | Operation Log    |
                               | Network Status   |
                               +------------------+
```

### Instrumentation Events

The Kora core emits events that DevTools consumes:

```typescript
type KoraEvent =
  | { type: 'operation:created'; operation: Operation }
  | { type: 'operation:applied'; operation: Operation; duration: number }
  | { type: 'merge:started'; operationA: Operation; operationB: Operation }
  | { type: 'merge:completed'; trace: MergeTrace }
  | { type: 'merge:conflict'; trace: MergeTrace }
  | { type: 'constraint:violated'; constraint: string; trace: MergeTrace }
  | { type: 'sync:connected'; nodeId: string }
  | { type: 'sync:disconnected'; reason: string }
  | { type: 'sync:sent'; operations: Operation[]; batchSize: number }
  | { type: 'sync:received'; operations: Operation[]; batchSize: number }
  | { type: 'sync:acknowledged'; sequenceNumber: number }
  | { type: 'query:subscribed'; queryId: string; collection: string }
  | { type: 'query:invalidated'; queryId: string; trigger: Operation }
  | { type: 'query:executed'; queryId: string; duration: number; resultCount: number }
  | { type: 'connection:quality'; quality: ConnectionQuality }

interface MergeTrace {
  operationA: Operation
  operationB: Operation
  field: string
  strategy: string       // 'lww', 'crdt-text', 'add-wins-set', 'unique-constraint', 'custom'
  inputA: unknown
  inputB: unknown
  base: unknown | null
  output: unknown
  tier: 1 | 2 | 3
  constraintViolated: string | null
  duration: number
}
```

### DevTools Panels (Phase 1)

1. **Sync Timeline:** Horizontal timeline showing operations and sync events. Color-coded by type. Click to inspect. Shows causal arrows between dependent operations.

2. **Conflict Inspector:** Table of merge events. Filterable by collection, tier, strategy. Each row expandable to show full MergeTrace with before/after values.

3. **Operation Log:** Searchable, filterable list of all operations. Click any operation to see full payload, causal deps, and the state of the database at that point (time-travel).

4. **Network Status:** Real-time connection quality indicator. Pending operation count. Bandwidth graph. Last sync timestamp.

---

## CLI SPECIFICATIONS

### create-kora-app

```bash
$ npx create-kora-app my-app

  Kora.js - Offline-first application framework

  ? Select a template:
    > React (basic)         # Local-only, no sync
      React (with sync)     # Includes sync server setup

  ? Package manager:
    > pnpm
      npm
      yarn
      bun

  Creating my-app...
  Installing dependencies...

  Done! Next steps:
    cd my-app
    pnpm dev
```

### kora dev

Starts the development environment:
- Vite dev server for the application
- Kora sync server (if configured in kora.config.ts)
- Embedded DevTools (accessible via Ctrl+Shift+K)
- Schema file watcher (auto-regenerate types on change)

### kora migrate

```bash
$ kora migrate

  Detected schema change: v1 -> v2

  Changes:
    + todos.priority (enum: low, medium, high, default: medium)
    ~ todos.tags (string -> array<string>)

  Generated migration: kora/migrations/002-add-priority.ts

  ? Apply migration to local store? (y/n)
```

### kora generate

```bash
$ kora generate types

  Generated TypeScript types from schema v2
  Output: kora/generated/types.ts
```

---

## WHAT GOOD LOOKS LIKE

When you complete a feature, check against these criteria:

### For any code:
- TypeScript strict mode passes with zero errors
- All exported functions have JSDoc documentation
- Unit tests cover happy path, edge cases, and error cases
- No `any` types anywhere
- No `@ts-ignore` or `@ts-expect-error`
- Error messages include enough context to debug without reproduction

### For the merge engine specifically:
- Property-based tests prove commutativity, associativity, idempotency
- Every merge path produces a MergeTrace for DevTools
- Constraint violations are detected and resolved without data loss
- Determinism test: 100 random operation orderings all produce identical final state

### For the sync engine specifically:
- Chaos test passes: 10 clients, 1000 ops each, 10% message loss, all converge
- Reconnection test: client offline for 60 seconds, queues 100 ops, reconnects, all ops sync
- Bandwidth adaptation test: sync completes on simulated 2G connection (256kbps)
- No operation is ever lost. No operation is ever applied twice (content-addressing dedup).

### For React hooks specifically:
- No unnecessary re-renders (verify with React DevTools profiler)
- Concurrent mode safe (no tearing with useSyncExternalStore)
- Subscriptions clean up on unmount (no memory leaks)
- Works with React.StrictMode (double-mount safe)

### For the developer experience:
- `npx create-kora-app my-app && cd my-app && pnpm dev` works in under 2 minutes
- IDE autocomplete works for all collection methods and field names
- Error messages tell the developer what went wrong AND how to fix it
- Zero lines of sync or conflict code needed for the default case

---

## ANTI-PATTERNS (Things You Must Never Do)

1. **NEVER assume connectivity.** Every code path must work offline. If you write `fetch()` or `WebSocket` without a fallback, you have broken the framework's core promise.

2. **NEVER use `Date.now()` for ordering.** Always use the Hybrid Logical Clock. Wall-clock time is unreliable across devices.

3. **NEVER mutate an Operation after creation.** Operations are immutable and content-addressed. Mutation breaks the integrity guarantee.

4. **NEVER swallow sync errors silently.** Every error must be logged, emitted as an event (for DevTools), and recoverable. The developer's data is sacred.

5. **NEVER block the main thread with storage operations.** SQLite WASM runs in a Web Worker. Queries and mutations use async communication with the worker.

6. **NEVER require the developer to understand distributed systems.** If your API requires the developer to think about version vectors, causal ordering, or CRDT semantics, you have failed. Hide the complexity.

7. **NEVER add a dependency without justification.** Every dependency is a liability. If you can implement the functionality in under 100 lines with equivalent correctness, do it in-house.

8. **NEVER use `export *`.** Every export is a public API commitment. Be explicit.

9. **NEVER write a test that depends on timing.** Use deterministic clocks, mock transports, and controlled event loops. Flaky tests are worse than no tests.

10. **NEVER optimize before measuring.** Write correct code first. Benchmark. Optimize only the measured bottleneck. Premature optimization in a distributed system creates subtle correctness bugs.

---

## IMPLEMENTATION ORDER

Build packages in this exact order. Each package depends only on packages built before it.

```
1. @kora/core         (schema, operations, clocks - the foundation)
2. @kora/store         (local storage - can demo locally after this)
3. @kora/merge         (conflict resolution - the hardest part)
4. @kora/sync          (sync protocol - requires merge)
5. @kora/server        (sync server - requires sync)
6. @kora/react         (React bindings - requires store + sync)
7. @kora/devtools      (DevTools - requires core for event types)
8. @kora/cli           (CLI - requires all packages for templates)
```

After each package, write an integration test that validates the new package works with all previously built packages. The test suite grows monotonically.

---

## WHEN IN DOUBT

If you face an ambiguous decision not covered by this document, apply these questions in order:

1. **Does this protect the developer's data?** Data integrity is non-negotiable. Choose the option that never loses data.

2. **Does this keep the API simple?** If one option requires the developer to learn a new concept and the other doesn't, choose the simpler option.

3. **Does this work offline?** If one option requires connectivity, choose the one that doesn't.

4. **Is this deterministic?** If one option introduces non-determinism (race conditions, timing dependencies), choose the deterministic option.

5. **Can I test this?** If one option is easier to test, choose it. Untestable code is untrustworthy code.

If none of these resolve the ambiguity, leave a `// DECISION NEEDED:` comment explaining the tradeoff and move on. A human engineer will resolve it.

---

*Kora: independent strings, shared harmony.*