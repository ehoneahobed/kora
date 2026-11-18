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

Context provider that makes the Kora app available to all composables. Must wrap any component that uses Kora composables. It renders its slot at once, before `app.ready` resolves, so the first paint is your interface: composables return empty values until the store opens, and writes made through them wait for it (saved to a small journal first). It shows an error message if initialization fails. Pass `waitForStorage` to hold the slot back and render `fallback` until the store is open. (`installKora(vueApp, app)` and `useKoraApp()` remain for older code but do not provide the reactive context.)

### Props

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `app` | `KoraAppLike` | Yes* | App instance from `createApp()`. |
| `store` | `Store` | No | Advanced: explicit store instead of `app`. |
| `syncEngine` | `SyncEngine \| null` | No | Advanced: used with `store` prop. |
| `fallback` | `VNode \| string \| null` | No | Shown while `app.ready` resolves, only with `waitForStorage`. |
| `waitForStorage` | `boolean` | No | Hold the slot back until the store is open. |

\* Either `app` or `store` is required.

### Example

<!-- docs-check: standalone -->
```typescript
import { createApp as createKoraApp, defineSchema, t } from 'korajs'
import { createApp, h } from 'vue'
import { KoraProvider } from '@korajs/vue'
import App from './App.vue'

const schema = defineSchema({ version: 1, collections: { todos: { fields: { title: t.string() } } } })
const kora = createKoraApp({ schema })

createApp({
  render: () => h(KoraProvider, { app: kora }, () => h(App)),
}).mount('#app')
```

---

## useQuery()

Returns a reactive array of records matching a query. Re-evaluates when the local store or sync updates the result set.

<!-- docs-check: signature @korajs/vue @korajs/store @korajs/sync vue -->
```typescript
function useQuery<T = CollectionRecord>(
  query: MaybeRefOrGetter<QueryBuilder<T> | null | undefined>,
  options?: {
    enabled?: MaybeRefOrGetter<boolean>
    onError?: (error: Error) => void
  },
): DeepReadonly<ShallowRef<readonly T[]>>
```

The value is `[]` until the query's first result arrives (`useQueryState` reports it as
`ready: false`).

The query and `enabled` can be plain values, refs or getters. Pass a **getter** to follow props or refs: the composable re-subscribes when the query's descriptor changes, releases the previous subscription, and keeps showing the previous rows until the new query answers. A getter that returns `null` disables the query.

A query that fails (for example a `where` or `orderBy` on an unknown field) is reported to `onError`, or logged with `console.error` when there is no handler. Use `useQueryState` to render the error.

In templates, refs auto-unwrap: use `todos` directly, not `todos.value`.

### Example

```vue
<script setup lang="ts">
import { useApp, useQuery } from '@korajs/vue'
import type { app as koraApp } from '../kora'

const props = defineProps<{ done: boolean }>()
// The type argument types the collections (`useApp()` alone returns `KoraAppLike`).
const app = useApp<typeof koraApp>()

// Follows the prop: switching `done` re-runs the query.
const todos = useQuery(() => app.todos.where({ completed: props.done }).orderBy('createdAt', 'desc'))
</script>

<template>
  <ul>
    <li v-for="todo in todos" :key="todo.id">{{ todo.title }}</li>
  </ul>
</template>
```

### useQueryState()

Same inputs; returns `{ data, error, ready, source, complete }` as readonly refs. `error` clears when results flow again, and `data` keeps the last good rows meanwhile. `source` says where the rows come from (`'server'` for an answer read before the local store opened, `'local'`, or `'pending'`), and `complete` is false while the device is still replicating its scope on a first visit, so you can show "showing what is on this device so far". It is always true for a local-only app.

```vue
<script setup lang="ts">
const { data: todos, error } = useQueryState(() => app.todos.where({ completed: false }))
</script>

<template>
  <p v-if="error" role="alert">{{ error.message }}</p>
  <ul v-else><li v-for="todo in todos" :key="todo.id">{{ todo.title }}</li></ul>
</template>
```

---

## useMutation()

Wraps a collection mutation with optimistic update hooks and loading/error state.

<!-- docs-check: signature @korajs/vue @korajs/store @korajs/sync vue -->
```typescript
function useMutation<TData, TArgs extends unknown[], TContext = void>(
  mutationFn: (...args: TArgs) => Promise<TData>,
  options?: {
    onMutate?: (...args: TArgs) => TContext | Promise<TContext>
    onRollback?: (context: TContext, ...args: TArgs) => void | Promise<void>
    onSuccess?: (data: TData, ...args: TArgs) => void
    onError?: (error: Error, ...args: TArgs) => void
    onSettled?: (data: TData | undefined, error: Error | null, ...args: TArgs) => void
    onRejected?: (rejection: MutationRejection<TArgs>) => void
  },
): UseMutationResult<TData, TArgs>
```

Returns `mutate` (fire and forget; failures go to `error` and `onError`), `mutateAsync`
(rejects on failure), `isLoading` (ref), `error` (ref), `rejected` (ref) and `reset`. `rejected`
and `onRejected` report a later server refusal of a write this composable made, while its
component is mounted; see [Rejected writes](/api/react#rejected-writes) for what a write is and
what `MutationRejection` contains. `onRollback` receives what
`onMutate` returned when the mutation fails, to undo optimistic UI state. The local write itself is
atomic: a failed write leaves nothing behind.

---

## useSyncStatus()

Returns a readonly ref of `SyncStatusInfo`: connection state, pending operations, last sync time, plus `heldOperations` / `heldNodes`, `localDurability` and `serverProtocolVersion` / `protocolDeprecated` (see the [React reference](/api/react#usesyncstatus) for their meaning). The ref only changes when the status does.

```vue
<script setup lang="ts">
import { useSyncStatus } from '@korajs/vue'

const status = useSyncStatus()
</script>

<template>
  <span>{{ status.status }} - {{ status.pendingOperations }} pending</span>
</template>
```

---

## useSyncSummary()

A computed ref of `SyncSummary`, the status summarized for an indicator: `tone` (`ok`, `working` or `attention`), a short `title`, one line of `detail`, pending writes, and whether the first download is still running. It follows `useSyncStatus()` (see the [React reference](/api/react#usesyncsummary) for each field).

```vue
<script setup lang="ts">
import { useSyncSummary } from '@korajs/vue'

const sync = useSyncSummary()
</script>

<template>
  <span :class="['chip', sync.tone]" :title="sync.detail">{{ sync.title }}</span>
</template>
```

---

## useApp() / useCollection()

- `useApp()`: returns the `KoraAppLike` instance from context.
- `useCollection(name)`: the store's collection accessor (`insert`, `update`, `delete`, `findById`, `where`).

## createKoraHooks()

`createKoraHooks<typeof app>()` returns composables typed for one app: `useCollection('todos')` accepts only the app's collection names and returns its typed accessor, so `insert`, `update`, `where` and the rows of `useQuery` follow the schema. Call it once next to `createApp`; nothing runs at call time. It returns `useApp`, `useCollection`, `useQuery`, `useQueryState`, `useMutation`, `useSyncStatus` and `useSyncSummary`.

<!-- docs-check: skip imports an app module of the reader's project -->
```typescript
// kora.ts
import { createApp } from 'korajs'
import { createKoraHooks } from '@korajs/vue'
import schema from './schema'

export const app = createApp({ schema })
export const { useCollection, useQuery, useMutation } = createKoraHooks<typeof app>()
```

---

## useRichText()

Binds a schema `t.richtext()` field to a shared Yjs document for editor integration.

<!-- docs-check: signature @korajs/vue @korajs/store @korajs/sync vue -->
```typescript
function useRichText(
  collectionName: MaybeRefOrGetter<string>,
  recordId: MaybeRefOrGetter<string>,
  fieldName: MaybeRefOrGetter<string>,
  options?: { user?: MaybeRefOrGetter<AwarenessUser | undefined>; useDocChannel?: boolean },
): UseRichTextResult
```

The collection, record id, field and `user` may be refs or getters. When the record id changes
(an editor reused across routes, `() => route.params.id`), the binding moves to the new record.

The result holds the Yjs `doc` and `text` to bind to an editor, `undo`/`redo` with
`canUndo`/`canRedo`, `ready`, `error`, remote `cursors` and `setCursor(anchor, head)`. Edits are
written to the record as rich-text updates and merge character by character. A refused save sets
`error` and `hasUnsavedChanges`; the edits stay in the document and the next edit or `retrySave()`
saves them (`getUnsavedState()` returns them for a recovery copy). See the
[React `useRichText`](/api/react#userichtext) behavior notes.

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

- `usePresence(user)`: publishes local presence; clears on unmount. `user` may be a ref, a getter or a reactive object: a change updates what collaborators see, and `null` clears it.
- `useCollaborators()`: a ref of remote peers' `AwarenessState` (`user`, `cursor?`). A state with a cursor reaches the sessions that can read its record; one without a cursor only sessions with the same download scope (see [Presence](/guide/presence#who-sees-a-presence-state)).

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

## useFormDraft() {#use-form-draft}

Keeps a form's input across the reload a new version of the app asks for (opt-in; see
[App updates and multiple tabs](/guide/app-updates#keeping-what-the-user-typed-form-drafts)).
Same options and rules as the React hook. `userId` may be a ref or a getter
(`() => (status.isLoading ? undefined : (user.value?.id ?? null))`), and `fieldRef` on a component
reads the form control inside its root element.

<!-- docs-check: skip Vue SFC fragment -->
```typescript
const draft = useFormDraft('new-todo', { title: '' }, { fields: ['title'], collection: 'todos' })
// <input v-model="draft.values.title" :ref="draft.fieldRef('title')" />
// after a successful submit: draft.clear()
```
