---
title: Kora for AI Agents
description: "How AI coding agents should build Kora.js apps: the data-plane rules, the correct hook API, anti-patterns to avoid, and the machine-readable docs endpoints."
---

# Kora for AI Agents

This page is written for AI coding agents (Cursor, Claude Code, Copilot, and similar) and for the developers who work alongside them. Kora owns the entire data plane, so the habits that serve a typical REST plus client-cache web app actively work against you here. Read the rules, then the anti-patterns.

If you scaffolded with `create-kora-app`, an `AGENTS.md` already sits in your project root with these rules. If you added Kora to an existing project, drop the same file in with:

```bash
npx kora agents-md
```

Commit it so agents pick up the conventions automatically. Re-run with `--force` to regenerate it after an upgrade.

## Machine-readable docs

You do not need to scrape the rendered site. Three endpoints exist for programmatic use:

- `https://korajs.dev/llms.txt` is a curated index of every page with descriptions, following the [llms.txt](https://llmstxt.org) convention.
- `https://korajs.dev/llms-full.txt` is the entire documentation set concatenated into one file.
- Any page is available as raw markdown by appending `.md` to its URL. For example, `https://korajs.dev/guide/react-hooks.md` returns the source of the React Hooks guide. Every HTML page also advertises its markdown twin through a `<link rel="alternate" type="text/markdown">` tag.

Prefer these over fetching HTML. They are smaller, stable, and free of navigation chrome.

## The rules that matter

1. The schema is the source of truth. Collections are defined with `defineSchema` and the `t.*` field builders, by convention in `src/schema.ts`. To change a data shape, edit the schema first; types flow from it. Never hand-write record types.
2. Never fetch application data over HTTP. Do not add REST or GraphQL calls for app data, and do not talk to the sync server directly. Read and write through Kora collections; sync happens in the background.
3. Await readiness outside components. Call `await app.ready` before touching `app.<collection>` methods in non-UI code. The framework bindings handle readiness inside components.
4. Offline must keep working. Every feature must function with the network off. Never gate a read or write on connectivity. Checking `navigator.onLine` before a data operation is a sign you have taken a wrong turn.
5. Surface mutation errors. Fire-and-forget `mutate` folds errors into the mutation state, so render `mutation.error`, or use `mutateAsync` and handle the promise.
6. Do not add a state library for app data. Reactive queries are the store. Reaching for react-query, SWR, Redux, or Zustand to hold collection data duplicates what Kora already does.
7. Do not add loading spinners for local reads. `useQuery` returns data synchronously from the local store, so there is nothing to wait on.

## The data API

```ts
await app.ready
const rec = await app.todos.insert({ title: 'Ship the beta' }) // defaults and .auto() applied
await app.todos.update(rec.id, { completed: true })            // partial update, changed fields only
await app.todos.delete(rec.id)
const one = await app.todos.findById(rec.id)

const unsubscribe = app.todos
  .where({ completed: false })
  .orderBy('createdAt', 'desc')
  .subscribe((rows) => {
    // fires immediately with current data, then on every change
  })
```

In components, use the hooks instead. The mutation object exposes `mutate` (fire-and-forget), `mutateAsync` (awaitable), `reset`, `isLoading`, and `error`. Sync state comes from `useSyncStatus().status`, which is one of `connected`, `syncing`, `synced`, `offline`, `clock-error`, `error`, or `schema-mismatch`.

```tsx
import { useCollection, useMutation, useQuery, useSyncStatus } from '@korajs/react'

const todos = useCollection('todos')
const rows = useQuery(todos.where({ completed: false }).orderBy('createdAt'))
const addTodo = useMutation((data) => todos.insert(data))
addTodo.mutate({ title: 'x' })            // errors land in addTodo.error
await addTodo.mutateAsync({ title: 'x' }) // resolves with the result; throws on failure
const status = useSyncStatus()            // status.status, status.pendingOperations
```

The Vue and Svelte bindings expose the same names from `@korajs/vue` and `@korajs/svelte`. See [React Hooks](/guide/react-hooks) for the full reference.

## Translation from a typical web app

If your instinct comes from REST plus a client cache, here is the mapping.

| You would normally reach for | In Kora you write |
|------------------------------|-------------------|
| `fetch('/api/todos')` then cache the JSON | `app.todos.where(...)` or `useQuery(...)`, already local and reactive |
| A REST or GraphQL endpoint for CRUD | `app.todos.insert / update / delete`, synced automatically |
| react-query, SWR, or a Redux slice for server state | Reactive queries; they are the store |
| A loading spinner for a data read | Nothing; local reads are synchronous |
| `useEffect` to fetch on mount | Subscribe with `useQuery`; it fires immediately and on change |
| `navigator.onLine` guards before writing | Write unconditionally; offline writes queue and sync later |
| Hand-written TypeScript interfaces for records | Types inferred from `defineSchema` |
| Manual conflict handling on the server | The three-tier merge engine; add a `resolve` function only for domain-specific merges |
| `localStorage` or `IndexedDB` glue | The local SQLite store, configured through the schema |

## Conflict handling

Concurrent edits converge automatically: last-write-wins per field, add-wins for arrays, and character-level CRDT for `t.richtext()` fields. When a field needs domain-specific merging, such as an inventory counter, add a `resolve` function to that field in the schema. Do not write your own merge or sync code. See [Conflict Resolution](/guide/conflict-resolution) for the model.

## Verifying you did it right

A correct Kora feature has no data-fetching code, no manual cache, no loading state for local reads, and no hand-written record types. If a diff you are about to write includes any of those, revisit the rules above before committing.
