# @korajs/svelte

Svelte bindings for [Kora.js](https://korajs.dev) offline-first applications (Svelte 4 stores + Svelte 5 components).

## Install

```bash
pnpm add korajs@beta @korajs/svelte@beta
```

## Setup

Create the Kora app at module scope, connect sync, then mount a root component with `KoraProvider`. This follows the CLI `svelte-tailwind-sync` template:

<!-- docs-check: skip template excerpt: imports the project's own auth, schema and component modules -->
```typescript
// main.ts
import { createApp as createKoraApp, lazyAuthSync } from 'korajs'
import { mount } from 'svelte'
import Root from './Root.svelte'
import schema from './schema'
import koraWorkerUrl from './kora-worker.ts?worker&url'

const kora = createKoraApp({
  schema,
  sync: {
    url: import.meta.env.VITE_SYNC_URL,
    // The sign-in client loads after the first paint; sync waits for it, the screen does not.
    authClient: lazyAuthSync(() => import('./auth').then((m) => m.authSync)),
  },
  store: { workerUrl: koraWorkerUrl },
})

void kora.sync?.connect()

mount(Root, { target: document.getElementById('app')!, props: { kora } })
```

```svelte
<!-- Root.svelte -->
<script lang="ts">
  import type { KoraAppLike } from '@korajs/svelte'
  import KoraProvider from '@korajs/svelte/KoraProvider.svelte'
  import App from './App.svelte'

  const { kora }: { kora: KoraAppLike } = $props()
  // The sign-in UI is not on the first paint's path: the screen renders from the local database.
  const authBridge = import('./AuthBridge.svelte')
</script>

<KoraProvider app={kora}>
  <App />
  {#await authBridge then bridge}
    <bridge.default />
  {:catch}
    <!-- The sign-in chunk did not load: the rest of the app keeps working. -->
  {/await}
</KoraProvider>
```

`./auth` exports `authSync = createKoraAuthSync({ authClient, schema })`. `AuthBridge.svelte` wraps the sign-in UI in `AuthProvider` (`@korajs/auth/svelte/AuthProvider.svelte`). `connect()` can be called at once: the request is remembered, and the socket opens while the local store does, once the sign-in client has loaded.

Precompiled component JS is also published under `dist/components/` for non-Vite bundlers; the `svelte` export condition still resolves to source for Vite/SvelteKit.

## Queries

### Static filters: a readable store

```svelte
<script lang="ts">
  import { getApp, createQueryStore } from '@korajs/svelte'
  import type { app as koraApp } from './kora'

  const app = getApp<typeof koraApp>()
  const todos = createQueryStore(app.todos.where({ completed: false }))
</script>

{#each $todos as todo}
  <p>{todo.title}</p>
{/each}
```

### Reactive filters: the `KoraQuery` component

```svelte
<script lang="ts">
  import KoraQuery from '@korajs/svelte/KoraQuery.svelte'
  import { getApp } from '@korajs/svelte'
  import type { app as koraApp } from './kora'

  const app = getApp<typeof koraApp>()
  let showDone = $state(false)
</script>

<KoraQuery query={app.todos.where({ completed: showDone })}>
  {#snippet children(data)}
    {#each data as todo}
      <p>{todo.title}</p>
    {/each}
  {/snippet}
</KoraQuery>
```

## API

| Export | Purpose |
|--------|---------|
| `KoraProvider.svelte` | Root provider: sets context and renders at once (`waitForStorage` holds the children until `app.ready`) |
| `KoraStoreProvider.svelte` | Store-only provider (advanced / tests) |
| `createQueryStore(query)` | Svelte readable store of results |
| `createQueryStateStore(query)` | Store of `{ data, error, ready, source, complete }` |
| `createMutation(fn)` | Mutation controller, with server-refusal (`rejected`) state |
| `createSyncStatusStore()` | Sync status readable store |
| `createSyncSummaryStore()` / `useSyncSummary()` | The sync status summarized for an indicator |
| `createOfflineReadyStore()` / `useOfflineReady()` | Whether a reload with no network would open the app with its data |
| `createOfflineKeepStore(query, { files })` / `useOfflineKeep()` | Keep a query's records on the device while the component lives |
| `useFormDraft(formKey, initial, { fields })` | Keep typed input across a new version's reload |
| `createKoraHooks<typeof app>()` | Helpers typed by your schema |
| `getApp()` / `getCollection()` | Context accessors |
| `createRichTextBinding()` / `useRichText()` | Yjs richtext editor binding |
| `applyPresence(user)` | Set local presence; use it in `$effect(() => applyPresence(user))` |
| `createCollaboratorsStore()` | Remote collaborator awareness states |
| `KoraQuery.svelte` | Descriptor-reactive query snippet |

## Organization auth

Use `OrgProvider` from `@korajs/auth/svelte/OrgProvider.svelte` and org stores from `@korajs/auth/svelte`.
