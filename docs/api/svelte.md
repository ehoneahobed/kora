---
title: Svelte API
description: "@korajs/svelte API reference: Kora stores and helpers for reactive queries, mutations, and sync status in Svelte apps."
---

# Svelte API Reference

`@korajs/svelte` provides Svelte stores, composables, and components for offline-first UIs. Works with Svelte 4 store subscriptions and Svelte 5 runes/snippets.

```typescript
import {
  createQueryStore,
  createMutation,
  createSyncStatusStore,
  getApp,
  applyPresence,
  createCollaboratorsStore,
} from '@korajs/svelte'
```

Or from the meta-package:

```typescript
import { createQueryStore, getApp } from 'korajs/svelte'
```

Component imports:

```svelte
<script>
  import KoraProvider from '@korajs/svelte/KoraProvider.svelte'
  import KoraQuery from '@korajs/svelte/KoraQuery.svelte'
</script>
```

---

## KoraProvider

Root layout component that waits for `app.ready`, sets Kora context, and renders children.

### Props

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `app` | `KoraAppLike` | Yes | App instance from `createApp()`. |
| `fallback` | `Snippet` | No | Shown while initializing. |
| `children` | `Snippet` | No | App content after ready. |

### Example

```svelte
<script lang="ts">
  import KoraProvider from '@korajs/svelte/KoraProvider.svelte'
  import App from './App.svelte'

  let { kora } = $props()
</script>

<KoraProvider app={kora}>
  {#snippet fallback()}Loading...{/snippet}
  <App />
</KoraProvider>
```

---

## createQueryStore() / useQuery()

Returns a Svelte `Readable` store of query results. Subscribe with `$store` or `store.subscribe()`.

```typescript
function createQueryStore<T extends CollectionRecord>(
  query: QueryBuilder<T>,
  options?: UseQueryOptions,
): Readable<T[]>
```

`useQuery` is an alias for `createQueryStore`.

### Example

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

---

## KoraQuery

Snippet component for queries whose **descriptor** changes at runtime (reactive filters).

```svelte
<KoraQuery query={app.todos.where({ completed: showDone })} let:data>
  {#each data as todo}
    <p>{todo.title}</p>
  {/each}
</KoraQuery>
```

---

## createMutation() / useMutation()

Mutation controller with optimistic hooks. Returns `mutate`, `mutateAsync`, `subscribeLoading`, `subscribeError`, and `reset`.

---

## createSyncStatusStore() / useSyncStatus()

Readable store of `SyncStatusInfo`.

```svelte
<script lang="ts">
  import { createSyncStatusStore } from '@korajs/svelte'
  const status = createSyncStatusStore()
</script>

<p>{$status.status}</p>
```

---

## getApp() / getCollection()

Context accessors. Must be called after `KoraProvider` has finished initializing (inside its child tree).

---

## createRichTextBinding() / useRichText()

Binds a `t.richtext()` field to Yjs. For reactive target changes, prefer `KoraRichText.svelte`.

---

## applyPresence() / createCollaboratorsStore()

Svelte presence uses an effect-friendly cleanup pattern:

```svelte
<script lang="ts">
  import { applyPresence, createCollaboratorsStore } from '@korajs/svelte'

  let user = $state({ name: 'Alice', color: '#e91e63' })
  $effect(() => applyPresence(user))

  const collaborators = createCollaboratorsStore()
</script>

<ul>
  {#each $collaborators as peer}
    <li style:color={peer.user.color}>{peer.user.name}</li>
  {/each}
</ul>
```

---

## Auth & organizations

Authentication stores and provider components live in `@korajs/auth/svelte`:

```svelte
<script>
  import AuthProvider from '@korajs/auth/svelte/AuthProvider.svelte'
  import OrgProvider from '@korajs/auth/svelte/OrgProvider.svelte'
  import { useOrg, usePermission } from '@korajs/auth/svelte'
</script>
```

See [Auth API](./auth.md).

---

## Package exports

| Import path | Description |
|-------------|-------------|
| `@korajs/svelte` | Stores, composables, context helpers |
| `@korajs/svelte/KoraProvider.svelte` | Source (Vite) or precompiled JS (`dist/components/`) |
| `@korajs/svelte/KoraQuery.svelte` | Reactive query snippet component |
| `@korajs/svelte/KoraRichText.svelte` | Richtext binding component |

---

## Types

Shared binding types are exported from `@korajs/core/bindings` and re-exported through `@korajs/svelte`.
