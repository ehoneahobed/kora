/**
 * Canonical AGENTS.md generator.
 *
 * `kora agents-md` writes this file into an existing project so AI coding agents
 * (and humans) build Kora apps correctly instead of drifting to fetch calls,
 * hand-written types, and loading spinners. New projects scaffolded with
 * `create-kora-app` already ship an AGENTS.md; this command covers the manual
 * setup path and lets existing projects regenerate the guidance on demand.
 */

/** UI framework whose bindings section the generated AGENTS.md documents. */
export type AgentsFramework = 'react' | 'vue' | 'svelte'

/** All supported frameworks, for validation and help text. */
export const AGENTS_FRAMEWORKS: readonly AgentsFramework[] = ['react', 'vue', 'svelte'] as const

/**
 * Narrows an arbitrary string to a supported {@link AgentsFramework}.
 *
 * @param value - Candidate framework identifier
 * @returns `true` when `value` is one of the supported frameworks
 */
export function isAgentsFramework(value: string): value is AgentsFramework {
	return (AGENTS_FRAMEWORKS as readonly string[]).includes(value)
}

/**
 * Detects the UI framework from a project's package manifest by looking for the
 * matching `@korajs/*` binding package in dependencies or devDependencies.
 *
 * @param manifest - Parsed `package.json` contents
 * @returns The detected framework, or `null` when no binding package is present
 */
export function detectFrameworkFromManifest(manifest: unknown): AgentsFramework | null {
	if (typeof manifest !== 'object' || manifest === null) return null
	const record = manifest as Record<string, unknown>
	const deps = collectDependencyNames(record.dependencies, record.devDependencies)
	if (deps.has('@korajs/react')) return 'react'
	if (deps.has('@korajs/vue')) return 'vue'
	if (deps.has('@korajs/svelte')) return 'svelte'
	return null
}

function collectDependencyNames(...groups: unknown[]): Set<string> {
	const names = new Set<string>()
	for (const group of groups) {
		if (typeof group !== 'object' || group === null) continue
		for (const name of Object.keys(group as Record<string, unknown>)) {
			names.add(name)
		}
	}
	return names
}

const FRAMEWORK_BINDINGS: Record<AgentsFramework, string> = {
	react: `## React bindings

\`\`\`tsx
import { KoraProvider, useCollection, useMutation, useQuery, useSyncStatus } from '@korajs/react'

// Wrap the tree once near your app entry: <KoraProvider app={app}><App /></KoraProvider>

const todos = useCollection('todos')
const rows = useQuery(todos.where({ completed: false }).orderBy('createdAt'))
const addTodo = useMutation((data) => todos.insert(data))
addTodo.mutate({ title: 'x' })                // fire-and-forget; errors land in addTodo.error
await addTodo.mutateAsync({ title: 'x' })     // resolves with the result; throws on failure
const status = useSyncStatus()                // status.status, status.pendingOperations
\`\`\`

Rules: always render \`mutation.error\` somewhere. Keep \`<StrictMode>\` in place; the hooks are StrictMode-safe. \`useQuery\` returns data synchronously from the local store, so do not add loading spinners for local reads.`,
	vue: `## Vue bindings

\`\`\`ts
import { useCollection, useMutation, useQuery, useSyncStatus } from '@korajs/vue'

const todos = useCollection('todos')
const rows = useQuery(todos.where({ completed: false }).orderBy('createdAt'))  // readonly reactive ref
const addTodo = useMutation((data) => todos.insert(data))
addTodo.mutate({ title: 'x' })                // fire-and-forget; errors land in addTodo.error
const status = useSyncStatus()                // status.status, status.pendingOperations
\`\`\`

Rules: surface the mutation's error state in the UI. \`useQuery\` reads synchronously from the local store, so avoid loading spinners for local data. The Kora context comes from \`KoraProvider\`, wired in your app entry (for example \`src/main.ts\`).`,
	svelte: `## Svelte bindings

Kora's Svelte bindings from \`@korajs/svelte\` expose \`useCollection\`, \`useQuery\`, \`useMutation\`, and \`useSyncStatus\`, wired through the provider set up in your app entry.

\`\`\`ts
import { useCollection, useMutation, useQuery, useSyncStatus } from '@korajs/svelte'

const todos = useCollection('todos')
const rows = useQuery(todos.where({ completed: false }).orderBy('createdAt'))  // reactive store
const addTodo = useMutation((data) => todos.insert(data))
addTodo.mutate({ title: 'x' })                // fire-and-forget; errors land in addTodo.error
const status = useSyncStatus()                // readable store; read $status.status in markup
\`\`\`

Rules: queries are reactive stores that read synchronously from the local database, so avoid loading spinners for local reads. Mutations expose an \`error\` state that must be surfaced in the UI.`,
}

/**
 * Renders the full AGENTS.md document for the given framework.
 *
 * The body (golden rules, data API cheat sheet, conflict handling, sync notes,
 * commands) is framework-agnostic; only the bindings section changes. File paths
 * are described as conventions so the guidance is correct for both scaffolded and
 * manually configured projects.
 *
 * @param framework - UI framework whose bindings to document
 * @returns The complete AGENTS.md file contents, terminated with a trailing newline
 */
export function generateAgentsMd(framework: AgentsFramework): string {
	return `# AGENTS.md

Guidance for AI coding agents working in this project. Humans: this is useful for you too.

## What this project is

This project uses **Kora.js**, an offline-first application framework. All application data lives in a local SQLite database (WASM + OPFS in the browser, native SQLite on desktop and server) and optionally syncs across devices through a Kora sync server. Offline is the normal state, not an error state. Full docs live at https://korajs.dev, with a machine-readable index at https://korajs.dev/llms.txt and the complete docs in one file at https://korajs.dev/llms-full.txt. Any documentation page is available as raw markdown by appending \`.md\` to its URL.

## Golden rules

1. **The schema is the source of truth.** Collections are defined with \`defineSchema\` and the \`t.*\` field builders (by convention in \`src/schema.ts\`). To add or change data shapes, edit the schema first; types flow from it automatically. Never hand-write types for records.
2. **Never fetch application data over HTTP.** Do not add REST or GraphQL calls for app data, and do not talk to the sync server directly. Read and write through Kora collections only; sync happens automatically in the background.
3. **Await readiness before direct collection access.** Outside the UI bindings, \`await app.ready\` before calling \`app.<collection>\` methods. The framework bindings handle this for you inside components.
4. **Offline must keep working.** Any feature you add must function with the network off. Never gate a read or write on connectivity. If you are checking \`navigator.onLine\` before a data operation, you are doing it wrong.
5. **Surface mutation errors.** Fire-and-forget \`mutate\` calls fold errors into the mutation state. Always render the mutation's \`error\`, or handle the promise from the \`mutateAsync\` variant. Silent failure is the worst failure.
6. **Do not add a state library for server or app data.** Kora's reactive queries are the store. Do not reach for react-query, SWR, Redux, Zustand, or similar for data that lives in a collection. Local UI state (form inputs, toggles) can use your framework's normal state tools.
7. **Do not add loading spinners for local reads.** \`useQuery\` returns data synchronously from the local store, so there is no loading state to wait on for local data.

## Data API cheat sheet

\`\`\`ts
await app.ready
const rec = await app.todos.insert({ title: 'x' })   // defaults and .auto() fields applied
await app.todos.update(rec.id, { completed: true })  // partial update, changed fields only
await app.todos.delete(rec.id)
const one = await app.todos.findById(rec.id)
const unsubscribe = app.todos
  .where({ completed: false })
  .orderBy('createdAt', 'desc')
  .subscribe((rows) => {/* fires immediately, then on every change */})
\`\`\`

Schema example (\`src/schema.ts\`):

\`\`\`ts
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
\`\`\`

If you change collection shapes, increment \`version\` and run \`npx kora migrate\`.

## Conflict handling

Concurrent edits merge automatically: last-write-wins per field, add-wins for arrays, and character-level CRDT for \`t.richtext()\` fields. When a field needs domain-specific merging (counters, quantities), add a \`resolve\` function in the schema rather than writing sync logic by hand. Never write your own conflict or merge code.

## Sync and auth

Enable sync by adding one line to \`createApp\`: \`createApp({ schema, sync: { url } })\`. When the app is offline, writes queue locally and sync when connectivity returns. If the project uses \`@korajs/auth\`, pass its client as \`createApp({ schema, sync: { url, authClient } })\`. Local writes work without sign-in; sync requires the server to accept the connection.

${FRAMEWORK_BINDINGS[framework]}

## Commands

- \`npx kora dev\` runs the dev environment (app server, local sync server when configured, schema watcher).
- \`npx kora doctor\` diagnoses a broken setup.
- \`npx kora migrate\` applies a schema change to the local store.
- In a running app, the DevTools overlay (Ctrl+Shift+K, Cmd+Shift+K on macOS) inspects operations, merges, and sync status.
`
}
