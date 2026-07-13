# @korajs/svelte

Svelte bindings for [Kora.js](https://github.com/ehoneahobed/kora) offline-first applications (Svelte 4 stores + Svelte 5 components).

## Install

```bash
pnpm add korajs @korajs/svelte
```

## Setup

Create the Kora app at module scope, connect sync after `ready`, then mount a root layout with provider components (matches the CLI `svelte-sync` template):

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
  sync: { url: 'ws://localhost:3000/kora-sync', authClient: createKoraAuthSync({ authClient, schema }) },
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

### Static filters — readable store

```svelte
<script lang="ts">
  import { getApp, createQueryStore } from '@korajs/svelte'

  const app = getApp()
  const todos = createQueryStore(app.todos.where({ completed: false }))
</script>

{#each $todos as todo}
  <p>{todo.title}</p>
{/each}
```

### Reactive filters — `KoraQuery` component

```svelte
<script lang="ts">
  import KoraQuery from '@korajs/svelte/KoraQuery.svelte'
  import { getApp } from '@korajs/svelte'

  const app = getApp()
  let showDone = $state(false)
</script>

<KoraQuery query={app.todos.where({ completed: showDone })} let:data>
  {#each data as todo}
    <p>{todo.title}</p>
  {/each}
</KoraQuery>
```

## API

| Export | Purpose |
|--------|---------|
| `KoraProvider.svelte` | Root provider (waits for `app.ready`, sets context) |
| `KoraStoreProvider.svelte` | Store-only provider (advanced / tests) |
| `createQueryStore(query)` | Svelte readable store of results |
| `createMutation(fn)` | Mutation controller |
| `createSyncStatusStore()` | Sync status readable store |
| `getApp()` / `getCollection()` | Context accessors |
| `createRichTextBinding()` / `useRichText()` | Yjs richtext editor binding |
| `applyPresence(user)` | Set local presence — use in `$effect(() => applyPresence(user))` |
| `createCollaboratorsStore()` | Remote collaborator awareness states |
| `KoraQuery.svelte` | Descriptor-reactive query snippet |

## Organization auth

Use `OrgProvider` from `@korajs/auth/svelte/OrgProvider.svelte` and org stores from `@korajs/auth/svelte`.
