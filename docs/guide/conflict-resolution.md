---
title: Conflict Resolution
description: "How Kora.js resolves concurrent edits: the three-tier merge engine with last-write-wins, CRDTs, declarative constraints, and custom resolvers."
---

# Conflict Resolution

When multiple devices modify the same data concurrently, Kora resolves conflicts through a three-tier merge engine. Each tier adds more control, and most apps never need to go beyond Tier 1.

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
| `t.array()` | Add-Wins Set | Union of elements from both sides |
| `t.richtext()` | Yjs CRDT | Character-level collaborative merge |

### Last-Write-Wins (LWW)

For scalar fields, Kora uses Hybrid Logical Clock (HLC) timestamps to determine which write is "later." The HLC provides a total order that respects causality without requiring synchronized wall clocks.

```
Device A writes title = "Buy milk"    at HLC(1000, 0, nodeA)
Device B writes title = "Buy bread"   at HLC(1001, 0, nodeB)

Merged result: title = "Buy bread"  (HLC timestamp is later)
```

If two writes have the same wall time, the HLC logical counter and node ID break the tie deterministically. Every device always reaches the same result, regardless of the order operations arrive.

### Add-Wins Set (Arrays)

For array fields, Kora takes the union of elements from both sides. If both devices add different items, all items appear in the result.

```
Base:     tags = ["work"]
Device A: tags = ["work", "urgent"]      (added "urgent")
Device B: tags = ["work", "important"]   (added "important")

Merged:   tags = ["work", "urgent", "important"]
```

### Yjs CRDT (Rich Text)

Fields declared as `t.richtext()` use Yjs under the hood. Yjs provides character-level conflict-free merging for rich text content, handling concurrent insertions, deletions, and formatting changes.

```typescript
notes: t.richtext()
```

Two users can type in the same document simultaneously and their edits merge seamlessly, just like in Google Docs.

## Schema-Level Merge Strategies

For common merge patterns that go beyond simple LWW, you can declare a merge strategy directly on a field using the `.merge()` modifier. This replaces the default Tier 1 strategy without needing a Tier 3 custom resolver.

### Counter

Additive merge for numeric fields. Both sides' deltas from the base value are applied:

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

The remote/server value always wins, regardless of timestamps:

```typescript
approvalStatus: t.string().merge('server-authoritative')
```

Useful for fields controlled by a server-side process (admin approval, moderation status, etc.).

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

1. Auto-merge (Tier 1) produces a candidate state.
2. Each constraint on the affected collection is evaluated.
3. If the candidate satisfies all constraints, it is accepted.
4. If a constraint is violated, the `onConflict` strategy produces a corrected state.
5. A `constraint-violation` event is emitted (visible in DevTools).

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
| `local` | The field value from the local device's operation |
| `remote` | The field value from the remote device's operation |
| `base` | The last known common value before the concurrent edits |

The function must return the resolved value. It is called only when both sides have modified the same field concurrently.

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
| Tags, labels, categories | Tier 1 (add-wins set) -- use `t.array()` |
| Counters, quantities, scores | `.merge('counter')` on the field |
| High scores, version numbers | `.merge('max')` on the field |
| Audit logs, append-only lists | `.merge('append-only')` on the field |
| Server-controlled fields | `.merge('server-authoritative')` on the field |
| Unique constraints (email, username, seat) | Tier 2 -- declare the constraint |
| Capacity limits (max participants) | Tier 2 -- declare the constraint |
| Complex domain-specific business logic | Tier 3 -- write a custom resolver |

Most applications work entirely with Tier 1 defaults. Add Tier 2 and 3 only where your domain requires it.
