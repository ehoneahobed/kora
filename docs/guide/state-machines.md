# State Machines

Kora supports state machines on enum fields. A state machine constrains which transitions are allowed, preventing invalid state changes during both local mutations and concurrent merges.

## Overview

Many application fields follow a strict workflow: an order goes from `draft` to `submitted` to `approved`, but should never jump from `draft` to `delivered`. Without state machines, concurrent offline edits could produce invalid state transitions. Kora's state machine system enforces transition rules at every layer:

- **Local mutations**: Invalid transitions are rejected or silently blocked before they produce operations.
- **Merge resolution**: When two devices concurrently change the same state field, the merge engine validates both transitions and picks a valid result.
- **DevTools visibility**: Every state machine merge decision is recorded in a `MergeTrace` for debugging.

## Defining Transitions

There are two ways to define state machine transitions: on the field itself using `.transitions()`, or at the collection level using the `stateMachine` property.

### Field-Level Transitions

The simplest approach is to call `.transitions()` on an enum field builder:

```typescript
import { defineSchema, t } from 'korajs'

export default defineSchema({
  version: 1,
  collections: {
    orders: {
      fields: {
        title: t.string(),
        status: t.enum(['draft', 'submitted', 'approved', 'shipped', 'delivered', 'cancelled'])
          .default('draft')
          .transitions({
            draft: ['submitted', 'cancelled'],
            submitted: ['approved', 'cancelled'],
            approved: ['shipped'],
            shipped: ['delivered'],
            delivered: [],
            cancelled: [],
          }),
      },
    },
  },
})
```

Each key in the transitions map is a source state, and the array contains the allowed target states. An empty array means the state is terminal -- no further transitions are possible.

### Collection-Level State Machine

Alternatively, define the state machine at the collection level. This approach lets you set the `onInvalidTransition` behavior:

```typescript
export default defineSchema({
  version: 1,
  collections: {
    orders: {
      fields: {
        title: t.string(),
        status: t.enum(['draft', 'submitted', 'approved', 'shipped', 'delivered', 'cancelled'])
          .default('draft'),
      },
      stateMachine: {
        field: 'status',
        transitions: {
          draft: ['submitted', 'cancelled'],
          submitted: ['approved', 'cancelled'],
          approved: ['shipped'],
          shipped: ['delivered'],
          delivered: [],
          cancelled: [],
        },
        onInvalidTransition: 'reject',
      },
    },
  },
})
```

Both approaches produce the same runtime behavior. The collection-level form gives you explicit control over `onInvalidTransition`.

## Invalid Transition Behavior

The `onInvalidTransition` option controls what happens when a local mutation attempts a transition that is not in the allowed list:

### `'reject'` (default)

Throws an `InvalidStateTransitionError` with a clear message:

```
Invalid state transition in collection "orders":
cannot transition field "status" from "draft" to "delivered".
Allowed transitions from "draft": submitted, cancelled
```

The error includes the collection name, record ID, field name, current state, attempted state, and the list of allowed targets. Use this when invalid transitions indicate a bug in the application logic.

### `'last-valid-state'`

Silently ignores the invalid transition. The state field keeps its current value, and the rest of the update (other fields) is applied normally.

```typescript
stateMachine: {
  field: 'status',
  transitions: {
    draft: ['submitted', 'cancelled'],
    submitted: ['approved', 'cancelled'],
    // ...
  },
  onInvalidTransition: 'last-valid-state',
}
```

Use this when you want the system to be lenient -- for example, when users might attempt impossible transitions due to stale UI state, and you prefer to silently preserve the current state rather than show an error.

## Local Mutation Validation

State machine transitions are validated during `update()` calls. The validator checks:

1. Whether the update includes the state machine field.
2. If so, what the current value of that field is on the existing record.
3. Whether the transition from the current value to the new value is in the allowed list.

Same-state transitions (e.g., `submitted` to `submitted`) are always valid. This makes idempotent updates safe.

For `insert()` calls, any valid enum value is accepted as the initial state. The state machine only constrains transitions from one state to another, not which state a new record starts in.

```typescript
// Valid: insert with any allowed enum value
await app.orders.insert({ title: 'Widget', status: 'draft' })

// Valid: allowed transition
await app.orders.update(id, { status: 'submitted' })

// Invalid (with 'reject'): throws InvalidStateTransitionError
await app.orders.update(id, { status: 'delivered' })

// Valid: updating other fields does not trigger state validation
await app.orders.update(id, { title: 'Updated Widget' })
```

## Merge Resolution

When two devices concurrently modify a state machine field, the merge engine applies special rules instead of the default LWW strategy. The resolution depends on the validity of each side's transition from the base state:

### Both Transitions Valid

If both the local and remote transitions are valid moves from the base state, the merge falls back to Last-Write-Wins using HLC timestamps:

```
Base state:     "draft"
Device A:       "submitted"   (valid: draft -> submitted)
Device B:       "cancelled"   (valid: draft -> cancelled)

Merged result:  whichever has the later HLC timestamp
```

Both transitions are legitimate, so the later one wins. This matches the standard LWW behavior but only after confirming both transitions are allowed.

### One Valid, One Invalid

If only one side's transition is valid from the base state, the valid transition wins regardless of timestamps:

```
Base state:     "draft"
Device A:       "submitted"   (valid: draft -> submitted)
Device B:       "delivered"   (invalid: draft -> delivered)

Merged result:  "submitted"   (valid wins)
```

This prevents an invalid transition on one device from overriding a correct transition on another, even if the invalid transition has a later timestamp.

### Both Invalid

If neither side's transition is valid from the base state, the base state is preserved:

```
Base state:     "draft"
Device A:       "delivered"   (invalid: draft -> delivered)
Device B:       "shipped"     (invalid: draft -> shipped)

Merged result:  "draft"       (base state preserved)
```

A constraint violation is recorded in the `MergeTrace` for DevTools inspection.

### Merge Summary

| Local Valid | Remote Valid | Result |
|-------------|-------------|--------|
| Yes | Yes | LWW (later timestamp wins) |
| Yes | No | Local wins |
| No | Yes | Remote wins |
| No | No | Base state preserved |

All merge decisions are deterministic. Given the same operations, every device produces the same result.

## Example: Order Workflow

A complete order lifecycle with terminal states:

```typescript
export default defineSchema({
  version: 1,
  collections: {
    orders: {
      fields: {
        customerName: t.string(),
        total: t.number(),
        status: t.enum([
          'draft',
          'submitted',
          'approved',
          'shipped',
          'delivered',
          'cancelled',
        ]).default('draft'),
        notes: t.string().optional(),
      },
      stateMachine: {
        field: 'status',
        transitions: {
          draft: ['submitted', 'cancelled'],
          submitted: ['approved', 'cancelled'],
          approved: ['shipped'],
          shipped: ['delivered'],
          delivered: [],      // terminal
          cancelled: [],      // terminal
        },
        onInvalidTransition: 'reject',
      },
    },
  },
})
```

Usage in application code:

```typescript
// Create a new order
const order = await app.orders.insert({
  customerName: 'Alice',
  total: 42.50,
  // status defaults to 'draft'
})

// Submit the order
await app.orders.update(order.id, { status: 'submitted' })

// Approve it
await app.orders.update(order.id, { status: 'approved' })

// This would throw -- cannot skip from approved to delivered
try {
  await app.orders.update(order.id, { status: 'delivered' })
} catch (e) {
  // InvalidStateTransitionError:
  // Allowed transitions from "approved": shipped
}

// Correct path: ship first, then deliver
await app.orders.update(order.id, { status: 'shipped' })
await app.orders.update(order.id, { status: 'delivered' })
```

## Example: Task Status with Cancel-from-Anywhere

Some workflows allow certain transitions from any state. Define those by listing the target in every source state:

```typescript
export default defineSchema({
  version: 1,
  collections: {
    tasks: {
      fields: {
        title: t.string(),
        assignee: t.string().optional(),
        status: t.enum(['todo', 'in_progress', 'review', 'done', 'cancelled'])
          .default('todo')
          .transitions({
            todo: ['in_progress', 'cancelled'],
            in_progress: ['review', 'todo', 'cancelled'],
            review: ['done', 'in_progress', 'cancelled'],
            done: ['todo'],            // can reopen
            cancelled: ['todo'],       // can reopen
          }),
      },
      stateMachine: {
        field: 'status',
        transitions: {
          todo: ['in_progress', 'cancelled'],
          in_progress: ['review', 'todo', 'cancelled'],
          review: ['done', 'in_progress', 'cancelled'],
          done: ['todo'],
          cancelled: ['todo'],
        },
        onInvalidTransition: 'last-valid-state',
      },
    },
  },
})
```

With `onInvalidTransition: 'last-valid-state'`, a stale UI that tries to move a task from `review` to `in_progress` when it has already been marked `done` will silently keep the `done` state instead of throwing an error. The user can then see the current state and take the correct action.

## Schema Validation

Kora validates state machine definitions at app initialization time:

- The `field` must reference an existing enum field in the collection.
- Every state in the `transitions` map (both source and target) must be a valid enum value.
- `onInvalidTransition` must be either `'reject'` or `'last-valid-state'`.

Invalid definitions throw a `SchemaValidationError` with a clear message indicating what is wrong:

```
State machine transition source "pending" is not a valid enum value
for field "status" in collection "orders".
Valid values: draft, submitted, approved, shipped, delivered, cancelled
```

## Inspecting in DevTools

State machine merge decisions appear in the [DevTools Conflict Inspector](/guide/devtools) with strategy names like:

- `state-machine-lww` -- both sides valid, resolved by timestamp
- `state-machine-valid-wins` -- one valid transition beat an invalid one
- `state-machine-both-invalid` -- both transitions invalid, base state preserved

Each trace includes the base state, both attempted transitions, the allowed targets, and the final resolved value.
