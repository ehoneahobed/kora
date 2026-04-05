# Schema Design

The schema is the foundation of every Kora app. It defines your collections, field types, indexes, and relations. Kora uses your schema to generate TypeScript types, create storage tables, and drive the merge engine.

## Defining a Schema

Use `defineSchema` to declare your data model:

```typescript
import { defineSchema, t } from 'kora'

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
