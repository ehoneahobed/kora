# Core API Reference

`@kora/core` is the foundation of every Kora.js application. It defines the schema system, operation model, hybrid logical clock, and shared types. It has zero dependencies on other `@kora` packages.

All exports documented here are also available from the `kora` meta-package.

```typescript
import { defineSchema, t, HybridLogicalClock, createOperation, KoraError } from '@kora/core'
// or
import { defineSchema, t, HybridLogicalClock, createOperation, KoraError } from 'kora'
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
import { defineSchema, t } from 'kora'

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
import { t } from 'kora'
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

Modifiers return a new `FieldDescriptor` and can be chained:

```typescript
t.string().optional()           // Valid
t.number().default(0)           // Valid
t.timestamp().auto()            // Valid
t.string().optional().default('n/a')  // Valid -- optional with a default
```

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
import { generateUUIDv7 } from 'kora'

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
import { createOperation, HybridLogicalClock, generateUUIDv7 } from 'kora'

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
import { KoraError } from 'kora'

try {
  await app.todos.insert({ title: 123 }) // wrong type
} catch (err) {
  if (err instanceof KoraError) {
    console.error(err.code)    // 'INVALID_OPERATION'
    console.error(err.context) // { field: 'title', expected: 'string', received: 'number' }
  }
}
```
