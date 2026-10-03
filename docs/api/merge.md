---
title: Merge API
description: "@korajs/merge API reference: constraint checking, referential integrity, rich-text helpers, and the deprecated pairwise merge engine and strategies."
---

# Merge API Reference

Since 1.0.0-beta.13, records are merged by the **record fold** in `@korajs/core`: one
deterministic per-field CRDT that every replica runs (see [the fold](/api/core#fold) and
[Conflict Resolution](/guide/conflict-resolution)). `@korajs/merge` keeps the checks that span
records and some helpers:

| Area | Status |
|------|--------|
| Constraint checking (`checkConstraints`, `resolveConstraintViolation`) | Used by the sync server (authoritative) and by devices (optimistic, for `constraint:violated`). |
| Referential integrity (`checkReferentialIntegrityOnDelete`, `resolveDeleteVsInsertConflict`, `buildMergeRelationLookup`) | Used on the deleting device and on the server. |
| Rich-text helpers (`richtextToString`, `stringToRichtextUpdate`, `mergeRichtext`) | Current. |
| `MergeEngine`, `mergeField` and the pairwise strategies | **Deprecated.** They back `experimental.legacyMerge` (the 1.0.0-beta.12 merge) for this release only and will be removed. |

Application code does not call this package: `createApp()` and the sync server wire it.

---

## Constraints

<!-- docs-check: skip signature -->
```typescript
function checkConstraints(
  mergedRecord: Record<string, unknown>,
  recordId: string,
  collection: string,
  collectionDef: CollectionDefinition,
  constraintContext: ConstraintContext,
): Promise<ConstraintViolation[]>

function resolveConstraintViolation(
  violation: ConstraintViolation,
  mergedRecord: Record<string, unknown>,
  localOp: Operation,
  remoteOp: Operation,
  baseState: Record<string, unknown>,
): ConstraintResolution   // { resolvedRecord, trace, sideEffects? }

interface ConstraintContext {
  queryRecords(collection: string, where: Record<string, unknown>): Promise<Record<string, unknown>[]>
  countRecords(collection: string, where: Record<string, unknown>): Promise<number>
}

interface ConstraintViolation {
  constraint: Constraint
  fields: string[]
  message: string
}
```

`checkConstraints` evaluates a candidate record against every constraint of its collection
(`unique`, `capacity`, `referential`; `where` is plain equality). `resolveConstraintViolation`
picks the winner: `last-write-wins` keeps the newer write, `priority-field` the higher
`priorityField` value, and every other `onConflict` value keeps the older write. A constraint's
`resolve` function is not called. How the server enforces constraints (ingest refusal, then
deterministic corrections) is described in
[Conflict Resolution](/guide/conflict-resolution#constraints).

---

## Referential integrity

<!-- docs-check: skip signature -->
```typescript
function buildMergeRelationLookup(schema: SchemaDefinition): Map<string, MergeIncomingRelation[]>
// target collection -> relations that point at it: { relationName, sourceCollection, foreignKeyField, onDelete }

function checkReferentialIntegrityOnDelete(
  deleteOp: Operation,
  schema: SchemaDefinition,
  ctx: ReferentialMergeContext,       // { queryRecords(collection, where), recordExists(collection, id) }
  relationLookup?: Map<string, MergeIncomingRelation[]>,
): Promise<ReferentialCheckResult>    // { allowed, sideEffectOps, traces }

function resolveDeleteVsInsertConflict(
  deleteOp: Operation,
  insertOp: Operation,
  relation: MergeIncomingRelation,
): DeleteVsInsertResolution           // { action: 'block-delete' | 'allow-delete', sideEffects, trace }
```

A delete of a referenced record produces side effects per `onDelete`: `cascade` deletes the
children, `set-null` clears their foreign keys, `restrict` refuses the delete while a live child
exists, `no-action` does nothing. `SideEffectOp` is
`{ type: 'delete' | 'update', collection, recordId, data, previousData }`; the caller writes them as
ordinary operations (the server gives them deterministic ids). The outcomes of a delete racing a
new child are listed in [Conflict Resolution](/guide/conflict-resolution#relations).

---

## Rich text

<!-- docs-check: skip signature -->
```typescript
type RichtextValue = string | Uint8Array | ArrayBuffer | KoraBytesValue | null | undefined

function richtextToString(value: RichtextValue): string     // plain text of a Yjs state
function stringToRichtextUpdate(value: string): Uint8Array  // a Yjs update holding the text
function mergeRichtext(local: RichtextValue, remote: RichtextValue, base: RichtextValue): Uint8Array
```

To combine the stored updates of a field, the fold uses `mergeYjsUpdates` from `@korajs/store`.

---

## Deprecated: pairwise merge

These APIs implement the 1.0.0-beta.12 merge: two operations at a time, resolved field by field.
They are kept only so `experimental.legacyMerge` can compare results during this release, and will
be removed. The fold does not use them, and their results can differ from what replicas converge
to.

| Export | Description |
|--------|-------------|
| `new MergeEngine().merge(input, constraintContext?)` | Merges `{ local, remote, baseState, collectionDef }` into `{ mergedData, traces, appliedOperation, sideEffects }`. |
| `mergeField(name, localOp, remoteOp, baseState, descriptor, resolver?)` | One field: `{ value, trace }`. |
| `lastWriteWins(local, remote, localTs, remoteTs)` | `{ value, winner }` by HLC order. |
| `addWinsSet(local, remote, base)` | Union of additions minus agreed removals. |
| `mergeObject(local, remote, base, localTs, remoteTs)` | Per-key last write wins. |
| `mergeAtomicOps(localOp, remoteOp, base)` | Combines two atomic intents (increments sum). |
| `counterMerge`, `maxMerge`, `minMerge`, `appendOnlyMerge`, `serverAuthoritativeMerge`, `applySchemaStrategy` | The `.merge()` strategies applied to two values. |

Differences from the fold, for readers comparing the two: the fold keeps duplicate array elements
(an occurrence multiset instead of a set), merges objects per key with removal markers, folds a
custom resolver over the field's whole write log in stamp order, and lets server writes win
`merge('server-authoritative')` fields by node identity instead of by "remote wins". See
[Conflict Resolution](/guide/conflict-resolution#what-changed-from-beta-12).
