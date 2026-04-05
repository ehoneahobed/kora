# Kora.js Product Document

**Version:** 1.0
**Date:** April 4, 2026
**Status:** Architecture Design Phase

---

## 1. What Kora Is

Kora.js is an offline-first application framework. It sits alongside your UI layer (React, Vue, Svelte, Flutter, or anything else) and owns everything about your application's data: how it is stored locally, how it syncs across devices, how conflicts resolve, and how it behaves when connectivity drops or disappears entirely.

Kora is to offline-first apps what Next.js is to React apps. Next.js did not replace React. It made React-based applications dramatically easier to build by handling routing, rendering strategies, and deployment conventions. Kora does not replace your UI framework or your database. It makes offline-first applications dramatically easier to build by handling persistence, synchronization, conflict resolution, and connectivity adaptation.

**Kora is not:**
- A database (it uses existing storage engines underneath)
- A sync engine (sync is one layer, not the whole product)
- A backend service (it runs on the client, server is optional)
- A UI framework (it pairs with whatever you already use)

**Kora is:**
- An opinionated, convention-driven framework for building applications that work without internet, sync when connected, and handle conflicts automatically
- A complete developer experience: CLI, DevTools, schema management, reactive queries, and deployment tooling
- The missing infrastructure layer that turns offline-first from a distributed systems PhD project into a `npx create-kora-app` experience

---

## 2. Why Kora Exists

### The Market Reality

Over 2.7 billion people live with unreliable or no internet connectivity. Most of them are in Africa, South Asia, and Southeast Asia. These are also among the fastest-growing markets for mobile applications, healthcare platforms, financial services, and education technology.

The Western-dominated developer tooling ecosystem has treated offline capability as an edge case rather than a primary design constraint. The result: building an offline-first application in 2026 still requires assembling 4 to 7 separate libraries, understanding distributed systems theory, and writing custom sync logic. This is the equivalent of requiring every web developer to write their own HTTP server before building a website.

### Why Nobody Has Solved This Yet

After analyzing every major competitor in the space (Replicache, Zero, ElectricSQL, PowerSync, RxDB, InstantDB, Fireproof, TinyBase, Evolu, cr-sqlite), seven consistent failure patterns emerge:

**Failure 1: Database coupling.** ElectricSQL and Zero both require PostgreSQL v15+. This eliminates 60%+ of the addressable market. PowerSync is the only competitor that supports multiple backends, and that is one reason it has the most complete solution.

**Failure 2: Read-path-only architectures.** ElectricSQL syncs data FROM Postgres TO clients but writes still go through your existing API. That is a real-time read cache, not an offline-first framework. True offline-first means writes must succeed locally and sync later.

**Failure 3: Excessive architectural commitment.** Replicache required teams to rewrite all business logic as "mutators" and restructure backends around serializable transactions. Adoption died because the cost of entry was too high. The framework entered maintenance mode.

**Failure 4: Pure CRDT assumptions.** Every solution either ignores conflict resolution or assumes CRDTs solve everything. In production, Figma, Notion, and Linear all use hybrid approaches because pure CRDTs cannot enforce business constraints like unique slots, inventory limits, or referential integrity.

**Failure 5: Fragmented developer experience.** PowerSync ships different SDK patterns for Flutter, React, and React Native. RxDB requires RxJS expertise. Zero's documentation is sparse. Nobody has achieved the unified, opinionated DX that made Next.js dominant.

**Failure 6: No connectivity awareness.** Zero solutions optimize for low-bandwidth, intermittent connectivity, SMS fallback, Bluetooth mesh, or battery-aware sync scheduling. They assume WebSocket or HTTP. That assumption fails for billions of users.

**Failure 7: DevTools as afterthought.** Debugging distributed state is the number one pain point after sync itself. Every competitor treats DevTools as a Phase 3 feature. The result: developers cannot diagnose sync failures, inspect conflicts, or simulate network conditions without building custom tooling.

### The Opportunity

Kora addresses all seven failure modes simultaneously. Not by building a better sync engine or a better database, but by building a higher-order abstraction: a framework that composes proven storage engines, conflict resolution strategies, and sync protocols into a single, opinionated developer experience with sensible defaults and deep escape hatches.

---

## 3. Strategic Positioning

### The Next.js Playbook

Next.js succeeded through a specific sequence:

1. Ship an opinionated framework on top of React (existing ecosystem)
2. Win developer love through DX superiority
3. Build the deployment platform (Vercel) as the natural next step
4. The framework creates adoption. The platform creates the business model.

Kora follows the same playbook:

1. **Phase 1:** Ship Kora.js as an opinionated offline-first framework (composing SQLite, Yjs, and proven sync primitives)
2. **Phase 2:** Win developer love through DX that makes offline-first trivially easy
3. **Phase 3:** Ship Kora Cloud as the hosted sync and deployment platform
4. **Phase 4:** The framework becomes the standard. The platform becomes the business.

### Brand Architecture

| Component | Purpose |
|-----------|---------|
| **Kora** | The brand, the company, the ecosystem |
| **Kora.js** | The open-source framework (npm package) |
| **Kora CLI** | Command-line tooling for scaffolding, migrations, inspection |
| **Kora DevTools** | Browser extension and embedded debugging panel |
| **Kora Cloud** | Hosted sync infrastructure, analytics, monitoring (future) |
| **Kora Mesh** | P2P and Bluetooth transport layer for low-connectivity (future) |

### The Name

Kora is the 21-string West African harp. Each string resonates independently but produces harmony together. This is not just a metaphor for eventual consistency and independent nodes converging to shared state. It is a metaphor for the entire framework philosophy: independent devices, independent writes, eventual harmony.

The West African origin ties directly to the mission: building infrastructure that serves the 2.7 billion people the current ecosystem ignores. The name is two syllables, easy to pronounce in any language, and has no trademark conflicts in the developer tooling space.

---

## 4. Core Architecture

### Design Philosophy

Three principles govern every architectural decision:

**Principle 1: Easy things easy, hard things possible.** The default path requires zero configuration. The escape hatches exist when business logic demands them. This is the principle that made React Hooks succeed where class components created friction.

**Principle 2: Compose, do not reinvent.** Kora builds on top of SQLite (proven storage), Yjs (proven CRDTs), and well-understood sync protocols. We do not build a new storage engine, a new CRDT library, or a new database. We build the opinionated glue that makes them work together seamlessly.

**Principle 3: Connectivity is a spectrum, not a binary.** Applications do not switch between "online" and "offline." They exist on a continuous spectrum from full bandwidth to zero connectivity, with every state in between. The framework must adapt to every point on that spectrum without developer intervention.

### Layered Architecture

```
+--------------------------------------------------+
|              APPLICATION CODE                     |
|         (React, Vue, Svelte, Flutter)             |
+--------------------------------------------------+
|              KORA DEVELOPER API                   |
|    Schema | Queries | Mutations | Subscriptions   |
+--------------------------------------------------+
|              KORA REACTIVE ENGINE                 |
|     Observable queries | Computed views           |
+--------------------------------------------------+
|              KORA MERGE ENGINE                    |
|   Auto-merge | Constraints | Custom resolvers     |
+--------------------------------------------------+
|              KORA OPERATION LOG                   |
|     Append-only event log | Content-addressed      |
+--------------------------------------------------+
|              KORA STORE                           |
|        SQLite (WASM) | IndexedDB | FS             |
+--------------------------------------------------+
|              KORA SYNC ENGINE                     |
|  Delta sync | Version vectors | Partial sync       |
+--------------------------------------------------+
|              KORA TRANSPORT                       |
|  WebSocket | HTTP | Bluetooth LE | SMS | P2P      |
+--------------------------------------------------+
```

Each layer is independently replaceable and testable. A developer can use Kora Store without Kora Sync (purely local app). They can use Kora Sync without Kora Cloud (self-hosted sync). They can replace the transport layer without touching the merge engine.

### Layer 1: Kora Store

**What it does:** Abstracts local storage into a unified, reactive interface. The developer writes queries against Kora Store. Kora Store routes them to the appropriate storage engine.

**Storage engines:**
- **Web:** SQLite compiled to WASM (via wa-sqlite or PGLite) as primary, IndexedDB as fallback
- **Mobile (React Native / Flutter):** Native SQLite
- **Desktop (Electron / Tauri):** Native SQLite
- **Node.js:** Native SQLite

**Why SQLite everywhere (not IndexedDB as primary):** IndexedDB has unpredictable quotas (Safari limits to 1GB, prompts every 200MB), Apple deletes IndexedDB data after 7 days of non-use, and query performance varies wildly across browsers. SQLite via WASM provides consistent behavior, full relational query capability, and proven reliability. IndexedDB serves only as a fallback where WASM is unavailable.

**Key design decisions:**
- Local database is always the source of truth for reads
- All writes go to the local store first, then propagate through the sync engine
- Reactive queries update automatically when underlying data changes
- Full SQL capability available through the query engine (not a limited subset)

### Layer 2: Kora Operation Log

**What it does:** Every mutation produces an immutable, content-addressed operation that is appended to the operation log. This is the foundation for sync, rollback, time-travel debugging, and deterministic merging.

**Operation structure:**
```json
{
  "id": "sha256:a1b2c3...",
  "type": "insert",
  "collection": "todos",
  "data": { "title": "Ship v1", "completed": false },
  "timestamp": 1712188800000,
  "nodeId": "device-abc-123",
  "schemaVersion": 3,
  "causalDeps": ["sha256:x1y2z3..."]
}
```

**Why content-addressed:** Each operation is identified by its content hash (like Git commits). This provides deduplication for free (same operation received twice is recognized), integrity verification (tampered operations are detected), and efficient delta sync (nodes exchange hashes to determine which operations the other is missing).

**Causal dependencies:** Each operation records which prior operations it causally depends on. This creates a directed acyclic graph (DAG) of operations, enabling the merge engine to understand causal ordering without relying on wall-clock timestamps (which are unreliable across devices).

### Layer 3: Kora Merge Engine

This is the hardest and most defensible layer. It is also where Kora fundamentally differs from every competitor.

**The problem with pure CRDTs:** CRDTs guarantee convergence (all nodes reach the same state) but cannot enforce application invariants. If two nurses book the last appointment slot offline, a CRDT will merge both bookings. Convergent, but broken.

**The problem with server-authority only:** Server-authoritative conflict resolution (like Replicache) requires the server to be available for writes to be finalized. This breaks the offline-first promise.

**Kora's solution: Three-tier conflict resolution**

**Tier 1: Auto-merge (default)**
For data types where convergence is sufficient. This covers 80%+ of real-world conflicts.

- Scalar fields: Last-write-wins using causal ordering (not wall-clock time)
- Text fields: Character-level CRDT merging via Yjs
- Counters: Grow-only counter CRDTs
- Sets/arrays: Add-wins set CRDTs
- Nested objects: Recursive field-level merging

The developer writes nothing. Conflicts resolve automatically.

**Tier 2: Constraint validation**
For fields where business rules must hold. The developer declares constraints in the schema.

```js
const schema = defineSchema({
  appointments: {
    fields: {
      slotId: 'string',
      patientId: 'string',
      nurseId: 'string',
      status: { type: 'enum', values: ['booked', 'cancelled', 'completed'] }
    },
    constraints: {
      uniqueSlot: {
        type: 'unique',
        fields: ['slotId'],
        where: { status: 'booked' },
        onConflict: 'first-write-wins'
      }
    }
  }
})
```

When the merge engine detects a constraint violation after auto-merge, it applies the declared resolution strategy. Available strategies: `first-write-wins`, `last-write-wins`, `priority-field` (higher value wins), `server-decides` (queue for server resolution), or `custom` (developer-provided function).

**Tier 3: Application-level resolution**
For complex business logic that cannot be expressed declaratively. The developer provides a resolver function.

```js
const schema = defineSchema({
  inventory: {
    fields: {
      productId: 'string',
      quantity: 'number'
    },
    resolve: {
      quantity: (local, remote, base) => {
        // Custom logic: ensure quantity never goes negative
        const merged = base.quantity + (local.quantity - base.quantity) + (remote.quantity - base.quantity)
        return Math.max(0, merged)
      }
    }
  }
})
```

**Escalation flow:** Auto-merge first. If constraints violated, apply constraint strategy. If constraint strategy is `custom` or `server-decides`, invoke the resolver or queue for server. The developer only writes code for Tier 2 and Tier 3, and only for the specific fields that need it.

### Layer 4: Kora Sync Engine

**What it does:** Exchanges operations between nodes to achieve eventual consistency. Transport-agnostic. Works identically whether the transport is WebSocket, HTTP, Bluetooth, or SMS.

**Sync protocol:**

1. **Handshake:** Two nodes exchange their version vectors (compact representation of which operations each has seen)
2. **Delta computation:** Each node computes which operations the other is missing
3. **Transfer:** Missing operations are sent in causal order (dependencies before dependents)
4. **Application:** Receiving node applies operations through the Merge Engine
5. **Acknowledgment:** Receiving node confirms applied operations, updating the sender's knowledge of the receiver's state

**Partial sync:** Nodes do not need to sync all data. The developer defines sync scopes:

```js
const app = createApp({
  schema,
  sync: {
    scopes: {
      // Only sync todos belonging to the current user
      todos: (userId) => ({ where: { assignee: userId } }),
      // Sync all shared projects
      projects: () => ({ where: { shared: true } })
    }
  }
})
```

**Bandwidth adaptation:** The sync engine monitors connection quality and adapts:
- **High bandwidth:** Stream operations in real-time via WebSocket
- **Medium bandwidth:** Batch operations and send periodically via HTTP
- **Low bandwidth:** Aggressive compression, prioritize critical operations
- **Intermittent:** Store-and-forward with automatic retry and deduplication
- **No connectivity:** Queue operations locally, sync when connection returns

### Layer 5: Kora Transport

**What it does:** Abstract transport layer that decouples the sync protocol from the physical medium.

**Built-in transports:**
- **WebSocket:** Default for web applications. Real-time, bidirectional.
- **HTTP long-polling:** Fallback when WebSocket is unavailable.
- **Bluetooth LE:** Device-to-device sync without internet. Critical for field deployments in Africa, rural healthcare, agricultural applications.
- **SMS gateway:** Operation encoding over SMS for ultra-low-connectivity environments. Operations are compressed and serialized into SMS-compatible format.
- **WebRTC:** Peer-to-peer sync without server intermediary.

**Custom transports:** The transport interface is simple enough that developers can implement custom transports (satellite, LoRa, USB transfer, QR code exchange).

```js
// Transport interface
interface KoraTransport {
  send(operations: Operation[]): Promise<void>
  receive(): AsyncIterable<Operation[]>
  getConnectionQuality(): ConnectionQuality
}
```

### Layer 6: Schema Evolution

This is the sleeper problem that every competitor either ignores or handles poorly.

**The problem:** You ship a schema change. Half your users are offline for three days. When they come back online, their operation logs reference a schema that no longer exists. How do you replay those operations against the new schema?

**Kora's solution: Versioned schemas with operation transformers**

```js
// Schema version 2 adds a 'priority' field to todos
const schemaV2 = defineSchema({
  version: 2,
  collections: {
    todos: {
      fields: {
        title: 'string',
        completed: 'boolean',
        priority: { type: 'enum', values: ['low', 'medium', 'high'], default: 'medium' }
      }
    }
  },
  migrations: {
    from: 1,
    transform: (operation) => {
      // Operations from schema v1 get the default priority
      if (operation.collection === 'todos' && operation.type === 'insert') {
        return {
          ...operation,
          data: { ...operation.data, priority: 'medium' }
        }
      }
      return operation
    }
  }
})
```

When a node with schema v1 operations syncs with a node running schema v2, the sync engine runs the operation transformer chain before applying operations. This is deterministic (same transform applied on every node) and composable (v1 to v2 to v3 chains automatically).

---

## 5. Developer Experience

### The 10-Minute Promise

A developer should go from zero to a working offline-first app in under 10 minutes. This is the benchmark. If any step takes longer, the framework has failed.

### Scaffolding

```bash
npx create-kora-app my-app
cd my-app
npm run dev
```

This generates:
```
my-app/
  kora.config.ts      # Framework configuration
  kora/
    schema.ts          # Data schema definitions
    resolvers.ts       # Custom conflict resolvers (if needed)
    scopes.ts          # Sync scope definitions (if needed)
  src/
    ...                # Application code (React, Vue, whatever)
  kora-devtools/       # Embedded DevTools configuration
```

### Schema Definition

```typescript
import { defineSchema, t } from 'korajs'

export default defineSchema({
  version: 1,
  collections: {
    todos: {
      fields: {
        title: t.string(),
        completed: t.boolean().default(false),
        assignee: t.string().optional(),
        tags: t.array(t.string()).default([]),
        notes: t.richtext(),  // CRDT-enabled rich text field
        createdAt: t.timestamp().auto(),
      },
      indexes: ['assignee', 'completed'],
    },
    projects: {
      fields: {
        name: t.string(),
        members: t.array(t.string()),
        status: t.enum(['active', 'archived']).default('active'),
      },
      constraints: {
        uniqueName: {
          type: 'unique',
          fields: ['name'],
          onConflict: 'first-write-wins'
        }
      }
    }
  },
  relations: {
    todoProject: {
      from: 'todos',
      to: 'projects',
      type: 'many-to-one',
      field: 'projectId'
    }
  }
})
```

TypeScript types are generated automatically from the schema. No separate type definitions needed.

### Querying and Mutations

```typescript
import { useKora } from 'korajs/react'  // or kora/vue, kora/svelte

function TodoList() {
  const db = useKora()

  // Reactive query: re-renders when data changes (local or synced)
  const todos = db.todos.where({ completed: false }).orderBy('createdAt')

  // Insert: works offline, syncs when connected
  const addTodo = async (title: string) => {
    await db.todos.insert({ title, projectId: currentProject.id })
  }

  // Update: same pattern
  const toggle = async (id: string) => {
    await db.todos.update(id, { completed: true })
  }

  // Delete
  const remove = async (id: string) => {
    await db.todos.delete(id)
  }

  // Relational query with join
  const todosWithProjects = db.todos
    .where({ completed: false })
    .include('project')  // Follows the todoProject relation
    .orderBy('createdAt')

  return (/* render */)
}
```

### What the Developer Does NOT Write

- No sync configuration (automatic)
- No retry logic (built-in)
- No queue management (built-in)
- No conflict resolution code (unless they opt into Tier 2/3)
- No backend API endpoints for sync (Kora handles it)
- No connection state management (framework adapts automatically)
- No schema migration scripts (declarative transforms)

### Configuration (When Needed)

```typescript
// kora.config.ts
import { defineConfig } from 'korajs'

export default defineConfig({
  // Storage: auto-detected by platform, or override
  store: 'sqlite-wasm',  // or 'indexeddb', 'sqlite-native'

  // Sync: optional, omit for purely local apps
  sync: {
    target: 'wss://my-api.com/kora',  // or Kora Cloud URL
    transport: 'websocket',            // or 'http', 'bluetooth', 'auto'
    partial: true,                     // only sync what the client needs
    compression: 'auto',               // adapts to bandwidth
    encryption: {
      enabled: true,
      keyProvider: 'local'             // or 'kms', or custom
    }
  },

  // DevTools: enabled in development, stripped in production
  devtools: {
    enabled: process.env.NODE_ENV === 'development',
    networkSimulator: true,
    conflictInspector: true
  }
})
```

---

## 6. Kora DevTools

DevTools are not a Phase 3 feature. They are core product, shipping with v1.

### Why This Matters

Every competitor treats debugging tools as secondary. The result: when developers hit sync bugs (and they will), they have no visibility into what happened. They add console.log statements, guess at causal ordering, and waste days on issues that a proper inspector would surface in minutes.

Kora DevTools is a browser extension (Chrome, Firefox) plus an embedded panel that provides:

### Sync Timeline
Visual timeline of all sync events. Which operations were sent, received, applied, or rejected. Causal dependency graph rendered as a DAG. Tap any operation to see its full payload, schema version, and merge result.

### Conflict Inspector
When Tier 2 or Tier 3 conflict resolution fires, the inspector shows: the conflicting operations, the base state, the merge strategy applied, and the final result. Developers can replay conflicts with different strategies to understand behavior.

### Network Simulator
Simulate network conditions without leaving the browser:
- Full offline (zero connectivity)
- Intermittent (random drops)
- High latency (500ms to 5s)
- Low bandwidth (2G, 3G simulation)
- Partition (some nodes reachable, others not)

This is how developers test their apps for the connectivity conditions their African, South Asian, and rural users actually experience.

### Operation Log Viewer
Searchable, filterable view of the entire operation log. Time-travel debugging: select any point in the log and see the application state at that moment. Diff view between any two points in time.

### Device State Viewer
Side-by-side comparison of state across multiple devices (simulated or real). Highlights divergences and shows which operations are pending sync on each device.

---

## 7. Sync Protocol Specification

### Protocol Design Goals

1. **Deterministic:** Same operations applied in any order produce the same final state
2. **Efficient:** Delta-based, not full-state transfer
3. **Resumable:** Interrupted syncs resume from where they stopped, not from the beginning
4. **Transport-agnostic:** Works over WebSocket, HTTP, Bluetooth, SMS, or any medium
5. **Partition-tolerant:** Handles network partitions gracefully with automatic reconciliation

### Version Vectors

Each node maintains a version vector: a mapping from node IDs to the highest operation sequence number seen from that node.

```
Node A's vector: { A: 15, B: 12, C: 8 }
Node B's vector: { A: 10, B: 14, C: 8 }
```

During sync, nodes exchange vectors. Node A sees that B is behind on A's operations (10 vs 15) and sends operations 11 through 15. Node B sees that A is behind on B's operations (12 vs 14) and sends operations 13 through 14. Node C's state is identical on both, so nothing is exchanged.

### Compression Strategy

Operations are compressed using a tiered approach:
- **Structural compression:** Operations on the same collection are batched and field names are dictionary-encoded
- **Delta compression:** Sequential updates to the same record are collapsed into a single delta
- **Binary encoding:** Protocol Buffers or MessagePack for wire format (not JSON)
- **Transport compression:** gzip/brotli at the transport level

For SMS transport, additional aggressive compression: field names are mapped to single-byte codes, timestamps are delta-encoded from a base, and the payload is base64-encoded for SMS compatibility.

### Encryption

All operations are encrypted before leaving the device using AES-256-GCM. Key management options:
- **Local keys:** Generated and stored on device. Simple but limits multi-device sync to devices that have exchanged keys.
- **Key Management Service (KMS):** Keys managed by a central service. Enables seamless multi-device but requires connectivity for key exchange.
- **Passphrase-derived:** User provides a passphrase that derives the encryption key via Argon2. Works offline, enables multi-device without KMS.

---

## 8. Technical Decisions and Tradeoffs

### Decision 1: SQLite WASM as Primary Web Storage

**Choice:** SQLite compiled to WebAssembly, with IndexedDB as fallback only.

**Why:** IndexedDB has unpredictable quotas, inconsistent behavior across browsers, and Apple's 7-day eviction policy makes it unsuitable as a primary storage engine for offline-first apps that may go days without network access. SQLite WASM provides consistent behavior, full relational queries, and proven reliability.

**Tradeoff:** WASM adds approximately 400KB to initial bundle size. Mitigated by lazy loading (SQLite WASM loads on first database interaction, not on page load) and CDN caching.

### Decision 2: Yjs for CRDT Operations (Not Automerge)

**Choice:** Yjs as the underlying CRDT library for auto-merge operations.

**Why:** Yjs is the fastest CRDT implementation available, has proven production reliability (JupyterLab, Serenity Notes, and others), uses memory-efficient binary encoding with garbage collection, and excels at text collaboration. Automerge v3.0 made significant memory improvements but remains slower than Yjs for the operations that matter most.

**Tradeoff:** Yjs API requires specific constructors rather than plain JSON manipulation. Kora abstracts this entirely; the developer never interacts with Yjs directly.

### Decision 3: Causal Ordering Over Wall-Clock Timestamps

**Choice:** Operations are ordered by causal dependencies (DAG), not by device timestamps.

**Why:** Wall-clock timestamps are unreliable across devices. A phone set to the wrong timezone, a device that has drifted, or a deliberately manipulated clock would corrupt ordering. Causal ordering (tracking which operations each operation depends on) provides a correct partial order without relying on synchronized clocks.

**Tradeoff:** Causal ordering is a partial order, not a total order. For fields where a total order is needed (last-write-wins), Kora uses Hybrid Logical Clocks (HLC) which combine causal ordering with physical time to produce a total order that respects causality.

### Decision 4: Framework, Not Library

**Choice:** Kora ships as an opinionated framework with conventions, CLI, and DevTools, not as a composable library.

**Why:** The offline-first space already has excellent libraries (Yjs, cr-sqlite, PGLite). What the ecosystem lacks is the opinionated glue that makes them work together. Libraries require assembly. Frameworks provide a complete developer experience. Next.js won over raw React + Express + Webpack for the same reason.

**Tradeoff:** Less flexibility than a library approach. Developers who want to use only the sync engine with their own storage cannot do so easily. Mitigated by modular architecture: Kora's layers can be imported independently for advanced use cases.

### Decision 5: Database-Agnostic Backend Sync

**Choice:** Kora's sync server can connect to any backend database (Postgres, MySQL, MongoDB, SQLite) or run without a backend entirely.

**Why:** ElectricSQL and Zero's Postgres-only requirement eliminates most potential adopters. PowerSync's backend-agnostic approach (supporting Postgres, MongoDB, MySQL, SQL Server) is its strongest competitive advantage. Kora adopts this principle.

**Implementation:** The sync server uses adapter pattern. Kora ships adapters for Postgres, MySQL, MongoDB, and SQLite. Community can contribute additional adapters.

### Decision 6: Connectivity-Aware Transport

**Choice:** Multiple transport layers with automatic switching based on connection quality.

**Why:** This is Kora's primary differentiation against every competitor. No existing solution optimizes for the connectivity conditions that 2.7 billion people actually experience. WebSocket and HTTP assumptions fail for users on 2G networks, intermittent satellite connections, or rural areas with no cellular coverage.

**Implementation:** The sync engine monitors connection quality metrics (latency, bandwidth, packet loss, connection stability) and automatically selects the optimal transport and compression strategy. Developers can also explicitly configure transport preferences.

---

## 9. Phasing Strategy

### Philosophy: Narrow But Complete, Not Broad But Shallow

ChatGPT's original phasing shipped a "core engine" without conflict resolution in Phase 1. That would launch a product that is worse than PouchDB (released in 2012). Instead, Kora's Phase 1 ships a narrow vertical (one platform, one storage engine, one sync transport) but with the full stack working end-to-end, including conflict resolution and DevTools.

### Phase 1: Foundation (Months 0 to 9)

**Target:** React developers building collaborative web applications.

**Deliverables:**
- Kora Store: SQLite WASM for web
- Kora Operation Log: Content-addressed, causal dependencies
- Kora Merge Engine: All three tiers (auto-merge, constraints, custom resolvers)
- Kora Sync Engine: WebSocket transport with HTTP fallback
- Kora DevTools: Sync timeline, conflict inspector, operation log viewer
- Kora CLI: `create-kora-app`, `kora dev`, `kora migrate`
- React bindings: `useKora` hook, reactive queries
- Self-hosted sync server with Postgres adapter
- Documentation and getting-started guides

**What ships:** A developer can `npx create-kora-app`, define a schema, build a React app that works offline, syncs via WebSocket, resolves conflicts automatically, and debug the entire flow using DevTools. End to end.

**What does NOT ship yet:** Mobile SDKs, Bluetooth/SMS transport, Vue/Svelte bindings, Kora Cloud, P2P sync.

### Phase 2: Platform Expansion (Months 9 to 18)

**Target:** Mobile developers, teams with non-Postgres backends.

**Deliverables:**
- React Native and Flutter SDKs (native SQLite)
- Vue and Svelte bindings
- MySQL and MongoDB sync server adapters
- Bluetooth LE transport (device-to-device sync)
- Network simulator in DevTools
- Schema evolution with operation transformers
- Partial sync with scope definitions
- Plugin system for custom transports and storage engines

### Phase 3: Connectivity and Ecosystem (Months 18 to 28)

**Target:** Developers building for low-connectivity regions.

**Deliverables:**
- SMS gateway transport
- P2P WebRTC transport
- Kora Mesh (Bluetooth mesh networking for multi-device relay)
- Battery-aware sync scheduling
- Kora Cloud beta (hosted sync, monitoring, analytics)
- Community plugin marketplace
- Enterprise features (audit logs, compliance tooling, role-based access)

### Phase 4: Platform Dominance (Months 28 to 36+)

**Target:** Becoming the default data layer for offline-capable applications.

**Deliverables:**
- Kora Cloud GA with global edge infrastructure
- One-click deployment from CLI
- Kora Studio (visual schema designer, sync topology builder)
- Partnerships with cloud providers (Vercel, Netlify, Railway)
- Certification program for Kora developers
- Enterprise SLAs and support tiers

---

## 10. Success Metrics

### Developer Experience Metrics
- Time from `npx create-kora-app` to working offline-first app: under 10 minutes
- Lines of sync/conflict code written by developer: zero (for default cases)
- Time to debug a sync issue using DevTools: under 5 minutes

### System Performance Metrics
- Local query latency: under 5ms for typical queries
- Sync latency (operation to visible on other device): under 200ms on good connectivity
- Sync efficiency: under 2x bandwidth overhead compared to raw data size
- Conflict auto-resolution rate: over 95% without developer intervention

### Adoption Metrics
- npm weekly downloads target at 12 months: 10,000+
- GitHub stars target at 12 months: 5,000+
- Production applications using Kora at 18 months: 500+
- Comparable adoption trajectory to: Next.js at same stage, Firebase at same stage

---

## 11. Risks and Mitigations

### Risk 1: CRDT Complexity Leaks Through the Abstraction

**Severity:** High
**Description:** Despite Kora hiding CRDTs behind the API, edge cases in conflict resolution may surface behavior that developers find confusing or unexpected.
**Mitigation:** Extensive documentation of merge behavior for each field type. DevTools conflict inspector makes merge decisions visible and debuggable. Default behaviors are chosen to match developer intuition (last-write-wins for scalars, merge for text, union for arrays).

### Risk 2: SQLite WASM Performance on Low-End Devices

**Severity:** Medium
**Description:** SQLite WASM adds memory and CPU overhead compared to native SQLite. Low-end Android devices (common in target African markets) may struggle.
**Mitigation:** Benchmark extensively on low-end hardware from Phase 1. Implement query optimization layer that adapts to device capability. Provide IndexedDB fallback for devices where WASM performance is unacceptable. Investigate using Origin Private File System (OPFS) for better SQLite WASM performance in browsers that support it.

### Risk 3: Schema Evolution Creates Unbounded Transformer Chains

**Severity:** Medium
**Description:** After many schema versions, a device that has been offline since v1 reconnecting to a v15 server must run 14 transformation steps on every operation. This could be slow.
**Mitigation:** Implement "compaction points" where the full state is snapshotted at a schema version. Devices offline since before the compaction point receive a full state snapshot rather than replaying the entire operation history. Set a maximum supported version gap (configurable, default 10 versions).

### Risk 4: Bluetooth/SMS Transport Proves Unreliable

**Severity:** Low-Medium
**Description:** Bluetooth LE and SMS are fundamentally less reliable than WebSocket/HTTP. Operations may be lost or corrupted.
**Mitigation:** All operations are content-addressed with integrity checksums. The sync protocol is idempotent and resumable. Lost operations are automatically retried. Corrupted operations are detected and re-requested.

### Risk 5: Developer Adoption in a Crowded Space

**Severity:** High
**Description:** The offline-first space has many solutions. Developers may be fatigued or skeptical.
**Mitigation:** Lead with DX, not with technology. The 10-minute getting-started experience must be genuinely delightful. Target specific verticals (healthcare in Africa, field services, agricultural tech) where offline-first is a hard requirement, not a nice-to-have. Build community through real use cases, not theoretical advantages.

---

## 12. Open Technical Questions

These questions must be resolved during Phase 1 development:

1. **Relational integrity in CRDTs:** How do we handle cascading deletes across relations when devices are offline? If a project is deleted on Device A while Device B adds a todo to that project, what happens? Current thinking: soft deletes with a "tombstone" period, and orphaned records are surfaced to the developer via a hook rather than silently discarded.

2. **Large binary data (files, images):** Should Kora handle file sync, or delegate to external blob storage? Current thinking: Kora handles metadata sync; large binaries are referenced by content hash and synced through a separate channel (or not synced at all, with the developer providing a blob storage URL).

3. **Real-time collaboration (simultaneous editing):** CRDTs handle this well for text, but what about structured data? If two users drag-and-drop reorder a list simultaneously, how does the merge work? Current thinking: list ordering uses a fractional indexing CRDT that produces a deterministic merged order, but this needs extensive testing.

4. **Access control enforcement offline:** If a user's permissions are revoked while they are offline, they can continue making writes that violate the new permissions. How are these handled on reconnect? Current thinking: the sync server validates permissions on incoming operations and rejects unauthorized ones, with the client rolling back the local state.

5. **Sync server scalability:** How many concurrent connections can a single Kora sync server handle? What is the horizontal scaling story? Current thinking: sync server is stateless (state lives in the backend database), enabling horizontal scaling behind a load balancer. Target: 10,000 concurrent connections per instance.

---

## 13. Competitive Moat

Kora's defensibility comes from four sources:

**1. The Merge Engine.** Three-tier conflict resolution with constraint validation is architecturally novel. No competitor offers declarative constraints on top of CRDT-based auto-merge with custom resolver fallback. This is the deepest technical moat.

**2. DevTools.** Best-in-class debugging tooling for distributed application state. Once developers experience sync timeline, conflict inspector, and network simulator, going back to console.log debugging feels unacceptable. DevTools create switching costs.

**3. Connectivity-aware transport.** Bluetooth LE, SMS gateway, and adaptive bandwidth transport are unique in the space. This makes Kora the only option for developers building for low-connectivity markets. No Western-focused competitor will prioritize this.

**4. Framework-level conventions.** Like Next.js, once the community builds on Kora's conventions (schema definitions, sync scopes, resolver patterns), an ecosystem of plugins, templates, and educational content creates a self-reinforcing adoption loop.

---

## 14. Long-Term Vision

Kora becomes the default data layer for applications that need to work everywhere, including places where "everywhere" means spotty 2G in rural Kenya, crowded networks in Lagos, or a mining operation with satellite-only connectivity.

The long-term state:
- Apps built with Kora work instantly, never lose data, function without internet, and sync seamlessly across devices
- Offline-first becomes the default architecture, not the advanced one
- The 2.7 billion people with unreliable connectivity get the same quality software experience as someone on gigabit fiber in San Francisco

The real product is not sync, storage, or CRDTs. It is making distributed systems complexity invisible to the developer while making every application resilient enough to work for every human on earth.

---

*Kora: independent strings, shared harmony.*