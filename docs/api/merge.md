# Merge API Reference

`@korajs/merge` implements the three-tier conflict resolution engine for Kora.js. It determines what happens when concurrent operations from different devices modify the same data.

- **Tier 1** -- Auto-merge per field kind (LWW, add-wins set, CRDT)
- **Tier 3** -- Custom resolvers override Tier 1 for specific fields
- **Tier 2** -- Constraint validation against the candidate merged state

Tier 3 runs before Tier 2 so that constraints validate the final merged state including any custom resolver outputs.

## Imports

```typescript
import {
  MergeEngine,
  lastWriteWins,
  addWinsSet,
  mergeRichtext,
  richtextToString,
  stringToRichtextUpdate,
  mergeField,
  checkConstraints,
  resolveConstraintViolation,
} from '@korajs/merge'

import type {
  MergeInput,
  MergeResult,
  FieldMergeResult,
  ConstraintContext,
  ConstraintViolation,
  ConstraintResolution,
  LWWResult,
} from '@korajs/merge'
```

---

## MergeEngine

The main entry point for resolving concurrent operations. Orchestrates all three merge tiers.

### Constructor

```typescript
new MergeEngine()
```

Takes no parameters.

### Methods

#### .merge(input, constraintContext?)

Merges two concurrent operations using all three tiers. This is the primary method for full conflict resolution.

```typescript
async merge(input: MergeInput, constraintContext?: ConstraintContext): Promise<MergeResult>
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `input` | `MergeInput` | Yes | The two operations, base state, and collection definition. |
| `constraintContext` | `ConstraintContext` | No | Pluggable DB lookup interface for Tier 2 constraint checking. If omitted, Tier 2 is skipped. |

**Returns:** `Promise<MergeResult>` -- The merged data, traces for DevTools, and which operation dominated.

**Flow:**

1. If both operations are deletes, returns empty merged data (both agree).
2. If one operation is a delete, applies record-level LWW (later timestamp wins).
3. Otherwise, runs field-level merge (Tier 1 + Tier 3) via `mergeFields()`.
4. If `constraintContext` is provided and the collection has constraints, runs Tier 2 constraint checking and resolves any violations.

```typescript
const engine = new MergeEngine()

const result = await engine.merge({
  local: localOp,
  remote: remoteOp,
  baseState: { title: 'Buy groceries', completed: false },
  collectionDef: schema.collections.todos,
})

console.log(result.mergedData)       // { title: 'Buy groceries', completed: true }
console.log(result.appliedOperation) // 'local' | 'remote' | 'merged'
console.log(result.traces)          // MergeTrace[] for DevTools
```

#### .mergeFields(input)

Synchronous field-level merge using Tier 1 and Tier 3 only. Skips Tier 2 constraint checking entirely. Useful when constraint context is unavailable or not needed.

```typescript
mergeFields(input: MergeInput): MergeResult
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `input` | `MergeInput` | Yes | The two operations, base state, and collection definition. |

**Returns:** `MergeResult` -- The merged data and traces. Note this is synchronous (no `Promise`).

```typescript
const engine = new MergeEngine()

const result = engine.mergeFields({
  local: localOp,
  remote: remoteOp,
  baseState: { title: 'Old title', tags: ['work'] },
  collectionDef: schema.collections.todos,
})
```

---

## Merge Strategies

Low-level merge functions used by the engine. These are also exported for direct use in custom resolvers or testing.

### lastWriteWins(localValue, remoteValue, localTimestamp, remoteTimestamp)

Last-Write-Wins merge strategy using HLC timestamps. The value with the later timestamp wins. The HLC total order guarantees a deterministic winner even when wall-clock times and logical counters are identical (nodeId tiebreaker).

Used by default for `string`, `number`, `boolean`, `enum`, and `timestamp` fields.

```typescript
function lastWriteWins(
  localValue: unknown,
  remoteValue: unknown,
  localTimestamp: HLCTimestamp,
  remoteTimestamp: HLCTimestamp,
): LWWResult
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `localValue` | `unknown` | The local field value. |
| `remoteValue` | `unknown` | The remote field value. |
| `localTimestamp` | `HLCTimestamp` | HLC timestamp of the local operation. |
| `remoteTimestamp` | `HLCTimestamp` | HLC timestamp of the remote operation. |

**Returns:** `LWWResult`

```typescript
import { lastWriteWins } from '@korajs/merge'

const result = lastWriteWins('local title', 'remote title', localTs, remoteTs)
console.log(result.value)  // The winning value
console.log(result.winner) // 'local' or 'remote'
```

### addWinsSet(localArray, remoteArray, baseArray)

Add-wins set merge strategy for array fields. Preserves all additions from both sides. An element is only removed from the result if both sides independently removed it.

```
Algorithm:
  added_local  = local - base
  added_remote = remote - base
  removed_local  = base - local
  removed_remote = base - remote
  result = (base U added_local U added_remote) - (removed_local intersection removed_remote)
```

Element ordering: base elements first (preserving original order), then local additions, then remote additions. Uses `JSON.stringify` for element comparison.

```typescript
function addWinsSet(
  localArray: unknown[],
  remoteArray: unknown[],
  baseArray: unknown[],
): unknown[]
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `localArray` | `unknown[]` | The local array after local modifications. |
| `remoteArray` | `unknown[]` | The remote array after remote modifications. |
| `baseArray` | `unknown[]` | The array state before either modification. |

**Returns:** `unknown[]` -- The merged array.

```typescript
import { addWinsSet } from '@korajs/merge'

const base   = ['a', 'b', 'c']
const local  = ['a', 'b', 'c', 'd']  // added 'd'
const remote = ['a', 'c', 'e']        // removed 'b', added 'e'

const merged = addWinsSet(local, remote, base)
// ['a', 'b', 'c', 'd', 'e']
// 'b' is kept because only one side removed it (add-wins)
// 'd' and 'e' are both preserved
```

### mergeRichtext(localValue, remoteValue, baseValue)

Merges rich text values using Yjs CRDT document updates. Supports character-level collaborative editing with automatic merge. Used by default for `richtext` fields.

```typescript
function mergeRichtext(
  localValue: RichtextValue,
  remoteValue: RichtextValue,
  baseValue: RichtextValue,
): Uint8Array
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `localValue` | `RichtextValue` | The local rich text state. |
| `remoteValue` | `RichtextValue` | The remote rich text state. |
| `baseValue` | `RichtextValue` | The base rich text state before either modification. |

`RichtextValue` is `string | Uint8Array | ArrayBuffer | null | undefined`.

**Returns:** `Uint8Array` -- The merged Yjs state update.

```typescript
import { mergeRichtext, richtextToString } from '@korajs/merge'

const merged = mergeRichtext(localUpdate, remoteUpdate, baseUpdate)
const text = richtextToString(merged) // plain text representation
```

### richtextToString(value)

Converts a Yjs rich text state update to a plain text string.

```typescript
function richtextToString(value: RichtextValue): string
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `value` | `RichtextValue` | A Yjs state update, plain string, or null/undefined. |

**Returns:** `string` -- The plain text content.

### stringToRichtextUpdate(value)

Converts a plain string to a Yjs state update. Useful for initializing rich text fields from plain text.

```typescript
function stringToRichtextUpdate(value: string): Uint8Array
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `value` | `string` | Plain text to convert. |

**Returns:** `Uint8Array` -- A Yjs state update containing the text.

---

## Field Merger

### mergeField(fieldName, localOp, remoteOp, baseState, fieldDescriptor, resolver?)

Merges a single field from two concurrent operations. Dispatches to the appropriate strategy based on field kind, or uses a custom resolver (Tier 3) if provided. Handles non-conflict cases where only one side modified the field.

```typescript
function mergeField(
  fieldName: string,
  localOp: Operation,
  remoteOp: Operation,
  baseState: Record<string, unknown>,
  fieldDescriptor: FieldDescriptor,
  resolver?: CustomResolver,
): FieldMergeResult
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `fieldName` | `string` | Yes | Name of the field being merged. |
| `localOp` | `Operation` | Yes | The local operation. |
| `remoteOp` | `Operation` | Yes | The remote operation. |
| `baseState` | `Record<string, unknown>` | Yes | Full record state before either operation. |
| `fieldDescriptor` | `FieldDescriptor` | Yes | Schema descriptor for this field (from `@korajs/core`). |
| `resolver` | `CustomResolver` | No | Tier 3 custom resolver function. Signature: `(local, remote, base) => resolved`. |

**Returns:** `FieldMergeResult` -- The resolved value and a trace for DevTools.

**Strategy dispatch by field kind:**

| Field Kind | Strategy | Description |
|------------|----------|-------------|
| `string` | LWW | Last-Write-Wins via HLC timestamp |
| `number` | LWW | Last-Write-Wins via HLC timestamp |
| `boolean` | LWW | Last-Write-Wins via HLC timestamp |
| `enum` | LWW | Last-Write-Wins via HLC timestamp |
| `timestamp` | LWW | Last-Write-Wins via HLC timestamp |
| `array` | add-wins set | Union of additions, only mutual removals |
| `richtext` | Yjs CRDT | Character-level merge via Yjs Y.Text |

---

## Constraint Checking

### checkConstraints(mergedRecord, recordId, collection, collectionDef, constraintContext)

Checks all constraints on a collection against a candidate merged record. Called after Tier 1 + Tier 3 merge produces a candidate state. Returns an array of violated constraints for Tier 2 resolution.

```typescript
async function checkConstraints(
  mergedRecord: Record<string, unknown>,
  recordId: string,
  collection: string,
  collectionDef: CollectionDefinition,
  constraintContext: ConstraintContext,
): Promise<ConstraintViolation[]>
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `mergedRecord` | `Record<string, unknown>` | The candidate record state after field-level merge. |
| `recordId` | `string` | ID of the record being merged. |
| `collection` | `string` | Name of the collection. |
| `collectionDef` | `CollectionDefinition` | Schema definition for the collection (from `@korajs/core`). |
| `constraintContext` | `ConstraintContext` | Pluggable DB lookup interface. |

**Returns:** `Promise<ConstraintViolation[]>` -- Array of violated constraints. Empty if all constraints pass.

**Supported constraint types:**

| Type | Description |
|------|-------------|
| `unique` | No two records may have the same value(s) for the constrained fields. |
| `capacity` | Limits the number of records in a group defined by the constrained fields. |
| `referential` | Foreign key must reference an existing record in another collection. |

```typescript
import { checkConstraints } from '@korajs/merge'

const violations = await checkConstraints(
  candidateRecord,
  recordId,
  'todos',
  schema.collections.todos,
  {
    queryRecords: async (coll, where) => store.query(coll, where),
    countRecords: async (coll, where) => store.count(coll, where),
  },
)

if (violations.length > 0) {
  // Handle violations with resolveConstraintViolation
}
```

### resolveConstraintViolation(violation, mergedRecord, localOp, remoteOp, baseState)

Resolves a constraint violation by applying the constraint's `onConflict` strategy. Returns the updated record and a merge trace for DevTools.

```typescript
function resolveConstraintViolation(
  violation: ConstraintViolation,
  mergedRecord: Record<string, unknown>,
  localOp: Operation,
  remoteOp: Operation,
  baseState: Record<string, unknown>,
): ConstraintResolution
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `violation` | `ConstraintViolation` | The constraint violation to resolve. |
| `mergedRecord` | `Record<string, unknown>` | The current candidate record state. |
| `localOp` | `Operation` | The local operation. |
| `remoteOp` | `Operation` | The remote operation. |
| `baseState` | `Record<string, unknown>` | The record state before either operation. |

**Returns:** `ConstraintResolution` -- The resolved record and a trace.

**Resolution strategies (set via `constraint.onConflict`):**

| Strategy | Description |
|----------|-------------|
| `last-write-wins` | The operation with the later HLC timestamp wins for the violated fields. |
| `first-write-wins` | The operation with the earlier HLC timestamp wins for the violated fields. |
| `priority-field` | Compares a designated priority field to determine the winner. Falls back to LWW if `priorityField` is not set. |
| `server-decides` | Marks the record with `_pendingServerResolution: true` for deferred server-side resolution. |
| `custom` | Calls the constraint's `resolve(local, remote, base)` function for each violated field. Falls back to LWW if no resolver is provided. |

```typescript
import { resolveConstraintViolation } from '@korajs/merge'

for (const violation of violations) {
  const resolution = resolveConstraintViolation(
    violation,
    mergedData,
    localOp,
    remoteOp,
    baseState,
  )
  mergedData = resolution.resolvedRecord
  traces.push(resolution.trace)
}
```

---

## Types

### MergeInput

Input to the merge engine when two concurrent operations conflict.

```typescript
interface MergeInput {
  /** The locally-originated operation */
  local: Operation

  /** The remotely-originated operation */
  remote: Operation

  /** Full record state before either operation was applied */
  baseState: Record<string, unknown>

  /** Schema definition for the collection being merged */
  collectionDef: CollectionDefinition
}
```

### MergeResult

Output of the merge engine after resolving all field conflicts.

```typescript
interface MergeResult {
  /** The resolved field values after merging */
  mergedData: Record<string, unknown>

  /** One trace per conflicting field (for DevTools) */
  traces: MergeTrace[]

  /** Which operation's values dominate overall, or 'merged' if mixed */
  appliedOperation: 'local' | 'remote' | 'merged'
}
```

### FieldMergeResult

Output of a single field-level merge decision.

```typescript
interface FieldMergeResult {
  /** The resolved value for this field */
  value: unknown

  /** Trace of the merge decision (for DevTools) */
  trace: MergeTrace
}
```

### LWWResult

Result of a Last-Write-Wins comparison.

```typescript
interface LWWResult {
  /** The winning value */
  value: unknown

  /** Which side won */
  winner: 'local' | 'remote'
}
```

### ConstraintContext

Pluggable database lookup interface for Tier 2 constraint checking. The `@korajs/store` package provides the runtime implementation; the merge package depends only on this interface, keeping it storage-agnostic.

```typescript
interface ConstraintContext {
  /** Query records matching the given filter in a collection */
  queryRecords(
    collection: string,
    where: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]>

  /** Count records matching the given filter in a collection */
  countRecords(
    collection: string,
    where: Record<string, unknown>,
  ): Promise<number>
}
```

### ConstraintViolation

Describes a constraint that was violated after auto-merge.

```typescript
interface ConstraintViolation {
  /** The constraint definition that was violated */
  constraint: Constraint

  /** The field(s) involved in the violation */
  fields: string[]

  /** Human-readable description of the violation */
  message: string
}
```

### ConstraintResolution

Result of resolving a constraint violation.

```typescript
interface ConstraintResolution {
  /** The updated record after constraint resolution */
  resolvedRecord: Record<string, unknown>

  /** Trace of the resolution decision for DevTools */
  trace: MergeTrace
}
```

### MergeTrace

Records the full context of a merge decision. Defined in `@korajs/core` and re-used throughout the merge package. See the [Core API Reference](./core.md#types) for the full definition.

---

## Examples

### Basic merge with MergeEngine

```typescript
import { MergeEngine } from '@korajs/merge'

const engine = new MergeEngine()

// Two users concurrently edit the same todo
const result = await engine.merge({
  local: {
    // ...operation fields
    type: 'update',
    collection: 'todos',
    recordId: 'todo-1',
    data: { title: 'Updated locally' },
    previousData: { title: 'Original' },
    timestamp: localClock.now(),
  },
  remote: {
    // ...operation fields
    type: 'update',
    collection: 'todos',
    recordId: 'todo-1',
    data: { completed: true },
    previousData: { completed: false },
    timestamp: remoteClock.now(),
  },
  baseState: { title: 'Original', completed: false },
  collectionDef: schema.collections.todos,
})

// No conflict: different fields changed
// result.mergedData = { title: 'Updated locally', completed: true }
// result.appliedOperation = 'merged'
```

### Merge with Tier 2 constraint checking

```typescript
import { MergeEngine } from '@korajs/merge'

const engine = new MergeEngine()

const constraintContext = {
  queryRecords: async (collection, where) => {
    return db.query(`SELECT * FROM ${collection} WHERE ...`, where)
  },
  countRecords: async (collection, where) => {
    return db.count(collection, where)
  },
}

const result = await engine.merge(
  {
    local: localOp,
    remote: remoteOp,
    baseState,
    collectionDef: schema.collections.todos,
  },
  constraintContext,
)

// If a unique constraint was violated, it will be resolved
// according to the constraint's onConflict strategy.
// All resolution traces appear in result.traces.
```

### Using strategies directly

```typescript
import { lastWriteWins, addWinsSet, mergeRichtext, richtextToString } from '@korajs/merge'

// LWW for scalar values
const lww = lastWriteWins('value-a', 'value-b', timestampA, timestampB)
console.log(lww.value, lww.winner)

// Add-wins set for arrays
const merged = addWinsSet(
  ['a', 'b', 'new-local'],
  ['a', 'b', 'new-remote'],
  ['a', 'b'],
)
// ['a', 'b', 'new-local', 'new-remote']

// Yjs CRDT for rich text
const mergedDoc = mergeRichtext(localUpdate, remoteUpdate, baseUpdate)
console.log(richtextToString(mergedDoc))
```

### Custom resolver (Tier 3) for additive quantity merge

```typescript
import { defineSchema, t } from '@korajs/core'

const schema = defineSchema({
  version: 1,
  collections: {
    inventory: {
      fields: {
        productId: t.string(),
        quantity: t.number(),
      },
      resolve: {
        quantity: (local, remote, base) => {
          // Additive merge: apply both deltas to the base value
          const localDelta = (local as number) - (base as number)
          const remoteDelta = (remote as number) - (base as number)
          return Math.max(0, (base as number) + localDelta + remoteDelta)
        },
      },
    },
  },
})

// base quantity = 10
// local sets quantity to 8  (delta = -2)
// remote sets quantity to 13 (delta = +3)
// resolved = max(0, 10 + (-2) + 3) = 11
```
