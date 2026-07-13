# @korajs/vue

Vue 3 composables for [Kora.js](https://github.com/ehoneahobed/kora) offline-first applications.

## Install

```bash
pnpm add korajs @korajs/vue
```

## Setup

Create the Kora app once at module scope, connect sync after `ready`, then wrap your tree with providers (matches the CLI `vue-tailwind-sync` template):

```typescript
import { createKoraAuthSync } from '@korajs/auth'
import { AuthProvider } from '@korajs/auth/vue'
import { KoraProvider } from '@korajs/vue'
import { createApp as createKoraApp } from 'korajs'
import { createApp, h } from 'vue'
import App from './App.vue'
import { authClient } from './auth'
import schema from './schema'
import koraWorkerUrl from './kora-worker.ts?worker&url'

const kora = createKoraApp({
  schema,
  sync: { url: 'ws://localhost:3000/kora-sync', authClient: createKoraAuthSync({ authClient, schema }) },
  store: { workerUrl: koraWorkerUrl },
})

kora.ready.then(() => kora.sync?.connect())

createApp({
  render: () =>
    h(AuthProvider, { client: authClient }, () =>
      h(KoraProvider, { app: kora }, () => h(App)),
    ),
}).mount('#app')
```

Or use SFC wrappers:

```vue
<AuthProvider :client="authClient">
  <KoraProvider :app="kora">
    <TodoList />
  </KoraProvider>
</AuthProvider>
```

## Composables

| Composable | Purpose |
|------------|---------|
| `useQuery(query)` | Reactive local query results |
| `useMutation(fn)` | Optimistic mutations with rollback |
| `useSyncStatus()` | Connection / sync state |
| `useApp()` | Typed `createApp()` instance |
| `useCollection(name)` | Collection accessor |
| `useRichText(name, id, field)` | Yjs richtext editor binding |
| `usePresence(user)` | Publish collaborative presence |
| `useCollaborators()` | Remote collaborator awareness states |

```vue
<script setup lang="ts">
import { useApp, useQuery, useMutation } from '@korajs/vue'

const app = useApp()
const todos = useQuery(app.todos.where({ completed: false }))
const { mutate: addTodo } = useMutation(app.todos.insert)
</script>

<template>
  <ul>
    <li v-for="todo in todos" :key="todo.id">{{ todo.title }}</li>
  </ul>
  <button @click="addTodo({ title: 'New' })">Add</button>
</template>
```

## Organization auth

When using `@korajs/auth` organizations, wrap with `OrgProvider` and use org composables from `@korajs/auth/vue`:

```vue
<OrgProvider :client="orgClient">
  <AdminPanel />
</OrgProvider>
```

## Legacy helpers

`installKora()` and `useKoraApp()` remain for app-context only. Prefer `KoraProvider` + composables for reactive data.
