# @korajs/svelte

Svelte bindings for [Kora.js](https://korajs.dev) offline-first applications (Svelte 4 stores + Svelte 5 components).

## Install

```bash
pnpm add korajs@beta @korajs/svelte@beta
```

## Setup

Create the Kora app at module scope, connect sync after `ready`, then mount a root layout with provider components (matches the CLI `svelte-sync` template):

<!-- docs-check: skip template excerpt: imports the project's own auth and schema modules -->
```typescript
// main.ts
import { createKoraAuthSync } from '@korajs/auth'
import { createApp as createKoraApp } from 'korajs'
import { mount } from 'svelte'
import Root from './Root.svelte'
import { authClient } from './auth'
import schema from './schema'
import koraWorkerUrl from './kora-worker.ts?worker&url'

const kora = createKoraApp({
  schema,
  sync: { url: 'ws://localhost:3001/kora-sync', authClient: createKoraAuthSync({ authClient, schema }) },
  store: { workerUrl: koraWorkerUrl },
})

kora.ready.then(() => kora.sync?.connect())

mount(Root, { target: document.getElementById('app')!, props: { kora, authClient } })
```

```svelte
<!-- Root.svelte -->
<script lang="ts">
  import AuthProvider from '@korajs/auth/svelte/AuthProvider.svelte'
  import KoraProvider from '@korajs/svelte/KoraProvider.svelte'
  import App from './App.svelte'

  let { kora, authClient } = $props()
</script>

<AuthProvider client={authClient}>
  <KoraProvider app={kora}>
    <App />
  </KoraProvider>
</AuthProvider>
```

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
| `createMutation(fn)` | Mutation controller |
| `createSyncStatusStore()` | Sync status readable store |
| `getApp()` / `getCollection()` | Context accessors |
| `createRichTextBinding()` / `useRichText()` | Yjs richtext editor binding |
| `applyPresence(user)` | Set local presence; use it in `$effect(() => applyPresence(user))` |
| `createCollaboratorsStore()` | Remote collaborator awareness states |
| `KoraQuery.svelte` | Descriptor-reactive query snippet |

## Organization auth

Use `OrgProvider` from `@korajs/auth/svelte/OrgProvider.svelte` and org stores from `@korajs/auth/svelte`.
