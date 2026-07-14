---
title: Vue API
description: "@korajs/vue API reference: the Kora provider and composables for reactive queries, mutations, and sync status in Vue apps."
---

# Vue API Reference

`@korajs/vue` provides Vue 3 composables for building reactive offline-first UIs. Composables use Vue's reactivity system and are safe to use inside `<script setup>`.

```typescript
import {
  KoraProvider,
  useQuery,
  useMutation,
  useSyncStatus,
  useCollection,
  useRichText,
  usePresence,
  useCollaborators,
} from '@korajs/vue'
```

Or from the meta-package:

```typescript
import { KoraProvider, useQuery } from 'korajs/vue'
```

---

## KoraProvider

Context provider that makes the Kora app available to all composables. Must wrap any component that uses Kora hooks.

### Props

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `app` | `KoraAppLike` | Yes* | App instance from `createApp()`. |
| `store` | `Store` | No | Advanced: explicit store instead of `app`. |
| `syncEngine` | `SyncEngine \| null` | No | Advanced: used with `store` prop. |
| `fallback` | `VNode \| string \| null` | No | Shown while `app.ready` resolves. |

\* Either `app` or `store` is required.

### Example

```typescript
import { createApp as createKoraApp } from 'korajs'
import { createApp, h } from 'vue'
import { KoraProvider } from '@korajs/vue'

const kora = createKoraApp({ schema })

createApp({
  render: () => h(KoraProvider, { app: kora }, () => h(App)),
}).mount('#app')
```

---

## useQuery()

Returns a reactive array of records matching a query. Re-evaluates when the local store or sync updates the result set.

```typescript
function useQuery<T extends CollectionRecord>(
  query: QueryBuilder<T>,
  options?: UseQueryOptions,
): Readonly<Ref<T[]>>
```

In templates, refs auto-unwrap — use `todos` directly, not `todos.value`.

### Example

```vue
<script setup lang="ts">
import { useApp, useQuery } from '@korajs/vue'

const app = useApp()
const todos = useQuery(app.todos.where({ completed: false }).orderBy('createdAt', 'desc'))
</script>

<template>
  <ul>
    <li v-for="todo in todos" :key="todo.id">{{ todo.title }}</li>
  </ul>
</template>
```

---

## useMutation()

Wraps a collection mutation with optimistic update hooks and loading/error state.

```typescript
function useMutation<TData, TArgs extends unknown[]>(
  mutationFn: (...args: TArgs) => Promise<TData>,
  options?: UseMutationOptions<TData, TArgs>,
): UseMutationResult<TData, TArgs>
```

Returns `mutate`, `mutateAsync`, `isLoading` (ref), `error` (ref), and `reset`.

---

## useSyncStatus()

Returns a readonly ref of `SyncStatusInfo` — connection state, pending operations, last sync time.

```vue
<script setup lang="ts">
import { useSyncStatus } from '@korajs/vue'

const status = useSyncStatus()
</script>

<template>
  <span>{{ status.status }} — {{ status.pendingOperations }} pending</span>
</template>
```

---

## useApp() / useCollection()

- `useApp()` — returns the `KoraAppLike` instance from context.
- `useCollection(name)` — typed collection accessor from the store.

---

## useRichText()

Binds a schema `t.richtext()` field to a shared Yjs document for editor integration.

```typescript
function useRichText(
  collectionName: string,
  recordId: string,
  fieldName: string,
  options?: UseRichTextOptions,
): UseRichTextResult
```

---

## usePresence() / useCollaborators()

Collaborative editing helpers backed by the sync engine awareness protocol.

```vue
<script setup lang="ts">
import { usePresence, useCollaborators } from '@korajs/vue'

usePresence({ name: 'Alice', color: '#e91e63' })
const collaborators = useCollaborators()
</script>
```

- `usePresence(user)` — publishes local presence; clears on unmount.
- `useCollaborators()` — readonly ref of remote peers' awareness states.

---

## Auth & organizations

Authentication composables live in `@korajs/auth/vue`:

```typescript
import { AuthProvider, useAuth, OrgProvider, useOrg, usePermission } from '@korajs/auth/vue'
```

See [Auth API](./auth.md) for session and organization management.

---

## Types

Shared binding types (`UseQueryOptions`, `UseMutationOptions`, `KoraAppLike`, etc.) are defined in `@korajs/core/bindings` and specialized in `@korajs/vue`.
