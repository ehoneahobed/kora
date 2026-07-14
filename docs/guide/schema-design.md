---
title: Schema Design
description: "Design Kora.js schemas: field types, defaults, enums, arrays, rich text, indexes, relations, constraints, and custom merge resolvers."
---

# Schema Design

The schema is the foundation of every Kora app. It defines your collections, field types, indexes, and relations. Kora uses your schema to generate TypeScript types, create storage tables, and drive the merge engine.

## Defining a Schema

Use `defineSchema` to declare your data model. For small apps, keeping the whole schema in
`src/schema.ts` is fine:

```typescript
import { defineSchema, t } from 'korajs'

export default defineSchema({
  version: 1,

  collections: {
    todos: {
      fields: {
        title: t.string(),
        completed: t.boolean().default(false),
        priority: t.enum(['low', 'medium', 'high']).default('medium'),
        tags: t.array(t.string()).default([]),
        notes: t.richtext(),
        dueDate: t.timestamp().optional(),
        createdAt: t.timestamp().auto(),
      },
      indexes: ['completed', 'dueDate'],
    },
  },
})
```

`defineSchema` validates your schema at app initialization time and produces full TypeScript type inference. Your IDE will autocomplete field names and type-check values on every collection operation.

## Organizing Large Schemas

For production apps, treat `src/schema.ts` as the schema entry point, not as the only place where
collection definitions can live. Keep each collection near the feature or domain that owns it, then
compose those collections in the schema entry point.

```text
src/
  modules/
    users/
      user.schema.ts
      user.queries.ts
      user.mutations.ts
      useUsers.ts
      components/
    posts/
      post.schema.ts
      post.queries.ts
      post.mutations.ts
      usePosts.ts
      components/
  schema.ts
```

Define each collection in its own file:

```typescript
// src/modules/users/user.schema.ts
import { t } from 'korajs'

export const users = {
  fields: {
    email: t.string(),
    name: t.string(),
    role: t.enum(['admin', 'member']).default('member'),
    createdAt: t.timestamp().auto(),
  },
  indexes: ['email'],
}
```

```typescript
// src/modules/posts/post.schema.ts
import { t } from 'korajs'

export const posts = {
  fields: {
    userId: t.string(),
    title: t.string(),
    body: t.richtext(),
    published: t.boolean().default(false),
    createdAt: t.timestamp().auto(),
  },
  indexes: ['userId', 'published'],
}
```

Then compose the final schema in `src/schema.ts`:

```typescript
import { defineSchema } from 'korajs'
import { posts } from './modules/posts/post.schema'
import { users } from './modules/users/user.schema'

export default defineSchema({
  version: 1,

  collections: {
    users,
    posts,
  },

  relations: {
    postAuthor: {
      from: 'posts',
      to: 'users',
      type: 'many-to-one',
      field: 'userId',
      onDelete: 'cascade',
    },
  },
})
```

This keeps Kora's type inference, migration tooling, and runtime validation working from one
canonical schema export while letting a feature-based codebase split schemas by domain. The terms in
this layout mean:

- `schema`: the data shape for a collection
- `queries`: reusable reads that do not change data
- `mutations`: reusable writes, including inserts, updates, deletes, and transactions
- `useUsers`, `usePosts`, or similar: framework-specific UI bindings; in React, these are hooks
- `components`: UI for the feature

Kora does not require controllers, services, or file-based routes. Use those patterns if your app
framework already has them, but Kora's recommended module boundary is data shape, reads, writes, UI
bindings, and components.

Prefer explicit imports from collection modules over filesystem auto-discovery; explicit composition
makes schema ownership and review diffs easier to understand.

### Queries, Mutations, and UI

Feature modules can also own reusable query builders, mutations, UI bindings, and components.
Queries should only read data:

```typescript
// src/modules/todos/todo.queries.ts
import type { CollectionAccessor } from 'korajs'

export function orderedTodos(todos: CollectionAccessor) {
  return todos.where({}).orderBy('createdAt', 'desc')
}
```

Mutations should contain writes:

```typescript
// src/modules/todos/todo.mutations.ts
import type { CollectionAccessor } from 'korajs'

export function createTodo(todos: CollectionAccessor, title: string) {
  return todos.insert({ title })
}

export function setTodoCompleted(
  todos: CollectionAccessor,
  id: string,
  completed: boolean,
) {
  return todos.update(id, { completed })
}
```

The React binding connects those reads and writes to components:

```typescript
// src/modules/todos/useTodos.ts
import { useCollection, useMutation, useQuery } from '@korajs/react'
import { createTodo, setTodoCompleted } from './todo.mutations'
import { orderedTodos } from './todo.queries'

export function useTodos() {
  const todos = useCollection('todos')
  const allTodos = useQuery(orderedTodos(todos))

  return {
    allTodos,
    createTodo: useMutation((title: string) => createTodo(todos, title)),
    setTodoCompleted: useMutation((id: string, completed: boolean) =>
      setTodoCompleted(todos, id, completed),
    ),
  }
}
```

The schema, query, and mutation files are framework-agnostic and can be reused across web, desktop,
and mobile. The binding file is framework-specific: React templates use `useTodos.ts`, while another
UI framework can use the naming convention that is idiomatic there.

Kora does not own routing. Use Next.js, React Router, TanStack Router, Remix, Expo Router, or any
other router your application needs. Route files can import feature module hooks and components, but
Kora will not generate or interpret routes.

## Field Types

Kora provides type builders through the `t` namespace. Each builder returns a typed field descriptor.

### `t.string()`

A UTF-8 text field. Stored as `TEXT` in SQLite.

```typescript
name: t.string()
```

### `t.number()`

A numeric field (integer or floating point). Stored as `REAL` in SQLite.

```typescript
price: t.number()
```

### `t.boolean()`

A true/false field. Stored as `INTEGER` (0 or 1) in SQLite.

```typescript
completed: t.boolean()
```

### `t.enum(values)`

A string field restricted to specific values. Stored as `TEXT` with a `CHECK` constraint.

```typescript
status: t.enum(['draft', 'published', 'archived'])
```

### `t.timestamp()`

A point in time, stored as `INTEGER` (milliseconds since Unix epoch) in SQLite.

```typescript
dueDate: t.timestamp()
```

### `t.array(innerType)`

An ordered list of values. Stored as `TEXT` (JSON-serialized) in SQLite. During merge, arrays use an add-wins-set strategy (union of elements).

```typescript
tags: t.array(t.string())
```

### `t.richtext()`

A CRDT-enabled rich text field backed by Yjs. Supports character-level collaborative editing with automatic merge. Stored as `BLOB` (Yjs document state) in SQLite.

```typescript
notes: t.richtext()
```

Rich text fields are the only fields that use Yjs CRDTs. All other field types use Hybrid Logical Clock last-write-wins (LWW) for conflict resolution.

## Field Modifiers

Chain modifiers onto any field type builder to control behavior.

### `.default(value)`

Set a default value used when the field is not provided during insert:

```typescript
completed: t.boolean().default(false)
priority: t.enum(['low', 'medium', 'high']).default('medium')
tags: t.array(t.string()).default([])
```

### `.optional()`

Mark a field as nullable. The field can be omitted on insert and may be `null`:

```typescript
dueDate: t.timestamp().optional()
assignee: t.string().optional()
```

Without `.optional()`, the field is required on insert (unless it has a `.default()` or `.auto()`).

### `.auto()`

The field is set automatically by Kora. The developer cannot provide a value on insert or update. Currently supported on `t.timestamp()` to capture the creation time:

```typescript
createdAt: t.timestamp().auto()
```

Auto fields are populated using the Hybrid Logical Clock, not `Date.now()`, ensuring consistent ordering across devices.

## Indexes

Declare indexes to speed up queries on specific fields:

```typescript
collections: {
  todos: {
    fields: { /* ... */ },
    indexes: ['completed', 'dueDate', 'assignee'],
  },
}
```

Kora creates SQLite indexes for each listed field. Use indexes on fields you frequently filter or sort by. You do not need an index on `id` -- it is always indexed as the primary key.

## Relations

Define relationships between collections in the top-level `relations` object:

```typescript
export default defineSchema({
  version: 1,

  collections: {
    projects: {
      fields: {
        name: t.string(),
        createdAt: t.timestamp().auto(),
      },
    },

    todos: {
      fields: {
        title: t.string(),
        projectId: t.string().optional(),
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

### Relation Properties

| Property | Description |
|----------|-------------|
| `from` | The collection that holds the foreign key |
| `to` | The referenced collection |
| `type` | `'many-to-one'` or `'one-to-many'` |
| `field` | The foreign key field on the `from` collection |
| `onDelete` | What happens when the referenced record is deleted |

### `onDelete` Strategies

| Strategy | Behavior |
|----------|----------|
| `'set-null'` | Set the foreign key to `null` |
| `'cascade'` | Delete the referencing records |
| `'restrict'` | Prevent deletion if references exist |
| `'no-action'` | Do nothing (may leave dangling references) |

### Querying Relations

Use `.include()` to load related data:

```typescript
const todosWithProject = await app.todos
  .where({ completed: false })
  .include('project')
  .exec()

// Each todo now has a `project` property with the related record
```

## State Machine Fields

Enum fields can be turned into state machines by declaring allowed transitions. This constrains which state changes are valid, both for local mutations and during merge conflict resolution.

```typescript
status: t.enum(['draft', 'submitted', 'approved', 'shipped', 'cancelled'])
  .default('draft')
  .transitions({
    draft: ['submitted', 'cancelled'],
    submitted: ['approved', 'cancelled'],
    approved: ['shipped', 'cancelled'],
    shipped: [],       // terminal state
    cancelled: [],     // terminal state
  })
```

When a state machine is defined:

- **Local mutations** are validated: attempting `draft → shipped` throws `InvalidStateTransitionError`
- **Merge conflicts** are resolved intelligently: valid transitions beat invalid ones, and both-valid conflicts use LWW
- **`onInvalidTransition`** controls behavior: `'reject'` (default) throws an error, `'last-valid-state'` silently keeps the current state

See the [State Machines guide](/guide/state-machines) for full details.

## Merge Strategies

You can override the default merge behavior for any field using `.merge()`:

```typescript
fields: {
  quantity: t.number().merge('counter'),       // additive merge
  highScore: t.number().merge('max'),          // keep maximum
  auditLog: t.array(t.string()).merge('append-only'), // no removals
}
```

See [Conflict Resolution](/guide/conflict-resolution#schema-level-merge-strategies) for all available strategies.

## Schema Versioning

Every schema has a `version` number. When you change your schema, increment the version:

```typescript
export default defineSchema({
  version: 2,  // was 1

  collections: {
    todos: {
      fields: {
        title: t.string(),
        completed: t.boolean().default(false),
        priority: t.enum(['low', 'medium', 'high']).default('medium'),  // new field
      },
    },
  },
})
```

### Generating Migrations

Use the CLI to detect changes and generate a migration:

```bash
kora migrate
```

```
Detected schema change: v1 -> v2

Changes:
  + todos.priority (enum: low, medium, high, default: medium)

Generated migration: kora/migrations/002-add-priority.ts

? Apply migration to local store? (y/n)
```

Kora tracks the schema version on every operation. When syncing with clients on different schema versions, operations are transformed to maintain compatibility.

### Programmatic Migrations

You can define migrations in code using the `MigrationBuilder`:

```typescript
import { defineSchema, t, migrate } from 'korajs'

export default defineSchema({
  version: 2,
  collections: { /* ... */ },
  migrations: {
    2: migrate()
      .addField('todos', 'priority', t.enum(['low', 'medium', 'high']).default('medium'))
      .addIndex('todos', 'priority')
      .backfill('todos', (record) => ({
        ...record,
        priority: record.urgent ? 'high' : 'medium',
      })),
  },
})
```

### Migration Rollbacks

Kora can auto-generate rollback steps for most migration operations:

| Forward Step | Auto-Rollback |
|-------------|---------------|
| `addField` | `removeField` |
| `addIndex` | `removeIndex` |
| `removeIndex` | `addIndex` |
| `renameField` | `renameField` (swapped) |
| `removeField` | Requires explicit `.down()` |
| `backfill` | Requires explicit `.down()` |

For steps that cannot be auto-reversed, provide an explicit rollback:

```typescript
migrate()
  .removeField('todos', 'legacyNotes')
  .down((rollback) =>
    rollback.addField('todos', 'legacyNotes', t.string().optional())
  )
```

### Migration Safety

- Adding a field with a default is always safe.
- Adding an optional field is always safe.
- Removing a field or changing a field type is a breaking change. The CLI will warn you and ask for confirmation.
- Kora never drops data during migration. Removed fields are preserved in the operation log.

## Type Inference

Kora generates full TypeScript types from your schema. After defining your schema:

```typescript
// The type of a todo record is inferred automatically:
// {
//   id: string
//   title: string
//   completed: boolean
//   priority: 'low' | 'medium' | 'high'
//   tags: string[]
//   dueDate?: number | null
//   createdAt: number
// }

const todo = await app.todos.insert({
  title: 'Ship v1',
  // IDE autocompletes all field names
  // TypeScript catches type errors at compile time
})
```

You can also generate type files explicitly:

```bash
kora generate types
```

This outputs a `kora/generated/types.ts` file you can import if needed, but in most cases the inference from `defineSchema` is sufficient.
