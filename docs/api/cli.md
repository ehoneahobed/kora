# CLI Reference

The Kora CLI provides commands for creating, developing, and managing Kora.js applications. It includes project scaffolding, a development server, schema migration tools, and type generation.

## Installation

The CLI is included when you install `kora` or can be installed standalone:

```bash
# Included with kora
pnpm add kora

# Or install standalone
pnpm add -D @korajs/cli
```

---

## kora create

Scaffolds a new Kora.js application from a template.

### Usage

```bash
npx create-kora-app [name] [options]
```

Or if the CLI is installed:

```bash
kora create [name] [options]
```

### Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | No | Project directory name. If omitted, you will be prompted. |

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--template` | `string` | -- | Template to use. Skips the template selection prompt. |
| `--pm` | `string` | -- | Package manager (`pnpm`, `npm`, `yarn`, `bun`). Skips the package manager prompt. |
| `--yes`, `-y` | `boolean` | `false` | Accept all defaults (recommended template + auto-detected package manager). |
| `--tailwind` / `--no-tailwind` | `boolean` | -- | Use Tailwind CSS or plain CSS. Skips styling prompt. |
| `--sync` / `--no-sync` | `boolean` | -- | Include sync server or not. Skips sync prompt. |
| `--no-install` | `boolean` | `false` | Skip installing dependencies. |
| `--no-git` | `boolean` | `false` | Skip initializing a git repository. |

### Templates

| Template | Styling | Sync | Description |
|----------|---------|------|-------------|
| `react-tailwind-sync` | Tailwind CSS | Yes | **Recommended.** Polished dark-themed UI with real-time sync. |
| `react-tailwind` | Tailwind CSS | No | Tailwind CSS with local-only storage. |
| `react-sync` | Plain CSS | Yes | Clean CSS with sync server. |
| `react-basic` | Plain CSS | No | Minimal setup with local-only storage. |

All templates include DevTools enabled by default, SQLite WASM persistence, and a todo app with stats, filters, and a polished UI.

### Interactive flow

When run without options, the CLI prompts for configuration:

```
$ npx create-kora-app my-app

  Kora.js - Offline-first application framework

  ? Select a template:
    > React + Tailwind (with sync)    (Recommended)
      React + Tailwind (local-only)
      React + CSS (with sync)
      React + CSS (local-only)

  ? Package manager:
    > pnpm
      npm
      yarn
      bun

  Creating my-app...
  Installing dependencies...

  Done! Next steps:
    cd my-app
    pnpm dev
```

### Non-interactive usage

```bash
# Use a specific template
npx create-kora-app my-app --template react-tailwind-sync --pm pnpm

# Accept all defaults (react-tailwind-sync + detected package manager)
npx create-kora-app my-app --yes

# Mix flags: Tailwind without sync
npx create-kora-app my-app --tailwind --no-sync --pm npm
```

### Generated project structure

```
my-app/
  src/
    schema.ts           # Your schema definition
    app.ts              # Kora app initialization
    main.tsx            # Application entry point
    components/         # React components
  server/               # (react-sync template only)
    index.ts            # Sync server entry point
  kora/
    generated/
      types.ts          # Auto-generated TypeScript types
    migrations/         # Schema migration files
  package.json
  tsconfig.json
  vite.config.ts
  kora.config.ts        # Kora configuration
```

---

## kora dev

Starts the full development environment with hot reloading, sync server, and DevTools.

### Usage

```bash
kora dev [options]
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--port` | `number` | `5173` | Vite dev server port. |
| `--sync-port` | `number` | `4567` | Sync server port (if sync is configured). |
| `--no-sync` | `boolean` | `false` | Disable the sync server even if configured. |
| `--no-devtools` | `boolean` | `false` | Disable embedded DevTools. |

### What it starts

1. **Vite dev server** -- Serves your application with hot module replacement (HMR).
2. **Kora sync server** -- Starts automatically if `sync` is configured in `kora.config.ts`. Not started for local-only apps.
3. **Schema watcher** -- Watches your schema file for changes and automatically regenerates TypeScript types.
4. **DevTools** -- Embedded DevTools accessible via `Ctrl+Shift+K` (or `Cmd+Shift+K` on macOS) in the browser.

### Example

```bash
$ kora dev

  Kora.js Dev Server

  App:      http://localhost:5173
  Sync:     ws://localhost:4567/kora
  DevTools:  Ctrl+Shift+K

  Watching schema for changes...
```

### Configuration file

The `kora dev` command reads from `kora.config.ts` in the project root:

```typescript
// kora.config.ts
import { defineConfig } from 'korajs/config'

export default defineConfig({
  schema: './src/schema.ts',
  sync: {
    port: 4567,
  },
  devtools: true,
  generate: {
    output: './kora/generated/types.ts',
  },
})
```

---

## kora migrate

Detects schema changes, generates migration files, and applies migrations to the local store.

### Usage

```bash
kora migrate [options]
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--dry-run` | `boolean` | `false` | Show what would change without generating or applying migrations. |
| `--apply` | `boolean` | `false` | Apply the migration immediately without prompting. |
| `--generate-only` | `boolean` | `false` | Generate the migration file but do not apply it. |

### Workflow

The `migrate` command compares the current schema version with the previous version and generates a migration file describing the changes.

```
$ kora migrate

  Detected schema change: v1 -> v2

  Changes:
    + todos.priority (enum: low, medium, high, default: medium)
    ~ todos.tags (string -> array<string>)
    - todos.legacyField (removed)

  Generated migration: kora/migrations/002-add-priority-change-tags.ts

  ? Apply migration to local store? (y/n)
```

### Change types

| Symbol | Meaning |
|--------|---------|
| `+` | New field added to a collection. |
| `~` | Existing field type or configuration changed. |
| `-` | Field removed from a collection. |
| `++` | New collection added. |
| `--` | Collection removed. |

### Generated migration file

```typescript
// kora/migrations/002-add-priority-change-tags.ts
import { defineMigration } from 'korajs'

export default defineMigration({
  version: 2,
  description: 'Add priority field, change tags to array',

  up: {
    // Automatically generated SQL
    sql: [
      `ALTER TABLE todos ADD COLUMN priority TEXT DEFAULT 'medium' CHECK(priority IN ('low','medium','high'))`,
      `ALTER TABLE todos ADD COLUMN tags_new TEXT DEFAULT '[]'`,
      // Data migration handled below
    ],

    // Optional: transform existing data
    transform: async (tx) => {
      const rows = await tx.query('SELECT id, tags FROM todos')
      for (const row of rows) {
        const tagsArray = row.tags ? [row.tags] : []
        await tx.execute(
          'UPDATE todos SET tags_new = ? WHERE id = ?',
          [JSON.stringify(tagsArray), row.id]
        )
      }
    },
  },

  down: {
    sql: [
      `ALTER TABLE todos DROP COLUMN priority`,
    ],
  },
})
```

### Dry run

```bash
$ kora migrate --dry-run

  Detected schema change: v1 -> v2

  Changes:
    + todos.priority (enum: low, medium, high, default: medium)

  Would generate: kora/migrations/002-add-priority.ts
  No changes applied (dry run).
```

---

## kora generate

Generates TypeScript types and other artifacts from your schema.

### Usage

```bash
kora generate <subcommand> [options]
```

### Subcommands

#### kora generate types

Generates TypeScript type definitions from the current schema. These types provide full autocomplete and type checking for collection operations.

```bash
kora generate types [options]
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--output` | `string` | `'kora/generated/types.ts'` | Output file path. |
| `--schema` | `string` | `'./src/schema.ts'` | Path to the schema file. |

```bash
$ kora generate types

  Generated TypeScript types from schema v1
  Output: kora/generated/types.ts
```

#### Generated output

For a schema with a `todos` collection, the generated file contains:

```typescript
// kora/generated/types.ts
// Auto-generated by Kora CLI. Do not edit manually.

export interface Todo {
  id: string
  title: string
  completed: boolean
  assignee: string | null
  tags: string[]
  notes: unknown          // Rich text (Yjs Y.Text)
  priority: 'low' | 'medium' | 'high'
  dueDate: number | null
  createdAt: number
}

export interface TodoInsert {
  title: string
  completed?: boolean
  assignee?: string | null
  tags?: string[]
  priority?: 'low' | 'medium' | 'high'
  dueDate?: number | null
  // createdAt is auto-set, not included
}

export interface TodoUpdate {
  title?: string
  completed?: boolean
  assignee?: string | null
  tags?: string[]
  priority?: 'low' | 'medium' | 'high'
  dueDate?: number | null
}

// Collection type map used internally by Kora
export interface KoraCollections {
  todos: {
    record: Todo
    insert: TodoInsert
    update: TodoUpdate
  }
}
```

::: tip
When using `kora dev`, types are regenerated automatically whenever your schema file changes. You only need to run `kora generate types` manually when not using the dev server.
:::

---

## Global options

These options are available on all commands:

| Option | Description |
|--------|-------------|
| `--help` | Show help for the command. |
| `--version` | Show the CLI version. |
| `--cwd <path>` | Set the working directory. Defaults to the current directory. |
| `--verbose` | Enable verbose logging output. |

```bash
kora --version
kora migrate --help
kora dev --cwd ./my-project
```
