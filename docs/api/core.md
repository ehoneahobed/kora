---
title: Core API
description: "@korajs/core API reference: defineSchema, field type builders, operations, hybrid logical clocks, version vectors, and events."
---

# Core API Reference

`@korajs/core` is the foundation of every Kora.js application. It defines the schema system, operation model, hybrid logical clock, and shared types. It has zero dependencies on other `@kora` packages.

All exports documented here are also available from the `kora` meta-package.

```typescript
import { defineSchema, t, op, migrate, HybridLogicalClock, createOperation, KoraError } from '@korajs/core'
// or
import { defineSchema, t, op, migrate, HybridLogicalClock, createOperation, KoraError } from 'korajs'
```

---

## defineSchema()

Creates a validated schema definition that describes your application's data model. This is the primary entry point for configuring a Kora application.

### Signature

```typescript
function defineSchema(input: SchemaInput): SchemaDefinition
```

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `input` | `SchemaInput` | Schema configuration object |

#### SchemaInput

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `version` | `number` | Yes | Schema version number. Must be a positive integer. Increment when you make changes. |
| `collections` | `Record<string, CollectionDefinition>` | Yes | Map of collection names to their definitions. |
| `relations` | `Record<string, RelationDefinition>` | No | Map of relation names to their definitions. |

#### CollectionDefinition

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `fields` | `Record<string, FieldDescriptor>` | Yes | Map of field names to type descriptors built with `t`. |
| `indexes` | `string[]` | No | Fields to index for faster queries. |
| `constraints` | `Record<string, Constraint>` | No | Tier 2 constraint definitions for conflict resolution. |
| `resolve` | `Record<string, ResolverFn>` | No | Tier 3 custom resolver functions for specific fields. |

#### RelationDefinition

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `from` | `string` | Yes | Source collection name. |
| `to` | `string` | Yes | Target collection name. |
| `type` | `'many-to-one' \| 'one-to-many' \| 'many-to-many'` | Yes | Relationship cardinality. |
| `field` | `string` | Yes | Foreign key field on the source collection. |
| `onDelete` | `'set-null' \| 'cascade' \| 'restrict' \| 'no-action'` | No | Behavior when the referenced record is deleted. Defaults to `'no-action'`. |

### Returns

`SchemaDefinition` -- A validated, frozen schema object used by `createApp` and other Kora internals.

### Example

```typescript
import { defineSchema, t } from 'korajs'

const schema = defineSchema({
  version: 1,

  collections: {
    todos: {
      fields: {
        title: t.string(),
        completed: t.boolean().default(false),
        assignee: t.string().optional(),
        tags: t.array(t.string()).default([]),
        notes: t.richtext(),
        priority: t.enum(['low', 'medium', 'high']).default('medium'),
        dueDate: t.timestamp().optional(),
        createdAt: t.timestamp().auto(),
      },
      indexes: ['assignee', 'completed', 'dueDate'],
    },

    projects: {
      fields: {
        name: t.string(),
        color: t.string().default('#3b82f6'),
        createdAt: t.timestamp().auto(),
      },
    },
  },

  relations: {
    todoBelongsToProject: {
      from: 'todos',
      to: 'projects',
      type: 'many-to-one',
      field: 'projectId',
      onDelete: 'set-null',
    },
  },
})
```

### Errors

- Throws `KoraError` with code `INVALID_SCHEMA` if `version` is not a positive integer.
- Throws `KoraError` with code `INVALID_SCHEMA` if a collection name is empty or contains invalid characters.
- Throws `KoraError` with code `INVALID_SCHEMA` if a relation references a collection that does not exist.
- Throws `KoraError` with code `INVALID_SCHEMA` if a relation references a field that does not exist on the source collection.

---

## t (Type Builders) {#type-builders}

The `t` object provides builder methods for defining field types in your schema. Each method returns a `FieldDescriptor` that can be further configured with modifier methods.

```typescript
import { t } from 'korajs'
```

### t.string()

Defines a text field. Stored as `TEXT` in SQLite.

```typescript
t.string()                    // Required string field
t.string().optional()         // Optional (nullable) string field
t.string().default('hello')   // Defaults to 'hello' on insert
```

### t.number()

Defines a numeric field. Stored as `REAL` in SQLite.

```typescript
t.number()                    // Required number field
t.number().optional()         // Optional (nullable) number field
t.number().default(0)         // Defaults to 0 on insert
```

### t.boolean()

Defines a boolean field. Stored as `INTEGER` (0/1) in SQLite.

```typescript
t.boolean()                   // Required boolean field
t.boolean().default(false)    // Defaults to false on insert
```

### t.enum(values)

Defines a field constrained to a set of string values. Stored as `TEXT` with a `CHECK` constraint in SQLite.

| Parameter | Type | Description |
|-----------|------|-------------|
| `values` | `readonly string[]` | Allowed values for this field. |

```typescript
t.enum(['low', 'medium', 'high'])                // Required enum field
t.enum(['low', 'medium', 'high']).default('medium')  // Defaults to 'medium'
```

### t.timestamp()

Defines a timestamp field. Stored as `INTEGER` (milliseconds since epoch) in SQLite.

```typescript
t.timestamp()                 // Required timestamp field
t.timestamp().optional()      // Optional timestamp field
t.timestamp().auto()          // Automatically set on insert (not user-writable)
```

### t.array(inner)

Defines an array field. Stored as `TEXT` (JSON-serialized) in SQLite. Uses add-wins set semantics during merge -- concurrent additions from different devices are both preserved.

| Parameter | Type | Description |
|-----------|------|-------------|
| `inner` | `FieldDescriptor` | Type descriptor for array elements. |

```typescript
t.array(t.string())           // Array of strings
t.array(t.number()).default([])  // Array of numbers, defaults to empty
```

### t.richtext()

Defines a rich text field backed by a Yjs `Y.Text` CRDT. Stored as `BLOB` (Yjs state vector) in SQLite. Supports character-level collaborative editing with automatic merge.

```typescript
t.richtext()                  // Rich text field
```

Rich text fields cannot use `.default()` or `.optional()` modifiers. They are always initialized as empty `Y.Text` documents.

### Field modifiers

All type builders (except `t.richtext()`) support these chainable modifiers:

| Modifier | Description |
|----------|-------------|
| `.optional()` | Makes the field nullable. Omitted fields default to `null`. |
| `.default(value)` | Sets a default value applied on insert when the field is not provided. |
| `.auto()` | Field is set automatically by Kora (e.g., `createdAt`). Cannot be provided by the developer. Only valid on `t.timestamp()`. |
| `.merge(strategy)` | Declares the merge strategy for this field during conflict resolution. See [Conflict Resolution](/guide/conflict-resolution). Only valid on `t.number()`, `t.string()`, and `t.array()`. |

Modifiers return a new `FieldDescriptor` and can be chained:

```typescript
t.string().optional()           // Valid
t.number().default(0)           // Valid
t.timestamp().auto()            // Valid
t.string().optional().default('n/a')  // Valid -- optional with a default
```

### .merge(strategy)

Declares how this field should be merged when concurrent edits conflict. Overrides the default Tier 1 auto-merge strategy.

| Parameter | Type | Description |
|-----------|------|-------------|
| `strategy` | `FieldMergeStrategy` | The merge strategy to use. |

#### Available strategies

| Strategy | Valid on | Behavior |
|----------|---------|----------|
| `'lww'` | All scalar types | Last-Write-Wins (default for scalars) |
| `'counter'` | `t.number()` | Additive merge: both deltas are applied to the base value |
| `'max'` | `t.number()` | Keeps the highest value across all sides |
| `'min'` | `t.number()` | Keeps the lowest value across all sides |
| `'union'` | `t.array()` | Add-wins set (default for arrays) |
| `'append-only'` | `t.array()` | Append-only: additions are kept, removals are ignored |
| `'server-authoritative'` | All types | Remote/server value always wins |

```typescript
import { defineSchema, t } from 'korajs'

const schema = defineSchema({
  version: 1,
  collections: {
    products: {
      fields: {
        name: t.string(),
        quantity: t.number().merge('counter'),   // additive — both decrements apply
        highScore: t.number().merge('max'),      // keep the highest value
        tags: t.array(t.string()).merge('append-only'), // never lose tags
        status: t.string().merge('server-authoritative'), // server decides
      },
    },
  },
})
```

::: tip
Schema-level merge strategies replace Tier 3 custom resolvers for common patterns like counters, max/min, and append-only lists. Use `.merge()` when a built-in strategy fits; use Tier 3 `resolve` functions for complex domain logic.
:::

---

## HybridLogicalClock

Implements the Hybrid Logical Clock algorithm (Kulkarni et al.) for causal ordering of operations across distributed devices without requiring synchronized clocks.

### Constructor

```typescript
new HybridLogicalClock(nodeId: string)
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `nodeId` | `string` | Unique identifier for this device/node. Typically a UUID v7. |

### Methods

#### .now()

Generates a new timestamp for a local event. Each call returns a strictly greater timestamp than the previous one.

```typescript
now(): HLCTimestamp
```

**Returns:** `HLCTimestamp` -- A new timestamp with the current wall time (or incremented logical counter if wall time has not advanced).

```typescript
const clock = new HybridLogicalClock('node-abc-123')

const ts1 = clock.now()  // { wallTime: 1712188800000, logical: 0, nodeId: 'node-abc-123' }
const ts2 = clock.now()  // { wallTime: 1712188800000, logical: 1, nodeId: 'node-abc-123' }
```

#### .receive(remote)

Updates the local clock after receiving a remote timestamp. Ensures the local clock stays ahead of both its own previous value and the remote value.

```typescript
receive(remote: HLCTimestamp): HLCTimestamp
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `remote` | `HLCTimestamp` | Timestamp received from a remote node. |

**Returns:** `HLCTimestamp` -- The updated local timestamp after merging with the remote clock.

```typescript
const localClock = new HybridLogicalClock('node-a')
const remoteTimestamp: HLCTimestamp = {
  wallTime: 1712188900000,
  logical: 5,
  nodeId: 'node-b'
}

const updated = localClock.receive(remoteTimestamp)
// updated.wallTime >= remoteTimestamp.wallTime
```

#### HybridLogicalClock.compare(a, b) {#hlc-compare}

Static method. Compares two timestamps for total ordering.

```typescript
static compare(a: HLCTimestamp, b: HLCTimestamp): number
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `a` | `HLCTimestamp` | First timestamp. |
| `b` | `HLCTimestamp` | Second timestamp. |

**Returns:** `number`
- Negative if `a` is before `b`
- Positive if `a` is after `b`
- Zero if `a` and `b` are identical (same wallTime, logical, and nodeId)

Comparison order: `wallTime` first, then `logical`, then `nodeId` (lexicographic).

```typescript
const a: HLCTimestamp = { wallTime: 1000, logical: 0, nodeId: 'node-a' }
const b: HLCTimestamp = { wallTime: 1000, logical: 1, nodeId: 'node-b' }

HybridLogicalClock.compare(a, b) // negative (a is before b, because a.logical < b.logical)
```

---

## generateUUIDv7()

Generates a UUID v7 identifier. UUID v7 values are time-sortable and contain a millisecond-precision timestamp, making them suitable for record IDs and node IDs.

### Signature

```typescript
function generateUUIDv7(): string
```

### Returns

`string` -- A new UUID v7 string (e.g., `'0190a6e0-7b3c-7def-8a12-4b5c6d7e8f90'`).

### Example

```typescript
import { generateUUIDv7 } from 'korajs'

const id = generateUUIDv7()
```

---

## createOperation()

Creates a new immutable, content-addressed operation. The operation's `id` is derived from a SHA-256 hash of its contents, ensuring that identical operations always produce the same ID.

### Signature

```typescript
function createOperation(input: OperationInput): Operation
```

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `input` | `OperationInput` | Operation data. See fields below. |

#### OperationInput

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `nodeId` | `string` | Yes | UUID v7 of the originating device. |
| `type` | `'insert' \| 'update' \| 'delete'` | Yes | What kind of mutation this represents. |
| `collection` | `string` | Yes | Target collection name (from schema). |
| `recordId` | `string` | Yes | ID of the affected record. |
| `data` | `Record<string, unknown> \| null` | Yes | Field values. `null` for delete. For updates, only changed fields. |
| `previousData` | `Record<string, unknown> \| null` | No | Previous values of changed fields (enables 3-way merge). `null` for insert/delete. |
| `timestamp` | `HLCTimestamp` | Yes | Hybrid Logical Clock timestamp. |
| `sequenceNumber` | `number` | Yes | Monotonically increasing per node. |
| `causalDeps` | `string[]` | No | Operation IDs this operation depends on. Defaults to `[]`. |
| `schemaVersion` | `number` | Yes | Schema version at time of creation. |

### Returns

`Operation` -- An immutable operation with a computed content-addressed `id`.

### Example

```typescript
import { createOperation, HybridLogicalClock, generateUUIDv7 } from 'korajs'

const nodeId = generateUUIDv7()
const clock = new HybridLogicalClock(nodeId)

const op = createOperation({
  nodeId,
  type: 'insert',
  collection: 'todos',
  recordId: generateUUIDv7(),
  data: { title: 'Ship Kora v1', completed: false },
  timestamp: clock.now(),
  sequenceNumber: 1,
  schemaVersion: 1,
})

console.log(op.id) // SHA-256 content hash
```

::: tip
In typical application code, you never call `createOperation` directly. The `Store` creates operations automatically when you call `insert()`, `update()`, or `delete()` on a collection. This function is exposed for advanced use cases like custom transports or testing.
:::

---

## op (Atomic Field Operations) {#atomic-ops}

The `op` helper creates atomic field operations that are resolved against the current value at write time, rather than setting an absolute value. This prevents lost updates when multiple devices modify the same field concurrently.

```typescript
import { op } from '@korajs/core'
// or
import { op } from 'korajs'
```

### op.increment(amount)

Increments a numeric field by the given amount.

```typescript
await app.products.update(id, { quantity: op.increment(1) })
await app.products.update(id, { quantity: op.increment(-3) }) // decrement by 3
```

### op.decrement(amount)

Decrements a numeric field by the given amount. Equivalent to `op.increment(-amount)`.

```typescript
await app.products.update(id, { quantity: op.decrement(5) })
```

### op.max(value)

Sets the field to the given value only if it is greater than the current value.

```typescript
await app.players.update(id, { highScore: op.max(newScore) })
```

### op.min(value)

Sets the field to the given value only if it is less than the current value.

```typescript
await app.auctions.update(id, { lowestBid: op.min(myBid) })
```

### op.append(item)

Appends an item to an array field.

```typescript
await app.todos.update(id, { tags: op.append('urgent') })
```

### op.remove(item)

Removes an item from an array field by value.

```typescript
await app.todos.update(id, { tags: op.remove('draft') })
```

::: warning
Atomic operations are resolved locally before creating the operation. They do not provide distributed atomicity — concurrent `op.increment(1)` calls from two devices both apply their deltas correctly because the operation stores the resolved value and the previous value, enabling 3-way merge.
:::

---

## buildScopeMap()

Builds a scope map from a schema definition and a set of scope values. Used internally by sync scoping but available for custom scope logic.

### Signature

```typescript
function buildScopeMap(
  schema: SchemaDefinition,
  scopeValues: Record<string, unknown>
): ScopeMap
```

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `schema` | `SchemaDefinition` | The validated schema from `defineSchema()`. |
| `scopeValues` | `Record<string, unknown>` | Flat key-value pairs used to populate scope filters. |

### Returns

`ScopeMap` — A `Record<string, Record<string, unknown>>` mapping collection names to their scope filter objects.

---

## Schema sync rules (partial sync DSL)

Declare which collections sync and which fields filter data using root-level `sync` rules in `defineSchema()`:

```typescript
const schema = defineSchema({
  version: 1,
  collections: {
    todos: {
      fields: {
        title: t.string(),
        userId: t.string(),
        orgId: t.string(),
      },
    },
    auditLog: {
      fields: {
        message: t.string(),
      },
    },
  },
  sync: {
    todos: { where: { userId: true, orgId: true } },
  },
})
```

Each `where` entry binds a **record field** to a **scope value key**:

| Value | Meaning |
|-------|---------|
| `true` | Bind field to a scope value with the same name (`userId` → `scopeValues.userId`) |
| `'otherKey'` | Bind field to a different scope value key (`ownerId: 'userId'`) |

When `schema.sync` is present, only collections listed in `sync` (or with legacy `collection.scope`) participate in sync. Other collections are omitted from the scope map (partial sync).

Use with `buildScopeMap(schema, scopeValues)` or `createKoraAuthSync({ schema })` on the client, and `resolveSessionScopes()` on the server.

---

## extractScopeValuesFromClaims()

Extracts flat scope values from JWT (or auth) claims using the scope field names declared on your schema collections.

### Signature

```typescript
function extractScopeValuesFromClaims(
  schema: SchemaDefinition,
  claims: Record<string, unknown>
): Record<string, unknown>

function collectSchemaScopeFields(schema: SchemaDefinition): string[]
```

### Resolution order

For each scope field declared on any collection:

1. Top-level claim with the same name (e.g. `orgId`)
2. Nested `claims.scope[field]`
3. JWT `sub` → `userId` when `userId` is a scope field

Pass the result to `buildScopeMap()` or use `createKoraAuthSync({ schema })` to apply automatically during sync handshake.

### Example

```typescript
import { extractScopeValuesFromClaims, buildScopeMap } from '@korajs/core'

const scopeValues = extractScopeValuesFromClaims(schema, {
  sub: 'user-abc',
  orgId: 'org-123',
})

const scopeMap = buildScopeMap(schema, scopeValues)
// { todos: { userId: 'user-abc', orgId: 'org-123' }, ... }
```

---

## migrate() / MigrationBuilder {#migrations}

Creates a fluent migration builder for defining schema migration steps programmatically. The builder is immutable — each method returns a new instance.

```typescript
import { migrate, migrationStepsToSQL, t } from '@korajs/core'
```

### migrate()

Returns a new empty `MigrationBuilder`.

```typescript
const migration = migrate()
  .addField('todos', 'priority', t.enum(['low', 'medium', 'high']).default('medium'))
  .removeField('todos', 'legacyFlag')
  .renameField('todos', 'desc', 'description')
  .addIndex('todos', 'priority')
```

### MigrationBuilder methods

| Method | Description |
|--------|-------------|
| `.addField(collection, field, builder)` | Add a new field to a collection. |
| `.removeField(collection, field)` | Remove a field from a collection. |
| `.renameField(collection, from, to)` | Rename a field. |
| `.addIndex(collection, field)` | Add an index on a field. |
| `.removeIndex(collection, field)` | Remove an index. |
| `.backfill(collection, transform)` | Apply a transform function to all existing records. |

### .build()

Returns a `MigrationDefinition` containing the ordered list of steps.

```typescript
const definition = migration.build()
console.log(definition.steps) // Array of MigrationStep objects
```

### migrationStepsToSQL()

Converts migration steps into SQL statements.

```typescript
function migrationStepsToSQL(steps: readonly MigrationStep[]): string[]
```

```typescript
const sql = migrationStepsToSQL(definition.steps)
// ['ALTER TABLE todos ADD COLUMN priority TEXT DEFAULT \'medium\' CHECK(...)']
```

---

## Types

### Operation

The atomic unit of mutation in Kora.js. Every data change produces an `Operation`. Operations are immutable and content-addressed.

```typescript
interface Operation {
  /** SHA-256 hash of content. Content-addressed. */
  id: string

  /** UUID v7 of the originating device. */
  nodeId: string

  /** What happened. */
  type: 'insert' | 'update' | 'delete'

  /** Which collection (from schema). */
  collection: string

  /** ID of the affected record. */
  recordId: string

  /** Field values. null for delete. For updates, only changed fields. */
  data: Record<string, unknown> | null

  /** Previous values of changed fields (enables 3-way merge). null for insert/delete. */
  previousData: Record<string, unknown> | null

  /** Hybrid Logical Clock timestamp. */
  timestamp: HLCTimestamp

  /** Monotonically increasing per node. Used in version vectors. */
  sequenceNumber: number

  /** Operation IDs this operation causally depends on (direct parents in the DAG). */
  causalDeps: string[]

  /** Schema version at time of creation. */
  schemaVersion: number
}
```

### HLCTimestamp

A timestamp produced by the Hybrid Logical Clock. Provides total ordering across distributed devices.

```typescript
interface HLCTimestamp {
  /** Physical wall-clock time in milliseconds since epoch. */
  wallTime: number

  /** Logical counter. Increments when wallTime has not changed since last event. */
  logical: number

  /** Node ID for tie-breaking. Ensures total order even with identical wall + logical. */
  nodeId: string
}
```

### VersionVector

Tracks the latest sequence number seen from each node. Used for delta sync computation.

```typescript
type VersionVector = Map<string, number>  // nodeId -> max sequence number
```

### SchemaDefinition

The validated output of `defineSchema()`. Passed to `createApp()`.

```typescript
interface SchemaDefinition {
  version: number
  collections: Record<string, CollectionDefinition>
  relations: Record<string, RelationDefinition>
}
```

### FieldDescriptor

Describes a single field's type, default value, and modifiers. Produced by the `t` type builders.

```typescript
interface FieldDescriptor {
  type: 'string' | 'number' | 'boolean' | 'enum' | 'timestamp' | 'array' | 'richtext'
  required: boolean
  defaultValue: unknown | undefined
  auto: boolean
  enumValues?: readonly string[]
  inner?: FieldDescriptor   // For array fields
  mergeStrategy?: 'lww' | 'counter' | 'max' | 'min' | 'union' | 'append-only' | 'server-authoritative'
}
```

### MergeTrace

Records the full context of a merge decision. Used by DevTools for conflict inspection.

```typescript
interface MergeTrace {
  /** First concurrent operation. */
  operationA: Operation

  /** Second concurrent operation. */
  operationB: Operation

  /** The field where the conflict occurred. */
  field: string

  /** Which strategy resolved the conflict. */
  strategy: 'lww' | 'crdt-text' | 'add-wins-set' | 'unique-constraint' | 'custom'

  /** Value from operation A. */
  inputA: unknown

  /** Value from operation B. */
  inputB: unknown

  /** Base value (before either operation). null if unavailable. */
  base: unknown | null

  /** The resolved output value. */
  output: unknown

  /** Which tier resolved this conflict. */
  tier: 1 | 2 | 3

  /** Name of the violated constraint, or null if no constraint was involved. */
  constraintViolated: string | null

  /** Time spent resolving in milliseconds. */
  duration: number
}
```

### KoraEvent

Union type of all instrumentation events emitted by the Kora runtime. Consumed by DevTools and custom event handlers.

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
```

::: warning
`operation:applied` is declared in the catalog but is not yet emitted by the store. Do not rely on it firing; subscribe to `operation:created` to observe writes.
:::

---

## KoraError

Base error class for all Kora.js errors. Includes a machine-readable `code` and optional `context` for debugging.

### Constructor

```typescript
new KoraError(message: string, code: string, context?: Record<string, unknown>)
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `message` | `string` | Human-readable error message. |
| `code` | `string` | Machine-readable error code (e.g., `'INVALID_SCHEMA'`, `'MERGE_CONFLICT'`). |
| `context` | `Record<string, unknown>` | Optional. Additional data for debugging. |

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `message` | `string` | Human-readable error message. |
| `code` | `string` | Machine-readable error code. |
| `context` | `Record<string, unknown> \| undefined` | Additional debugging data. |
| `name` | `string` | Always `'KoraError'`. |

### Error codes

| Code | Description |
|------|-------------|
| `INVALID_SCHEMA` | Schema definition is malformed or contains invalid references. |
| `MERGE_CONFLICT` | A merge conflict could not be resolved automatically. |
| `CONSTRAINT_VIOLATION` | A constraint was violated and the `onConflict` strategy failed. |
| `STORAGE_ERROR` | A storage adapter operation failed. |
| `SYNC_ERROR` | A sync protocol error occurred. |
| `CLOCK_DRIFT` | The local clock has drifted more than 5 minutes behind the HLC. |
| `INVALID_OPERATION` | An operation failed validation. |

### Example

```typescript
import { KoraError } from 'korajs'

try {
  await app.todos.insert({ title: 123 }) // wrong type
} catch (err) {
  if (err instanceof KoraError) {
    console.error(err.code)    // 'INVALID_OPERATION'
    console.error(err.context) // { field: 'title', expected: 'string', received: 'number' }
  }
}
```

---

## State Machine Constraints {#state-machine}

State machine constraints enforce valid transitions on enum fields. When a state machine is declared on an enum field, mutations and merges verify that the field only moves along allowed transitions. This prevents invalid state changes such as moving an order directly from `'draft'` to `'shipped'`.

```typescript
import { validateTransition, buildStateMachineConstraints, getTransitionMap } from '@korajs/core'
```

### .transitions() on EnumFieldBuilder

The `.transitions()` method is available on `t.enum()` fields. It accepts a map of source states to allowed target states and returns a new `EnumFieldBuilder` with the transition rules attached.

```typescript
t.enum(['draft', 'pending', 'confirmed', 'cancelled']).transitions({
  draft: ['pending', 'cancelled'],
  pending: ['confirmed', 'cancelled'],
  confirmed: [],
  cancelled: [],
})
```

Both the source and target states in the map must be valid enum values. The method throws a `SchemaValidationError` if any state in the map is not one of the declared enum values.

#### Full schema example

```typescript
import { defineSchema, t } from 'korajs'

const schema = defineSchema({
  version: 1,
  collections: {
    orders: {
      fields: {
        title: t.string(),
        status: t.enum(['draft', 'submitted', 'approved', 'cancelled'])
          .default('draft')
          .transitions({
            draft: ['submitted', 'cancelled'],
            submitted: ['approved', 'cancelled'],
            approved: [],
            cancelled: [],
          }),
      },
    },
  },
})
```

### validateTransition()

Validates whether a transition from one state to another is allowed by a given state machine constraint.

#### Signature

```typescript
function validateTransition(
  constraint: StateMachineConstraint,
  fromValue: unknown,
  toValue: unknown
): TransitionValidationResult
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `constraint` | `StateMachineConstraint` | The state machine constraint defining allowed transitions. |
| `fromValue` | `unknown` | The current state value (before the transition). Coerced to string. |
| `toValue` | `unknown` | The target state value (after the transition). Coerced to string. |

#### Returns

`TransitionValidationResult` -- An object describing whether the transition is valid, along with the source state, target state, field name, collection name, and the full list of allowed targets from the source state.

#### Example

```typescript
import { validateTransition } from '@korajs/core'

const constraint = {
  field: 'status',
  collection: 'orders',
  transitions: {
    draft: ['submitted', 'cancelled'],
    submitted: ['approved'],
    approved: [],
    cancelled: [],
  },
}

const result = validateTransition(constraint, 'draft', 'submitted')
// { valid: true, from: 'draft', to: 'submitted', field: 'status',
//   collection: 'orders', allowedTargets: ['submitted', 'cancelled'] }

const invalid = validateTransition(constraint, 'draft', 'approved')
// { valid: false, from: 'draft', to: 'approved', field: 'status',
//   collection: 'orders', allowedTargets: ['submitted', 'cancelled'] }
```

### buildStateMachineConstraints()

Extracts all state machine constraints from a schema definition. Scans every collection for enum fields that have transition rules declared via the `.transitions()` builder method.

#### Signature

```typescript
function buildStateMachineConstraints(schema: SchemaDefinition): StateMachineConstraint[]
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `schema` | `SchemaDefinition` | The validated schema from `defineSchema()`. |

#### Returns

`StateMachineConstraint[]` -- An array of constraint objects, one per enum field with transitions declared. Returns an empty array if no fields have transitions.

#### Example

```typescript
import { defineSchema, t, buildStateMachineConstraints } from '@korajs/core'

const schema = defineSchema({
  version: 1,
  collections: {
    orders: {
      fields: {
        status: t.enum(['draft', 'submitted']).transitions({
          draft: ['submitted'],
          submitted: [],
        }),
        title: t.string(),
      },
    },
  },
})

const constraints = buildStateMachineConstraints(schema)
// [{ field: 'status', collection: 'orders', transitions: { draft: ['submitted'], submitted: [] } }]
```

### getTransitionMap()

Finds the transition map for a specific field in a specific collection, if one exists.

#### Signature

```typescript
function getTransitionMap(
  schema: SchemaDefinition,
  collection: string,
  field: string
): TransitionMap | null
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `schema` | `SchemaDefinition` | The validated schema from `defineSchema()`. |
| `collection` | `string` | The collection name to search. |
| `field` | `string` | The field name to look up. |

#### Returns

`TransitionMap | null` -- The transition map if the field has transitions declared, or `null` if the collection does not exist, the field does not exist, the field is not an enum, or no transitions are declared.

#### Example

```typescript
const transitions = getTransitionMap(schema, 'orders', 'status')
// { draft: ['submitted'], submitted: [] }

const none = getTransitionMap(schema, 'orders', 'title')
// null (title is a string field, not an enum with transitions)
```

### validateStateMachineDefinition()

Validates a state machine definition against a collection's fields during schema building. Called internally by `defineSchema()` to ensure the state machine is well-formed. You can also call it directly for custom validation logic.

#### Signature

```typescript
function validateStateMachineDefinition(
  collectionName: string,
  sm: { field: string; transitions: Record<string, string[]>; onInvalidTransition: string },
  fields: Record<string, FieldDescriptor>
): void
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `collectionName` | `string` | Name of the collection (for error messages). |
| `sm` | `object` | The state machine input definition with `field`, `transitions`, and `onInvalidTransition`. |
| `fields` | `Record<string, FieldDescriptor>` | The built field descriptors for the collection. |

#### Errors

- Throws `SchemaValidationError` if the referenced field does not exist in the collection.
- Throws `SchemaValidationError` if the referenced field is not an enum.
- Throws `SchemaValidationError` if the enum field has no values defined.
- Throws `SchemaValidationError` if a source or target state in the transition map is not a valid enum value.
- Throws `SchemaValidationError` if `onInvalidTransition` is not `'reject'` or `'last-valid-state'`.

### State machine types

#### StateMachineConstraint

A state machine constraint extracted from the schema. Used by merge and validation to enforce valid state transitions.

```typescript
interface StateMachineConstraint {
  /** The enum field this constraint controls */
  field: string
  /** The collection this constraint applies to */
  collection: string
  /** Map of state to allowed next states */
  transitions: TransitionMap
}
```

#### TransitionMap

Map of state names to allowed next states.

```typescript
type TransitionMap = Record<string, string[]>
```

#### TransitionValidationResult

Result of validating a state transition.

```typescript
interface TransitionValidationResult {
  /** Whether the transition is allowed */
  valid: boolean
  /** The source state */
  from: string
  /** The target state */
  to: string
  /** The field being transitioned */
  field: string
  /** The collection containing the field */
  collection: string
  /** All allowed target states from the source state */
  allowedTargets: string[]
}
```

#### StateMachineDefinition

Defines a state machine on an enum field at the collection level, constraining valid state transitions. Used as the `stateMachine` property in a `CollectionDefinition`.

```typescript
interface StateMachineDefinition {
  /** The enum field this state machine controls */
  field: string
  /** Map of state to allowed next states */
  transitions: Record<string, string[]>
  /** What to do when an invalid transition is attempted */
  onInvalidTransition: 'reject' | 'last-valid-state'
}
```

| `onInvalidTransition` value | Behavior |
|------------------------------|----------|
| `'reject'` | The mutation is rejected and an error is thrown. |
| `'last-valid-state'` | The field retains its previous value instead of transitioning. |

---

## Migration Rollbacks {#migration-rollbacks}

Migration rollbacks allow you to reverse schema migrations, either automatically (when the inverse is deterministic) or via explicit rollback steps. This builds on top of the `migrate()` / `MigrationBuilder` API documented [above](#migrations).

```typescript
import { canAutoRollback, generateRollbackSteps, createReversibleMigration } from '@korajs/core'
```

### canAutoRollback()

Determines whether a single forward migration step can be automatically rolled back without explicit developer-provided down steps.

#### Signature

```typescript
function canAutoRollback(step: MigrationStep): boolean
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `step` | `MigrationStep` | The forward migration step to check. |

#### Returns

`boolean` -- `true` if the step can be auto-rolled back, `false` if it requires an explicit `.down()` definition.

#### Auto-rollback support by step type

| Step type | Auto-rollback | Inverse operation |
|-----------|---------------|-------------------|
| `addField` | Yes | `removeField` (drops the added column) |
| `addIndex` | Yes | `removeIndex` (drops the added index) |
| `removeIndex` | Yes | `addIndex` (re-creates the index) |
| `renameField` | Yes | `renameField` (swaps from/to names) |
| `removeField` | No | Requires the field descriptor to re-create the column. Provide a `FieldBuilder` to `removeField()` or use `.down()`. |
| `backfill` | No | Data transforms are not reversible. Provide a `reverseTransform` on the step or use `.down()`. |

#### Example

```typescript
import { canAutoRollback } from '@korajs/core'

canAutoRollback({ type: 'addField', collection: 'todos', field: 'priority', descriptor: /* ... */ })
// true

canAutoRollback({ type: 'backfill', collection: 'todos', transform: (r) => r })
// false
```

### generateRollbackSteps()

Generates rollback steps for a list of forward migration steps. Steps are reversed in order: the last forward step becomes the first rollback step.

#### Signature

```typescript
function generateRollbackSteps(forwardSteps: readonly MigrationStep[]): MigrationStep[]
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `forwardSteps` | `readonly MigrationStep[]` | The forward migration steps to generate rollbacks for. |

#### Returns

`MigrationStep[]` -- Array of rollback steps in reverse execution order.

#### Errors

Throws `MigrationRollbackError` if any step cannot be auto-rolled back. Use `canAutoRollback()` to check before calling, or provide explicit down steps via the MigrationBuilder `.down()` API instead.

#### Example

```typescript
import { migrate, generateRollbackSteps } from '@korajs/core'

const migration = migrate()
  .addField('todos', 'priority', t.enum(['low', 'medium', 'high']).default('medium'))
  .addIndex('todos', 'priority')

const rollbackSteps = generateRollbackSteps(migration.steps)
// [
//   { type: 'removeIndex', collection: 'todos', field: 'priority' },
//   { type: 'removeField', collection: 'todos', field: 'priority' },
// ]
```

### createReversibleMigration()

Creates a `ReversibleMigration` from forward steps, optional explicit down steps, and version information. If explicit down steps are provided, they are used as-is. Otherwise, auto-generation is attempted via `generateRollbackSteps()`.

#### Signature

```typescript
function createReversibleMigration(
  upSteps: readonly MigrationStep[],
  downSteps: readonly MigrationStep[] | null,
  fromVersion: number,
  toVersion: number
): ReversibleMigration
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `upSteps` | `readonly MigrationStep[]` | The forward migration steps. |
| `downSteps` | `readonly MigrationStep[] \| null` | Optional explicit rollback steps. Pass `null` to auto-generate. |
| `fromVersion` | `number` | The schema version before the migration. |
| `toVersion` | `number` | The schema version after the migration. |

#### Returns

`ReversibleMigration` -- A complete reversible migration with both `up` and `down` steps.

#### Errors

Throws `MigrationRollbackError` if `downSteps` is `null` and auto-generation fails for any step.

#### Example

```typescript
import { migrate, createReversibleMigration, t } from '@korajs/core'

const migration = migrate()
  .addField('todos', 'priority', t.enum(['low', 'medium', 'high']).default('medium'))
  .addIndex('todos', 'priority')

// Auto-generated rollback
const reversible = createReversibleMigration(migration.steps, null, 1, 2)
console.log(reversible.fromVersion) // 1
console.log(reversible.toVersion)   // 2
console.log(reversible.down)
// [
//   { type: 'removeIndex', collection: 'todos', field: 'priority' },
//   { type: 'removeField', collection: 'todos', field: 'priority' },
// ]
```

### MigrationBuilder .down()

The `.down()` method on `MigrationBuilder` lets you define explicit rollback steps. This is required when a migration contains steps that cannot be auto-rolled back (such as `removeField` without a descriptor, or `backfill` without a `reverseTransform`).

#### Signature

```typescript
down(fn: (rollback: RollbackBuilder) => void): MigrationBuilder
```

The `RollbackBuilder` passed to the callback provides the same step methods as `MigrationBuilder`: `addField()`, `removeField()`, `renameField()`, `addIndex()`, `removeIndex()`, and `backfill()`.

#### Example

```typescript
import { migrate, t } from '@korajs/core'

const migration = migrate()
  .removeField('todos', 'legacyFlag')
  .backfill('todos', (record) => ({
    priority: record.urgency === 'high' ? 'high' : 'medium',
  }))
  .down((rollback) => {
    rollback
      .addField('todos', 'legacyFlag', t.boolean().default(false))
      .backfill('todos', (record) => ({
        urgency: record.priority === 'high' ? 'high' : 'normal',
      }))
  })

console.log(migration.safelyReversible) // true
```

### MigrationRollbackError

Error thrown when a migration step cannot be automatically rolled back and no explicit down step has been provided. Extends `KoraError` with code `'MIGRATION_ROLLBACK'`.

```typescript
class MigrationRollbackError extends KoraError {
  constructor(step: MigrationStep)
}
```

The error message includes the step type and collection name, telling you exactly which step needs an explicit `.down()` definition.

### ReversibleMigration

A migration that includes both forward (up) and backward (down) steps, along with version metadata.

```typescript
interface ReversibleMigration {
  readonly up: readonly MigrationStep[]
  readonly down: readonly MigrationStep[]
  readonly fromVersion: number
  readonly toVersion: number
}
```

---

## Protobuf Code Generation {#proto-codegen}

Generates Protocol Buffer definitions from a Kora schema. Useful for producing `.proto` files for external tooling, type-safe binary serialization, or runtime protobufjs usage without parsing `.proto` text.

```typescript
import { generateProtoDefinitions } from '@korajs/core'
```

### generateProtoDefinitions()

Converts a validated schema into Protocol Buffer definitions. Produces three outputs: the `.proto` file text, a type map linking Kora field paths to protobuf types, and a JSON descriptor compatible with protobufjs `Root.fromJSON()`.

#### Signature

```typescript
function generateProtoDefinitions(schema: SchemaDefinition): ProtoOutput
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `schema` | `SchemaDefinition` | A validated schema from `defineSchema()`. |

#### Returns

`ProtoOutput` -- An object containing:

| Field | Type | Description |
|-------|------|-------------|
| `proto` | `string` | The generated `.proto` file content as a string (proto3 syntax). |
| `typeMap` | `Map<string, string>` | Maps Kora field paths (`"collection.field"`) to protobuf type strings. |
| `jsonDescriptor` | `Record<string, unknown>` | JSON descriptor for runtime protobufjs usage via `Root.fromJSON()`. |

#### Generated messages

The output includes the following protobuf messages:

| Message | Description |
|---------|-------------|
| `{Collection}Record` | Per-collection record message (e.g., `TodosRecord` for a `todos` collection). Includes an `id` field and all schema-defined fields. |
| `KoraOperation` | Wire format for individual operations in the sync protocol. |
| `OperationBatch` | Batches operations for sync transfer with an `is_final` flag. |
| `HandshakeMessage` | Initiates a sync session with version vector and schema version. |
| `HandshakeResponse` | Server acknowledges with its own version vector. |
| `Acknowledgment` | Confirms receipt of an operation batch. |

#### Type mapping

Kora field kinds are mapped to protobuf scalar types as follows:

| Kora field kind | Protobuf type |
|-----------------|---------------|
| `string` | `string` |
| `number` | `double` |
| `boolean` | `bool` |
| `timestamp` | `int64` |
| `richtext` | `bytes` |
| `enum` | Generated nested enum (e.g., `TodosRecordPriority`) |
| `array` | `repeated` of the item's scalar type |

Enum fields produce a nested protobuf enum inside the parent message. A sentinel `_UNSPECIFIED = 0` value is always added as the first entry, following proto3 conventions.

Collection names are converted to PascalCase for message names (e.g., `todo_items` becomes `TodoItemsRecord`). Field names are converted to snake_case for protobuf field names (e.g., `dueDate` becomes `due_date`).

#### Example

```typescript
import { defineSchema, t, generateProtoDefinitions } from '@korajs/core'

const schema = defineSchema({
  version: 1,
  collections: {
    todos: {
      fields: {
        title: t.string(),
        completed: t.boolean().default(false),
        priority: t.enum(['low', 'medium', 'high']).default('medium'),
        tags: t.array(t.string()).default([]),
      },
    },
  },
})

const { proto, typeMap, jsonDescriptor } = generateProtoDefinitions(schema)
```

The `proto` string for this schema produces:

```protobuf
syntax = "proto3";

package kora;

// Collection record messages

message TodosRecord {
  string id = 1;
  string title = 2;
  bool completed = 3;
  TodosRecordPriority priority = 4;
  repeated string tags = 5;

  enum TodosRecordPriority {
    TODOSRECORDPRIORITY_UNSPECIFIED = 0;
    TODOSRECORDPRIORITY_LOW = 1;
    TODOSRECORDPRIORITY_MEDIUM = 2;
    TODOSRECORDPRIORITY_HIGH = 3;
  }
}

// Sync protocol messages

message KoraOperation { ... }
message OperationBatch { ... }
message HandshakeMessage { ... }
message HandshakeResponse { ... }
message Acknowledgment { ... }
```

The `typeMap` contains:

```typescript
typeMap.get('todos.id')        // 'string'
typeMap.get('todos.title')     // 'string'
typeMap.get('todos.completed') // 'bool'
typeMap.get('todos.priority')  // 'TodosRecordPriority'
typeMap.get('todos.tags')      // 'repeated string'
```

The `jsonDescriptor` can be loaded directly with protobufjs for runtime encoding and decoding:

```typescript
import protobuf from 'protobufjs'

const root = protobuf.Root.fromJSON(jsonDescriptor)
const TodosRecord = root.lookupType('kora.TodosRecord')
```
