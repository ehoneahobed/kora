# AGENTS.md

Guidance for AI coding agents working in this project. Humans: this is useful for you too.

## What this project is

This is a **Kora.js** application: an offline-first app where all data lives in a local SQLite database (WASM + OPFS in the browser) and optionally syncs across devices through a Kora sync server. Offline is the normal state, not an error state. Full docs: https://korajs.dev and machine-readable index at https://korajs.dev/llms.txt (complete docs in one file: https://korajs.dev/llms-full.txt).

## Golden rules

1. **The schema is the source of truth.** All collections are defined in `src/schema.ts` with `defineSchema` and the `t.*` field builders. To add or change data shapes, edit the schema first; types flow from it automatically. Never hand-write types for records.
2. **Never fetch application data over HTTP.** Do not add REST or GraphQL calls for app data, and do not talk to the sync server directly. Read and write through Kora collections only; sync happens automatically in the background.
3. **Await readiness before direct collection access.** Outside the UI bindings, `await app.ready` before calling `app.<collection>` methods. The bindings handle this for you inside components.
4. **Offline must keep working.** Any feature you add must function with the network off. Never gate a write or a read on connectivity. If you find yourself checking `navigator.onLine` before a data operation, you are doing it wrong.
5. **Surface mutation errors.** Fire-and-forget mutate calls swallow errors into the mutation state. Always render the mutation's `error` in the UI or handle the promise from the async variant. Silent failure is the worst failure.
6. **Do not touch `src/kora-worker.ts`.** It wires the SQLite WASM binary URL for both dev and production builds. Changing it breaks production builds in ways that only show up after deploy.
7. **Do not add a state management library for server or app data.** Kora's reactive queries are the store. Local UI state (form inputs, toggles) can use the framework's normal state tools.

## Data API cheat sheet

```ts
await app.ready
const rec = await app.todos.insert({ title: 'x' })   // defaults and .auto() fields applied
await app.todos.update(rec.id, { completed: true })  // partial update, changed fields only
await app.todos.delete(rec.id)
const one = await app.todos.findById(rec.id)
const unsubscribe = app.todos
  .where({ completed: false })
  .orderBy('createdAt', 'desc')
  .subscribe((rows) => {/* fires immediately, then on every change */})
```

Schema example (`src/schema.ts`):

```ts
import { defineSchema, t } from 'korajs'

export default defineSchema({
  version: 1,
  collections: {
    todos: {
      fields: {
        title: t.string(),
        completed: t.boolean().default(false),
        tags: t.array(t.string()).default([]),
        priority: t.enum(['low', 'medium', 'high']).default('medium'),
        createdAt: t.timestamp().auto(), // set automatically; never pass it on insert
      },
      indexes: ['completed', 'createdAt'],
    },
  },
})
```

If you bump collections in a way that changes shapes, increment `version` and run `npx kora migrate`.

## Project conventions

- Feature code lives in `src/modules/<feature>/` with the pattern: `<feature>.schema.ts` (collection definition, imported into `src/schema.ts`), `<feature>.queries.ts` (query builders), `<feature>.mutations.ts` (mutation functions taking a collection accessor).
- Conflict handling is declarative. Concurrent edits merge automatically (last-write-wins per field, add-wins for arrays). If a field needs domain-specific merging (counters, quantities), add a `resolve` function in the schema rather than writing sync logic.
- `kora.config.ts` controls the dev environment (ports, sync server, schema watcher).

## Commands

- `npm run dev` starts everything: Vite dev server (port 5173), local sync server (port 3001), and the schema watcher.
- `npm run build` type-checks and builds for production.
- `npx kora doctor` diagnoses a broken setup.
- DevTools overlay: press Ctrl+Shift+K (Cmd+Shift+K on macOS) in the running app to inspect operations, merges, and sync status.

## Sync and auth

Sync is configured in `src/main.*` via `createApp({ sync: { url, authClient } })`. In dev, the sync URL is derived from the page host and proxied by Vite; in production set `VITE_SYNC_URL`. Auth (if present in this template) uses `@korajs/auth`; the client is created in `src/auth.ts`. Local writes work without sign-in; sync requires the server to accept the connection.

## Svelte bindings

Kora's Svelte package exposes store-based bindings from `@korajs/svelte`, wired through the provider set up in the app entry. Queries are reactive stores that read synchronously from the local database; mutations expose error state that must be surfaced in the UI. Avoid loading spinners for local reads.
