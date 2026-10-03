---
title: Core API
description: "@korajs/core API reference: defineSchema, field builders, atomic ops, operations, the hybrid logical clock, version vectors, the record fold, scopes, migrations, blobs and errors."
---

# Core API Reference

`@korajs/core` is the foundation of every Kora.js application. It defines the schema system, the
operation model, the hybrid logical clock, the per-field merge (the fold) and the shared types. It
depends on no other `@korajs` package. Everything on this page is also exported by the `korajs`
meta-package.

```typescript
import { defineSchema, t, op, migrate, HybridLogicalClock, KoraError } from '@korajs/core'
// The same names are exported by 'korajs'.
```

<!-- docs-check-prelude
import { createApp, defineSchema, t } from 'korajs'
import type { AtomicOp, EncryptedOperationEnvelope, HLCTimestamp, Operation } from '@korajs/core'
const docsSchema = defineSchema({
  version: 1,
  collections: {
    todos: { fields: { title: t.string(), tags: t.array(t.string()).default([]) } },
    products: { fields: { name: t.string(), quantity: t.number().default(0) } },
    players: { fields: { name: t.string(), highScore: t.number().default(0) } },
    auctions: { fields: { title: t.string(), lowestBid: t.number().optional() } },
  },
})
const app = createApp({ schema: docsSchema })
declare const schema: typeof docsSchema
declare const id: string
-->

---

## defineSchema()

Validates a schema and returns it with its exact builder types, so `createApp({ schema })`
produces typed collections without code generation.

<!-- docs-check: skip signature -->
```typescript
function defineSchema<const T extends SchemaInput>(input: T): TypedSchemaDefinition<T>
```

#### SchemaInput

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `version` | `number` | Yes | Positive integer. Increment it with every schema change and add a migration. |
| `collections` | `Record<string, CollectionInput>` | Yes | At least one collection. Names start with a letter and contain letters, digits and underscores. |
| `relations` | `Record<string, RelationInput>` | No | Relations between collections. |
| `migrations` | `Record<number, MigrationBuilder>` | No | Migrations keyed by target version (2 to `version`), built with [`migrate()`](#migrations). |
| `sync` | `Record<string, { where: Record<string, true \| string> }>` | No | [Partial-sync rules](#schema-sync-rules). |

#### CollectionInput

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `fields` | `Record<string, FieldBuilder>` | Yes | At least one field, built with [`t`](#type-builders). |
| `indexes` | `string[]` | No | Fields to index. Each must exist. |
| `constraints` | `ConstraintInput[]` | No | An **array** of unique, capacity or referential constraints. See [Conflict Resolution](/guide/conflict-resolution#constraints). |
| `resolve` | `Record<string, (local, remote, base) => unknown>` | No | Custom resolvers per field (tier 3). |
| `scope` | `string[]` | No | Legacy scope fields for sync filtering; prefer root-level `sync` rules. |
| `stateMachine` | `{ field, transitions, onInvalidTransition: 'reject' \| 'last-valid-state' }` | No | A state machine on an enum field. See [State Machines](/guide/state-machines). |

#### RelationInput

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `from` | `string` | Yes | Source collection. |
| `to` | `string` | Yes | Target collection. |
| `type` | `'one-to-one' \| 'one-to-many' \| 'many-to-one' \| 'many-to-many'` | Yes | Cardinality. |
| `field` | `string` | Yes | Foreign key field. It must be declared in the source collection's `fields`. |
| `onDelete` | `'cascade' \| 'set-null' \| 'restrict' \| 'no-action'` | Yes | What happens to referencing records when the target is deleted, also when a delete races a concurrent reference (see [Conflict Resolution](/guide/conflict-resolution#relations)). |

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
        notes: t.richtext().optional(),
        priority: t.enum(['low', 'medium', 'high']).default('medium'),
        dueDate: t.timestamp().optional(),
        projectId: t.string().optional(),
        createdAt: t.timestamp().auto(),
      },
      indexes: ['assignee', 'completed', 'dueDate'],
    },
    projects: {
      fields: {
        name: t.string(),
        color: t.string().default('#3b82f6'),
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

`defineSchema()` throws `SchemaValidationError` (code `SCHEMA_VALIDATION`) at the call, with the
offending collection or field in `context`, when:

- `version` is not a positive integer, or there is no collection, or a collection has no field
- a collection or field name is invalid
- an index, scope field, resolver, constraint field or `priorityField` names a field that does not exist
- a `priority-field` constraint has no `priorityField`, or a `custom` constraint no `resolve` function
- a relation names a missing collection or a `field` the source collection does not declare
- a migration key is not an integer from 2 to `version`, or a migration has no steps
- a state machine or `.transitions()` map names a value that is not in the enum

---

## t (Field builders) {#type-builders}

Every builder returns an immutable builder; modifiers return a new one. The
[Schema Design guide](/guide/schema-design#field-types) lists each type's storage, value domain and
merge behaviour.

| Builder | Value | Default merge |
|---------|-------|---------------|
| `t.string()` | `string` | last write wins |
| `t.number()` | finite `number` | last write wins |
| `t.boolean()` | `boolean` | last write wins |
| `t.timestamp()` | integer milliseconds (`number`, not a `Date`) | last write wins |
| `t.enum(values)` | one of `values` | last write wins |
| `t.array(item)` | `Item[]` | element set: concurrent additions and removals both apply |
| `t.object({ ... })` | the declared shape | per top-level key |
| `t.json<T>()` | `T` (compile time only) | per top-level key |
| `t.richtext()` | Yjs update bytes on read; a string or Yjs bytes on write | Yjs character merge |
| `t.blob()` | `BlobRef` (see [Blobs](#blobs)) | last write wins |
| `t.secret()` | `string`, encrypted at rest (`.hashed()` for passwords) | last write wins, redacted from traces |

### Modifiers

| Modifier | Description |
|----------|-------------|
| `.optional()` | The field may be omitted on insert. Reads `T \| null`. |
| `.default(value)` | Value used when an insert omits the field. Typed by the field (`t.number().default('x')` is a type error). |
| `.auto()` | The developer cannot set the field. Kora fills `t.timestamp().auto()` with the insert time; on any other kind the field stays empty. |
| `.merge(strategy)` | Overrides the default merge. Strategies are not validated against the kind, so use them where the table below says they apply. |
| `.transitions(map)` | Enum only: allowed state transitions. See [State Machines](/guide/state-machines). |

| `.merge()` strategy | Use on | Behaviour (trace strategy name) |
|---------------------|--------|---------------------------------|
| `'lww'` | any | last write wins (`lww`) |
| `'counter'` | `t.number()` | base value plus every concurrent delta (`schema-counter`) |
| `'max'` / `'min'` | `t.number()`, `t.timestamp()` | extremum of every write (`schema-max`, `schema-min`) |
| `'union'` | `t.array()` | element set, the array default (`lww-element-set`) |
| `'append-only'` | `t.array()` | element set that ignores removals (`schema-append-only`); on other kinds it is last write wins |
| `'server-authoritative'` | any | writes by the sync server beat every device write regardless of time (`schema-server-authoritative`) |

```typescript
import { defineSchema, t } from 'korajs'

const inventory = defineSchema({
  version: 1,
  collections: {
    products: {
      fields: {
        name: t.string(),
        quantity: t.number().merge('counter'),
        highScore: t.number().merge('max'),
        tags: t.array(t.string()).merge('append-only'),
        status: t.string().merge('server-authoritative'),
      },
    },
  },
})
```

### Type inference {#type-inference}

| Field | Record (read) type | `insert()` | `update()` |
|-------|--------------------|------------|------------|
| required | `T` | required | `T` |
| `.optional()` | `T \| null` | may be omitted (`null` is refused: omit the key) | `T \| null` |
| `.default(v)` | `T \| null` | may be omitted | `T \| null` |
| `t.timestamp().auto()` | `number` | cannot be set | cannot be set |
| other `.auto()` | `T \| null` | cannot be set | cannot be set |
| `t.enum([...])` | literal union | | |
| `t.array(item)` | `Item[]` | | also `op.append` / `op.remove` |
| `t.number()` / `t.timestamp()` | `number` | | also `op.increment` / `op.decrement` / `op.max` / `op.min` |
| `t.richtext()` | `Uint8Array` | `string \| Uint8Array \| ArrayBuffer` | same as insert |

Every record also has `id: string`, `createdAt: number` and `updatedAt: number`. A defaulted field
reads as `T | null` because `update(id, { field: null })` can clear it.

```typescript
import type { CollectionInsertOf, CollectionRecordOf } from 'korajs'

type Todo = CollectionRecordOf<typeof app, 'todos'>
type NewTodo = CollectionInsertOf<typeof app, 'todos'>
```

`InferRecord`, `InferInsert` and `InferUpdate` (from `@korajs/core`) do the same from a collection
definition. Queries are typed too: `where()` accepts only the collection's fields (plus `id`,
`createdAt`, `updatedAt`) with values of the field's type or the operators `$eq`, `$ne`, `$gt`,
`$gte`, `$lt`, `$lte`, `$in`; `orderBy()` accepts only those keys; `include()` accepts only declared
relations.

---

## op (Atomic field operations) {#atomic-ops}

`op` values express intent instead of an absolute value, so concurrent changes from several
devices combine instead of overwriting each other.

```typescript
import { op } from 'korajs'

await app.products.update(id, { quantity: op.increment(1) })
await app.products.update(id, { quantity: op.decrement(5) })
await app.players.update(id, { highScore: op.max(1200) })
await app.auctions.update(id, { lowestBid: op.min(40) })
await app.todos.update(id, { tags: op.append('urgent') })
await app.todos.update(id, { tags: op.remove('draft') })
```

| Helper | Field | Effect |
|--------|-------|--------|
| `op.increment(n)` / `op.decrement(n)` | number | adds (subtracts) `n` |
| `op.max(n)` / `op.min(n)` | number, timestamp | keeps the larger (smaller) value |
| `op.append(item)` | array | adds one occurrence of `item` |
| `op.remove(item)` | array | removes one occurrence of `item` |

The operation stores the resolved value and the intent (`atomicOps`). In the merge, concurrent
increments of the same field sum and concurrent `max`/`min` keep the extremum; a plain write in
between takes over. Declare `.merge('counter')` (or `'max'`/`'min'`) when **every** write of a field
should combine this way, including plain `update(id, { quantity: 7 })` writes.

---

## HybridLogicalClock

The clock that orders every operation (Kulkarni et al.). You rarely need it directly: the store
creates operations with its own clock.

<!-- docs-check: skip signature -->
```typescript
new HybridLogicalClock(
  nodeId: string,
  timeSource?: TimeSource,                  // { now(): number }, default Date
  onDriftWarning?: (driftMs: number) => void,
  onDriftError?: (driftMs: number) => void,
)
```

| Member | Description |
|--------|-------------|
| `now(): HLCTimestamp` | A timestamp strictly greater than every earlier one from this clock. Never throws: when the physical clock moves backwards, the wall time freezes and the logical counter advances; drift over 60 s calls `onDriftWarning`, over 5 minutes `onDriftError`. |
| `receive(remote): HLCTimestamp` | Merges a remote timestamp. Throws `InvalidTimestampError` (`INVALID_TIMESTAMP_FIELDS`) for non-integer or negative fields or `logical > MAX_LOGICAL`, and `RemoteClockDriftError` (`REMOTE_CLOCK_DRIFT`) for a timestamp more than 5 minutes ahead of reference-corrected time, before changing any state. |
| `setReferenceOffset(ms)` | Records the server-minus-local offset learned at the handshake, so drift and remote validation use corrected time. |
| `advanceTo(ts)` | Moves the clock forward to at least `ts` (never backwards). |
| `static compare(a, b)` | Total order: `wallTime`, then `logical`, then `nodeId`. |
| `static serialize(ts)` / `static deserialize(s)` | Lexicographically sortable string form. |

`MAX_LOGICAL` is 99 999; an increment beyond it carries into the wall time (1 ms), so the counter
never overflows.

```typescript
import { HybridLogicalClock, type HLCTimestamp } from 'korajs'

const clock = new HybridLogicalClock('node-a')
const first = clock.now()
const remote: HLCTimestamp = { wallTime: first.wallTime + 10, logical: 5, nodeId: 'node-b' }
const merged = clock.receive(remote)
HybridLogicalClock.compare(merged, remote) // > 0
```

The sync engine measures clock skew at every handshake: a device whose clock is far ahead is told
so (`sync:clock-skew`) and its unsynced writes are re-stamped (`sync:clock-rebase`). See
[Clock integrity](/guide/clock-integrity).

---

## generateUUIDv7()

<!-- docs-check: skip signature -->
```typescript
function generateUUIDv7(): string
function isValidUUIDv7(value: string): boolean
function extractTimestamp(uuid: string): number
```

Time-sortable identifiers for record ids and node ids.

---

## Operations

Every mutation produces one immutable, content-addressed `Operation`.

```typescript
interface Operation {
  id: string                        // SHA-256 content hash (see hashVersion)
  nodeId: string                    // the writing device
  type: 'insert' | 'update' | 'delete'
  collection: string
  recordId: string
  data: Record<string, unknown> | null          // null for delete; changed fields for update
  previousData: Record<string, unknown> | null  // update: previous values of the changed fields
  timestamp: HLCTimestamp
  sequenceNumber: number            // per node, gap-free
  causalDeps: string[]
  schemaVersion: number
  atomicOps?: Record<string, AtomicOp>
  transactionId?: string            // not hashed
  mutationName?: string             // not hashed
  hashVersion?: 1 | 2               // absent = 1
  fieldVersions?: Record<string, HLCTimestamp>  // server scope-entry inserts only
  foldState?: string                // server scope-entry inserts only
  encrypted?: EncryptedOperationEnvelope        // end-to-end encrypted operations
}
```

- **Content hash.** Version 2 (every new operation) hashes `type`, `collection`, `recordId`,
  `data`, `previousData`, `timestamp`, `nodeId`, `sequenceNumber`, `causalDeps`, `schemaVersion`
  and `atomicOps`. Version 1 (operations written by Kora 1.0.0-beta.12 and earlier) leaves out
  `previousData`, `sequenceNumber`, `causalDeps` and `schemaVersion`. `verifyOperationId(op)`
  recomputes it; receivers refuse an operation whose id does not match.
- **Canonical values.** `createOperation` canonicalizes `data` once (sorted keys, the value
  domain of the schema), and the id covers exactly what is stored and sent.

<!-- docs-check: skip signature -->
```typescript
function createOperation(
  input: OperationInput,
  clock: HybridLogicalClock,
  options?: { hashVersion?: 1 | 2 },  // default 2
): Promise<Operation>
```

`OperationInput` is `Operation` without `id`, `timestamp` and the server-only fields. Application
code never calls it: collections create operations on `insert()`, `update()` and `delete()`. Use it
for custom transports and tests.

| Helper | Description |
|--------|-------------|
| `verifyOperationId(op)` | `Promise<boolean>`: the id matches the content for its `hashVersion`. |
| `isValidOperation(value)` | Structural type guard. |
| `computeOperationId(body, version)` | The content hash. |

---

## The record fold {#fold}

Every replica (device, server, restored backup) computes a record from its operations with one
deterministic per-field CRDT: the **fold**. The result depends only on the set of operations, not
on their order, duplicates or batching. The [Conflict Resolution guide](/guide/conflict-resolution)
describes the semantics per field type; these functions expose it for tools and tests.

| Function | Description |
|----------|-------------|
| `foldRecord(ops, schema, options?)` | Folds a record's operations from scratch (any order). Returns `{ state, traces }`. |
| `mergeOp(state, op, schema, options?)` | Merges one operation into a state (a join). Returns `{ state, traces, changed }`. |
| `materialize(state, { richtext? })` | The record's field values, or `null` when it does not exist or is deleted. |
| `joinStates(a, b, schema)` | Joins two replicas' states of one record. |
| `serializeFoldState` / `deserializeFoldState` | Stable serialized form. |
| `toMergeTrace(trace)` | Converts a fold trace to the DevTools `MergeTrace`. |

`FoldOptions`: `exclude` (operation ids or a predicate to leave out), `richtext`
(`mergeYjsUpdates` from `@korajs/store`, needed to materialize concurrent rich-text edits),
`traces` (`'none' | 'conflicts' | 'all'`), `authoritativeNodeIds` and
`revokedAuthoritativeNodeIds` (server authority for `merge('server-authoritative')`).

```typescript
import { foldRecord, materialize } from '@korajs/core'
import type { Operation } from '@korajs/core'

declare const operations: Operation[]
const { state } = foldRecord(operations, schema)
const record = state ? materialize(state) : null
```

---

## Version vectors

`VersionVector` is `Map<nodeId, highest sequence number>`. The client uses it for its uploads and
deduplication; downloads are resumed from the server's delivery sequence instead (see
[Sync Protocol](/guide/sync-protocol)).

| Function | Description |
|----------|-------------|
| `createVersionVector()` | Empty vector. |
| `mergeVectors(a, b)` | Per-node maximum. |
| `advanceVector(v, nodeId, seq)` | Copy with `nodeId` raised to at least `seq`. |
| `dominates(a, b)` / `vectorsEqual(a, b)` | Comparison. |
| `computeDelta(local, remote, log)` | `Promise<Operation[]>`: operations `local` has and `remote` lacks, in causal order. `log` implements `getRange(nodeId, fromSeq, toSeq)`. |
| `serializeVector(v)` / `deserializeVector(s)` | Sorted JSON form. |

---

## Scopes {#schema-sync-rules}

Root-level `sync` rules declare which collections sync and which fields filter them:

```typescript
const scoped = defineSchema({
  version: 1,
  collections: {
    todos: { fields: { title: t.string(), userId: t.string(), orgId: t.string() } },
    auditLog: { fields: { message: t.string() } },
  },
  sync: {
    todos: { where: { userId: true, orgId: true } },
  },
})
```

`true` binds the field to the scope value of the same name; a string binds it to another key
(`ownerId: 'userId'`). With `sync` present, only the listed collections (plus collections with a
legacy `scope`) sync.

What a session may sync is decided **on the server** from its verified identity (see
[Authentication](/guide/authentication#sync-scopes)). The client helpers below only build hints that
can narrow it:

| Function | Description |
|----------|-------------|
| `buildScopeMap(schema, scopeValues)` | Per-collection filters from flat scope values. |
| `extractScopeValuesFromClaims(schema, claims)` | Scope values from (unverified) token claims: a top-level claim, then `claims.scope[key]`, then `sub` for `userId`. |
| `collectSchemaScopeValueKeys(schema)` | Every scope value key the schema uses (`collectSchemaScopeFields` is a deprecated alias). |
| `claimScopes(values, explicit?)` | Server side: a scope grant from verified values (used by auth providers and `resolveScopes`). |

---

## migrate() {#migrations}

`migrate()` returns an immutable `MigrationBuilder`; pass it under `migrations` in `defineSchema()`
keyed by the target version. See the [Schema Design guide](/guide/schema-design#migrations) for how
migrations run (one transaction per version, typed backfills that sync).

```typescript
import { defineSchema, migrate, t } from 'korajs'

const v2 = defineSchema({
  version: 2,
  collections: {
    todos: {
      fields: {
        title: t.string(),
        urgent: t.boolean().default(false),
        priority: t.enum(['low', 'medium', 'high']).default('medium'),
      },
    },
  },
  migrations: {
    2: migrate()
      .addField('todos', 'priority', t.enum(['low', 'medium', 'high']).default('medium'))
      .addIndex('todos', 'priority')
      .backfill('todos', (record) => ({ priority: record.urgent ? 'high' : 'medium' })),
  },
})
```

| Method | Description |
|--------|-------------|
| `.addField(collection, field, builder)` | Adds a column. |
| `.removeField(collection, field, builder?)` | Drops a column; pass the old builder to make it reversible. |
| `.renameField(collection, from, to)` | Renames a column. |
| `.addIndex(collection, field)` / `.removeIndex(collection, field)` | Index changes. |
| `.backfill(collection, transform, reverseOrOptions?)` | Rewrites live records. Changes are written as updates named `migration:v<N>` that sync; `{ localOnly: true }` rewrites rows on this device only. The third argument is a reverse transform or `{ reverseTransform?, localOnly? }`. |
| `.down(fn)` | Explicit rollback steps through a `RollbackBuilder` with the same methods. |
| `.steps` | The ordered `MigrationStep[]`. |
| `.safelyReversible` | `false` when a `backfill` has no reverse or a `removeField` has no builder, unless `.down()` was given. |

### Rollbacks and SQL

| Function | Description |
|----------|-------------|
| `canAutoRollback(step)` | `true` for `addField`, `addIndex`, `removeIndex` and `renameField`; `false` for `removeField` and `backfill` (which `generateRollbackSteps` can still invert when they carry a descriptor or a reverse transform). |
| `generateRollbackSteps(steps)` | Inverse steps in reverse order: `removeField` with a descriptor becomes `addField`, `backfill` with a `reverseTransform` runs it. Throws `MigrationRollbackError` (`MIGRATION_ROLLBACK`) for a step without an inverse. |
| `createReversibleMigration(up, down \| null, from, to)` | `{ up, down, fromVersion, toVersion }`; `null` generates `down`. |
| `migrationStepsToSQL(steps)` / `rollbackStepsToSQL(steps)` | SQL for the structural steps. |

```typescript
import { createReversibleMigration, generateRollbackSteps, migrate, t } from '@korajs/core'

const migration = migrate()
  .addField('todos', 'priority', t.enum(['low', 'medium', 'high']).default('medium'))
  .addIndex('todos', 'priority')

const down = generateRollbackSteps(migration.steps) // removeIndex, then removeField
const reversible = createReversibleMigration(migration.steps, null, 1, 2)
```

### Older clients: operation transforms

`OperationTransform` (`{ fromVersion, toVersion, transform(op) }`) and `operationSchemaView` let a
server and newer clients read operations written under an older schema version without rewriting
them. See [Schema Design](/guide/schema-design#devices-on-older-versions-transforms-at-fold-time).

---

## State machines {#state-machine}

`t.enum(values).transitions(map)` (or a collection's `stateMachine`) restricts which transitions a
local write may make. Transitions are validated on the writing device; concurrent writes from two
devices merge by last write wins. See [State Machines](/guide/state-machines).

| Function | Description |
|----------|-------------|
| `validateTransition(constraint, from, to)` | `{ valid, from, to, field, collection, allowedTargets }`. |
| `buildStateMachineConstraints(schema)` | One `{ field, collection, transitions }` per enum field with transitions. |
| `getTransitionMap(schema, collection, field)` | The field's map, or `null`. |

```typescript
import { validateTransition } from '@korajs/core'

const result = validateTransition(
  { field: 'status', collection: 'orders', transitions: { draft: ['submitted'], submitted: [] } },
  'draft',
  'submitted',
)
result.valid // true
```

---

## quoteIdent()

<!-- docs-check: skip signature -->
```typescript
function quoteIdent(name: string): string
```

Wraps a SQL identifier in double quotes and doubles embedded quotes, so camelCase names and SQL
keywords (`order`) are safe in generated DDL on SQLite and Postgres. `quoteIdent('order')` returns
`"order"`.

---

## Blobs

A `t.blob()` field stores a small content-addressed `BlobRef`; the bytes live in a blob store and
are transferred out of band, once per content hash.

<!-- docs-check: skip signature -->
```typescript
function hashBlob(bytes: Uint8Array): Promise<string>    // hex SHA-256
function createBlobRef(bytes: Uint8Array, metadata?: { mimeType?: string; filename?: string }): Promise<BlobRef>
function isBlobRef(value: unknown): value is BlobRef      // shape check only

interface BlobRef {
  hash: string          // hex SHA-256 of the bytes
  size: number
  mimeType?: string
  filename?: string
  manifestHash?: string // chunk index, when stored for transfer
}
```

---

## Events and merge traces

`KoraEvent` is the union of every instrumentation event (`app.events.on(type, listener)`); the
[DevTools reference](/api/devtools#events) lists each event, its payload and when it fires.
`MergeTrace` describes one merge decision:

```typescript
interface MergeTrace {
  operationA: Operation
  operationB: Operation
  field: string          // '*' for a record-level decision (delete versus update)
  strategy: string       // 'lww', 'lww-element-set', 'object-key-lww', 'crdt-text', 'schema-counter', 'custom', ...
  inputA: unknown
  inputB: unknown
  base: unknown | null
  output: unknown
  tier: 1 | 2 | 3
  constraintViolated: string | null
  duration: number
}
```

---

## Errors

Every Kora error extends `KoraError` with a machine-readable `code` and a `context` object.

<!-- docs-check: skip signature -->
```typescript
class KoraError extends Error {
  constructor(message: string, code: string, context?: Record<string, unknown>)
  readonly code: string
  readonly context?: Record<string, unknown>
}
```

Core error classes: `SchemaValidationError` (`SCHEMA_VALIDATION`), `OperationError`
(`OPERATION_ERROR`), `OperationTooLargeError` (`OPERATION_TOO_LARGE`), `MergeConflictError`
(`MERGE_CONFLICT`), `SyncError` (`SYNC_ERROR`), `StorageError` (`STORAGE_ERROR`), `AppNotReadyError`
(`APP_NOT_READY`), `ClockDriftError` (`CLOCK_DRIFT`), `RemoteClockDriftError` (`REMOTE_CLOCK_DRIFT`),
`InvalidTimestampError` (`INVALID_TIMESTAMP_FIELDS`). `getKoraErrorFix(code)` returns a short fix
hint for common codes. The [Error Codes reference](/api/errors) lists every code of every package
with its cause and fix.

```typescript
import { KoraError } from 'korajs'

try {
  // @ts-expect-error a number is not a valid title
  await app.todos.insert({ title: 123 })
} catch (err) {
  if (err instanceof KoraError) {
    err.code // 'SCHEMA_VALIDATION'
    err.context // { collection: 'todos', field: 'title', expectedType: 'string', receivedType: 'number' }
  }
}
```

---

## generateProtoDefinitions()

<!-- docs-check: skip signature -->
```typescript
function generateProtoDefinitions(schema: SchemaDefinition): {
  proto: string                          // proto3 text
  typeMap: Map<string, string>           // 'collection.field' -> protobuf type
  jsonDescriptor: Record<string, unknown> // for protobufjs Root.fromJSON()
}
```

Generates a `.proto` file for external tooling: one `<Collection>Record` message per collection
(PascalCase name, snake_case fields, an `id` field first, enums as nested enums with an
`_UNSPECIFIED = 0` entry; `string`, `double`, `bool`, `int64`, `bytes`, `repeated`) plus simplified
`KoraOperation`, `OperationBatch`, `HandshakeMessage`, `HandshakeResponse` and `Acknowledgment`
messages. These sync messages are illustrative and are **not** the sync wire format: Kora syncs with
JSON over protocol v2 (see [Sync Protocol](/guide/sync-protocol#wire-format)).
