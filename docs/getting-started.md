# Getting Started

Get from zero to a working offline-first app in under 5 minutes.

## Quick Start

Scaffold a new project with a single command:

```bash
npx create-kora-app my-app
```

You will be prompted to choose a template and package manager:

```
Kora.js - Offline-first application framework

? Select a template:
  > React + Tailwind (with sync)    # Recommended — polished UI with real-time sync
    React + Tailwind (local-only)   # Tailwind CSS, no sync server
    React + CSS (with sync)         # Plain CSS with sync server
    React + CSS (local-only)        # Plain CSS, local-only

? Package manager:
  > pnpm
    npm
    yarn
    bun
```

You can also skip the prompts entirely:

```bash
npx create-kora-app my-app --yes  # Uses recommended defaults
```

Once scaffolding completes:

```bash
cd my-app
pnpm install
pnpm dev
```

Your app is running. Everything works offline out of the box.

## Manual Setup

If you prefer to add Kora to an existing project:

```bash
pnpm add kora @korajs/react
```

## Project Structure

A scaffolded Kora project looks like this:

```
my-app/
  src/
    schema.ts         # Your data schema
    app.ts            # Kora app instance
    main.tsx          # React entry point
    components/       # Your UI components
  kora.config.ts      # Optional: sync and DevTools config
  package.json
```

## Define Your Schema

The schema is the single source of truth for your data model. Create `src/schema.ts`:

```typescript
import { defineSchema, t } from 'korajs'

export default defineSchema({
  version: 1,

  collections: {
    todos: {
      fields: {
        title: t.string(),
        completed: t.boolean().default(false),
        createdAt: t.timestamp().auto(),
      },
      indexes: ['completed', 'createdAt'],
    },
  },
})
```

Key points:

- **`defineSchema`** validates your schema and generates TypeScript types.
- **`t.string()`**, **`t.boolean()`**, etc. are field type builders that support chaining (`.default()`, `.optional()`, `.auto()`).
- **`indexes`** improve query performance on the listed fields.
- **`version`** tracks schema changes for migrations.

## Create the App

Create `src/app.ts`:

```typescript
import { createApp } from 'korajs'
import schema from './schema'

export const app = createApp({ schema })
```

That is the entire setup for a local-only app. No database configuration, no storage boilerplate. Kora uses SQLite WASM with OPFS under the hood and falls back to IndexedDB automatically.

## CRUD Operations

With your app instance, you can immediately perform operations on your collections:

```typescript
import { app } from './app'

// Insert a record
const todo = await app.todos.insert({
  title: 'Ship Kora v1',
  // completed defaults to false
  // createdAt is set automatically
})
// => { id: '01905e5a-...', title: 'Ship Kora v1', completed: false, createdAt: 1712188800000 }

// Find by ID
const found = await app.todos.findById(todo.id)

// Update (partial — only the fields you pass)
await app.todos.update(todo.id, { completed: true })

// Query with filters
const active = await app.todos
  .where({ completed: false })
  .orderBy('createdAt', 'desc')
  .limit(10)
  .exec()

// Count
const count = await app.todos.where({ completed: false }).count()

// Delete
await app.todos.delete(todo.id)
```

Every operation works offline. Data is persisted to the local store immediately.

## Use with React

Wrap your app in `KoraProvider` and use hooks to access data reactively:

```tsx
import { KoraProvider, useQuery, useMutation } from '@korajs/react'
import { app } from './app'

function App() {
  return (
    <KoraProvider app={app}>
      <TodoList />
    </KoraProvider>
  )
}

function TodoList() {
  // Reactive query — re-renders when data changes
  const todos = useQuery(
    app.todos.where({ completed: false }).orderBy('createdAt')
  )

  const addTodo = useMutation(app.todos.insert)

  return (
    <div>
      <button onClick={() => addTodo({ title: 'New todo' })}>
        Add Todo
      </button>
      <ul>
        {todos.map((todo) => (
          <li key={todo.id}>{todo.title}</li>
        ))}
      </ul>
    </div>
  )
}
```

`useQuery` returns data synchronously from the local store. There are no loading spinners for local data because the data is always available.

## Enable Sync

To sync data across devices, add a single `sync` property to your app config:

```typescript
import { createApp } from 'korajs'
import schema from './schema'

export const app = createApp({
  schema,
  sync: {
    url: 'wss://my-server.com/kora',
  },
})
```

That is it. Kora handles connection management, conflict resolution, and operation syncing automatically. When the device is offline, operations queue locally and sync when connectivity returns.

For details on running the sync server, see [Deployment](/guide/deployment).

## What's Next

- [Schema Design](/guide/schema-design) — Field types, relations, and versioning
- [Offline Patterns](/guide/offline-patterns) — Building UIs that embrace offline-first
- [Conflict Resolution](/guide/conflict-resolution) — How Kora handles concurrent edits
- [React Hooks](/guide/react-hooks) — Full reference for all React bindings
- [Sync Configuration](/guide/sync-configuration) — Auth, scopes, encryption, and transports
- [DevTools](/guide/devtools) — Debugging with the Kora browser extension
