---
title: Conflict Resolution
description: "How Kora.js resolves concurrent edits: the three-tier merge engine with last-write-wins, CRDTs, declarative constraints, and custom resolvers."
---

# Conflict Resolution

When multiple devices modify the same data concurrently, Kora resolves conflicts through three tiers of rules. Each tier adds more control, and most apps never need to go beyond Tier 1.

Since beta.14 every replica (each device, the sync server, a restored backup) computes a record the same way: its operations are **folded** into a per-field merge state that is itself a CRDT. The result depends only on *which* operations a replica holds, never on the order they arrived in, so replicas that hold the same operations hold the same record. See [One fold, everywhere](#one-fold-everywhere) for the exact rules and what changed from beta.13.

## Overview

The three tiers run in sequence for every merge:

1. **Tier 1: Auto-Merge** -- Default strategies applied per field type. No configuration needed.
2. **Tier 2: Constraints** -- Declarative rules that validate the merged result and apply corrective strategies if violated.
3. **Tier 3: Custom Resolvers** -- Developer-defined functions for domain-specific merge logic.

Every merge decision is recorded in a `MergeTrace`, which is visible in [DevTools](/guide/devtools) for debugging.

## Tier 1: Auto-Merge

Every field type has a default merge strategy that runs automatically. This handles the vast majority of conflicts without any developer configuration.

### Strategies by Field Type

| Field Type | Strategy | Behavior |
|------------|----------|----------|
| `t.string()` | Last-Write-Wins (LWW) | The value with the later HLC timestamp wins |
| `t.number()` | Last-Write-Wins (LWW) | The value with the later HLC timestamp wins |
| `t.boolean()` | Last-Write-Wins (LWW) | The value with the later HLC timestamp wins |
| `t.enum()` | Last-Write-Wins (LWW) | The value with the later HLC timestamp wins |
| `t.timestamp()` | Last-Write-Wins (LWW) | The value with the later HLC timestamp wins |
| `t.array()` | LWW element multiset | Adds and removals merge per element occurrence |
| `t.object()` / `t.json()` | Per-key LWW | Concurrent edits of different top-level keys both survive |
| `t.richtext()` | Yjs CRDT | Character-level collaborative merge |

### Last-Write-Wins (LWW)

For scalar fields, Kora uses Hybrid Logical Clock (HLC) timestamps to determine which write is "later." The HLC provides a total order that respects causality without requiring synchronized wall clocks.

```
Device A writes title = "Buy milk"    at HLC(1000, 0, nodeA)
Device B writes title = "Buy bread"   at HLC(1001, 0, nodeB)

Merged result: title = "Buy bread"  (HLC timestamp is later)
```

If two writes have the same wall time, the HLC logical counter and node ID break the tie deterministically. Every device always reaches the same result, regardless of the order operations arrive.

### Element Multiset (Arrays)

An array write is read as the elements it **adds** and **removes** compared with the
array the writer started from (its `previousData`). Each element occurrence keeps the
time of its newest add and its newest removal, and is present when the add is later.
Concurrent adds of different elements both survive, and a removal on one device is not
undone by another device that merely kept the element.

```
Base:     tags = ["work", "old"]
Device A: tags = ["work", "urgent"]      (removed "old", added "urgent")
Device B: tags = ["work", "old", "important"]   (added "important")

Merged:   tags = ["work", "urgent", "important"]
```

- **Duplicates are kept.** `["a", "a"]` is two occurrences of `"a"` (the 1st and the
  2nd copy). Removing one copy removes one occurrence. Two devices that each add the
  same value to the same starting array add the *same* occurrence, so the result holds
  it once.
- **Order** is the order elements were first added (HLC order of the writes, then the
  position inside the write), not the order of the last writer's array.
- Elements are compared by value; objects inside arrays compare by their canonical JSON
  (key order does not matter).
- Writing `null` (or any non-array value) replaces the whole value and clears the
  elements added before it.
- `op.append(x)` / `op.remove(x)` are the same add / remove: appending a value that is
  already present adds another copy; removing removes every copy the writer saw.

### Objects and JSON

`t.object()` and `t.json()` merge per top-level key: concurrent edits of different keys
both survive, the later write of the same key wins, and a removed key stays removed
unless written again later. Values nested under a top-level key are replaced as a whole
(last write wins), so keep independently edited data in separate top-level keys.

### Yjs CRDT (Rich Text)

Fields declared as `t.richtext()` use Yjs under the hood. Yjs provides character-level conflict-free merging for rich text content, handling concurrent insertions, deletions, and formatting changes.

```typescript
notes: t.richtext()
```

Two users can type in the same document simultaneously and their edits merge seamlessly, just like in Google Docs.

## Schema-Level Merge Strategies

For common merge patterns that go beyond simple LWW, you can declare a merge strategy directly on a field using the `.merge()` modifier. This replaces the default Tier 1 strategy without needing a Tier 3 custom resolver.

### Counter

Additive merge for numeric fields. Every write after the newest base write (the insert,
or a non-numeric write) contributes its delta (`value - previousData`, or the
`op.increment` amount), so any number of concurrent writers accumulate:

```typescript
quantity: t.number().merge('counter')
```

```
Base:     100
Device A: 97   (sold 3, delta: -3)
Device B: 95   (sold 5, delta: -5)
Merged:   92   (100 + (-3) + (-5))
```

This is the recommended approach for quantities, scores, vote counts, and any numeric field where concurrent changes should accumulate rather than overwrite.

### Max / Min

Keep the highest or lowest value:

```typescript
highScore: t.number().merge('max')     // keeps the highest value
lowestBid: t.number().merge('min')     // keeps the lowest value
```

```
Base:     50
Device A: 75
Device B: 60
Max:      75   (max of all three)
Min:      50   (min of all three)
```

### Append-Only

For array fields where items should never be removed -- only added:

```typescript
auditLog: t.array(t.string()).merge('append-only')
```

```
Base:     ["created"]
Device A: ["created", "reviewed"]          (added "reviewed")
Device B: ["reviewed"]                     (removed "created", added "reviewed")
Merged:   ["created", "reviewed"]          (removal ignored, additions merged)
```

### Server-Authoritative

A write made by the sync server (its node ids are announced in the sync handshake)
beats any device's write of the field, even a later one. Device writes among
themselves, and server writes among themselves, are last-write-wins:

```typescript
approvalStatus: t.string().merge('server-authoritative')
```

Useful for fields controlled by a server-side process (admin approval, moderation status, etc.).
Until a device has learned the server's node ids (first handshake), the field behaves
as last-write-wins; when they become known, the device re-folds the affected records.

### When to Use What

| Pattern | Use | Instead of |
|---------|-----|------------|
| `t.number().merge('counter')` | Quantities, scores, counters | Tier 3 additive resolver |
| `t.number().merge('max')` | High scores, version numbers | Tier 3 max resolver |
| `t.number().merge('min')` | Lowest bid, minimum stock | Tier 3 min resolver |
| `t.array().merge('append-only')` | Audit logs, event history | Tier 3 custom array resolver |
| `t.string().merge('server-authoritative')` | Admin-controlled fields | Tier 2 server-decides constraint |
| Tier 3 `resolve` | Complex domain logic | -- |

Schema-level strategies are preferred over Tier 3 resolvers when a built-in strategy fits, because they are:
- Declarative (visible in the schema)
- Tested and proven (commutative, idempotent)
- Visible in DevTools as strategy names (e.g., `schema-counter`)

## Tier 2: Constraint Validation

After auto-merge produces a candidate state, Tier 2 checks declarative constraints. If a constraint is violated, the specified resolution strategy is applied.

### Defining Constraints

Add constraints to a collection in your schema:

```typescript
export default defineSchema({
  version: 1,

  collections: {
    seats: {
      fields: {
        eventId: t.string(),
        seatNumber: t.string(),
        claimedBy: t.string().optional(),
      },
      constraints: {
        uniqueSeat: {
          type: 'unique',
          fields: ['eventId', 'seatNumber'],
          where: { claimedBy: { $ne: null } },
          onConflict: 'first-write-wins',
        },
      },
    },
  },
})
```

### Constraint Types

#### `unique`

Ensures a combination of field values is unique across the collection:

```typescript
constraints: {
  uniqueEmail: {
    type: 'unique',
    fields: ['email'],
    onConflict: 'first-write-wins',
  },
}
```

#### `capacity`

Limits the number of records matching a condition:

```typescript
constraints: {
  maxParticipants: {
    type: 'capacity',
    fields: ['eventId'],
    max: 100,
    onConflict: 'priority-field',
    priorityField: 'registeredAt',
  },
}
```

#### `referential`

Ensures a foreign key points to an existing record:

```typescript
constraints: {
  validProject: {
    type: 'referential',
    fields: ['projectId'],
    references: 'projects',
    onConflict: 'server-decides',
  },
}
```

### `onConflict` Strategies

| Strategy | Behavior |
|----------|----------|
| `'first-write-wins'` | The earlier write (by HLC timestamp) takes precedence |
| `'last-write-wins'` | The later write takes precedence |
| `'priority-field'` | The record with the higher priority value wins (requires `priorityField`) |
| `'server-decides'` | Defer to the server's version of the data |
| `'custom'` | Call a custom resolver function (requires `resolve`) |

### Constraint Flow

Constraints that look at **other** records (`unique`, `capacity`, `referential`) have
one authority: the sync server.

1. The fold (Tier 1 and Tier 3) produces the record's state on every replica.
2. Devices evaluate the collection's constraints **optimistically** after applying a
   remote operation and emit `constraint:violated` (visible in DevTools); they do not
   rewrite the record locally, so every replica keeps folding the same operations.
3. The server evaluates them **authoritatively** and applies the `onConflict`
   strategy; its correction is an ordinary operation that reaches every device.

Rules within one record (state machines) are part of the record's own merge.

## Tier 3: Custom Resolvers

For domain-specific logic that neither LWW nor constraints can express, define a custom resolver function.

### Basic Custom Resolver

```typescript
export default defineSchema({
  version: 1,

  collections: {
    inventory: {
      fields: {
        productId: t.string(),
        quantity: t.number(),
      },
      resolve: {
        quantity: (local, remote, base) => {
          // Additive merge: apply both deltas to the base
          const localDelta = local - base
          const remoteDelta = remote - base
          return Math.max(0, base + localDelta + remoteDelta)
        },
      },
    },
  },
})
```

### How It Works

The resolver function receives three arguments:

| Argument | Description |
|----------|-------------|
| `local` | The field's value merged so far (every earlier write, in HLC order) |
| `remote` | The value of the write being merged |
| `base` | The value that write started from (its `previousData`); `null` for an insert |

The function must return the resolved value. Every replica folds the field's writes in
the same order (HLC, then operation id): the first write sets the value, and the
resolver is called once per later write. It does not need to be commutative. If it
throws, the write's own value is used and the error is reported on the merge trace.

### Example: Additive Inventory

The classic example is inventory management. Two stores each sell items from a shared stock:

```
Base quantity:     100
Store A sells 3:   quantity = 97  (delta: -3)
Store B sells 5:   quantity = 95  (delta: -5)
```

With LWW, one store's sales would be lost. The custom resolver applies both deltas:

```
Resolved: 100 + (-3) + (-5) = 92
```

Both stores' sales are correctly reflected.

### Example: Score Accumulation

```typescript
resolve: {
  score: (local, remote, base) => {
    return base + (local - base) + (remote - base)
  },
}
```

### Example: Priority-Based Selection

```typescript
resolve: {
  status: (local, remote, _base) => {
    const priority = { draft: 0, review: 1, published: 2 }
    // Higher status always wins
    return priority[local] >= priority[remote] ? local : remote
  },
}
```

## State Machine Constraints

Enum fields with declared transitions act as state machines. The merge engine enforces valid transitions even during concurrent modifications.

### Defining a State Machine

```typescript
export default defineSchema({
  version: 1,
  collections: {
    orders: {
      fields: {
        status: t.enum(['draft', 'submitted', 'approved', 'shipped', 'delivered', 'cancelled'])
          .default('draft')
          .transitions({
            draft: ['submitted', 'cancelled'],
            submitted: ['approved', 'cancelled'],
            approved: ['shipped', 'cancelled'],
            shipped: ['delivered'],
            delivered: [],
            cancelled: [],
          }),
      },
    },
  },
})
```

### How Concurrent State Transitions Merge

When two devices concurrently change a state machine field from the same base state, the merge engine applies these rules:

| Scenario | Result |
|----------|--------|
| Both transitions valid | LWW (later HLC timestamp wins) |
| One valid, one invalid | The valid transition wins (regardless of timestamp) |
| Both transitions invalid | Base state is kept, constraint violation emitted |
| Only one side changed | The change is applied if the transition is valid |

```
Base state:    "submitted"
Device A:      "approved"     (valid: submitted → approved)
Device B:      "cancelled"    (valid: submitted → cancelled)

Both valid → LWW decides. If A has later timestamp:
Merged:        "approved"
```

```
Base state:    "submitted"
Device A:      "approved"     (valid: submitted → approved)
Device B:      "delivered"    (INVALID: submitted → delivered)

One valid, one invalid → valid wins:
Merged:        "approved"
```

See the [State Machines guide](/guide/state-machines) for more details.

## Referential Integrity During Merge

When relations are defined in your schema, the merge engine enforces referential integrity during concurrent operations. A common conflict pattern is a concurrent delete and insert:

```
Device A: Deletes project "proj-1"
Device B: Inserts todo with projectId = "proj-1"
```

The resolution depends on the relation's `onDelete` policy:

| `onDelete` | Behavior |
|------------|----------|
| `'cascade'` | The insert is rejected (child follows parent deletion) |
| `'set-null'` | The insert succeeds but `projectId` is set to `null` |
| `'restrict'` | The delete is rejected (child record prevents parent deletion) |
| `'no-action'` | Both operations apply (orphan record allowed) |

## Merge Determinism

A critical property of Kora's merge engine: **given the same set of operations, every device produces the identical merged state.** This is guaranteed by:

- **Commutativity**: merge(A, B) equals merge(B, A). Order of operations does not matter.
- **Associativity**: merging in any grouping (operation by operation, or whole replica states) gives the same state.
- **Idempotency**: Applying the same operation twice produces the same result as applying it once.
- **Deterministic tie-breaking**: The HLC and node ID provide a total order with no ambiguity.

These properties are verified with property-based tests using `fast-check` in the Kora test suite.

## Inspecting Merge Decisions

Every merge produces a `MergeTrace` that records:

- The conflicting operations
- The strategy applied (LWW, CRDT, constraint, custom)
- The input values from both sides and the base
- The output value
- Which tier resolved the conflict
- Duration of the merge

Use the [DevTools Conflict Inspector](/guide/devtools) to view these traces in real time. This is invaluable for understanding why a particular value was chosen during conflict resolution.

## Choosing the Right Tier

| Scenario | Recommended Approach |
|----------|---------------------|
| Simple fields (names, booleans, dates) | Tier 1 (LWW) -- the default, no config |
| Collaborative text editing | Tier 1 (richtext CRDT) -- use `t.richtext()` |
| Tags, labels, categories | Tier 1 (element multiset) -- use `t.array()` |
| Counters, quantities, scores | `.merge('counter')` on the field |
| High scores, version numbers | `.merge('max')` on the field |
| Audit logs, append-only lists | `.merge('append-only')` on the field |
| Server-controlled fields | `.merge('server-authoritative')` on the field |
| Unique constraints (email, username, seat) | Tier 2 -- declare the constraint |
| Capacity limits (max participants) | Tier 2 -- declare the constraint |
| Complex domain-specific business logic | Tier 3 -- write a custom resolver |

Most applications work entirely with Tier 1 defaults. Add Tier 2 and 3 only where your domain requires it.


## One fold, everywhere

Every write (local or remote) is appended to the operation log and then merged into the
record's **fold state**: per field, exactly the information that field's rule needs (a
last-write-wins register, element add/remove times, per-key registers, counter deltas,
a resolver's write log, Yjs updates). Merging is commutative, associative and
idempotent, so the record depends only on the set of operations merged. The row you
query is the materialization of that state, written in the same transaction.

The rules, per field:

- An update writes a field only when the value differs from its own `previousData`.
  Re-sending an unchanged field (a form that saves every field) is not a write and
  never overrides a concurrent change.
- Scalars: last write wins by HLC, then operation id. `op.increment` chains compose.
- Arrays, objects / JSON, counters, max / min, append-only, server-authoritative,
  resolvers and richtext: as described in the sections above.
- An insert onto a record that already exists merges per field; it does not reset
  fields it does not carry. An update to a record whose insert has not arrived waits
  for it.
- Delete vs write: the later of the newest delete and the newest write decides; a
  record revived by a later write shows every field's merged value.
- An operation the server refused for good is left out: its author re-folds the
  record without it and converges to the server.
- When a record enters a device's sync scope, the server sends its fold state and the
  device joins it, so counters, richtext, resolvers and arrays keep their concurrent
  local edits instead of being overwritten.

### What changed from beta.13

Each change fixes a case where devices or the server could disagree forever:

1. Arrays are multisets merged per element occurrence (no pairwise add-wins set):
   duplicates are kept, order is first-add order, a removal beats an unchanged copy.
2. Objects merge per top-level key only; nested values are whole-value last-write-wins.
3. An update that restates a field unchanged no longer wins last-write-wins for it.
4. Custom resolvers see `local` = the merged value so far, in HLC order, once per write.
5. An insert onto an existing record merges per field (the server used to reset it).
6. `merge('server-authoritative')` lets server writes win; it was plain last-write-wins.
7. `merge('counter' | 'max' | 'min' | 'append-only')` fold over every write instead of
   a formula over two concurrent writes.
8. `op.append` of a value already present adds a copy; `op.remove` removes every copy.
9. An update whose insert never arrived does not create a row.
10. A scope entry joins the server's fold state (all field kinds), not per-field LWW.

On the first open with beta.14 the store **re-materializes** every record from its log
(emitting `store:rematerialized`), which also repairs devices that diverged under
earlier betas. A database whose log was compacted uses its current rows as the starting
point; a database whose log has quarantined rows (see `store.verifyLogIntegrity()`)
keeps its rows exactly as they are. For one beta, `createApp({ experimental: {
legacyMerge: true } })` runs the beta.13 pipeline instead, for comparison.

What this guarantees in practice:

- Concurrent edits to **different fields** of the same record both survive:
  neither device's change is lost.
- Concurrent edits to the **same field** converge to one agreed winner on
  every device, deterministically.
- Updates delivered **before their insert** (reordering networks) are folded
  in when the insert lands, matching in-order devices exactly.
- A remote insert that lands on an **already existing record id** resolves
  per field like an update instead of failing on the primary key, and
  `createdAt` converges to the later insert wall time.
- Atomic operations compose: `op.increment(n)` on two offline devices merges
  to the **sum of both deltas**, never last-write-wins.
- A merge reads and writes the record's state inside one write transaction,
  so a local edit can never slip between a merge's read and its write.
- Compacting the log (`store.compact()`) keeps the merge exact: the effect of the
  removed operations stays in the record's base state.

You can see all of this with your own eyes: `kora studio` shows each field's
last writer, and the [Studio Lab](/studio) lets you reproduce any conflict
interactively. Every merge decision is also persisted to the durable audit
trail (`_kora_audit_traces`) and shown in Studio's Merges view.
