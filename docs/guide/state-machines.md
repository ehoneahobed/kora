---
title: State Machines
description: "Model workflow states safely in offline-first apps: field transitions and state machine validation in Kora.js schemas."
---

# State Machines

Kora supports state machines on enum fields. A state machine constrains which transitions a
device may write: an order goes from `draft` to `submitted` to `approved`, but a device can never
jump it from `draft` to `delivered`.

## What is enforced where

- **Local writes** (`update`, transactions, migration backfills) are validated against the
  record's current local value. An invalid transition is refused (or, in `'last-valid-state'`
  mode, dropped) before it produces an operation.
- **Concurrent writes** from different devices are merged by the per-field fold, which treats the
  state field like any enum: the later write by HLC wins. The fold does not re-check transitions,
  so two individually valid changes can meet in an order the map does not list (see
  [Concurrent changes](#concurrent-changes)).
- **The sync server** does not check transitions on its own. Add a `validateOperation` rule, or
  make the field `server-authoritative`, when the order must hold across devices.

<!-- docs-check-prelude
import { defineSchema, t } from 'korajs'
-->

## Defining Transitions

There are two ways to define state machine transitions: on the field itself using `.transitions()`, or at the collection level using the `stateMachine` property.

### Field-Level Transitions

The simplest approach is to call `.transitions()` on an enum field builder:

```typescript
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

Each key in the transitions map is a source state, and the array contains the allowed target states. An empty array means the state is terminal: no further transitions are possible. A field-level map always uses the `'reject'` mode.

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

The collection-level form also chooses `onInvalidTransition`. When both are declared for the same field, the collection-level machine is used.

## Invalid Transition Behavior

The `onInvalidTransition` option controls what happens when a local mutation attempts a transition that is not in the allowed list:

### `'reject'` (default)

Throws an `InvalidStateTransitionError` (code `INVALID_STATE_TRANSITION`) with a clear message:

```
Invalid state transition in collection "orders":
cannot transition field "status" from "draft" to "delivered".
Allowed transitions from "draft": submitted, cancelled
```

The error includes the collection name, record ID, field name, current state, attempted state, and the list of allowed targets. Use this when invalid transitions indicate a bug in the application logic.

### `'last-valid-state'`

Silently ignores the invalid transition. The state field keeps its current value, and the rest of the update (other fields) is applied normally.

```typescript
const lenient = defineSchema({
  version: 1,
  collections: {
    orders: {
      fields: {
        status: t.enum(['draft', 'submitted', 'approved', 'cancelled']).default('draft'),
      },
      stateMachine: {
        field: 'status',
        transitions: {
          draft: ['submitted', 'cancelled'],
          submitted: ['approved', 'cancelled'],
          approved: [],
          cancelled: [],
        },
        onInvalidTransition: 'last-valid-state',
      },
    },
  },
})
```

Use this when you want the system to be lenient: for example, when users might attempt impossible transitions due to stale UI state, and you prefer to silently preserve the current state rather than show an error.

## Local Mutation Validation

State machine transitions are validated during `update()` calls. The validator checks:

1. Whether the update includes the state machine field.
2. If so, what the current value of that field is on the existing record.
3. Whether the transition from the current value to the new value is in the allowed list.

Same-state transitions (e.g., `submitted` to `submitted`) are always valid. This makes idempotent updates safe.

For `insert()` calls, any valid enum value is accepted as the initial state. The state machine only constrains transitions from one state to another, not which state a new record starts in.

<!-- docs-check-prelude
import { createApp, defineSchema, t } from 'korajs'
const app = createApp({
  schema: defineSchema({
    version: 1,
    collections: {
      orders: {
        fields: {
          title: t.string().optional(),
          customerName: t.string().optional(),
          total: t.number().optional(),
          status: t.enum(['draft', 'submitted', 'approved', 'shipped', 'delivered', 'cancelled']).default('draft'),
        },
      },
    },
  }),
})
declare const id: string
-->

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

## Concurrent changes

Two devices that change the same state field while apart each pass local validation; when they
sync, every replica keeps the later write by HLC (the state field merges like any enum):

```
Base state:  "submitted" on both devices
Device A:    submitted -> approved -> shipped   (valid locally)
Device B:    submitted -> cancelled             (valid locally, written last)
Every replica: "cancelled"
```

Every replica agrees, but the history `shipped -> cancelled` is not in the map. When that matters:

- **Validate on the server.** A `validateOperation` rule sees the stored record and the incoming
  operation and can refuse a change whose `previousData` no longer matches the stored state
  (the writer saw a stale value). The device learns it through `sync:operation-rejected`, and the
  refused write is undone on its author. See [Server-side Validation](/guide/server-side-validation).
- **Let the server decide.** `t.enum([...]).merge('server-authoritative')` makes server writes win;
  devices request a transition through a server route that checks the current state.
- **Model the decision as data.** Record each device's request (an `approvals` collection) and
  derive the state from the requests.

## Example: Order Workflow

A complete order lifecycle with terminal states:

<!-- docs-check: standalone -->
```typescript
import { defineSchema, t } from 'korajs'

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

// This would throw: cannot skip from approved to delivered
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

<!-- docs-check-prelude
import { defineSchema, t } from 'korajs'
-->

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

A refused local transition throws before anything is written, so it never reaches DevTools.
Concurrent changes of a state field appear in the [Conflict Inspector](/guide/devtools) like any
last-write-wins decision (strategy `lww`), with both values and the winner.
