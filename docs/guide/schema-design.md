---
title: Schema Design
description: "Design Kora.js schemas: field types and modifiers, inferred types, the value domain, names, indexes, relations, state machines, constraints and migrations."
---

# Schema Design

The schema is the single source of truth for your data. Kora uses it to type your collections,
create local tables, validate every write, merge concurrent edits and run migrations.

## Defining a schema

<!-- docs-check: file schema.ts -->
```ts
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
        notes: t.richtext().optional(),
        dueDate: t.timestamp().optional(),
        createdAt: t.timestamp().auto(),
      },
      indexes: ['completed', 'dueDate'],
    },
  },
})
```

`defineSchema` validates the schema when it runs (at app start) and throws a
`SchemaValidationError` naming the problem. It keeps the exact builder types, so
`createApp({ schema })` returns typed collections with no code generation.

### Organizing large schemas

Keep `src/schema.ts` as the entry point and define each collection next to the feature that owns
it, the way the templates do (`src/modules/todos/todo.schema.ts`, plus `todo.queries.ts`,
`todo.mutations.ts` and a framework binding such as `useTodos.ts`). A collection definition is a
plain object; compose them in `defineSchema`:

<!-- docs-check: file modules/users/user.schema.ts -->
```ts
import { t } from 'korajs'

export const users = {
  fields: {
    email: t.string(),
    name: t.string(),
    role: t.enum(['admin', 'member']).default('member'),
  },
  indexes: ['email'],
}
```

<!-- docs-check: file schema-composed.ts -->
```ts
import { defineSchema, t } from 'korajs'
import { users } from './modules/users/user.schema'

export default defineSchema({
  version: 1,
  collections: {
    users,
    posts: {
      fields: { userId: t.string(), title: t.string(), published: t.boolean().default(false) },
    },
  },
  relations: {
    postAuthor: { from: 'posts', to: 'users', type: 'many-to-one', field: 'userId', onDelete: 'cascade' },
  },
})
```

Kora does not own routing or app structure: use any router and organize code as your framework
prefers.

## Field types

| Builder | Reads as | Notes |
|---------|----------|-------|
| `t.string()` | `string` | Any string, including U+0000 and lone surrogates. |
| `t.number()` | `number` | A finite double. `NaN` and `±Infinity` are refused; `-0` is stored as `0`. |
| `t.boolean()` | `boolean` | |
| `t.enum([...])` | the literal union | One of the declared values. `.transitions()` makes it a [state machine](#state-machines). |
| `t.timestamp()` | `number` | Integer milliseconds since the epoch, within the `Date` range. A `Date` object is refused, and a fraction is refused, not rounded: use `date.getTime()` or `Math.round`. |
| `t.array(item)` | `Item[]` | A dense array of the item type, nested at most 64 levels. Merges per element (see [Conflict Resolution](/guide/conflict-resolution#arrays)). |
| `t.object({...})` | the declared shape | A plain object whose declared keys follow their own builders. Merges per top-level key. |
| `t.json<T>()` | `T` | Any JSON value. `T` is compile-time only, not validated. Merges per top-level key when it is an object. |
| `t.richtext()` | `Uint8Array` | Collaborative text (Yjs). Write a string or Yjs update bytes; read the Yjs state. Edit it with `useRichText`. |
| `t.blob()` | `BlobRef` | A reference to content-addressed bytes in the blob store (`app.blobs`); the bytes travel out of band. |
| `t.secret()` | `string` | Redacted from merge traces, DevTools and logs; stored encrypted (default, `.encrypted()`) or as a one-way hash (`.hashed()`, for passwords). |

Every field is **required** on insert unless it has `.optional()`, `.default(value)` or `.auto()`.
This includes `t.richtext()`: give it `.optional()` (or a default text) when records are created
without one.

### Modifiers

| Modifier | Effect |
|----------|--------|
| `.optional()` | May be omitted on insert; reads may return `null`; `update(id, { field: null })` clears it. |
| `.default(value)` | Used when the field is omitted on insert. Typed by the field: `t.number().default('x')` is a compile error. |
| `.auto()` | Set by Kora, never by you. `t.timestamp().auto()` holds the insert time (from the HLC wall clock). |
| `.merge(strategy)` | How concurrent writes merge: `'lww'`, `'counter'`, `'max'`, `'min'`, `'union'` (arrays, the default), `'append-only'` (arrays), `'server-authoritative'`. See [Conflict Resolution](/guide/conflict-resolution#merge-strategies). |
| `.transitions(map)` | Enums only: the allowed state changes. |
| `.hashed()` / `.encrypted()` | Secrets only: at-rest protection. |

## Inferred types

`createApp({ schema })` types every collection from the schema:

| Field | Record (read) type | `insert()` | `update()` |
|-------|--------------------|------------|------------|
| required | `T` | required | `T` |
| `.optional()` | `T \| null` | may be omitted (`null` is refused: omit the key) | `T \| null` |
| `.default(v)` | `T \| null` | may be omitted | `T \| null` |
| `t.timestamp().auto()` | `number` | cannot be set | cannot be set |
| `t.number()` / `t.timestamp()` | `number` | | also `op.increment`, `op.max`, `op.min` |
| `t.array(item)` | `Item[]` | | also `op.append`, `op.remove` |
| `t.richtext()` | `Uint8Array` | `string \| Uint8Array \| ArrayBuffer` | same as insert |

Every record also has `id: string`, `createdAt: number` and `updatedAt: number`. A defaulted
field reads as `T | null` because an update can clear it with `null`.

<!-- docs-check-prelude
import { createApp } from 'korajs'
import schema from './schema'
const app = createApp({ schema })
-->

```ts
import type { CollectionInsertOf, CollectionRecordOf } from 'korajs'

type Todo = CollectionRecordOf<typeof app, 'todos'>
type NewTodo = CollectionInsertOf<typeof app, 'todos'>

const draft: NewTodo = { title: 'Write the docs', tags: ['docs'] }
const todo: Todo = await app.todos.insert(draft)
const open = await app.todos.where({ completed: false, priority: { $in: ['high', 'medium'] } }).exec()
```

`where()` accepts the collection's fields plus `id`, `createdAt` and `updatedAt`, with values of
the field's type or the operators `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte` and `$in`
(comparisons on numbers and strings only). `orderBy()` accepts the same keys and `include()` only
the schema's relations.

<!-- docs-check-prelude
import { createApp, defineSchema, t } from 'korajs'
-->

## The value domain

Every value the local API accepts is stored and synced unchanged by every built-in store (client
SQLite and IndexedDB; server memory, SQLite and Postgres) and transport. The domain is checked
where a value is written (`insert`, `update`, and the result of an atomic op such as
`op.increment`) and again by the sync server for every uploaded or route-written operation. A
value outside it is refused up front with a `SchemaValidationError` naming the field and the fix,
and nothing is written. The server refuses such an operation on its own
(`SCHEMA_VALIDATION_ERROR`, per operation), so it never blocks a device's later writes.

| Field type | Accepted values | Client SQLite / IndexedDB | Server SQLite | Server Postgres | Wire |
|---|---|---|---|---|---|
| `t.string()` | any string, including U+0000 and lone surrogates | TEXT / string | TEXT (lossless text codec) | TEXT (lossless text codec) | JSON string |
| `t.enum()` | one of the declared values | TEXT / string | TEXT | TEXT | JSON string |
| `t.number()` | a finite double (`NaN` and `±Infinity` refused; `-0` becomes `0`) | REAL / number | REAL | DOUBLE PRECISION | JSON number |
| `t.boolean()` | `true` / `false` | INTEGER 0/1 / boolean | INTEGER | INTEGER | JSON boolean |
| `t.timestamp()` | integer milliseconds in `[-8.64e15, 8.64e15]` (fractions refused) | INTEGER / number | INTEGER | BIGINT | JSON number |
| `t.array()` | a dense array of the item type's values, nested at most 64 levels | TEXT (JSON) / array | TEXT (JSON) | JSONB | JSON array |
| `t.object()` | a plain object; declared keys follow their own type | TEXT (JSON) / object | TEXT (JSON) | JSONB | JSON object |
| `t.json()` | any JSON value: finite numbers, no `__proto__` key, nested at most 64 levels, and not exactly `{ __kora_bytes__: ... }` (the wire's binary form) | TEXT (JSON) / value | TEXT (JSON) | JSONB | JSON |
| `t.blob()` | a `BlobRef` from the blob store | TEXT (JSON) | TEXT | TEXT | JSON object |
| `t.secret()` | a string (stored hashed or encrypted) | TEXT | TEXT | TEXT | JSON string |
| `t.richtext()` | Yjs update bytes or a string | BLOB / bytes | BLOB | BYTEA | bytes (`{ $koraBytes }` in JSON) |

One known gap: the client SQLite store turns a lone surrogate inside a string into U+FFFD (the
server stores it losslessly). Range filters and `orderBy` on strings that contain U+0000, U+FFFF
or a lone surrogate order them by their stored escape, not by JavaScript order.

### How values are normalized

The operation log and the wire are JSON, and an operation's id is a hash of its body, so every
write is put in one canonical form when it is created. What you write is exactly what is hashed,
stored, synced and merged:

| You write | It becomes |
|-----------|------------|
| `undefined` for a field in `insert` | the field is absent (its default applies) |
| `update(id, { field: undefined })` | `null`: the field is **cleared** |
| `undefined` inside an object value | absent (as `JSON.stringify` drops it); a `t.json()` field refuses it |
| `undefined` array element | `null` |
| `-0` | `0` |
| a valid `Date` inside a json or object value | its ISO 8601 string |
| `Uint8Array` / `ArrayBuffer` (rich text) | bytes |
| `Map`, `Set`, class instances, functions, `BigInt`, `NaN`, `±Infinity`, invalid dates, objects with `toJSON`, an own `__proto__` key, cycles, sparse arrays | refused (`SchemaValidationError` from `NON_CANONICAL_VALUE`, naming the path) |

### Operation size

One write produces one operation, which must fit the sync server's `maxOperationBytes` (default
256 KiB of operation JSON). The local store checks it before the write is accepted
(`OperationTooLargeError`, nothing written); set `store.maxOperationBytes` in `createApp` to the
server's value when you change it there. Store large content in a blob (`t.blob()`).

## Names

- **Collections**: a letter, then letters, digits and underscores. Case is kept (`formResponses`,
  `UserProfiles`). Names starting with `_` are Kora's own.
- **Fields**: a lowercase letter, then letters, digits and underscores (`dueDate`). `id`,
  `_created_at`, `_updated_at`, `_version` and `_deleted` are reserved.
- **`createdAt` and `updatedAt`** are on every record and can always be filtered and sorted on,
  declared or not: they map to the record's own creation and last-update times. A schema field of
  the same name (`createdAt: t.timestamp().auto()`) takes precedence.
- **App properties.** `app.<collection>` works for every collection except names the app object
  already uses: `ready`, `events`, `on`, `collections`, `sync`, `encryption`, `sequences`,
  `blobs`, `storage`, `getStore`, `getSyncEngine`, `getQueryStoreCache`, `storeInfo`, `close`,
  `transaction`, `mutation`, `exportBackup`, `importBackup`, `replayTo` and `exportAudit`
  (exported as `RESERVED_APP_PROPERTIES`). Reach such a collection through
  `app.collections.<name>` (and `tx.<name>` in a transaction, which has no reserved names). In
  development, `createApp` warns once about every shadowed name.

## Indexes

```ts
const schema = defineSchema({
  version: 1,
  collections: {
    todos: {
      fields: { title: t.string(), assignee: t.string().optional(), dueDate: t.timestamp().optional() },
      indexes: ['assignee', 'dueDate'],
    },
  },
})
```

Kora creates a local SQLite index for each listed field. `id` is always the primary key.

## Relations

Relations are declared at the top level. `field` is the foreign key on the `from` collection:

```ts
const schema = defineSchema({
  version: 1,
  collections: {
    projects: { fields: { name: t.string() } },
    todos: { fields: { title: t.string(), projectId: t.string().optional() } },
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

| Property | Values |
|----------|--------|
| `type` | `'many-to-one'`, `'one-to-many'`, `'one-to-one'`, `'many-to-many'` |
| `onDelete` | `'cascade'` (delete the children), `'set-null'` (clear their foreign key), `'restrict'` (refuse the delete while children exist), `'no-action'` (leave them) |

How deletes are enforced:

- **On the device that deletes.** `restrict` refuses the delete locally (`ReferentialIntegrityError`,
  `REFERENTIAL_INTEGRITY`); `cascade` and `set-null` write the effects as that device's own
  operations, in the same transaction, and they sync.
- **On devices that receive the delete.** The effects are applied locally only (never uploaded),
  until the copy authored by the deleting device or the server arrives, so the log holds one
  cascade per child however many devices apply the delete.
- **On the server**, which is the authority. It refuses a delete whose effects would reach
  records outside the writer's scope, or that a `restrict` relation forbids, with the generic
  `RESTRICTED` code (no ids or counts leak). When a child is written concurrently under a parent
  that was deleted, the server corrects it: `cascade` deletes the child, `set-null` clears the
  foreign key, and `restrict` revives the parent. Corrections are ordinary operations that reach
  every device.
- **With end-to-end encryption**, the foreign key of every `cascade`, `set-null` or `restrict`
  relation must be listed in `cleartextFields`, or `createApp` refuses to start
  (`SealedRelationFieldError`, `SEALED_RELATION_FIELD`). Use `onDelete: 'no-action'` for a
  relation whose key must stay sealed. See [Sync Encryption](/guide/sync-encryption#foreign-keys-of-enforced-relations-must-be-cleartext).

Load related records with `include()`:

<!-- docs-check: continue -->
```ts
const app = createApp({ schema })
const rows = await app.todos.where({}).include('project').exec()
const name: string | undefined = rows[0]?.project?.name
```

Including a many-to-one relation adds the parent (or `null`) under its singular name
(`project`); including a one-to-many relation from the parent side adds an array of children
(`app.projects.where({}).include('todos')` adds `todos`).

## State machines

An enum with `.transitions()` only accepts the listed state changes:

```ts
const schema = defineSchema({
  version: 1,
  collections: {
    orders: {
      fields: {
        status: t
          .enum(['draft', 'submitted', 'approved', 'shipped', 'cancelled'])
          .default('draft')
          .transitions({
            draft: ['submitted', 'cancelled'],
            submitted: ['approved', 'cancelled'],
            approved: ['shipped', 'cancelled'],
            shipped: [],
            cancelled: [],
          }),
      },
    },
  },
})
```

Local writes are validated: `update(id, { status: 'shipped' })` on a draft throws
`InvalidStateTransitionError` (`INVALID_STATE_TRANSITION`), in transactions and migration backfills
too. A collection-level `stateMachine: { field, transitions, onInvalidTransition }` does the
same and can choose `'last-valid-state'`, which drops an invalid change of the field instead of
throwing.

Transitions are checked on the writing device only. Concurrent changes from two devices merge
last-write-wins by HLC like any enum, so two individually valid changes can meet in an order the
map does not list (draft to cancelled on one device, draft to submitted to approved on another).
When the order matters across devices, validate on the server with `validateOperation` (see
[Server-side Validation](/guide/server-side-validation)) or make the field
`.merge('server-authoritative')` and change it through a server route. See
[State Machines](/guide/state-machines).

## Constraints

Rules that span records (`unique`, `capacity`, `referential`) are declared per collection as a
list and enforced by the sync server, which refuses a violating write
(`CONSTRAINT_VIOLATION`) or, for a race between two writes, corrects the loser. Devices check them
optimistically and report `constraint:violated`. See
[Conflict Resolution](/guide/conflict-resolution#constraints).

```ts
const schema = defineSchema({
  version: 1,
  collections: {
    seats: {
      fields: { eventId: t.string(), seatNumber: t.string(), claimedBy: t.string().optional() },
      constraints: [{ type: 'unique', fields: ['eventId', 'seatNumber'], onConflict: 'first-write-wins' }],
    },
  },
})
```

## Sync scopes

A collection's `scope` lists the fields that decide which records a user syncs, and the
top-level `sync` rules bind them to values the server grants:

```ts
const schema = defineSchema({
  version: 1,
  collections: {
    todos: { fields: { title: t.string(), userId: t.string(), orgId: t.string() } },
  },
  sync: {
    todos: { where: { userId: true, orgId: true } },
  },
})
```

The server grants the values from the verified identity; a client can only narrow them. See
[Authentication](/guide/authentication#sync-scopes).

<!-- docs-check-prelude -->

## Migrations

Every schema has a `version`. A change to the stored shape (a new field, a rename, a new index)
needs a new version and a migration for it, because devices already have a database at the old
version:

<!-- docs-check: file schema-v2.ts -->
```ts
import { defineSchema, migrate, t } from 'korajs'

export default defineSchema({
  version: 2,
  collections: {
    todos: {
      fields: {
        title: t.string(),
        urgent: t.boolean().default(false),
        priority: t.enum(['low', 'medium', 'high']).default('medium'),
        searchKey: t.string().optional(),
      },
    },
  },
  migrations: {
    2: migrate()
      .addField('todos', 'priority', t.enum(['low', 'medium', 'high']).default('medium'))
      .addField('todos', 'searchKey', t.string().optional())
      .addIndex('todos', 'priority')
      .backfill('todos', (record) => ({ priority: record.urgent ? 'high' : 'medium' }))
      .backfill('todos', (record) => ({ searchKey: String(record.title).toLowerCase() }), {
        localOnly: true,
      }),
  },
})
```

Steps: `addField`, `removeField`, `renameField`, `addIndex`, `removeIndex` and `backfill`.
Migration keys are the target version (2 or more, at most `version`), and each needs at least one
step. When the app opens a database at an older version:

- **One transaction per version.** A version's structural changes, all of its backfills and the
  stored schema version commit together. If a backfill throws (or the app crashes mid-way)
  nothing of that version is applied and the next open runs it again from the start, so a
  non-idempotent backfill never runs twice on the same data.
- **Typed records.** A backfill receives each live record as the app reads it (booleans, arrays,
  objects, timestamps) and returns the fields to change. Fields returned unchanged are not
  written.
- **Backfills sync.** Each changed record is written through the normal local write path as an
  update with the mutation name `migration:v<N>`, so the values reach the server and the user's
  other devices. `{ localOnly: true }` rewrites rows on this device only, without operations
  (a local cache, a derived column).
- Backfill updates pass the same checks as any update (value domain, state machines): a backfill
  that makes a transition the state machine forbids fails the migration.

### Changing a field's value domain

Adding or removing enum values, or making a field optional or required, changes which values a
write may hold, not the table. The value domain is enforced by validation on every replica
(local writes, and the sync server for every uploaded operation); tables carry no `CHECK` or
`NOT NULL` for schema fields, so a new schema version needs no structural step for it:

- **Added enum value, field made optional:** accepted everywhere as soon as the replica runs
  the new schema.
- **Removed enum value:** rows and operations that hold it keep it and read it back as written
  (other fields of those rows stay writable); new writes of it are refused
  (`SchemaValidationError`). Add a `backfill` to move old rows to a current value.
- **Field made required:** new writes need a value (or get the default); existing nulls stay
  until a `backfill` fills them.

Databases created by beta.12 and earlier restated enum values and requiredness as table
constraints, which refused values a later schema allowed. On the first open (client: SQLite,
SQLite WASM/OPFS, IndexedDB) or start (server: SQLite, Postgres) of this release, those
constraints are removed once, in one transaction (SQLite rebuilds the table keeping rows,
indexes, triggers, foreign keys and every other `CHECK`; Postgres drops the enum `CHECK` and
`NOT NULL` on schema fields). Only an enum-shaped check (one column against a list of literals)
on an enum field of the schema is Kora's; checks you added by hand, such as
`CHECK (price >= 0)`, are kept, and a table that carries only those is not rebuilt. It is
idempotent: a later open finds nothing to do.
`kora migrate` emits the same step for a value-domain change (see below).

### Devices on older versions: transforms at fold time

A sync server can accept clients of several schema versions (`supportedSchemaVersions`). An
`OperationTransform` (`{ fromVersion, toVersion, transform(op) }`) turns an operation authored
under an older version into what the newer schema reads (rename a field, fill a new one).
Operations are immutable and content-addressed, so a transform never rewrites one:

- **Stored as written, everywhere.** The server stores every operation exactly as uploaded and
  delivers that original to every client; devices store what they receive the same way.
- **Folded as the schema reads it.** Every replica merges the operation's view through the
  transform chain for its own schema version (`operationSchemaView` in `@korajs/core`). The
  server's authorization, validators, constraint checks and scope filters judge the same view.
- **The same transforms everywhere.** Pass the list to the server (`operationTransforms` in the
  server config, and `store.setSchema(schema, { operationTransforms })` to fold with it from the
  first start) and to the client (`sync.operationTransforms` in `createApp`, which hands it to the
  local store too). Transforms are part of the fold plan fingerprint: changing one re-folds every
  record once.
- **Pure and deterministic.** A transform may rewrite only `data`, `previousData`, `atomicOps`
  and `schemaVersion`, with JSON values, and must return the same result on every replica (no
  clock, randomness or I/O). Changing an operation's id, node, type, collection, record or
  timestamp is refused (`SCHEMA_TRANSFORM_INVALID`).
- **Never retire a transform.** The operation log is append-only, so operations of a source
  version exist for as long as the data does, and a transform must stay registered with them.
  A server store (`setSchema`, `setOperationTransforms`, `KoraSyncServer.start()`) and a local
  database (`app.ready`) refuse to start when a schema version in their log has no transform
  path to the current version, with `OperationTransformCoverageError`
  (`OPERATION_TRANSFORM_MISSING`) naming the versions and the missing step. Starting anyway
  would fold those operations as absent and silently erase them from their records. To fix it,
  register the retired transform again. Registering no transforms at all is also accepted
  (every operation then folds as written). This release has no compaction that folds old
  operations into snapshots, so a transform cannot yet be removed safely.
- **Older clients** receive newer operations as written; with no transform path to their version
  they quarantine them and replay them after upgrading. Encrypted operations are opaque to the
  server, which folds their cleartext fields as written; devices transform them after decryption.

### Rollbacks and the CLI

`kora migrate` diffs the schema against its last snapshot (`kora/schema.snapshot.json`) and writes the migration artifacts to `kora/migrations` (`--dry-run` previews, `--apply` applies them to the configured SQLite and Postgres databases, changing only the fields and indexes the schema changed: Kora's own columns, foreign keys, other indexes, the operation log and the fold state are kept; see [CLI](/api/cli#migrate)).
Most steps have an automatic inverse (`addField`/`removeField`, `addIndex`/`removeIndex`,
`renameField` swapped); `removeField` without a descriptor and `backfill` need an explicit
`.down(rollback => ...)`. Adding an optional or defaulted field is always safe; removing a field
or changing its type is breaking, and the CLI asks for confirmation. Removed fields stay in the
operation log.
